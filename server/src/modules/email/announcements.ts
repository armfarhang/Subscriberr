import {
  addDays,
  type Audience,
  type AnnouncementDraft,
  announcementDraftSchema,
  type AnnouncementProgress,
  type AnnouncementRecipient,
  type AnnouncementRecipientStatus,
  type AnnouncementView,
  audienceSchema,
  type EmailPreview,
} from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import { AppError, conflict, notFound } from '../../core/errors.js';
import { type Clock, nowIso, today } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import { getWorkspaceSettings, readJsonSetting, writeJsonSetting } from '../workspaces/settings.js';
import { loadActivePack, type PackEnv, themeValues } from './packs.js';
import { memberForEmail, memberVars, PRIORITY, queueMemberEmail, sampleVars } from './queue.js';
import { checkTemplate, renderEmail, renderSnippet } from './render.js';
import { sanitizeAnnouncement } from './sanitize.js';

// Mass announcements (Spec §9.4): drafts, audiences, a recipient preview with explicit
// confirmation, then one queued email per recipient. The queue's cap and reserve spread a large
// announcement over as many days as needed; its status stays `sending` until every copy is done.

export interface AnnouncementDeps {
  clock: Clock;
  packs: PackEnv;
}

const FOOTER_KEY = 'announcement_footer';

interface Row {
  id: number;
  subject: string;
  body: string;
  audience: string;
  status: AnnouncementView['status'];
  created_at: string;
}

interface StoredBody {
  html: string;
  footer: string;
}

function parseBody(raw: string): StoredBody {
  try {
    const v = JSON.parse(raw) as StoredBody;
    if (typeof v.html === 'string') return { html: v.html, footer: v.footer ?? '' };
  } catch {
    /* plain html */
  }
  return { html: raw, footer: '' };
}

export function defaultFooter(ws: WorkspaceContext): string {
  const v = readJsonSetting(ws, FOOTER_KEY);
  return typeof v === 'string' ? v : '';
}

// ---- Audiences ---------------------------------------------------------------------------------

interface AudienceMember {
  id: number;
  display_name: string;
  email: string | null;
  emails_enabled: number;
}

export function resolveAudience(ws: WorkspaceContext, clock: Clock, audience: Audience): AudienceMember[] {
  const a = audienceSchema.parse(audience);
  const base = 'SELECT id, display_name, email, emails_enabled FROM members WHERE account_id = ?';
  const order = ' ORDER BY display_name COLLATE NOCASE, id';
  switch (a.type) {
    case 'active':
      // Everyone who currently has access.
      return ws.sqlite.prepare(`${base} AND status IN ('active', 'grace')${order}`).all(ws.accountId) as AudienceMember[];
    case 'non_archived':
      return ws.sqlite.prepare(`${base} AND status <> 'archived'${order}`).all(ws.accountId) as AudienceMember[];
    case 'status':
      return ws.sqlite.prepare(`${base} AND status IN (${a.statuses.map(() => '?').join(',')})${order}`).all(ws.accountId, ...a.statuses) as AudienceMember[];
    case 'server':
      return ws.sqlite
        .prepare(`${base} AND status <> 'archived' AND id IN (SELECT member_id FROM member_server_accounts WHERE account_id = ? AND server_id = ?)${order}`)
        .all(ws.accountId, ws.accountId, a.serverId) as AudienceMember[];
    case 'expiring': {
      const t = today(clock, getWorkspaceSettings(ws).timezone);
      return ws.sqlite.prepare(`${base} AND status IN ('active', 'grace') AND paid_through BETWEEN ? AND ?${order}`).all(ws.accountId, t, addDays(t, a.days)) as AudienceMember[];
    }
    case 'picked': {
      const rows = ws.sqlite.prepare(`${base}${order}`).all(ws.accountId) as AudienceMember[];
      const wanted = new Set(a.memberIds);
      return rows.filter((r) => wanted.has(r.id));
    }
  }
}

export function audienceRecipients(ws: WorkspaceContext, clock: Clock, audience: Audience): AnnouncementRecipient[] {
  return resolveAudience(ws, clock, audience).map((m) => ({
    memberId: m.id,
    displayName: m.display_name,
    email: m.email,
    excluded: !m.email ? 'no email on file' : m.emails_enabled !== 1 ? 'emails turned off for this member' : null,
  }));
}

// ---- Drafts ----------------------------------------------------------------------------------

function validateTemplates(subject: string, body: string) {
  const problems = [...checkTemplate(subject).map((m) => ({ path: 'subject', message: m })), ...checkTemplate(body).map((m) => ({ path: 'body', message: m }))];
  if (problems.length > 0) throw new AppError(422, 'invalid_template', 'The announcement uses variables or syntax that are not allowed', problems);
}

function cleanDraft(input: AnnouncementDraft) {
  const d = announcementDraftSchema.parse(input);
  const body = sanitizeAnnouncement(d.body);
  const footer = sanitizeAnnouncement(d.footer);
  validateTemplates(d.subject, `${body}${footer}`);
  return { ...d, body, footer };
}

function requireRow(ws: WorkspaceContext, id: number): Row {
  const row = ws.sqlite.prepare('SELECT id, subject, body, audience, status, created_at FROM announcements WHERE account_id = ? AND id = ?').get(ws.accountId, id) as Row | undefined;
  if (!row) throw notFound('Announcement not found');
  return row;
}

function progress(ws: WorkspaceContext, id: number): AnnouncementProgress {
  const r = ws.sqlite
    .prepare(
      `SELECT count(*) AS total, sum(status IN ('queued', 'sending')) AS queued, sum(status = 'sent') AS sent, sum(status = 'failed') AS failed, sum(status = 'cancelled') AS cancelled
       FROM email_queue WHERE account_id = ? AND announcement_id = ?`,
    )
    .get(ws.accountId, id) as { total: number; queued: number | null; sent: number | null; failed: number | null; cancelled: number | null };
  return { total: r.total, queued: r.queued ?? 0, sent: r.sent ?? 0, failed: r.failed ?? 0, cancelled: r.cancelled ?? 0 };
}

/** An announcement stays `sending` until no copy is queued any more (§9.5). */
export function settleAnnouncements(ws: WorkspaceContext): void {
  const rows = ws.sqlite.prepare(`SELECT id FROM announcements WHERE account_id = ? AND status = 'sending'`).all(ws.accountId) as Array<{ id: number }>;
  for (const { id } of rows) if (progress(ws, id).queued === 0) ws.sqlite.prepare(`UPDATE announcements SET status = 'sent' WHERE account_id = ? AND id = ?`).run(ws.accountId, id);
}

function toView(ws: WorkspaceContext, r: Row): AnnouncementView {
  const body = parseBody(r.body);
  return {
    id: r.id,
    subject: r.subject,
    body: body.html,
    footer: body.footer,
    audience: audienceSchema.parse(JSON.parse(r.audience)),
    status: r.status,
    createdAt: r.created_at,
    progress: r.status === 'draft' ? null : progress(ws, r.id),
  };
}

export function listAnnouncements(ws: WorkspaceContext): AnnouncementView[] {
  settleAnnouncements(ws);
  const rows = ws.sqlite.prepare('SELECT id, subject, body, audience, status, created_at FROM announcements WHERE account_id = ? ORDER BY id DESC LIMIT 100').all(ws.accountId) as Row[];
  return rows.map((r) => toView(ws, r));
}

export function getAnnouncement(ws: WorkspaceContext, id: number): AnnouncementView {
  settleAnnouncements(ws);
  return toView(ws, requireRow(ws, id));
}

export function createAnnouncement(ws: WorkspaceContext, clock: Clock, actor: string, input: AnnouncementDraft): AnnouncementView {
  const d = cleanDraft(input);
  const id = ws.sqlite.transaction(() => {
    const newId = Number(
      ws.sqlite
        .prepare(`INSERT INTO announcements (account_id, subject, body, audience, status, created_at) VALUES (?, ?, ?, ?, 'draft', ?)`)
        .run(ws.accountId, d.subject, JSON.stringify({ html: d.body, footer: d.footer }), JSON.stringify(d.audience), nowIso(clock)).lastInsertRowid,
    );
    writeJsonSetting(ws, FOOTER_KEY, d.footer);
    writeAudit(ws, clock, { actor, action: 'announcement.created', entity: 'announcement', entityId: newId, details: { subject: d.subject } });
    return newId;
  })();
  return getAnnouncement(ws, id);
}

export function updateAnnouncement(ws: WorkspaceContext, clock: Clock, actor: string, id: number, input: AnnouncementDraft): AnnouncementView {
  if (requireRow(ws, id).status !== 'draft') throw conflict('Only drafts can be edited.');
  const d = cleanDraft(input);
  ws.sqlite.transaction(() => {
    ws.sqlite.prepare(`UPDATE announcements SET subject = ?, body = ?, audience = ? WHERE account_id = ? AND id = ?`).run(d.subject, JSON.stringify({ html: d.body, footer: d.footer }), JSON.stringify(d.audience), ws.accountId, id);
    writeJsonSetting(ws, FOOTER_KEY, d.footer);
  })();
  void actor;
  return getAnnouncement(ws, id);
}

export function deleteDraft(ws: WorkspaceContext, clock: Clock, actor: string, id: number): void {
  if (requireRow(ws, id).status !== 'draft') throw conflict('Sent announcements are kept as history.');
  ws.sqlite.transaction(() => {
    ws.sqlite.prepare('DELETE FROM announcements WHERE account_id = ? AND id = ?').run(ws.accountId, id);
    writeAudit(ws, clock, { actor, action: 'announcement.deleted', entity: 'announcement', entityId: id });
  })();
}

/** The composer text with the member's variables, then the footer (both already sanitized). */
function contentFor(body: StoredBody, vars: Parameters<typeof renderSnippet>[1]): string {
  return renderSnippet(`${body.html}${body.footer ? `<hr>${body.footer}` : ''}`, vars);
}

/** Preview: rendered for the first recipient (or sample data), with the active pack. */
export function previewAnnouncement(ws: WorkspaceContext, deps: AnnouncementDeps, input: AnnouncementDraft): EmailPreview {
  const d = cleanDraft(input);
  const first = audienceRecipients(ws, deps.clock, d.audience).find((r) => !r.excluded);
  const base = first ? memberVars(ws, deps.clock, memberForEmail(ws, first.memberId)) : sampleVars(ws);
  const subject = renderSnippet(d.subject, base, { noEscape: true });
  const pack = loadActivePack(deps.packs, ws);
  const r = renderEmail(pack, 'announcement', { ...base, subject, content: contentFor({ html: d.body, footer: d.footer }, base) }, themeValues(ws, pack));
  let html = r.html;
  for (const a of r.attachments) html = html.replaceAll(`cid:${a.cid}`, `data:${a.contentType};base64,${a.content.toString('base64')}`);
  return { subject: r.subject, html, text: r.text };
}

export function sendAnnouncement(ws: WorkspaceContext, deps: AnnouncementDeps, actor: string, id: number, confirmRecipients: number): AnnouncementView {
  const row = requireRow(ws, id);
  if (row.status !== 'draft') throw conflict('This announcement was already sent.');
  const audience = audienceSchema.parse(JSON.parse(row.audience));
  const recipients = audienceRecipients(ws, deps.clock, audience).filter((r) => !r.excluded);
  if (recipients.length === 0) throw conflict('Nobody in this audience can receive email.');
  if (recipients.length !== confirmRecipients) {
    throw conflict(`The audience now has ${recipients.length} recipient(s), not ${confirmRecipients}. Check the list and confirm again.`, { recipients: recipients.length });
  }
  const body = parseBody(row.body);
  ws.sqlite.transaction(() => {
    for (const r of recipients) {
      const vars = memberVars(ws, deps.clock, memberForEmail(ws, r.memberId));
      queueMemberEmail(ws, deps, 'announcement', r.memberId, `announcement:${id}:${r.memberId}`, { subject: renderSnippet(row.subject, vars, { noEscape: true }), content: contentFor(body, vars) }, { announcementId: id, priority: PRIORITY.announcement });
    }
    ws.sqlite.prepare(`UPDATE announcements SET status = 'sending' WHERE account_id = ? AND id = ?`).run(ws.accountId, id);
    writeAudit(ws, deps.clock, { actor, action: 'announcement.sent', entity: 'announcement', entityId: id, details: { recipients: recipients.length, subject: row.subject } });
  })();
  return getAnnouncement(ws, id);
}

export function cancelAnnouncement(ws: WorkspaceContext, clock: Clock, actor: string, id: number): AnnouncementView {
  const row = requireRow(ws, id);
  if (row.status !== 'sending') throw conflict('Only an announcement that is still sending can be cancelled.');
  ws.sqlite.transaction(() => {
    const n = ws.sqlite.prepare(`UPDATE email_queue SET status = 'cancelled', error = 'Announcement cancelled' WHERE account_id = ? AND announcement_id = ? AND status = 'queued'`).run(ws.accountId, id).changes;
    ws.sqlite.prepare(`UPDATE announcements SET status = 'cancelled' WHERE account_id = ? AND id = ?`).run(ws.accountId, id);
    writeAudit(ws, clock, { actor, action: 'announcement.cancelled', entity: 'announcement', entityId: id, details: { cancelledCopies: n } });
  })();
  return getAnnouncement(ws, id);
}

export function announcementRecipients(ws: WorkspaceContext, id: number): AnnouncementRecipientStatus[] {
  requireRow(ws, id);
  const rows = ws.sqlite
    .prepare(
      `SELECT q.id, q.member_id, m.display_name, q.to_address, q.status, q.sent_at, q.error FROM email_queue q
       LEFT JOIN members m ON m.account_id = q.account_id AND m.id = q.member_id WHERE q.account_id = ? AND q.announcement_id = ? ORDER BY m.display_name COLLATE NOCASE, q.id`,
    )
    .all(ws.accountId, id) as Array<{ id: number; member_id: number | null; display_name: string | null; to_address: string; status: AnnouncementRecipientStatus['status']; sent_at: string | null; error: string | null }>;
  return rows.map((r) => ({ emailId: r.id, memberId: r.member_id, displayName: r.display_name, email: r.to_address, status: r.status, sentAt: r.sent_at, error: r.error }));
}
