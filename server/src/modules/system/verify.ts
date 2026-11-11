import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractZipSafely, type ZipLimits } from '../../core/safe-zip.js';
import { inspectDatabaseFile, sha256File } from '../../db/snapshot.js';
import { BACKUP_DB_ENTRY, BACKUP_MANIFEST_ENTRY, BACKUP_ZIP_LIMITS, type BackupManifest, backupManifestSchema } from './manifest.js';

export interface VerifyResult {
  ok: boolean;
  error: string | null;
  manifest: BackupManifest | null;
}

export interface ExtractedBackup {
  dir: string;
  manifest: BackupManifest;
  cleanup(): void;
}

function scratchDir(parent?: string): string {
  return mkdtempSync(path.join(parent ?? os.tmpdir(), 'subscriberr-verify-'));
}

/**
 * Extracts a backup into a scratch directory and runs every check of §6.9 layer 2:
 * safe unzip, manifest shape, sha256 of the DB, `PRAGMA integrity_check`, row counts.
 * On success the caller owns the scratch directory (call `cleanup()`); on failure it is removed.
 */
export async function extractAndVerifyBackup(
  zipFile: string,
  options: { scratchParent?: string; limits?: ZipLimits } = {},
): Promise<{ ok: true; extracted: ExtractedBackup } | { ok: false; error: string; manifest: BackupManifest | null }> {
  if (!existsSync(zipFile) || !statSync(zipFile).isFile()) {
    return { ok: false, error: `Backup file not found: ${zipFile}`, manifest: null };
  }
  const dir = scratchDir(options.scratchParent);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let manifest: BackupManifest | null = null;
  const fail = (error: string) => {
    cleanup();
    return { ok: false as const, error, manifest };
  };

  try {
    await extractZipSafely(zipFile, dir, options.limits ?? BACKUP_ZIP_LIMITS);
  } catch (err) {
    return fail(`Unzip failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const manifestFile = path.join(dir, BACKUP_MANIFEST_ENTRY);
  const dbFile = path.join(dir, BACKUP_DB_ENTRY);
  if (!existsSync(manifestFile)) return fail('manifest.json is missing from the backup');
  if (!existsSync(dbFile)) return fail('subscriberr.db is missing from the backup');

  try {
    manifest = backupManifestSchema.parse(JSON.parse(readFileSync(manifestFile, 'utf8')));
  } catch (err) {
    return fail(`manifest.json is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Hash before opening the database: opening must not be able to influence the checksum.
  const sha = await sha256File(dbFile);
  if (sha !== manifest.db.sha256) return fail('Database checksum does not match the manifest (sha256 mismatch)');

  const inspection = inspectDatabaseFile(dbFile);
  if (!inspection.ok) return fail(`Database integrity check failed: ${inspection.problems.join('; ')}`);
  if (inspection.schemaVersion !== manifest.schemaVersion) {
    return fail(`Schema version ${inspection.schemaVersion} does not match the manifest (${manifest.schemaVersion})`);
  }
  const tables = new Set([...Object.keys(manifest.rowCounts), ...Object.keys(inspection.rowCounts)]);
  for (const table of tables) {
    if (manifest.rowCounts[table] !== inspection.rowCounts[table]) {
      return fail(`Row count mismatch for table "${table}": manifest ${manifest.rowCounts[table] ?? 'missing'}, database ${inspection.rowCounts[table] ?? 'missing'}`);
    }
  }

  return { ok: true, extracted: { dir, manifest, cleanup } };
}

/** Verifies a backup zip and discards the scratch copy. Never throws. */
export async function verifyBackupFile(zipFile: string, options: { scratchParent?: string; limits?: ZipLimits } = {}): Promise<VerifyResult> {
  try {
    const result = await extractAndVerifyBackup(zipFile, options);
    if (!result.ok) return { ok: false, error: result.error, manifest: result.manifest };
    result.extracted.cleanup();
    return { ok: true, error: null, manifest: result.extracted.manifest };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), manifest: null };
  }
}
