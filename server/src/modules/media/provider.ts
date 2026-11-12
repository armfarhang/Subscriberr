// The provider interface (Spec §10.1). enforcement.ts will depend ONLY on this file; Plex- and
// Jellyfin-specific behaviour stays in their own files. A future Silo = one more file here.

export type Result = { ok: true; detail?: string } | { ok: false; error: string };

export interface ExternalUser {
  id: string;
  username: string;
  email?: string | null;
  /** The server's own admin/owner account — never modified by enforcement (hard guard). */
  isAdmin: boolean;
}

/** An invitation that was not accepted yet (Plex): shown as pending, never linkable (§10.3). */
export interface PendingInvite {
  id: string;
  email: string;
}

export interface ExternalLibrary {
  id: string;
  name: string;
}

export interface AccessSnapshot {
  state: 'granted' | 'revoked';
  libraryIds: string[];
}

export interface MediaServerProvider {
  testConnection(): Promise<Result>;
  /** Only linkable (accepted/active) users. */
  listUsers(): Promise<ExternalUser[]>;
  /** Plex only: invitations that were not accepted yet. */
  listPendingInvites?(): Promise<PendingInvite[]>;
  listLibraries(): Promise<ExternalLibrary[]>;
  getAccess(user: ExternalUser): Promise<AccessSnapshot>;
  grantAccess(user: ExternalUser, libraryIds: string[]): Promise<void>;
  revokeAccess(user: ExternalUser, opts?: { endSessions?: boolean }): Promise<void>;
}
