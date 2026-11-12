import type { AccessSnapshot, ExternalLibrary, ExternalUser, MediaServerProvider, Result } from './provider.js';

// Jellyfin (Spec §10.4) with an API key. Grant = policy `EnableAllFolders: false` +
// `EnabledFolders: [ids]` (and re-enable a user this app disabled); revoke = `EnabledFolders: []`,
// optionally `IsDisabled: true` (per-server option, off by default) and optionally stopping the
// user's active sessions. The full policy object is sent back with only those fields changed.

export interface JellyfinOptions {
  disableOnRevoke?: boolean;
  endSessionsOnRevoke?: boolean;
}

interface JfPolicy {
  IsAdministrator?: boolean;
  IsDisabled?: boolean;
  EnableAllFolders?: boolean;
  EnabledFolders?: string[];
  [key: string]: unknown;
}

interface JfUser {
  Id: string;
  Name: string;
  Policy?: JfPolicy;
}

export class JellyfinProvider implements MediaServerProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly options: JellyfinOptions = {},
    private readonly http: typeof fetch = fetch,
  ) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.http(this.url(path), {
      method: init.method ?? 'GET',
      headers: { 'X-Emby-Token': this.apiKey, Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw Object.assign(new Error(`Jellyfin ${res.status} for ${path}`), { status: res.status });
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async testConnection(): Promise<Result> {
    try {
      const info = await this.call<{ ServerName?: string; Version?: string }>('/System/Info');
      return { ok: true, detail: `Jellyfin ${info.Version ?? ''} “${info.ServerName ?? ''}”`.trim() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listUsers(): Promise<ExternalUser[]> {
    const users = await this.call<JfUser[]>('/Users');
    return users.map((u) => ({ id: u.Id, username: u.Name, email: null, isAdmin: Boolean(u.Policy?.IsAdministrator) }));
  }

  async listLibraries(): Promise<ExternalLibrary[]> {
    const folders = await this.call<Array<{ Name: string; ItemId: string }>>('/Library/VirtualFolders');
    return folders.map((f) => ({ id: f.ItemId, name: f.Name }));
  }

  private async user(id: string): Promise<JfUser> {
    return this.call<JfUser>(`/Users/${encodeURIComponent(id)}`);
  }

  async getAccess(user: ExternalUser): Promise<AccessSnapshot> {
    const u = await this.user(user.id);
    const p = u.Policy ?? {};
    if (p.IsDisabled) return { state: 'revoked', libraryIds: [] };
    if (p.EnableAllFolders) return { state: 'granted', libraryIds: (await this.listLibraries()).map((l) => l.id).sort() };
    const ids = [...(p.EnabledFolders ?? [])].sort();
    return { state: ids.length > 0 ? 'granted' : 'revoked', libraryIds: ids };
  }

  private async setPolicy(user: ExternalUser, change: (p: JfPolicy) => JfPolicy): Promise<void> {
    const u = await this.user(user.id);
    // Hard guard: never modify an administrator, whatever the caller says.
    if (user.isAdmin || u.Policy?.IsAdministrator) throw new Error('Refusing to modify a Jellyfin administrator');
    await this.call(`/Users/${encodeURIComponent(user.id)}/Policy`, { method: 'POST', body: change({ ...(u.Policy ?? {}) }) });
  }

  async grantAccess(user: ExternalUser, libraryIds: string[]): Promise<void> {
    if (libraryIds.length === 0) throw new Error('Granting needs at least one library');
    await this.setPolicy(user, (p) => ({ ...p, EnableAllFolders: false, EnabledFolders: libraryIds, IsDisabled: false }));
  }

  async revokeAccess(user: ExternalUser, opts: { endSessions?: boolean } = {}): Promise<void> {
    await this.setPolicy(user, (p) => ({ ...p, EnableAllFolders: false, EnabledFolders: [], ...(this.options.disableOnRevoke ? { IsDisabled: true } : {}) }));
    if (opts.endSessions ?? this.options.endSessionsOnRevoke) {
      const sessions = await this.call<Array<{ Id: string; UserId?: string }>>('/Sessions');
      for (const s of sessions.filter((x) => x.UserId === user.id)) await this.call(`/Sessions/${encodeURIComponent(s.Id)}/Playing/Stop`, { method: 'POST' });
    }
  }
}
