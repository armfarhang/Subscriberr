import { writeAudit } from '../../core/audit.js';
import type { Logger } from '../../core/logger.js';
import { type Clock, nowIso } from '../../core/time.js';
import { forWorkspace, type SystemContext, type WorkspaceContext } from '../../core/workspace-context.js';
import { isInvalidGrant } from '../auth/google.js';
import type { GmailClientFactory } from '../gmail/factory.js';
import { markGmailDisconnected } from '../gmail/tokens.js';
import { settleAnnouncements } from './announcements.js';
import { buildMime, getEmailSettings, PRIORITY, sentInWindow } from './queue.js';

// The drainer (Spec §9.5): every minute, per workspace, sends queued mail in priority order
// (transactional first), throttled, within a rolling-24h cap that keeps a reserve for
// transactional mail. Announcements past the cap simply wait for the window to free up.

export interface DrainDeps {
  clock: Clock;
  log: Logger;
  gmail: GmailClientFactory;
  /** Pause between sends (default 700 ms ≈ 1.4 msg/s). */
  throttleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DrainResult {
  sent: number;
  failed: number;
  retried: number;
  dryRun: number;
  skipped?: string;
}

export const MAX_ATTEMPTS = 8;
const MAX_PER_RUN = 80;
const STUCK_AFTER_MS = 10 * 60_000;

/** Permanent failures: bad addresses / rejected messages. Everything else is retried. */
function isPermanent(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  const status = Number(e?.response?.status ?? e?.status ?? e?.code);
  return status === 400 || status === 403 || status === 404;
}

interface Row {
  id: number;
  kind: string;
  member_id: number | null;
  to_address: string;
  subject: string;
  html: string;
  text: string;
  attempts: number;
}

const running = new Set<number>();

export async function drainWorkspace(ws: WorkspaceContext, deps: DrainDeps): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, failed: 0, retried: 0, dryRun: 0 };
  if (running.has(ws.accountId)) return { ...result, skipped: 'already running' };
  running.add(ws.accountId);
  try {
    const now = () => nowIso(deps.clock);
    // A crash between "sending" and "sent" must never cause a second copy: such rows are failed for a person to check.
    const stuckBefore = new Date(deps.clock.now().getTime() - STUCK_AFTER_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    ws.sqlite
      .prepare(`UPDATE email_queue SET status = 'failed', error = 'Interrupted while sending. Check Gmail Sent before retrying.' WHERE account_id = ? AND status = 'sending' AND COALESCE(not_before, created_at) < ?`)
      .run(ws.accountId, stuckBefore);

    const settings = getEmailSettings(ws);
    const account = ws.sqlite.prepare('SELECT email, gmail_status FROM accounts WHERE id = ?').get(ws.accountId) as { email: string; gmail_status: string };
    const pick = (maxPriority: number) =>
      ws.sqlite
        .prepare(
          `SELECT id, kind, member_id, to_address, subject, html, text, attempts FROM email_queue
           WHERE account_id = ? AND status = 'queued' AND (not_before IS NULL OR not_before <= ?) AND priority <= ? ORDER BY priority, id LIMIT 1`,
        )
        .get(ws.accountId, now(), maxPriority) as Row | undefined;

    if (settings.dryRun) {
      // Dry run: show what would be sent, send nothing.
      for (let row = pick(Number.MAX_SAFE_INTEGER); row; row = pick(Number.MAX_SAFE_INTEGER)) {
        ws.sqlite.prepare(`UPDATE email_queue SET status = 'cancelled', error = 'Dry run: not sent' WHERE account_id = ? AND id = ?`).run(ws.accountId, row.id);
        result.dryRun++;
      }
      return result;
    }
    if (account.gmail_status !== 'connected') return { ...result, skipped: 'Gmail is not connected' };

    let gmail;
    try {
      gmail = await deps.gmail(ws.accountId);
    } catch (err) {
      return { ...result, skipped: err instanceof Error ? err.message : String(err) };
    }
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let n = 0; n < MAX_PER_RUN; n++) {
      const used = sentInWindow(ws, deps.clock).count;
      if (used >= settings.dailyCap) break;
      // Announcements may only use the part of the cap above the transactional reserve.
      const maxPriority = used < settings.dailyCap - settings.transactionalReserve ? Number.MAX_SAFE_INTEGER : PRIORITY.transactional;
      const row = pick(maxPriority);
      if (!row) break;
      ws.sqlite.prepare(`UPDATE email_queue SET status = 'sending', not_before = ? WHERE account_id = ? AND id = ?`).run(now(), ws.accountId, row.id);
      try {
        const raw = await buildMime({ fromName: settings.fromName, fromAddress: account.email, to: row.to_address, subject: row.subject, html: row.html, text: row.text });
        const sent = await gmail.send(raw);
        ws.sqlite.transaction(() => {
          ws.sqlite.prepare(`UPDATE email_queue SET status = 'sent', sent_at = ?, gmail_message_id = ?, attempts = attempts + 1, error = NULL WHERE account_id = ? AND id = ?`).run(now(), sent.id, ws.accountId, row.id);
          if (row.member_id) writeAudit(ws, deps.clock, { actor: 'system', action: 'email.sent', entity: 'member', entityId: row.member_id, details: { emailId: row.id, kind: row.kind, subject: row.subject } });
        })();
        result.sent++;
      } catch (err) {
        if (isInvalidGrant(err)) {
          ws.sqlite.prepare(`UPDATE email_queue SET status = 'queued' WHERE account_id = ? AND id = ?`).run(ws.accountId, row.id);
          markGmailDisconnected(ws, deps.clock, 'invalid_grant while sending');
          return { ...result, skipped: 'Gmail was disconnected' };
        }
        const message = err instanceof Error ? err.message : String(err);
        const attempts = row.attempts + 1;
        if (isPermanent(err) || attempts >= MAX_ATTEMPTS) {
          ws.sqlite.prepare(`UPDATE email_queue SET status = 'failed', attempts = ?, error = ? WHERE account_id = ? AND id = ?`).run(attempts, message.slice(0, 500), ws.accountId, row.id);
          result.failed++;
        } else {
          // Exponential backoff: 2, 4, 8 … minutes, at most 6 hours.
          const wait = Math.min(2 ** attempts, 360) * 60_000;
          const notBefore = new Date(deps.clock.now().getTime() + wait).toISOString().replace(/\.\d{3}Z$/, 'Z');
          ws.sqlite.prepare(`UPDATE email_queue SET status = 'queued', attempts = ?, not_before = ?, error = ? WHERE account_id = ? AND id = ?`).run(attempts, notBefore, message.slice(0, 500), ws.accountId, row.id);
          result.retried++;
        }
        deps.log.warn('email send failed', { accountId: ws.accountId, emailId: row.id, attempts, err });
      }
      if (deps.throttleMs !== 0) await sleep(deps.throttleMs ?? 700);
    }
    return result;
  } finally {
    running.delete(ws.accountId);
  }
}

export async function drainAll(ctx: SystemContext, deps: DrainDeps): Promise<Record<string, DrainResult>> {
  const accounts = ctx.sqlite.prepare(`SELECT DISTINCT account_id FROM email_queue WHERE status IN ('queued', 'sending')`).all() as Array<{ account_id: number }>;
  const out: Record<string, DrainResult> = {};
  for (const { account_id: id } of accounts) {
    try {
      const ws = forWorkspace(ctx, id);
      out[`workspace ${id}`] = await drainWorkspace(ws, deps);
      settleAnnouncements(ws);
    } catch (err) {
      deps.log.error('email drain failed', { accountId: id, err });
    }
  }
  return out;
}
