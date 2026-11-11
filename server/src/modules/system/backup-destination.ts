import { accessSync, constants, existsSync, mkdirSync, statfsSync, statSync } from 'node:fs';
import type { BackupDestination } from '@subscriberr/shared';

// Layer 3 of §6.9: backups must live on a different disk than the data. This check drives the
// loud warning on the System page / dashboard and the hourly health job.

export function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Creates the backup directory (mode 0700) if the parent volume allows it. Returns false on failure. */
export function ensureBackupDir(backupDir: string): boolean {
  try {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

export function checkBackupDestination(backupDir: string, dataDir: string): BackupDestination {
  const problems: string[] = [];
  const exists = existsSync(backupDir) && statSync(backupDir).isDirectory();
  let writable = false;
  let sameFilesystemAsData = false;

  if (!exists) {
    problems.push(`Backup directory ${backupDir} is missing. Map a separate /backups volume.`);
  } else {
    try {
      accessSync(backupDir, constants.W_OK | constants.R_OK);
      writable = true;
    } catch {
      problems.push(`Backup directory ${backupDir} is not writable.`);
    }
    try {
      sameFilesystemAsData = existsSync(dataDir) && statSync(backupDir).dev === statSync(dataDir).dev;
    } catch {
      sameFilesystemAsData = false;
    }
    if (sameFilesystemAsData) {
      problems.push(
        'Backups are on the same filesystem as the data directory. That is not redundancy: ' +
          'map BACKUP_DIR to a different disk or share.',
      );
    }
  }

  return {
    ok: problems.length === 0,
    path: backupDir,
    exists,
    writable,
    sameFilesystemAsData,
    freeBytes: exists ? freeBytes(backupDir) : null,
    problems,
  };
}
