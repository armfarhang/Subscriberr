import { chmodSync, createWriteStream, existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import {
  type BackupKind,
  type BackupRetention,
  type BackupRun,
  type BackupTier,
  backupRetentionSchema,
  DEFAULT_BACKUP_RETENTION,
  localParts,
  toUtcIso,
} from '@subscriberr/shared';
import type { Logger } from '../../core/logger.js';
import type { Clock } from '../../core/time.js';
import type { SystemContext } from '../../core/workspace-context.js';
import { inspectDatabaseFile, sha256File, snapshotDatabase } from '../../db/snapshot.js';
import { checkBackupDestination, ensureBackupDir, freeBytes } from './backup-destination.js';
import { BACKUP_DB_ENTRY, BACKUP_MANIFEST_ENTRY, BACKUP_WORKSPACES_ENTRY, type BackupManifest } from './manifest.js';
import { pruneBackups, type PruneResult } from './prune.js';
import { verifyBackupFile } from './verify.js';

// Backup engine (Spec §6.9 layer 2): online snapshot → one zip (db + workspaces/ + manifest)
// → immediate verification → record → prune.

export interface BackupEnv {
  ctx: SystemContext;
  dbFile: string;
  workspacesDir: string;
  dataDir: string;
  backupDir: string;
  appVersion: string;
  timeZone: string;
  clock: Clock;
  log: Logger;
}

export interface BackupOutcome {
  kind: BackupKind;
  tier: BackupTier;
  startedAt: string;
  finishedAt: string;
  /** File name inside BACKUP_DIR (null when nothing could be written). */
  file: string | null;
  bytes: number | null;
  sha256: string | null;
  schemaVersion: number | null;
  verified: boolean;
  verifiedAt: string | null;
  error: string | null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function backupFileName(instant: Date, timeZone: string, kind: BackupKind): string {
  const p = localParts(instant, timeZone);
  return `subscriberr-${pad(p.year, 4)}${pad(p.month)}${pad(p.day)}-${pad(p.hour)}${pad(p.minute)}${pad(p.second)}-${kind}.zip`;
}

function directorySize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

function writeZip(zipFile: string, snapshot: string, workspacesDir: string, manifest: BackupManifest): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipFile, { mode: 0o600 });
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', reject);
    archive.pipe(output);
    archive.file(snapshot, { name: BACKUP_DB_ENTRY });
    if (existsSync(workspacesDir)) archive.directory(workspacesDir, BACKUP_WORKSPACES_ENTRY);
    archive.append(JSON.stringify(manifest, null, 2), { name: BACKUP_MANIFEST_ENTRY });
    void archive.finalize();
  });
}

/**
 * Creates and verifies one backup. Does not write to the database, so it can run before
 * migrations. Expected failures (destination missing/full, verification failed) are returned
 * as an outcome with `error` set rather than thrown.
 */
export async function createBackup(env: Omit<BackupEnv, 'ctx'> & { ctx: Pick<SystemContext, 'sqlite'> }, kind: BackupKind): Promise<BackupOutcome> {
  const started = env.clock.now();
  const outcome: BackupOutcome = {
    kind,
    tier: kind === 'nightly' ? 'daily' : 'safety',
    startedAt: toUtcIso(started),
    finishedAt: toUtcIso(started),
    file: null,
    bytes: null,
    sha256: null,
    schemaVersion: null,
    verified: false,
    verifiedAt: null,
    error: null,
  };
  const finish = (error: string | null): BackupOutcome => {
    outcome.error = error;
    outcome.finishedAt = toUtcIso(env.clock.now());
    return outcome;
  };

  ensureBackupDir(env.backupDir);
  const dest = checkBackupDestination(env.backupDir, env.dataDir);
  if (!dest.exists || !dest.writable) return finish(dest.problems.join(' '));

  // Free-space check: the scratch snapshot and the zip both land on the backup volume.
  const needed = 2 * ((existsSync(env.dbFile) ? statSync(env.dbFile).size : 0) + directorySize(env.workspacesDir)) + 8 * 1024 * 1024;
  const free = freeBytes(env.backupDir);
  if (free !== null && free < needed) {
    return finish(`Not enough free space in ${env.backupDir}: need about ${needed} bytes, ${free} available.`);
  }

  let scratch: string | null = null;
  let partial: string | null = null;
  try {
    scratch = mkdtempSync(path.join(env.backupDir, '.tmp-backup-'));
    const snapshot = path.join(scratch, BACKUP_DB_ENTRY);
    await snapshotDatabase(env.ctx.sqlite, snapshot);

    const sha256 = await sha256File(snapshot);
    const bytes = statSync(snapshot).size;
    const inspection = inspectDatabaseFile(snapshot);
    outcome.sha256 = sha256;
    outcome.schemaVersion = inspection.schemaVersion;
    if (!inspection.ok) return finish(`Snapshot failed its integrity check: ${inspection.problems.join('; ')}`);

    const manifest: BackupManifest = {
      app: 'subscriberr',
      formatVersion: 1,
      appVersion: env.appVersion,
      schemaVersion: inspection.schemaVersion,
      createdAt: outcome.startedAt,
      kind,
      db: { file: BACKUP_DB_ENTRY, sha256, bytes },
      rowCounts: inspection.rowCounts,
    };

    let name = backupFileName(started, env.timeZone, kind);
    for (let n = 2; existsSync(path.join(env.backupDir, name)); n++) {
      name = backupFileName(started, env.timeZone, kind).replace(/\.zip$/, `-${n}.zip`);
    }
    const finalFile = path.join(env.backupDir, name);
    partial = `${finalFile}.partial`;
    await writeZip(partial, snapshot, env.workspacesDir, manifest);
    renameSync(partial, finalFile);
    partial = null;
    try {
      chmodSync(finalFile, 0o600);
    } catch {
      /* best effort (no-op on Windows) */
    }
    outcome.file = name;
    outcome.bytes = statSync(finalFile).size;

    const verification = await verifyBackupFile(finalFile, { scratchParent: env.backupDir });
    if (!verification.ok) return finish(`Verification failed: ${verification.error}`);
    outcome.verified = true;
    outcome.verifiedAt = toUtcIso(env.clock.now());
    return finish(null);
  } catch (err) {
    return finish(err instanceof Error ? err.message : String(err));
  } finally {
    if (partial) rmSync(partial, { force: true });
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

export function recordBackupRun(ctx: SystemContext, o: BackupOutcome): number {
  const info = ctx.sqlite
    .prepare(
      `INSERT INTO backup_runs (kind, tier, started_at, finished_at, file, bytes, sha256, schema_version, verified, verified_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(o.kind, o.tier, o.startedAt, o.finishedAt, o.file, o.bytes, o.sha256, o.schemaVersion, o.verified ? 1 : 0, o.verifiedAt, o.error);
  if (o.verified) {
    ctx.sqlite
      .prepare(`INSERT INTO meta (key, value) VALUES ('last_backup_ok_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(o.verifiedAt ?? o.finishedAt);
  }
  return Number(info.lastInsertRowid);
}

/** Retention is edited in the Owner's Settings; falls back to 2 daily / 4 weekly / 6 monthly. */
export function getBackupRetention(ctx: SystemContext): BackupRetention {
  const row = ctx.sqlite
    .prepare(
      `SELECT s.value FROM settings s JOIN accounts a ON a.id = s.account_id
        WHERE a.role = 'owner' AND s.key = 'backup_retention' ORDER BY a.id LIMIT 1`,
    )
    .get() as { value: string } | undefined;
  if (!row) return DEFAULT_BACKUP_RETENTION;
  const parsed = backupRetentionSchema.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : DEFAULT_BACKUP_RETENTION;
}

export interface BackupRunResult {
  id: number;
  outcome: BackupOutcome;
  /** null when pruning was skipped because the new backup is not verified. */
  pruned: PruneResult | null;
}

/** Full flow: create + verify, record in `backup_runs`, then prune (only after a verified backup). */
export async function runBackup(env: BackupEnv, kind: BackupKind): Promise<BackupRunResult> {
  const outcome = await createBackup(env, kind);
  const id = recordBackupRun(env.ctx, outcome);
  let pruned: PruneResult | null = null;
  if (outcome.verified) {
    pruned = pruneBackups(env.ctx, {
      backupDir: env.backupDir,
      retention: getBackupRetention(env.ctx),
      timeZone: env.timeZone,
      now: env.clock.now(),
      nowIso: toUtcIso(env.clock.now()),
    });
    env.log.info('backup complete', { kind, file: outcome.file, bytes: outcome.bytes, pruned: pruned.removed.length });
  } else {
    env.log.error('backup failed', { kind, file: outcome.file, error: outcome.error });
  }
  return { id, outcome, pruned };
}

interface BackupRunRow {
  id: number;
  kind: BackupKind;
  tier: BackupTier;
  started_at: string;
  finished_at: string | null;
  file: string | null;
  bytes: number | null;
  schema_version: number | null;
  verified: number;
  verified_at: string | null;
  pruned_at: string | null;
  error: string | null;
}

export function listBackupRuns(ctx: SystemContext, limit = 100): BackupRun[] {
  const rows = ctx.sqlite.prepare('SELECT * FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT ?').all(limit) as BackupRunRow[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    tier: r.tier,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    file: r.file,
    bytes: r.bytes,
    schemaVersion: r.schema_version,
    verified: r.verified === 1,
    verifiedAt: r.verified_at,
    prunedAt: r.pruned_at,
    error: r.error,
  }));
}
