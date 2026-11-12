import { z } from 'zod';
import { ACCOUNT_ROLES, BACKUP_KINDS, BACKUP_TIERS, GMAIL_STATUSES } from '../enums.js';

/** Error envelope used by every API response that fails (Spec §14). */
export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  schemaVersion: z.number().int(),
  time: z.string(),
});
export type Health = z.infer<typeof healthSchema>;

/** Unauthenticated bootstrap info for the sign-in page. */
export const publicConfigSchema = z.object({
  appName: z.string(),
  version: z.string(),
  devFakeLogin: z.boolean(),
  demoMode: z.boolean(),
  /** "Sign in with Google" is available (real Google, or the local fake Google in demo mode). */
  googleSignIn: z.boolean(),
});
export type PublicConfig = z.infer<typeof publicConfigSchema>;

export const meSchema = z.object({
  id: z.number().int(),
  email: z.string(),
  role: z.enum(ACCOUNT_ROLES),
  gmailStatus: z.enum(GMAIL_STATUSES),
  timezone: z.string(),
  /** False until this workspace has finished the first-run wizard. */
  onboardingCompleted: z.boolean(),
});
export type Me = z.infer<typeof meSchema>;

export const devLoginRequestSchema = z.object({ email: z.email().optional() });
export type DevLoginRequest = z.infer<typeof devLoginRequestSchema>;

export const backupRunSchema = z.object({
  id: z.number().int(),
  kind: z.enum(BACKUP_KINDS),
  tier: z.enum(BACKUP_TIERS),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  file: z.string().nullable(),
  bytes: z.number().int().nullable(),
  schemaVersion: z.number().int().nullable(),
  verified: z.boolean(),
  verifiedAt: z.string().nullable(),
  prunedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type BackupRun = z.infer<typeof backupRunSchema>;

export const backupDestinationSchema = z.object({
  ok: z.boolean(),
  path: z.string(),
  exists: z.boolean(),
  writable: z.boolean(),
  sameFilesystemAsData: z.boolean(),
  freeBytes: z.number().nullable(),
  problems: z.array(z.string()),
});
export type BackupDestination = z.infer<typeof backupDestinationSchema>;

export const systemStatusSchema = z.object({
  version: z.string(),
  schemaVersion: z.number().int(),
  demoMode: z.boolean(),
  lastBackupOkAt: z.string().nullable(),
  backupStale: z.boolean(),
  backupDestination: backupDestinationSchema,
  /** Latest nightly integrity + ledger verification (§6.9 layer 1); null before the first run. */
  integrity: z.object({ ok: z.boolean(), checkedAt: z.string(), problems: z.array(z.string()) }).nullable(),
});
export type SystemStatus = z.infer<typeof systemStatusSchema>;

export const backupRetentionSchema = z.object({
  daily: z.number().int().min(1).max(60),
  weekly: z.number().int().min(0).max(60),
  monthly: z.number().int().min(0).max(120),
});
export type BackupRetention = z.infer<typeof backupRetentionSchema>;

export const DEFAULT_BACKUP_RETENTION: BackupRetention = { daily: 2, weekly: 4, monthly: 6 };
