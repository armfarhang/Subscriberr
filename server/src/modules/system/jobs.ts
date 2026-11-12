import type { Scheduler } from '../jobs/scheduler.js';
import { type BackupEnv, runBackup } from './backup.js';
import { runBackupDestinationCheck } from './status.js';
import { runIntegrityCheck } from './integrity.js';

export const JOB_BACKUP = 'backup';
export const JOB_BACKUP_DESTINATION = 'backup-destination-health';
export const JOB_INTEGRITY = 'integrity-check';

/** Registers the global (not per-workspace) system jobs of Spec §11 that exist in this milestone. */
export function registerSystemJobs(scheduler: Scheduler, env: BackupEnv, onIntegrityProblem?: (problems: string[]) => void): void {
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
    name: JOB_INTEGRITY,
    cron: '30 3 * * *', // nightly 03:30, after the backup
    timeZone: env.timeZone,
    async run() {
      const result = runIntegrityCheck(env.ctx, env.clock);
      if (!result.ok) {
        env.log.error('integrity / ledger verification found problems', { problems: result.problems });
        onIntegrityProblem?.(result.problems);
        throw new Error(`${result.problems.length} problem(s): ${result.problems[0]}`);
      }
      return { ok: true };
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
