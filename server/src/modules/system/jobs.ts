import type { Scheduler } from '../jobs/scheduler.js';
import { type BackupEnv, runBackup } from './backup.js';
import { runBackupDestinationCheck } from './status.js';

export const JOB_BACKUP = 'backup';
export const JOB_BACKUP_DESTINATION = 'backup-destination-health';

/** Registers the global (not per-workspace) system jobs of Spec §11 that exist in this milestone. */
export function registerSystemJobs(scheduler: Scheduler, env: BackupEnv): void {
  scheduler.register({
    name: JOB_BACKUP,
    cron: '0 3 * * *', // nightly 03:00, server timezone
    timeZone: env.timeZone,
    async run() {
      const result = await runBackup(env, 'nightly');
      if (!result.outcome.verified) throw new Error(result.outcome.error ?? 'backup failed');
      return { file: result.outcome.file, bytes: result.outcome.bytes, pruned: result.pruned?.removed.length ?? 0 };
    },
  });

  scheduler.register({
    name: JOB_BACKUP_DESTINATION,
    cron: '5 * * * *', // hourly
    timeZone: env.timeZone,
    async run() {
      const dest = runBackupDestinationCheck(env.backupDir, env.dataDir);
      if (!dest.ok) env.log.warn('backup destination problem', { problems: dest.problems });
      return { ok: dest.ok, problems: dest.problems, freeBytes: dest.freeBytes };
    },
  });
}
