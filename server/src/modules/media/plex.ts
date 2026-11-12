import type { AccessSnapshot, ExternalLibrary, ExternalUser, MediaServerProvider, PendingInvite, Result } from './provider.js';
import { xmlElements } from './xml.js';

// Plex (Spec §10.3, D14), through plex.tv with the admin token and the server's machine id.
// Plex's sharing API is unofficial; every endpoint here is an ASSUMPTION to be verified by the
// owner against a real server (docs/OWNER_CHECKLIST.md). Requests go through an injectable
// `fetch` so tests use recorded/mocked responses and never contact plex.tv.
//
// - Linkable users = accepted shares of THIS server (`shared_servers` with accepted="1").
//   Pending invitations are listed separately and are not linkable. The token's own account is
//   the server admin and is never modified.
// - Library ids are plex.tv "Section id" values (not the local library keys).
// - Grant sets the share's `library_section_ids`; revoke keeps the share with an EMPTY list
//   (no re-invite needed). If Plex refuses an empty list, the error is surfaced, never worked
//   around silently.

export interface PlexCredentials {
  token: string;
  machineId?: string | null;
}

export const PLEX_TV = 'https://plex.tv';

export class PlexProvider implements MediaServerProvider {
  private machineId: string | null;
  constructor(
    private readonly baseUrl: string,
    private readonly creds: PlexCredentials,
    private readonly http: typeof fetch = fetch,
    private readonly plexTv = PLEX_TV,
  ) {
    this.machineId = creds.machineId ?? null;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'X-Plex-Token': this.creds.token,
      'X-Plex-Client-Identifier': 'subscriberr',
      'X-Plex-Product': 'Subscriberr',
      Accept: 'application/xml',
      ...extra,
    };
  }

  private async get(url: string, accept = 'application/xml'): Promise<string> {
    const res = await this.http(url, { headers: this.headers({ Accept: accept }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw Object.assign(new Error(`Plex ${res.status} for ${new URL(url).pathname}`), { status: res.status });
    return res.text();
  }

  async serverMachineId(): Promise<string> {
    if (this.machineId) return this.machineId;
    const xml = await this.get(`${this.baseUrl.replace(/\/$/, '')}/identity`);
    const id = xmlElements(xml, 'MediaContainer')[0]?.attrs.machineIdentifier;
    if (!id) throw new Error('The Plex server did not report its machine identifier');
    this.machineId = id;
    return id;
  }

  private async owner(): Promise<ExternalUser> {
    const json = JSON.parse(await this.get(`${this.plexTv}/api/v2/user`, 'application/json')) as { id: number; username?: string; title?: string; email?: string };
    return { id: String(json.id), username: json.username ?? json.title ?? 'owner', email: json.email ?? null, isAdmin: true };
  }

  private async shares() {
    const mid = await this.serverMachineId();
    const xml = await this.get(`${this.plexTv}/api/servers/${encodeURIComponent(mid)}/shared_servers`);
    return xmlElements(xml, 'SharedServer').map((s) => ({
      shareId: s.attrs.id ?? '',
      userId: s.attrs.userID ?? '',
      username: s.attrs.username || s.attrs.email || s.attrs.userID || '',
      email: s.attrs.email || null,
      accepted: s.attrs.accepted === '1' || s.attrs.accepted === 'true' || Boolean(s.attrs.acceptedAt && s.attrs.acceptedAt !== '0'),
      sections: xmlElements(s.inner, 'Section')
        .filter((x) => x.attrs.shared === '1' || x.attrs.shared === 'true')
        .map((x) => x.attrs.id ?? '')
        .filter(Boolean),
    }));
  }

  async testConnection(): Promise<Result> {
    try {
      const mid = await this.serverMachineId();
      const owner = await this.owner();
      return { ok: true, detail: `Plex server ${mid.slice(0, 8)}…, signed in as ${owner.username}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listUsers(): Promise<ExternalUser[]> {
    const [owner, shares] = await Promise.all([this.owner(), this.shares()]);
    return [owner, ...shares.filter((s) => s.accepted && s.userId && s.userId !== '0').map((s) => ({ id: s.userId, username: s.username, email: s.email, isAdmin: s.userId === owner.id }))];
  }

  async listPendingInvites(): Promise<PendingInvite[]> {
    return (await this.shares()).filter((s) => !s.accepted).map((s) => ({ id: s.userId && s.userId !== '0' ? s.userId : s.shareId, email: s.email ?? s.username }));
  }

  async listLibraries(): Promise<ExternalLibrary[]> {
    const mid = await this.serverMachineId();
    const xml = await this.get(`${this.plexTv}/api/servers/${encodeURIComponent(mid)}`);
    return xmlElements(xml, 'Section').map((s) => ({ id: s.attrs.id ?? '', name: s.attrs.title ?? s.attrs.key ?? '' })).filter((l) => l.id);
  }

  private async share(user: ExternalUser) {
    const share = (await this.shares()).find((s) => s.userId === user.id && s.accepted);
    if (!share) throw new Error(`Plex user ${user.username} has no accepted share on this server`);
    return share;
  }

  async getAccess(user: ExternalUser): Promise<AccessSnapshot> {
    const s = await this.share(user);
    return { state: s.sections.length > 0 ? 'granted' : 'revoked', libraryIds: [...s.sections].sort() };
  }

  private async setSections(user: ExternalUser, libraryIds: string[]): Promise<void> {
    if (user.isAdmin) throw new Error('Refusing to modify the Plex server owner');
    const share = await this.share(user);
    const mid = await this.serverMachineId();
    const res = await this.http(`${this.plexTv}/api/servers/${encodeURIComponent(mid)}/shared_servers/${encodeURIComponent(share.shareId)}`, {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ server_id: mid, shared_server: { library_section_ids: libraryIds.map((id) => Number(id)) } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw Object.assign(new Error(`Plex refused the library change (${res.status})`), { status: res.status });
  }

  async grantAccess(user: ExternalUser, libraryIds: string[]): Promise<void> {
    if (libraryIds.length === 0) throw new Error('Granting needs at least one library');
    await this.setSections(user, libraryIds);
  }

  async revokeAccess(user: ExternalUser): Promise<void> {
    // Keeps the share (no re-invite needed) and empties its library list (§10.3).
    await this.setSections(user, []);
  }
}
