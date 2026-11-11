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
  listLibraries(): Promise<ExternalLibrary[]>;
  getAccess(user: ExternalUser): Promise<AccessSnapshot>;
  grantAccess(user: ExternalUser, libraryIds: string[]): Promise<void>;
  revokeAccess(user: ExternalUser, opts?: { endSessions?: boolean }): Promise<void>;
}
