import type { Logger } from './core/logger.js';
import type { Clock } from './core/time.js';
import type { SystemContext, WorkspaceContext } from './core/workspace-context.js';
import type { MediaProviderFactory } from './modules/media/factory.js';
import { mediaBillingEvents, processPendingSyncs, reconcileWorkspace } from './modules/media/sync.js';
import { applyPayment, type BillingDeps, type BillingEvents, expirePendingDeposits, recomputeStatuses } from './modules/billing/ledger.js';
import { emailBillingEvents, reminderStep } from './modules/email/automated.js';
import type { PackEnv } from './modules/email/packs.js';
import type { DailyStep } from './modules/jobs/daily.js';

// How the modules are connected (shared by main.ts and the tests, so tests run the real wiring):
// ingest → billing (apply payments), billing → events (emails; media access in M9), and the
// steps of the per-workspace daily run.

export interface Services {
  billing: BillingDeps;
  billingEvents: BillingEvents;
  onPaymentStored: (ws: WorkspaceContext, paymentId: number, opts: { rescan: boolean; receivedAt: string }) => void;
  dailySteps: DailyStep[];
  /** More listeners (e.g. media enforcement) can be added before the app starts. */
  addBillingListener: (listener: BillingEvents) => void;
}

export interface ServiceInputs {
  clock: Clock;
  log: Logger;
  packs: PackEnv;
  /** Media enforcement (M9): needs the database and the provider factory. */
  ctx?: SystemContext;
  media?: MediaProviderFactory;
  /** Process media syncs right after a billing event (production); tests run them explicitly. */
  autoSync?: boolean;
}

export function createServices(inputs: ServiceInputs): Services {
  const listeners: BillingEvents[] = [emailBillingEvents({ clock: inputs.clock, log: inputs.log, packs: inputs.packs })];
  const syncDeps = inputs.media ? { clock: inputs.clock, media: inputs.media, log: inputs.log } : null;
  if (syncDeps && inputs.ctx) {
    const ctx = inputs.ctx;
    let scheduled = false;
    // Billing runs inside DB transactions; the server calls happen right after, outside them.
    const kick = () => {
      if (!inputs.autoSync || scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        processPendingSyncs(ctx, syncDeps).catch((err: unknown) => inputs.log.error('media sync failed', { err }));
      }, 50);
    };
    listeners.push(mediaBillingEvents(kick));
  }
  const billingEvents: BillingEvents = {
    paymentApplied: (ws, e) => listeners.forEach((l) => l.paymentApplied?.(ws, e)),
    statusChanged: (ws, e) => listeners.forEach((l) => l.statusChanged?.(ws, e)),
  };
  const billing: BillingDeps = { clock: inputs.clock, events: billingEvents };
  return {
    billing,
    billingEvents,
    addBillingListener: (l) => listeners.push(l),
    onPaymentStored: (ws, paymentId, opts) => {
      // Applying never loses the payment: problems become a review item instead of an exception.
      try {
        applyPayment(ws, billing, 'system', paymentId, { rescan: opts.rescan });
      } catch (err) {
        inputs.log.error('could not apply payment', { accountId: ws.accountId, paymentId, err });
        ws.sqlite
          .prepare(`UPDATE payments SET status = 'needs_review', member_id = NULL, review_reason = ? WHERE account_id = ? AND id = ?`)
          .run(`The payment could not be applied automatically: ${err instanceof Error ? err.message : String(err)}`, ws.accountId, paymentId);
      }
    },
    dailySteps: [
      { name: 'expire-pending-deposits', run: (ws) => ({ expired: expirePendingDeposits(ws, inputs.clock) }) },
      { name: 'recompute-statuses', run: (ws) => recomputeStatuses(ws, billing) },
      reminderStep({ clock: inputs.clock, log: inputs.log, packs: inputs.packs }),
      ...(syncDeps ? [{ name: 'media-reconcile', run: (ws: WorkspaceContext) => reconcileWorkspace(ws, syncDeps) }] : []),
    ],
  };
}
