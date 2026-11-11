import type { Config } from '../config.js';
import type { Logger } from '../core/logger.js';
import type { Clock } from '../core/time.js';
import type { SystemContext } from '../core/workspace-context.js';
import type { AccountRecord } from '../modules/auth/accounts.js';
import type { Scheduler } from '../modules/jobs/scheduler.js';
import type { BackupEnv } from '../modules/system/backup.js';

/** Everything the HTTP layer needs; built once in main.ts (and by tests). */
export interface AppDeps {
  config: Config;
  ctx: SystemContext;
  clock: Clock;
  log: Logger;
  backupEnv: BackupEnv;
  scheduler?: Scheduler;
  /** Directory with the built web app (web/dist). Omitted → API only. */
  webDir?: string;
}

export type AppEnv = {
  Variables: {
    /** Signed-in account, or null. Set by the session middleware. */
    account: AccountRecord | null;
    sessionToken: string | null;
  };
};
