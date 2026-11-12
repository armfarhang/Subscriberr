import type { SystemContext } from '../../core/workspace-context.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { drainAll, type DrainDeps } from './drain.js';

export const JOB_EMAIL_DRAIN = 'email-drain';

/** The queue drainer runs every minute (Spec §9.5, §11). */
export function registerEmailJobs(scheduler: Scheduler, ctx: SystemContext, deps: DrainDeps, timeZone: string): void {
  scheduler.register({
    name: JOB_EMAIL_DRAIN,
    cron: '* * * * *',
    timeZone,
    async run() {
      return drainAll(ctx, deps);
    },
  });
}
