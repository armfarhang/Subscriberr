import type { Clock } from '../../core/time.js';
import { forWorkspace, type SystemContext } from '../../core/workspace-context.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { purgeAbandonedStaging } from './imports.js';

export const JOB_IMPORT_CLEANUP = 'import-staging-cleanup';

/** Daily: abandon staged imports older than 7 days and delete their rows (Spec §11, §12.3). */
export function registerCsvJobs(scheduler: Scheduler, ctx: SystemContext, clock: Clock, timeZone: string): void {
  scheduler.register({
    name: JOB_IMPORT_CLEANUP,
    cron: '40 4 * * *',
    timeZone,
    async run() {
      return runImportCleanup(ctx, clock);
    },
  });
}

export function runImportCleanup(ctx: SystemContext, clock: Clock): { abandoned: number } {
  const accounts = ctx.sqlite.prepare('SELECT id FROM accounts').all() as Array<{ id: number }>;
  let abandoned = 0;
  for (const a of accounts) abandoned += purgeAbandonedStaging(forWorkspace(ctx, a.id), clock);
  return { abandoned };
}
