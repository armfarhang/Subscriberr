import { z } from 'zod';
import { MEDIA_SERVER_TYPES, type AccessState, type MediaServerType, type MemberStatus } from '../enums.js';

// Media servers and enforced access (Spec §10).

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Use an http:// or https:// address')
  .transform((u) => u.replace(/\/+$/, ''));

export const serverOptionsSchema = z
  .object({
    /** Jellyfin: also disable the user on revoke (default off, §10.4). */
    disableOnRevoke: z.boolean().default(false),
    /** Stop active streams when access is revoked (Jellyfin). */
    endSessionsOnRevoke: z.boolean().default(false),
  })
  .strict();
export type ServerOptions = z.infer<typeof serverOptionsSchema>;

export const createServerSchema = z
  .object({
    type: z.enum(MEDIA_SERVER_TYPES),
    name: z.string().trim().min(1).max(60),
    baseUrl: httpUrl,
    /** Plex admin token or Jellyfin API key; write-only (never returned). */
    token: z.string().trim().min(8, 'Paste the token / API key').max(500),
    options: serverOptionsSchema.default({ disableOnRevoke: false, endSessionsOnRevoke: false }),
  })
  .strict();
export type CreateServer = z.input<typeof createServerSchema>;

export const updateServerSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    baseUrl: httpUrl,
    token: z.string().trim().min(8).max(500),
    enabled: z.boolean(),
    options: serverOptionsSchema,
    defaultLibraryIds: z.array(z.string().min(1).max(100)).max(200),
  })
  .partial()
  .strict();
export type UpdateServer = z.input<typeof updateServerSchema>;

export interface ServerView {
  id: number;
  type: MediaServerType;
  name: string;
  baseUrl: string;
  enabled: boolean;
  enforcementEnabled: boolean;
  /** False until the first (dry-run) sync was reviewed and applied (§10.2). */
  enforcementConfirmed: boolean;
  defaultLibraryIds: string[];
  options: ServerOptions;
  hasCredentials: boolean;
  lastCheckedAt: string | null;
  lastStatus: string | null;
  linked: number;
  /** Links whose last action failed (a failed revoke is the important one). */
  failing: Array<{ memberId: number; displayName: string; error: string; pendingRevoke: boolean }>;
}

export interface ServerUserView {
  id: string;
  username: string;
  email: string | null;
  isAdmin: boolean;
  linkedMember: { id: number; displayName: string } | null;
}

export interface ServerUsersView {
  users: ServerUserView[];
  pendingInvites: Array<{ id: string; email: string }>;
}

export const linkMemberSchema = z
  .object({
    serverId: z.number().int().positive(),
    externalUserId: z.string().min(1).max(200),
    /** null = use the server's default libraries. */
    libraryIds: z.array(z.string().min(1).max(100)).max(200).nullable().default(null),
  })
  .strict();
export type LinkMember = z.input<typeof linkMemberSchema>;

export const linkLibrariesSchema = z.object({ libraryIds: z.array(z.string().min(1).max(100)).max(200).nullable() }).strict();

export type SyncAction = 'grant' | 'revoke' | 'none' | 'skip';

export interface SyncPlanItem {
  memberId: number;
  displayName: string;
  memberStatus: MemberStatus;
  externalUserId: string;
  externalUsername: string | null;
  current: { state: 'granted' | 'revoked'; libraryIds: string[] } | null;
  desired: { state: 'granted' | 'revoked'; libraryIds: string[] } | null;
  action: SyncAction;
  reason: string;
  /** Set after applying when the server call failed. */
  error?: string;
  accessState?: AccessState;
}

export interface SyncResult {
  serverId: number;
  dryRun: boolean;
  items: SyncPlanItem[];
  changed: number;
  failed: number;
  error?: string;
}
