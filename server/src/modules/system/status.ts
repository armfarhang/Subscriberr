import type { BackupDestination, SystemStatus } from '@subscriberr/shared';
import type { Clock } from '../../core/time.js';
import type { SystemContext } from '../../core/workspace-context.js';
import { currentSchemaVersion, getMeta } from '../../db/migrate.js';
import { checkBackupDestination } from './backup-destination.js';

/** The newest verified backup must be younger than this, or the dashboard warns (Spec §6.9). */
export const BACKUP_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export interface SystemStatusDeps {
  ctx: SystemContext;
  clock: Clock;
  appVersion: string;
  demoMode: boolean;
  dataDir: string;
  backupDir: string;
}

/** Checks the backup destination now (cheap: a few stat calls). Also run hourly as a job so problems are logged. */
export function runBackupDestinationCheck(backupDir: string, dataDir: string): BackupDestination {
  return checkBackupDestination(backupDir, dataDir);
}

export function getSystemStatus(deps: SystemStatusDeps): SystemStatus {
  const lastBackupOkAt = getMeta(deps.ctx.sqlite, 'last_backup_ok_at');
  const age = lastBackupOkAt ? deps.clock.now().getTime() - Date.parse(lastBackupOkAt) : Number.POSITIVE_INFINITY;
  return {
    version: deps.appVersion,
    schemaVersion: currentSchemaVersion(deps.ctx.sqlite),
    demoMode: deps.demoMode,
    lastBackupOkAt,
    backupStale: age > BACKUP_STALE_AFTER_MS,
    backupDestination: runBackupDestinationCheck(deps.backupDir, deps.dataDir),
  };
}
