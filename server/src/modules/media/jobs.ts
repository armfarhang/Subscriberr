import type { SystemContext } from '../../core/workspace-context.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { processPendingSyncs, type SyncDeps } from './sync.js';

export const JOB_MEDIA_SYNC = 'media-sync';

/** Pending access changes and due retries, every minute (Spec §10.2). The full reconcile is a daily step. */
export function registerMediaJobs(scheduler: Scheduler, ctx: SystemContext, deps: SyncDeps, timeZone: string): void {
  scheduler.register({
    name: JOB_MEDIA_SYNC,
    cron: '* * * * *',
    timeZone,
    async run() {
      return processPendingSyncs(ctx, deps);
    },
  });
}
