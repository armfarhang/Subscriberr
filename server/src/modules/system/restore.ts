import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { localParts } from '@subscriberr/shared';
import type { Logger } from '../../core/logger.js';
import type { Clock } from '../../core/time.js';
import { nowIso } from '../../core/time.js';
import { bootDatabase, checkIntegrity } from '../../db/boot.js';
import { latestSchemaVersion } from '../../db/migrate.js';
import { canLockExclusively } from '../../db/snapshot.js';
import { isAppRunning } from './lock.js';
import { BACKUP_DB_ENTRY, BACKUP_WORKSPACES_ENTRY, type BackupManifest } from './manifest.js';
import { extractAndVerifyBackup } from './verify.js';

// Restore (Spec §6.9 layer 5). CLI only — there is deliberately no web endpoint for this.

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

export interface RestoreOptions {
  backupFile: string;
  dataDir: string;
  appVersion: string;
  timeZone: string;
  clock: Clock;
  log: Logger;
  migrationsDir?: string;
}

export interface RestoreResult {
  manifest: BackupManifest;
  /** Paths the previous database / workspaces were moved to (empty when there was nothing). */
  movedAside: string[];
  migratedFrom: number;
  migratedTo: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function moveEntry(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    // Different filesystem (scratch vs data): copy, then remove the source.
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const { dataDir, backupFile, log } = options;
  const dbFile = path.join(dataDir, BACKUP_DB_ENTRY);
  const workspacesDir = path.join(dataDir, BACKUP_WORKSPACES_ENTRY);

  // 1. Never restore over a running app.
  if (isAppRunning(dataDir)) {
    throw new RestoreError('Subscriberr appears to be running (the run lock is fresh). Stop the app/container first, then run restore again.');
  }
  if (existsSync(dbFile) && !canLockExclusively(dbFile)) {
    throw new RestoreError(`The database at ${dbFile} is in use by another process. Stop the app first.`);
  }

  // 2. Verify the backup before touching anything (same checks as after every backup).
  mkdirSync(dataDir, { recursive: true });
  const verified = await extractAndVerifyBackup(backupFile, { scratchParent: dataDir });
  if (!verified.ok) throw new RestoreError(`Backup verification failed, nothing was changed: ${verified.error}`);
  const { extracted } = verified;

  try {
    const appSchema = latestSchemaVersion(options.migrationsDir);
    if (extracted.manifest.schemaVersion > appSchema) {
      throw new RestoreError(
        `The backup has schema version ${extracted.manifest.schemaVersion} but this app only supports ${appSchema}. ` +
          'Restore it with the same (or a newer) app version. Nothing was changed.',
      );
    }

    // 3. Move the current data aside — never delete it.
    const p = localParts(options.clock.now(), options.timeZone);
    const stamp = `${pad(p.year, 4)}${pad(p.month)}${pad(p.day)}-${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`;
    const movedAside: string[] = [];
    for (const name of [BACKUP_DB_ENTRY, `${BACKUP_DB_ENTRY}-wal`, `${BACKUP_DB_ENTRY}-shm`, BACKUP_WORKSPACES_ENTRY]) {
      const current = path.join(dataDir, name);
      if (!existsSync(current)) continue;
      const aside = path.join(dataDir, `${name}.before-restore-${stamp}`);
      renameSync(current, aside);
      movedAside.push(aside);
    }

    // 4. Put the backup's files in place.
    moveEntry(path.join(extracted.dir, BACKUP_DB_ENTRY), dbFile);
    const extractedWorkspaces = path.join(extracted.dir, BACKUP_WORKSPACES_ENTRY);
    if (existsSync(extractedWorkspaces)) moveEntry(extractedWorkspaces, workspacesDir);
    else mkdirSync(workspacesDir, { recursive: true });

    // 5. Migrate if the backup is older than this app, then check integrity.
    const boot = await bootDatabase({
      dbFile,
      appVersion: options.appVersion,
      nowIso: nowIso(options.clock),
      migrationsDir: options.migrationsDir,
    });
    try {
      const report = checkIntegrity(boot.db);
      if (!report.ok) {
        throw new RestoreError(
          `The restored database failed its integrity check (${[...report.integrity, `${report.foreignKeyViolations} FK violations`].join('; ')}). ` +
            `Your previous data is still at: ${movedAside.join(', ') || '(none)'}`,
        );
      }
    } finally {
      boot.db.close();
    }

    log.info('restore complete', { backup: path.basename(backupFile), schemaFrom: boot.migration.from, schemaTo: boot.migration.to });
    return { manifest: extracted.manifest, movedAside, migratedFrom: boot.migration.from, migratedTo: boot.migration.to };
  } finally {
    extracted.cleanup();
  }
}
