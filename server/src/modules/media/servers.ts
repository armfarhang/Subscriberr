import {
  type CreateServer,
  createServerSchema,
  type LinkMember,
  linkMemberSchema,
  type ServerOptions,
  serverOptionsSchema,
  type ServerUsersView,
  type ServerView,
  type UpdateServer,
  updateServerSchema,
} from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import type { SecretBox } from '../../core/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../../core/errors.js';
import { type Clock, nowIso } from '../../core/time.js';
import type { SystemContext, WorkspaceContext } from '../../core/workspace-context.js';
import type { MediaProviderFactory, ServerSecrets } from './factory.js';
import { getMemberLink, setMemberLink } from './links.js';
import type { MediaServerProvider } from './provider.js';

// Media servers of a workspace (Spec §6.3, §10): credentials encrypted and write-only, users and
// libraries read live from the server, members linked to existing server accounts.

export interface MediaDeps {
  clock: Clock;
  secretBox: SecretBox;
  media: MediaProviderFactory;
}

interface ServerRow {
  id: number;
  type: ServerView['type'];
  name: string;
  base_url: string;
  credentials_enc: string | null;
  enforcement_enabled: number;
  enforcement_confirmed: number;
  default_library_ids: string;
  enabled: number;
  last_checked_at: string | null;
  last_status: string | null;
  options: string;
}

const optionsOf = (r: ServerRow): ServerOptions => serverOptionsSchema.catch({ disableOnRevoke: false, endSessionsOnRevoke: false }).parse(JSON.parse(r.options));

export function serverRow(ws: WorkspaceContext, id: number): ServerRow {
  const r = ws.sqlite.prepare('SELECT * FROM media_servers WHERE account_id = ? AND id = ?').get(ws.accountId, id) as ServerRow | undefined;
  if (!r) throw notFound('Server not found');
  return r;
}

/** Decrypted secrets for the provider factory; looked up by server id across workspaces (ids are global). */
export function credentialsResolver(ctx: SystemContext, secretBox: SecretBox) {
  return (serverId: number): ServerSecrets | null => {
    const r = ctx.sqlite.prepare('SELECT credentials_enc, options FROM media_servers WHERE id = ?').get(serverId) as { credentials_enc: string | null; options: string } | undefined;
    if (!r?.credentials_enc) return null;
    const secret = JSON.parse(secretBox.decrypt(r.credentials_enc)) as { token: string; machineId?: string | null };
    return { ...secret, options: JSON.parse(r.options) as ServerSecrets['options'] };
  };
}

export function providerFor(ws: WorkspaceContext, deps: Pick<MediaDeps, 'media'>, serverId: number): MediaServerProvider {
  const r = serverRow(ws, serverId);
  return deps.media({ id: r.id, type: r.type, baseUrl: r.base_url });
}

function toView(ws: WorkspaceContext, r: ServerRow): ServerView {
  const linked = (ws.sqlite.prepare('SELECT count(*) AS n FROM member_server_accounts WHERE account_id = ? AND server_id = ?').get(ws.accountId, r.id) as { n: number }).n;
  const failing = ws.sqlite
    .prepare(
      `SELECT l.member_id, m.display_name, l.last_error, m.status FROM member_server_accounts l JOIN members m ON m.account_id = l.account_id AND m.id = l.member_id
       WHERE l.account_id = ? AND l.server_id = ? AND l.access_state = 'error' ORDER BY m.display_name`,
    )
    .all(ws.accountId, r.id) as Array<{ member_id: number; display_name: string; last_error: string | null; status: string }>;
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    baseUrl: r.base_url,
    enabled: r.enabled === 1,
    enforcementEnabled: r.enforcement_enabled === 1,
    enforcementConfirmed: r.enforcement_confirmed === 1,
    defaultLibraryIds: JSON.parse(r.default_library_ids) as string[],
    options: optionsOf(r),
    hasCredentials: Boolean(r.credentials_enc) || r.base_url.startsWith('fake://'),
    lastCheckedAt: r.last_checked_at,
    lastStatus: r.last_status,
    linked,
    failing: failing.map((f) => ({ memberId: f.member_id, displayName: f.display_name, error: f.last_error ?? 'failed', pendingRevoke: f.status === 'expired' || f.status === 'archived' })),
  };
}

export function listServerViews(ws: WorkspaceContext): ServerView[] {
  const rows = ws.sqlite.prepare('SELECT * FROM media_servers WHERE account_id = ? ORDER BY name, id').all(ws.accountId) as ServerRow[];
  return rows.map((r) => toView(ws, r));
}

export function getServerView(ws: WorkspaceContext, id: number): ServerView {
  return toView(ws, serverRow(ws, id));
}

export function createServer(ws: WorkspaceContext, deps: MediaDeps, actor: string, input: CreateServer): ServerView {
  const s = createServerSchema.parse(input);
  if (ws.sqlite.prepare('SELECT 1 FROM media_servers WHERE account_id = ? AND name = ?').get(ws.accountId, s.name)) throw conflict(`A server named “${s.name}” already exists.`);
  const id = ws.sqlite.transaction(() => {
    const newId = Number(
      ws.sqlite
        .prepare(`INSERT INTO media_servers (account_id, type, name, base_url, credentials_enc, options, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(ws.accountId, s.type, s.name, s.baseUrl, deps.secretBox.encrypt(JSON.stringify({ token: s.token })), JSON.stringify(s.options), nowIso(deps.clock)).lastInsertRowid,
    );
    writeAudit(ws, deps.clock, { actor, action: 'server.created', entity: 'server', entityId: newId, details: { type: s.type, name: s.name, baseUrl: s.baseUrl } });
    return newId;
  })();
  return getServerView(ws, id);
}

export function updateServer(ws: WorkspaceContext, deps: MediaDeps, actor: string, id: number, input: UpdateServer): ServerView {
  const u = updateServerSchema.parse(input);
  const r = serverRow(ws, id);
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (u.name !== undefined) set('name', u.name);
  if (u.baseUrl !== undefined) set('base_url', u.baseUrl);
  if (u.enabled !== undefined) set('enabled', u.enabled ? 1 : 0);
  if (u.options !== undefined) set('options', JSON.stringify(u.options));
  if (u.defaultLibraryIds !== undefined) set('default_library_ids', JSON.stringify([...new Set(u.defaultLibraryIds)]));
  // A new token or address means a new machine id must be learned again (Plex).
  if (u.token !== undefined) set('credentials_enc', deps.secretBox.encrypt(JSON.stringify({ token: u.token })));
  else if (u.baseUrl !== undefined && u.baseUrl !== r.base_url && r.credentials_enc) {
    const old = JSON.parse(deps.secretBox.decrypt(r.credentials_enc)) as { token: string };
    set('credentials_enc', deps.secretBox.encrypt(JSON.stringify({ token: old.token })));
  }
  if (sets.length === 0) return getServerView(ws, id);
  ws.sqlite.transaction(() => {
    ws.sqlite.prepare(`UPDATE media_servers SET ${sets.join(', ')} WHERE account_id = ? AND id = ?`).run(...args, ws.accountId, id);
    writeAudit(ws, deps.clock, { actor, action: 'server.updated', entity: 'server', entityId: id, details: { fields: Object.keys(u).filter((k) => k !== 'token').concat(u.token ? ['token (changed)'] : []) } });
  })();
  return getServerView(ws, id);
}

export function deleteServer(ws: WorkspaceContext, deps: MediaDeps, actor: string, id: number): void {
  const r = serverRow(ws, id);
  ws.sqlite.transaction(() => {
    // Links go with the server (nothing is changed on the server itself).
    ws.sqlite.prepare('DELETE FROM media_servers WHERE account_id = ? AND id = ?').run(ws.accountId, id);
    writeAudit(ws, deps.clock, { actor, action: 'server.deleted', entity: 'server', entityId: id, details: { name: r.name } });
  })();
}

/** "Test connection": also remembers Plex's machine identifier. */
export async function testServer(ws: WorkspaceContext, deps: MediaDeps, id: number): Promise<{ ok: boolean; detail: string }> {
  const r = serverRow(ws, id);
  let ok = false;
  let detail: string;
  try {
    const provider = providerFor(ws, deps, id);
    const result = await provider.testConnection();
    ok = result.ok;
    detail = result.ok ? (result.detail ?? 'Connected') : result.error;
    const mid = ok && 'serverMachineId' in provider ? await (provider as { serverMachineId(): Promise<string> }).serverMachineId() : null;
    if (mid && r.credentials_enc) {
      const secret = JSON.parse(deps.secretBox.decrypt(r.credentials_enc)) as { token: string; machineId?: string };
      if (secret.machineId !== mid) ws.sqlite.prepare('UPDATE media_servers SET credentials_enc = ? WHERE account_id = ? AND id = ?').run(deps.secretBox.encrypt(JSON.stringify({ ...secret, machineId: mid })), ws.accountId, id);
    }
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }
  ws.sqlite.prepare('UPDATE media_servers SET last_checked_at = ?, last_status = ? WHERE account_id = ? AND id = ?').run(nowIso(deps.clock), ok ? `ok: ${detail}` : `error: ${detail}`, ws.accountId, id);
  return { ok, detail };
}

async function live<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new AppError(503, 'server_unreachable', `The server could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function serverUsers(ws: WorkspaceContext, deps: MediaDeps, id: number): Promise<ServerUsersView> {
  const provider = providerFor(ws, deps, id);
  const [users, pending] = await live(() => Promise.all([provider.listUsers(), provider.listPendingInvites ? provider.listPendingInvites() : Promise.resolve([])]));
  const links = ws.sqlite
    .prepare('SELECT l.external_user_id, m.id, m.display_name FROM member_server_accounts l JOIN members m ON m.account_id = l.account_id AND m.id = l.member_id WHERE l.account_id = ? AND l.server_id = ?')
    .all(ws.accountId, id) as Array<{ external_user_id: string; id: number; display_name: string }>;
  return {
    users: users.map((u) => {
      const l = links.find((x) => x.external_user_id === u.id);
      return { id: u.id, username: u.username, email: u.email ?? null, isAdmin: u.isAdmin, linkedMember: l ? { id: l.id, displayName: l.display_name } : null };
    }),
    pendingInvites: pending,
  };
}

export async function serverLibraries(ws: WorkspaceContext, deps: MediaDeps, id: number) {
  const provider = providerFor(ws, deps, id);
  return live(() => provider.listLibraries());
}

/** Links a member to an existing, accepted, non-admin account on the server (§10.1). */
export async function linkMember(ws: WorkspaceContext, deps: MediaDeps, actor: string, memberId: number, input: LinkMember): Promise<void> {
  const l = linkMemberSchema.parse(input);
  serverRow(ws, l.serverId);
  if (!ws.sqlite.prepare('SELECT 1 FROM members WHERE account_id = ? AND id = ?').get(ws.accountId, memberId)) throw notFound('Member not found');
  const users = await live(() => providerFor(ws, deps, l.serverId).listUsers());
  const user = users.find((u) => u.id === l.externalUserId);
  if (!user) throw badRequest('That account is not a linkable user on this server (for Plex: the invitation must be accepted first).');
  if (user.isAdmin) throw badRequest('The server’s admin/owner account can never be linked to a member.');
  const taken = ws.sqlite
    .prepare(`SELECT m.display_name FROM member_server_accounts l JOIN members m ON m.account_id = l.account_id AND m.id = l.member_id WHERE l.account_id = ? AND l.server_id = ? AND l.external_user_id = ? AND l.member_id <> ?`)
    .get(ws.accountId, l.serverId, user.id, memberId) as { display_name: string } | undefined;
  if (taken) throw conflict(`${user.username} is already linked to ${taken.display_name}.`);
  ws.sqlite.transaction(() => {
    setMemberLink(ws, deps.clock, actor, memberId, l.serverId, { id: user.id, username: user.username, email: user.email ?? null });
    ws.sqlite.prepare('UPDATE member_server_accounts SET library_ids_override = ?, sync_pending = 1 WHERE account_id = ? AND member_id = ? AND server_id = ?').run(l.libraryIds ? JSON.stringify(l.libraryIds) : null, ws.accountId, memberId, l.serverId);
  })();
}

export function setLinkLibraries(ws: WorkspaceContext, clock: Clock, actor: string, memberId: number, serverId: number, libraryIds: string[] | null): void {
  if (!getMemberLink(ws, memberId, serverId)) throw notFound('This member is not linked to that server');
  ws.sqlite.transaction(() => {
    ws.sqlite.prepare('UPDATE member_server_accounts SET library_ids_override = ?, sync_pending = 1 WHERE account_id = ? AND member_id = ? AND server_id = ?').run(libraryIds ? JSON.stringify([...new Set(libraryIds)]) : null, ws.accountId, memberId, serverId);
    writeAudit(ws, clock, { actor, action: 'member.libraries_changed', entity: 'member', entityId: memberId, details: { serverId, libraryIds } });
  })();
}

/** Unlinking only forgets the link; nothing changes on the server. */
export function unlinkMember(ws: WorkspaceContext, clock: Clock, actor: string, memberId: number, serverId: number): void {
  const link = getMemberLink(ws, memberId, serverId);
  if (!link) throw notFound('This member is not linked to that server');
  ws.sqlite.transaction(() => {
    ws.sqlite.prepare('DELETE FROM member_server_accounts WHERE account_id = ? AND member_id = ? AND server_id = ?').run(ws.accountId, memberId, serverId);
    writeAudit(ws, clock, { actor, action: 'member.server_unlinked', entity: 'member', entityId: memberId, details: { serverId, username: link.externalUsername } });
  })();
}
