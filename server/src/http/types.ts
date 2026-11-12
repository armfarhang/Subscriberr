import type { Config } from '../config.js';
import type { SecretBox } from '../core/crypto.js';
import type { Logger } from '../core/logger.js';
import type { Clock } from '../core/time.js';
import type { SystemContext, WorkspaceContext } from '../core/workspace-context.js';
import type { AccountRecord } from '../modules/auth/accounts.js';
import type { GoogleAuthProvider } from '../modules/auth/google.js';
import type { Scheduler } from '../modules/jobs/scheduler.js';
import type { MediaProviderFactory } from '../modules/media/factory.js';
import type { GmailClientFactory } from '../modules/gmail/factory.js';
import type { BillingEvents } from '../modules/billing/ledger.js';
import type { PackEnv } from '../modules/email/packs.js';
import type { BackupEnv } from '../modules/system/backup.js';

/** Everything the HTTP layer needs; built once in main.ts (and by tests). */
export interface AppDeps {
  config: Config;
  ctx: SystemContext;
  clock: Clock;
  log: Logger;
  secretBox: SecretBox;
  /** Google sign-in provider (real, or the in-process fake in demo mode); null = unavailable. */
  google: GoogleAuthProvider | null;
  backupEnv: BackupEnv;
  scheduler?: Scheduler;
  /** Resolves configured Plex/Jellyfin servers to providers (fake in demo mode). */
  media?: MediaProviderFactory;
  /** Gmail client per workspace (fake in demo mode). */
  gmail?: GmailClientFactory;
  /** Billing events (emails in M7, media access in M9). */
  billingEvents?: BillingEvents;
  /** Where template packs live (defaults: templates/builtin + the data volume). */
  packs?: PackEnv;
  /** Pause between sent emails (tests use 0). */
  emailThrottleMs?: number;
  /** Called when a payment becomes applicable (wired to billing in main.ts / tests). */
  onPaymentStored?: (ws: WorkspaceContext, paymentId: number, opts: { rescan: boolean; receivedAt: string }) => void;
  /** Directory with the built web app (web/dist). Omitted → API only. */
  webDir?: string;
}

export type AppEnv = {
  Variables: {
    /** Signed-in account, or null. Set by the session middleware. */
    account: AccountRecord | null;
    /** The signed-in account's workspace context — the only DB handle route handlers use for workspace data. */
    ws: WorkspaceContext | null;
    sessionToken: string | null;
  };
};
