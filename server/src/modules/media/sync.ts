import type { MemberStatus, SyncResult } from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import type { Logger } from '../../core/logger.js';
import { nowIso } from '../../core/time.js';
import { forWorkspace, type SystemContext, type WorkspaceContext } from '../../core/workspace-context.js';
import type { BillingEvents } from '../billing/ledger.js';
import { applyItem, type LinkInput, planSync } from './enforcement.js';
import { type MediaDeps, providerFor, serverRow } from './servers.js';

// The impure side of enforcement (Spec §10.2): loads links, runs the plan, writes the outcome,
// retries failures with backoff, and reacts to billing (payment → grant, expired → revoke).
// Automatic changes happen only on servers with enforcement on AND whose first (dry-run) sync was
// reviewed and applied by the admin.

export type SyncDeps = Pick<MediaDeps, 'clock' | 'media'> & { log?: Logger };

const MAX_BACKOFF_MS = 6 * 3_600_000;

interface LinkRow {
  member_id: number;
  display_name: string;
  status: MemberStatus;
  external_user_id: string;
  external_username: string | null;
  library_ids_override: string | null;
}

function links(ws: WorkspaceContext, serverId: number, memberIds?: number[]): LinkInput[] {
  const rows = ws.sqlite
    .prepare(
      `SELECT l.member_id, m.display_name, m.status, l.external_user_id, l.external_username, l.library_ids_override FROM member_server_accounts l
       JOIN members m ON m.account_id = l.account_id AND m.id = l.member_id WHERE l.account_id = ? AND l.server_id = ? ORDER BY m.display_name COLLATE NOCASE`,
    )
    .all(ws.accountId, serverId) as LinkRow[];
  return rows
    .filter((r) => !memberIds || memberIds.includes(r.member_id))
    .map((r) => ({
      memberId: r.member_id,
      displayName: r.display_name,
      memberStatus: r.status,
      externalUserId: r.external_user_id,
      externalUsername: r.external_username,
      libraryOverride: r.library_ids_override ? (JSON.parse(r.library_ids_override) as string[]) : null,
    }));
}

/**
 * Plans (dry run) or applies the sync of one server. `confirm` is the admin's explicit "apply"
 * that also confirms the first sync; automatic runs pass neither and only apply on confirmed servers.
 */
export async function syncServer(ws: WorkspaceContext, deps: SyncDeps, serverId: number, opts: { dryRun: boolean; confirm?: boolean; memberIds?: number[]; actor?: string }): Promise<SyncResult> {
  const server = serverRow(ws, serverId);
  const actor = opts.actor ?? 'system';
  const result: SyncResult = { serverId, dryRun: true, items: [], changed: 0, failed: 0 };
  const now = nowIso(deps.clock);
  const linkInputs = links(ws, serverId, opts.memberIds);
  if (linkInputs.length === 0) return result;
  let plan;
  try {
    plan = await planSync(providerFor(ws, deps, serverId), linkInputs, JSON.parse(server.default_library_ids) as string[]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ws.sqlite.prepare('UPDATE media_servers SET last_checked_at = ?, last_status = ? WHERE account_id = ? AND id = ?').run(now, `error: ${message}`, ws.accountId, serverId);
    // Server unreachable during a real (automatic or admin) sync: the links that needed work are
    // marked failed with backoff so they are retried and shown, never silently forgotten.
    const applying = !opts.dryRun && server.enabled === 1 && server.enforcement_enabled === 1 && (server.enforcement_confirmed === 1 || opts.confirm === true);
    if (applying) {
      const rows = ws.sqlite
        .prepare(`SELECT member_id, attempts FROM member_server_accounts WHERE account_id = ? AND server_id = ? AND (sync_pending = 1 OR access_state = 'error')`)
        .all(ws.accountId, serverId) as Array<{ member_id: number; attempts: number }>;
      for (const r of rows.filter((x) => !opts.memberIds || opts.memberIds.includes(x.member_id))) {
        const attempts = r.attempts + 1;
        const next = new Date(deps.clock.now().getTime() + Math.min(2 ** attempts * 5 * 60_000, MAX_BACKOFF_MS)).toISOString().replace(/\.\d{3}Z$/, 'Z');
        ws.sqlite
          .prepare(`UPDATE member_server_accounts SET access_state = 'error', last_error = ?, attempts = ?, next_attempt_at = ?, sync_pending = 0 WHERE account_id = ? AND member_id = ? AND server_id = ?`)
          .run(`Server unreachable: ${message}`.slice(0, 500), attempts, next, ws.accountId, r.member_id, serverId);
        result.failed++;
      }
    }
    return { ...result, dryRun: !applying, error: message };
  }
  result.items = plan.items;
  const allowed = server.enabled === 1 && server.enforcement_enabled === 1 && (server.enforcement_confirmed === 1 || opts.confirm === true);
  if (opts.dryRun || !allowed) return result;

  result.dryRun = false;
  if (server.enforcement_confirmed !== 1) {
    ws.sqlite.prepare('UPDATE media_servers SET enforcement_confirmed = 1 WHERE account_id = ? AND id = ?').run(ws.accountId, serverId);
    writeAudit(ws, deps.clock, { actor, action: 'server.enforcement_confirmed', entity: 'server', entityId: serverId });
  }
  const provider = providerFor(ws, deps, serverId);
  const options = JSON.parse(server.options) as { endSessionsOnRevoke?: boolean };
  const update = ws.sqlite.prepare(
    `UPDATE member_server_accounts SET access_state = ?, last_granted_library_ids = COALESCE(?, last_granted_library_ids), last_synced_at = ?, last_error = ?, attempts = ?, next_attempt_at = ?, sync_pending = 0
     WHERE account_id = ? AND member_id = ? AND server_id = ?`,
  );
  for (const item of result.items) {
    const link = ws.sqlite.prepare('SELECT attempts FROM member_server_accounts WHERE account_id = ? AND member_id = ? AND server_id = ?').get(ws.accountId, item.memberId, serverId) as { attempts: number };
    const fail = (message: string) => {
      const attempts = link.attempts + 1;
      const wait = Math.min(2 ** attempts * 5 * 60_000, MAX_BACKOFF_MS);
      update.run('error', null, now, message.slice(0, 500), attempts, new Date(deps.clock.now().getTime() + wait).toISOString().replace(/\.\d{3}Z$/, 'Z'), ws.accountId, item.memberId, serverId);
      writeAudit(ws, deps.clock, { actor, action: 'member.access_failed', entity: 'member', entityId: item.memberId, details: { serverId, server: server.name, action: item.action, wanted: item.desired?.state ?? null, error: message, attempts } });
      item.error = message;
      item.accessState = 'error';
      result.failed++;
    };
    if (item.action === 'skip') {
      if (item.error) fail(item.error);
      continue;
    }
    if (item.action === 'none') {
      update.run(item.current?.state ?? 'unknown', null, now, null, 0, null, ws.accountId, item.memberId, serverId);
      item.accessState = item.current?.state ?? 'unknown';
      continue;
    }
    try {
      await applyItem(provider, item, plan.users.get(item.externalUserId)!, { endSessions: options.endSessionsOnRevoke });
      // On revoke, remember what they had, so a later re-grant can be compared with it (§10.1).
      const remembered = item.action === 'grant' ? item.desired!.libraryIds : (item.current?.libraryIds ?? []);
      update.run(item.action === 'grant' ? 'granted' : 'revoked', JSON.stringify(remembered), now, null, 0, null, ws.accountId, item.memberId, serverId);
      writeAudit(ws, deps.clock, {
        actor,
        action: item.action === 'grant' ? 'member.access_granted' : 'member.access_revoked',
        entity: 'member',
        entityId: item.memberId,
        details: { serverId, server: server.name, libraryIds: item.action === 'grant' ? item.desired!.libraryIds : [], before: item.current },
      });
      item.accessState = item.action === 'grant' ? 'granted' : 'revoked';
      result.changed++;
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      deps.log?.warn('media access change failed', { accountId: ws.accountId, serverId, memberId: item.memberId, action: item.action, err });
    }
  }
  ws.sqlite.prepare('UPDATE media_servers SET last_checked_at = ?, last_status = ? WHERE account_id = ? AND id = ?').run(now, result.failed > 0 ? `error: ${result.failed} change(s) failed` : `ok: ${result.changed} change(s)`, ws.accountId, serverId);
  return result;
}

/** Billing → enforcement: the member's links are marked for a sync, processed right after. */
export function mediaBillingEvents(kick: () => void): BillingEvents {
  const mark = (ws: WorkspaceContext, memberId: number) => {
    ws.sqlite.prepare('UPDATE member_server_accounts SET sync_pending = 1 WHERE account_id = ? AND member_id = ?').run(ws.accountId, memberId);
    kick();
  };
  return {
    paymentApplied: (ws, e) => mark(ws, e.memberId),
    statusChanged: (ws, e) => mark(ws, e.memberId),
  };
}

/** Pending syncs and due retries, for confirmed enforcement servers (every minute + after billing events). */
export async function processPendingSyncs(ctx: SystemContext, deps: SyncDeps): Promise<{ servers: number; changed: number; failed: number }> {
  const now = nowIso(deps.clock);
  const rows = ctx.sqlite
    .prepare(
      `SELECT DISTINCT l.account_id, l.server_id, l.member_id FROM member_server_accounts l JOIN media_servers s ON s.id = l.server_id AND s.account_id = l.account_id
       WHERE s.enabled = 1 AND s.enforcement_enabled = 1 AND s.enforcement_confirmed = 1
         AND (l.sync_pending = 1 OR (l.access_state = 'error' AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= ?)))`,
    )
    .all(now) as Array<{ account_id: number; server_id: number; member_id: number }>;
  const groups = new Map<string, { accountId: number; serverId: number; members: number[] }>();
  for (const r of rows) {
    const key = `${r.account_id}:${r.server_id}`;
    const g = groups.get(key) ?? { accountId: r.account_id, serverId: r.server_id, members: [] };
    g.members.push(r.member_id);
    groups.set(key, g);
  }
  const out = { servers: 0, changed: 0, failed: 0 };
  for (const g of groups.values()) {
    const ws = forWorkspace(ctx, g.accountId);
    const r = await syncServer(ws, deps, g.serverId, { dryRun: false, memberIds: g.members });
    out.servers++;
    out.changed += r.changed;
    out.failed += r.failed;
  }
  // Links on servers without (confirmed) enforcement just forget the pending flag.
  ctx.sqlite
    .prepare(
      `UPDATE member_server_accounts SET sync_pending = 0 WHERE sync_pending = 1 AND server_id IN (SELECT id FROM media_servers WHERE enabled = 0 OR enforcement_enabled = 0 OR enforcement_confirmed = 0)`,
    )
    .run();
  return out;
}

/** Daily reconcile (§10.2, §11): detect and fix drift on every confirmed enforcement server. */
export async function reconcileWorkspace(ws: WorkspaceContext, deps: SyncDeps): Promise<Record<string, unknown>> {
  const servers = ws.sqlite
    .prepare('SELECT id, name FROM media_servers WHERE account_id = ? AND enabled = 1 AND enforcement_enabled = 1 AND enforcement_confirmed = 1')
    .all(ws.accountId) as Array<{ id: number; name: string }>;
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    const r = await syncServer(ws, deps, s.id, { dryRun: false });
    out[s.name] = r.error ? { error: r.error } : { changed: r.changed, failed: r.failed };
  }
  return out;
}

