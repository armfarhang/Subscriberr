import type { Scheduler } from '../jobs/scheduler.js';
import { checkGmailTokens, type TokenDeps } from '../gmail/tokens.js';

export const JOB_TOKEN_HEALTH = 'token-health';

/** Hourly token health check (Spec §11). */
export function registerAuthJobs(scheduler: Scheduler, deps: TokenDeps, timeZone: string): void {
  scheduler.register({
    name: JOB_TOKEN_HEALTH,
    cron: '17 * * * *',
    timeZone,
    async run() {
      return { ...(await checkGmailTokens(deps)) };
    },
  });
}
