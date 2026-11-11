import { z } from 'zod';
import { BACKUP_KINDS } from '@subscriberr/shared';
import type { ZipLimits } from '../../core/safe-zip.js';

/** `manifest.json` inside every backup zip (Spec §6.9 layer 2). */
export const backupManifestSchema = z.object({
  app: z.literal('subscriberr'),
  formatVersion: z.literal(1),
  appVersion: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  createdAt: z.string(),
  kind: z.enum(BACKUP_KINDS),
  db: z.object({ file: z.literal('subscriberr.db'), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() }),
  rowCounts: z.record(z.string(), z.number().int().nonnegative()),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export const BACKUP_DB_ENTRY = 'subscriberr.db';
export const BACKUP_MANIFEST_ENTRY = 'manifest.json';
export const BACKUP_WORKSPACES_ENTRY = 'workspaces';

/** Generous guard rails: backups are our own files, but restore must still refuse absurd archives. */
export const BACKUP_ZIP_LIMITS: ZipLimits = {
  maxEntries: 200_000,
  maxTotalBytes: 64 * 1024 ** 3,
  maxEntryBytes: 32 * 1024 ** 3,
};
