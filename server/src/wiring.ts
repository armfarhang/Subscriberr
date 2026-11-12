import type { Logger } from './core/logger.js';
import type { Clock } from './core/time.js';
import type { WorkspaceContext } from './core/workspace-context.js';
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
}

export function createServices(inputs: ServiceInputs): Services {
  const listeners: BillingEvents[] = [emailBillingEvents({ clock: inputs.clock, log: inputs.log, packs: inputs.packs })];
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
    ],
  };
}
