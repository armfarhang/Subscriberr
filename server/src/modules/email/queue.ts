import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import {


  DEFAULT_EMAIL_SETTINGS,
  diffDays,
  type EmailKind,
  type EmailQueueItem,
  type EmailQueueStatus,
  type EmailSettings,
  emailListQuerySchema,
  emailSettingsSchema,
  formatCents,
  type TemplateKind,
} from '@subscriberr/shared';
import type { z } from 'zod';
import { writeAudit } from '../../core/audit.js';
import { conflict, notFound } from '../../core/errors.js';
import { type Clock, nowIso, today } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import { resolveTerms } from '../members/members.js';
import { getWorkspaceSettings, readJsonSetting, writeJsonSetting } from '../workspaces/settings.js';
import { loadActivePack, type PackEnv, themeValues } from './packs.js';
import { type RenderedEmail, renderEmail, type TemplateVars } from './render.js';

// The persistent outbound queue (Spec §9.5). Every email is rendered when it is queued (the queue
// keeps exactly what will be sent) and is never sent inline: the drainer sends it later.

export const PRIORITY = { transactional: 10, announcement: 50 } as const;
const SETTINGS_KEY = 'email_settings';

export function getEmailSettings(ws: WorkspaceContext): EmailSettings {
  const raw = readJsonSetting(ws, SETTINGS_KEY);
  const parsed = emailSettingsSchema.partial().safeParse(raw ?? {});
  return { ...DEFAULT_EMAIL_SETTINGS, ...(parsed.success ? parsed.data : {}) } as EmailSettings;
}

export function saveEmailSettings(ws: WorkspaceContext, clock: Clock, actor: string, value: EmailSettings): EmailSettings {
  const v = emailSettingsSchema.parse(value);
  ws.sqlite.transaction(() => {
    writeJsonSetting(ws, SETTINGS_KEY, { ...v, reminderOffsets: [...new Set(v.reminderOffsets)].sort((a, b) => b - a), overdueOffsets: [...new Set(v.overdueOffsets)].sort((a, b) => a - b) });
    writeAudit(ws, clock, { actor, action: 'settings.email_updated', entity: 'workspace', entityId: ws.accountId });
  })();
  return getEmailSettings(ws);
}

interface MemberForEmail {
  id: number;
  display_name: string;
  email: string | null;
  emails_enabled: number;
  reminders_enabled: number;
  status: string;
  paid_through: string | null;
  credit_cents: number;
  currency: string;
  payment_memo_code: string | null;
  plan_amount_cents: number | null;
  plan_period_days: number | null;
  tolerance_cents: number | null;
  grace_days: number | null;
}

export function memberForEmail(ws: WorkspaceContext, memberId: number): MemberForEmail {
  const m = ws.sqlite.prepare('SELECT * FROM members WHERE account_id = ? AND id = ?').get(ws.accountId, memberId) as MemberForEmail | undefined;
  if (!m) throw notFound('Member not found');
  return m;
}

const longDate = (d: string | null) => (d ? new Intl.DateTimeFormat('en-CA', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)) : '');

/** The documented variable set (§9.2) for one member, plus kind-specific extras. */
export function memberVars(ws: WorkspaceContext, clock: Clock, m: MemberForEmail, extra: TemplateVars = {}): TemplateVars {
  const settings = getWorkspaceSettings(ws);
  const terms = resolveTerms(m, settings.memberDefaults);
  const money = (c: number | null) => (c === null ? '' : formatCents(c, m.currency));
  const todayDate = today(clock, settings.timezone);
  return {
    member: { display_name: m.display_name },
    plan: { amount: money(terms.planAmountCents.value), period_days: terms.planPeriodDays.value },
    paid_through: longDate(m.paid_through),
    due_date: longDate(m.paid_through),
    days_until_due: m.paid_through ? Math.max(diffDays(todayDate, m.paid_through), 0) : '',
    grace_days: terms.graceDays.value,
    amount_expected: money(terms.planAmountCents.value),
    credit: m.credit_cents > 0 ? money(m.credit_cents) : '',
    etransfer_email: settings.etransferEmail ?? '',
    etransfer_instructions: settings.etransferInstructions,
    payment_memo_code: m.payment_memo_code ?? '',
    app_name: 'Subscriberr',
    ...extra,
  };
}

/** Sample data for previews and test sends. */
export function sampleVars(ws: WorkspaceContext): TemplateVars {
  const s = getWorkspaceSettings(ws);
  return {
    member: { display_name: 'Ann (neighbour)' },
    plan: { amount: '$15.00', period_days: 30 },
    paid_through: 'December 31, 2026',
    due_date: 'December 31, 2026',
    days_until_due: 3,
    grace_days: 3,
    amount_received: '$10.00',
    amount_expected: '$15.00',
    shortfall: '$5.00',
    credit: '$10.00',
    periods_covered: 1,
    etransfer_email: s.etransferEmail ?? 'payments@example.com',
    etransfer_instructions: s.etransferInstructions,
    payment_memo_code: 'AN-1',
    app_name: 'Subscriberr',
    subject: 'Movie night this Friday',
    content: '<p>We added a new 4K library. Enjoy!</p>',
  };
}

export interface EnqueueInput {
  kind: EmailKind;
  memberId: number | null;
  to: string;
  rendered: RenderedEmail;
  priority: number;
  dedupeKey: string;
  announcementId?: number | null;
  templatePack?: string | null;
  templateVersion?: string | null;
  notBefore?: string | null;
}

/** Queues one email. Returns the new id, or null when the dedupe key was already used. */
export function enqueue(ws: WorkspaceContext, clock: Clock, e: EnqueueInput): number | null {
  // Attachments (inline images) are kept with the rendered snapshot, so a retry sends exactly the same thing.
  const html = e.rendered.attachments.length > 0 ? JSON.stringify({ html: e.rendered.html, attachments: e.rendered.attachments.map((a) => ({ ...a, content: a.content.toString('base64') })) }) : e.rendered.html;
  const res = ws.sqlite
    .prepare(
      `INSERT OR IGNORE INTO email_queue (account_id, kind, member_id, to_address, subject, html, text, priority, status, attempts, not_before, dedupe_key, announcement_id, template_pack, template_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ws.accountId,
      e.kind,
      e.memberId,
      e.to,
      e.rendered.subject,
      html,
      e.rendered.text,
      e.priority,
      e.notBefore ?? null,
      e.dedupeKey,
      e.announcementId ?? null,
      e.templatePack ?? null,
      e.templateVersion ?? null,
      nowIso(clock),
    );
  return res.changes > 0 ? Number(res.lastInsertRowid) : null;
}

/** Renders a member email with the active pack and queues it (no-op if it was already queued). */
export function queueMemberEmail(
  ws: WorkspaceContext,
  deps: { clock: Clock; packs: PackEnv },
  kind: TemplateKind,
  memberId: number,
  dedupeKey: string,
  extra: TemplateVars = {},
  opts: { announcementId?: number; priority?: number } = {},
): { queued: boolean; reason?: string } {
  const m = memberForEmail(ws, memberId);
  // Only ever the member's email on file (§9.3: never the payer's Reply-To).
  if (!m.email) return { queued: false, reason: 'no email on file' };
  if (m.emails_enabled !== 1) return { queued: false, reason: 'emails turned off for this member' };
  if (kind === 'reminder' && m.reminders_enabled !== 1) return { queued: false, reason: 'reminders turned off for this member' };
  const pack = loadActivePack(deps.packs, ws);
  const rendered = renderEmail(pack, kind, memberVars(ws, deps.clock, m, extra), themeValues(ws, pack));
  const id = enqueue(ws, deps.clock, {
    kind,
    memberId,
    to: m.email,
    rendered,
    priority: opts.priority ?? (kind === 'announcement' ? PRIORITY.announcement : PRIORITY.transactional),
    dedupeKey,
    announcementId: opts.announcementId ?? null,
    templatePack: pack.id,
    templateVersion: pack.meta.version,
  });
  return id === null ? { queued: false, reason: 'already queued' } : { queued: true };
}

/** MIME message (multipart/alternative, + related for inline images), UTF-8, one recipient. */
export async function buildMime(input: { fromName: string; fromAddress: string; to: string; subject: string; html: string; text: string; messageIdDomain?: string }): Promise<Buffer> {
  let html = input.html;
  let attachments: Array<{ filename: string; cid: string; content: Buffer; contentType: string }> = [];
  if (html.startsWith('{"html":')) {
    const parsed = JSON.parse(html) as { html: string; attachments: Array<{ filename: string; cid: string; content: string; contentType: string }> };
    html = parsed.html;
    attachments = parsed.attachments.map((a) => ({ ...a, content: Buffer.from(a.content, 'base64') }));
  }
  const composer = new MailComposer({
    from: input.fromName ? { name: input.fromName, address: input.fromAddress } : input.fromAddress,
    to: input.to,
    subject: input.subject,
    html,
    text: input.text,
    attachments,
    textEncoding: 'quoted-printable',
  });
  return composer.compile().build();
}

// ---- Views -----------------------------------------------------------------------------------

interface QueueRow {
  id: number;
  kind: EmailKind;
  member_id: number | null;
  member_name: string | null;
  to_address: string;
  subject: string;
  status: EmailQueueItem['status'];
  priority: number;
  attempts: number;
  not_before: string | null;
  sent_at: string | null;
  error: string | null;
  created_at: string;
  announcement_id: number | null;
  template_pack: string | null;
}

const toItem = (r: QueueRow): EmailQueueItem => ({
  id: r.id,
  kind: r.kind,
  memberId: r.member_id,
  memberName: r.member_name,
  toAddress: r.to_address,
  subject: r.subject,
  status: r.status,
  priority: r.priority,
  attempts: r.attempts,
  notBefore: r.not_before,
  sentAt: r.sent_at,
  error: r.error,
  createdAt: r.created_at,
  announcementId: r.announcement_id,
  templatePack: r.template_pack,
});

export function listQueue(ws: WorkspaceContext, raw: z.input<typeof emailListQuerySchema>): { items: EmailQueueItem[]; total: number; page: number; pageSize: number } {
  const q = emailListQuerySchema.parse(raw);
  const where = ['q.account_id = ?'];
  const args: unknown[] = [ws.accountId];
  for (const [column, value] of [
    ['q.status', q.status],
    ['q.kind', q.kind],
    ['q.member_id', q.memberId],
  ] as const) {
    if (value === undefined) continue;
    where.push(`${column} = ?`);
    args.push(value);
  }
  const total = (ws.sqlite.prepare(`SELECT count(*) AS n FROM email_queue q WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n;
  const rows = ws.sqlite
    .prepare(
      `SELECT q.*, m.display_name AS member_name FROM email_queue q LEFT JOIN members m ON m.account_id = q.account_id AND m.id = q.member_id
       WHERE ${where.join(' AND ')} ORDER BY COALESCE(q.sent_at, q.created_at) DESC, q.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, q.pageSize, (q.page - 1) * q.pageSize) as QueueRow[];
  return { items: rows.map(toItem), total, page: q.page, pageSize: q.pageSize };
}

export function getQueueItem(ws: WorkspaceContext, id: number): EmailQueueItem & { html: string; text: string } {
  const r = ws.sqlite
    .prepare(`SELECT q.*, m.display_name AS member_name FROM email_queue q LEFT JOIN members m ON m.account_id = q.account_id AND m.id = q.member_id WHERE q.account_id = ? AND q.id = ?`)
    .get(ws.accountId, id) as (QueueRow & { html: string; text: string }) | undefined;
  if (!r) throw notFound('Email not found');
  const html = r.html.startsWith('{"html":') ? (JSON.parse(r.html) as { html: string }).html : r.html;
  return { ...toItem(r), html, text: r.text };
}

export function sentInWindow(ws: WorkspaceContext, clock: Clock): { count: number; oldest: string | null } {
  const since = new Date(clock.now().getTime() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const row = ws.sqlite.prepare(`SELECT count(*) AS n, min(sent_at) AS oldest FROM email_queue WHERE account_id = ? AND status = 'sent' AND sent_at >= ?`).get(ws.accountId, since) as {
    n: number;
    oldest: string | null;
  };
  return { count: row.n, oldest: row.oldest };
}

export function queueStatus(ws: WorkspaceContext, clock: Clock): EmailQueueStatus {
  const s = getEmailSettings(ws);
  const sent = sentInWindow(ws, clock);
  const counts = ws.sqlite
    .prepare(
      `SELECT sum(status = 'queued') AS queued, sum(status = 'queued' AND kind = 'announcement') AS ann, sum(status = 'failed') AS failed FROM email_queue WHERE account_id = ?`,
    )
    .get(ws.accountId) as { queued: number | null; ann: number | null; failed: number | null };
  const gmail = ws.sqlite.prepare('SELECT gmail_status FROM accounts WHERE id = ?').get(ws.accountId) as { gmail_status: string };
  const atCap = sent.count >= s.dailyCap - ((counts.ann ?? 0) > 0 && (counts.queued ?? 0) === (counts.ann ?? 0) ? s.transactionalReserve : 0);
  return {
    sentLast24h: sent.count,
    cap: s.dailyCap,
    transactionalReserve: s.transactionalReserve,
    queued: counts.queued ?? 0,
    queuedAnnouncements: counts.ann ?? 0,
    failed: counts.failed ?? 0,
    resumesAt: atCap && sent.oldest ? new Date(Date.parse(sent.oldest) + 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    dryRun: s.dryRun,
    gmailConnected: gmail.gmail_status === 'connected',
  };
}

export function retryEmail(ws: WorkspaceContext, clock: Clock, actor: string, id: number): void {
  const item = getQueueItem(ws, id);
  if (item.status !== 'failed' && item.status !== 'cancelled') throw conflict('Only failed or cancelled emails can be retried.');
  ws.sqlite.prepare(`UPDATE email_queue SET status = 'queued', attempts = 0, not_before = NULL, error = NULL WHERE account_id = ? AND id = ?`).run(ws.accountId, id);
  writeAudit(ws, clock, { actor, action: 'email.retried', entity: item.memberId ? 'member' : 'email', entityId: item.memberId ?? id, details: { emailId: id } });
}

export function cancelEmail(ws: WorkspaceContext, clock: Clock, actor: string, id: number): void {
  const item = getQueueItem(ws, id);
  if (item.status !== 'queued') throw conflict('Only queued emails can be cancelled.');
  ws.sqlite.prepare(`UPDATE email_queue SET status = 'cancelled', error = 'Cancelled by admin' WHERE account_id = ? AND id = ? AND status = 'queued'`).run(ws.accountId, id);
  writeAudit(ws, clock, { actor, action: 'email.cancelled', entity: item.memberId ? 'member' : 'email', entityId: item.memberId ?? id, details: { emailId: id } });
}

