import type { MediaServerType } from '@subscriberr/shared';
import type { AccessSnapshot, ExternalLibrary, ExternalUser, MediaServerProvider, Result } from './provider.js';

// In-memory fake Plex / Jellyfin servers for demo mode and tests (Spec §17). No network.

export interface FakeServerSeed {
  users: ExternalUser[];
  /** Invited but not yet accepted (Plex): shown as pending, never linkable (§10.3). */
  pendingInvites?: Array<{ id: string; email: string }>;
  libraries: ExternalLibrary[];
  /** Initial library access per user id. */
  access?: Record<string, string[]>;
}

export interface FakeCall {
  op: 'grant' | 'revoke';
  userId: string;
  libraryIds: string[];
  endSessions?: boolean;
}

export class FakeMediaServer implements MediaServerProvider {
  private readonly users: ExternalUser[];
  private readonly libraries: ExternalLibrary[];
  private readonly access = new Map<string, string[]>();
  readonly pendingInvites: Array<{ id: string; email: string }>;
  /** Every mutating call, in order — lets tests assert idempotency ("call only if it differs"). */
  readonly calls: FakeCall[] = [];
  /** Set to simulate an unreachable server. */
  offline = false;

  constructor(
    readonly type: MediaServerType,
    seed: FakeServerSeed,
  ) {
    this.users = seed.users.map((u) => ({ ...u }));
    this.libraries = seed.libraries.map((l) => ({ ...l }));
    this.pendingInvites = [...(seed.pendingInvites ?? [])];
    for (const [userId, libs] of Object.entries(seed.access ?? {})) this.access.set(userId, [...libs]);
  }

  private assertOnline(): void {
    if (this.offline) throw new Error(`Fake ${this.type} server is offline`);
  }

  private requireUser(user: ExternalUser): ExternalUser {
    const found = this.users.find((u) => u.id === user.id);
    if (!found) throw new Error(`Fake ${this.type}: unknown user ${user.id}`);
    return found;
  }

  async testConnection(): Promise<Result> {
    return this.offline ? { ok: false, error: 'offline' } : { ok: true, detail: `Fake ${this.type} server` };
  }

  async listUsers(): Promise<ExternalUser[]> {
    this.assertOnline();
    return this.users.map((u) => ({ ...u }));
  }

  async listPendingInvites(): Promise<Array<{ id: string; email: string }>> {
    this.assertOnline();
    return this.pendingInvites.map((p) => ({ ...p }));
  }

  async listLibraries(): Promise<ExternalLibrary[]> {
    this.assertOnline();
    return this.libraries.map((l) => ({ ...l }));
  }

  async getAccess(user: ExternalUser): Promise<AccessSnapshot> {
    this.assertOnline();
    const libraryIds = [...(this.access.get(this.requireUser(user).id) ?? [])].sort();
    return { state: libraryIds.length > 0 ? 'granted' : 'revoked', libraryIds };
  }

  async grantAccess(user: ExternalUser, libraryIds: string[]): Promise<void> {
    this.assertOnline();
    const target = this.requireUser(user);
    // The real adapters rely on enforcement.ts never passing an admin; the fake fails loudly so
    // a missing guard is caught by tests.
    if (target.isAdmin) throw new Error(`Fake ${this.type}: refusing to modify admin account ${target.username}`);
    const known = new Set(this.libraries.map((l) => l.id));
    const unknown = libraryIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`Fake ${this.type}: unknown libraries ${unknown.join(', ')}`);
    this.access.set(target.id, [...new Set(libraryIds)]);
    this.calls.push({ op: 'grant', userId: target.id, libraryIds: [...libraryIds] });
  }

  async revokeAccess(user: ExternalUser, opts?: { endSessions?: boolean }): Promise<void> {
    this.assertOnline();
    const target = this.requireUser(user);
    if (target.isAdmin) throw new Error(`Fake ${this.type}: refusing to modify admin account ${target.username}`);
    // Revoke keeps the account/share and empties the library list (§10.3 / §10.4).
    this.access.set(target.id, []);
    this.calls.push({ op: 'revoke', userId: target.id, libraryIds: [], endSessions: opts?.endSessions });
  }
}

/** Demo dataset; user ids match db/seed-demo.ts. */
export function createDemoPlex(): FakeMediaServer {
  return new FakeMediaServer('plex', {
    users: [
      { id: 'plex-1', username: 'demo-owner', email: 'demo@example.com', isAdmin: true },
      { id: 'plex-101', username: 'payer.one', email: 'payer1@example.com', isAdmin: false },
      { id: 'plex-102', username: 'pat', email: 'payer2@example.com', isAdmin: false },
      { id: 'plex-104', username: 'jordan', email: 'jordan@example.com', isAdmin: false },
    ],
    pendingInvites: [{ id: 'plex-invite-9', email: 'not-accepted-yet@example.com' }],
    libraries: [
      { id: '1', name: 'Movies' },
      { id: '2', name: 'TV Shows' },
      { id: '3', name: 'Music' },
    ],
    access: { 'plex-101': ['1', '2'], 'plex-102': ['1', '2'], 'plex-104': ['1', '2', '3'] },
  });
}

export function createDemoJellyfin(): FakeMediaServer {
  return new FakeMediaServer('jellyfin', {
    users: [
      { id: 'jf-1', username: 'admin', isAdmin: true },
      { id: 'jf-101', username: 'payerone', isAdmin: false },
      { id: 'jf-103', username: 'sam', isAdmin: false },
      { id: 'jf-104', username: 'jordan', isAdmin: false },
    ],
    libraries: [
      { id: 'movies', name: 'Movies' },
      { id: 'shows', name: 'Shows' },
      { id: 'kids', name: 'Kids' },
    ],
    access: { 'jf-101': ['movies', 'shows'], 'jf-103': ['movies', 'shows'], 'jf-104': ['movies', 'shows'] },
  });
}
