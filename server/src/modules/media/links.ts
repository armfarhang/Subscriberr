import type { MediaServerType } from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import type { Clock } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import type { MediaProviderFactory } from './factory.js';
import type { ExternalUser } from './provider.js';

// Links between members and existing accounts on a media server (member_server_accounts).
// Creating or replacing a link never changes anything on the server itself: access is only
// granted/revoked by enforcement (M9), whose first reconcile is a dry run (§10.2, §12.3).

export interface ServerRef {
  id: number;
  name: string;
  type: MediaServerType;
  baseUrl: string;
  enabled: boolean;
}

export interface MemberLink {
  serverId: number;
  externalUserId: string;
  externalUsername: string | null;
  externalEmail: string | null;
  accessState: 'granted' | 'revoked' | 'unknown' | 'error';
}

export function listServers(ws: WorkspaceContext): ServerRef[] {
  const rows = ws.sqlite.prepare('SELECT id, name, type, base_url, enabled FROM media_servers WHERE account_id = ? ORDER BY name, id').all(ws.accountId) as Array<{
    id: number;
    name: string;
    type: MediaServerType;
    base_url: string;
    enabled: number;
  }>;
  return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, baseUrl: r.base_url, enabled: r.enabled === 1 }));
}

/** All links of the workspace, keyed by member id. */
export function linksByMember(ws: WorkspaceContext): Map<number, MemberLink[]> {
  const rows = ws.sqlite
    .prepare('SELECT member_id, server_id, external_user_id, external_username, external_email, access_state FROM member_server_accounts WHERE account_id = ?')
    .all(ws.accountId) as Array<{ member_id: number; server_id: number; external_user_id: string; external_username: string | null; external_email: string | null; access_state: MemberLink['accessState'] }>;
  const map = new Map<number, MemberLink[]>();
  for (const r of rows) {
    const link: MemberLink = { serverId: r.server_id, externalUserId: r.external_user_id, externalUsername: r.external_username, externalEmail: r.external_email, accessState: r.access_state };
    map.set(r.member_id, [...(map.get(r.member_id) ?? []), link]);
  }
  return map;
}

/** The text that identifies a linked account in a CSV `server:<name>` column. */
export function linkLabel(link: Pick<MemberLink, 'externalUsername' | 'externalEmail' | 'externalUserId'>): string {
  return link.externalUsername ?? link.externalEmail ?? link.externalUserId;
}

/** Creates or replaces the member's link on one server. Returns the previous link (for undo). */
export function setMemberLink(ws: WorkspaceContext, clock: Clock, actor: string, memberId: number, serverId: number, user: Pick<ExternalUser, 'id' | 'username' | 'email'>, details: Record<string, unknown> = {}): MemberLink | null {
  const previous = getMemberLink(ws, memberId, serverId);
  if (previous) {
    ws.sqlite
      .prepare(
        `UPDATE member_server_accounts SET external_user_id = ?, external_username = ?, external_email = ?, access_state = 'unknown', last_synced_at = NULL, last_error = NULL
         WHERE account_id = ? AND member_id = ? AND server_id = ?`,
      )
      .run(user.id, user.username, user.email ?? null, ws.accountId, memberId, serverId);
  } else {
    ws.sqlite
      .prepare(`INSERT INTO member_server_accounts (account_id, member_id, server_id, external_user_id, external_username, external_email) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(ws.accountId, memberId, serverId, user.id, user.username, user.email ?? null);
  }
  writeAudit(ws, clock, { actor, action: 'member.server_linked', entity: 'member', entityId: memberId, details: { serverId, externalUserId: user.id, username: user.username, ...details } });
  return previous;
}

export function getMemberLink(ws: WorkspaceContext, memberId: number, serverId: number): MemberLink | null {
  const r = ws.sqlite
    .prepare('SELECT server_id, external_user_id, external_username, external_email, access_state FROM member_server_accounts WHERE account_id = ? AND member_id = ? AND server_id = ?')
    .get(ws.accountId, memberId, serverId) as
    | { server_id: number; external_user_id: string; external_username: string | null; external_email: string | null; access_state: MemberLink['accessState'] }
    | undefined;
  return r ? { serverId: r.server_id, externalUserId: r.external_user_id, externalUsername: r.external_username, externalEmail: r.external_email, accessState: r.access_state } : null;
}

/** Undo helper: puts a link back exactly as it was (or removes it when there was none). */
export function restoreMemberLink(ws: WorkspaceContext, clock: Clock, actor: string, memberId: number, serverId: number, previous: MemberLink | null, details: Record<string, unknown> = {}): void {
  if (previous) {
    ws.sqlite
      .prepare(
        `UPDATE member_server_accounts SET external_user_id = ?, external_username = ?, external_email = ?, access_state = ?
         WHERE account_id = ? AND member_id = ? AND server_id = ?`,
      )
      .run(previous.externalUserId, previous.externalUsername, previous.externalEmail, previous.accessState, ws.accountId, memberId, serverId);
  } else {
    ws.sqlite.prepare('DELETE FROM member_server_accounts WHERE account_id = ? AND member_id = ? AND server_id = ?').run(ws.accountId, memberId, serverId);
  }
  writeAudit(ws, clock, { actor, action: 'member.server_link_restored', entity: 'member', entityId: memberId, details: { serverId, ...details } });
}

/** Linkable users per server, cached briefly so a review session does not hammer the servers. */
export class ServerUserDirectory {
  private readonly cache = new Map<number, { at: number; users: ExternalUser[] | null; error: string | null }>();
  constructor(
    private readonly factory: MediaProviderFactory | undefined,
    private readonly clock: Clock,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  /** Users of a server, or an error message when the server cannot be asked. */
  async users(server: ServerRef): Promise<{ users: ExternalUser[] | null; error: string | null }> {
    const now = this.clock.now().getTime();
    const hit = this.cache.get(server.id);
    if (hit && now - hit.at < this.ttlMs) return hit;
    let entry: { at: number; users: ExternalUser[] | null; error: string | null };
    if (!this.factory) entry = { at: now, users: null, error: 'Media servers are not available' };
    else {
      try {
        entry = { at: now, users: await this.factory({ id: server.id, type: server.type, baseUrl: server.baseUrl }).listUsers(), error: null };
      } catch (err) {
        entry = { at: now, users: null, error: err instanceof Error ? err.message : String(err) };
      }
    }
    this.cache.set(server.id, entry);
    return entry;
  }
}
