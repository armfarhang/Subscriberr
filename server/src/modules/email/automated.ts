import { diffDays, formatCents, localDate } from '@subscriberr/shared';
import type { Logger } from '../../core/logger.js';
import { type Clock, nowIso, today } from '../../core/time.js';
import { forWorkspace, type SystemContext, type WorkspaceContext } from '../../core/workspace-context.js';
import type { BillingEvents } from '../billing/ledger.js';
import type { DailyStep } from '../jobs/daily.js';
import { getWorkspaceSettings } from '../workspaces/settings.js';
import type { PackEnv } from './packs.js';
import { enqueue, getEmailSettings, memberForEmail, PRIORITY, queueMemberEmail } from './queue.js';

// Automated emails (Spec §9.3): thank-you / deficit after a payment, reminders before and after
// the due date, "access paused" when a member expires. All deduplicated by key, all opt-out-able
// (globally and per member), never to the payer's Reply-To — only the member's email on file.

export interface AutomatedDeps {
  clock: Clock;
  log: Logger;
  packs: PackEnv;
}

const longDate = (d: string | null) => (d ? new Intl.DateTimeFormat('en-CA', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)) : '');

export function emailBillingEvents(deps: AutomatedDeps): BillingEvents {
  const safely = (what: string, ws: WorkspaceContext, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      // An email problem must never undo a payment.
      deps.log.error(`could not queue ${what} email`, { accountId: ws.accountId, err });
    }
  };
  return {
    paymentApplied(ws, e) {
      safely('payment', ws, () => {
        const settings = getEmailSettings(ws);
        // Old payments (a rescan after a restore, or the first scan of a mailbox) never trigger
        // confirmations: only money received within the window does (§6.9 layer 4, default 3 days).
        if (deps.clock.now().getTime() - Date.parse(e.receivedAt) > settings.rescanResendWindowDays * 86_400_000) return;
        const m = memberForEmail(ws, e.memberId);
        const money = (c: number) => formatCents(c, m.currency);
        if (e.output.periodsApplied > 0) {
          if (!settings.enabled.thanks) return;
          queueMemberEmail(ws, deps, 'thanks', e.memberId, `payment:${e.paymentId}:thanks`, {
            amount_received: money(e.amountCents),
            periods_covered: e.output.periodsApplied,
            paid_through: longDate(e.output.paidThroughAfter),
            credit: e.output.creditAfterCents > 0 ? money(e.output.creditAfterCents) : '',
          });
        } else {
          if (!settings.enabled.deficit) return;
          queueMemberEmail(ws, deps, 'deficit', e.memberId, `payment:${e.paymentId}:deficit`, {
            amount_received: money(e.amountCents),
            amount_expected: money(e.planAmountCents),
            shortfall: money(Math.max(e.planAmountCents - e.output.creditAfterCents, 0)),
            credit: money(e.output.creditAfterCents),
            paid_through: longDate(e.output.paidThroughAfter),
          });
        }
      });
    },
    statusChanged(ws, e) {
      if (e.to !== 'expired' || (e.from !== 'grace' && e.from !== 'active')) return;
      safely('access paused', ws, () => {
        if (!getEmailSettings(ws).enabled.expired) return;
        const m = memberForEmail(ws, e.memberId);
        queueMemberEmail(ws, deps, 'expired', e.memberId, `expired:${e.memberId}:${m.paid_through ?? 'never'}`);
      });
    },
  };
}

/** Daily step: reminders N days before the due date, on the day, and after it (§9.3). */
export function reminderStep(deps: AutomatedDeps): DailyStep {
  return {
    name: 'reminders',
    run(ws) {
      const settings = getEmailSettings(ws);
      if (!settings.enabled.reminder) return { queued: 0, disabled: true };
      const todayDate = today(deps.clock, getWorkspaceSettings(ws).timezone);
      const members = ws.sqlite
        .prepare(`SELECT id, paid_through FROM members WHERE account_id = ? AND paid_through IS NOT NULL AND status IN ('active', 'grace') AND reminders_enabled = 1 AND emails_enabled = 1`)
        .all(ws.accountId) as Array<{ id: number; paid_through: string }>;
      let queued = 0;
      for (const m of members) {
        const days = diffDays(todayDate, m.paid_through);
        let tag: string | null = null;
        if (days > 0 && settings.reminderOffsets.includes(days)) tag = `before-${days}`;
        else if (days === 0 && settings.remindDueToday) tag = 'due';
        else if (days < 0 && settings.overdueOffsets.includes(-days)) tag = `overdue-${-days}`;
        if (!tag) continue;
        // Keyed on the due date: paying moves the due date, so no reminder for a period already paid.
        const r = queueMemberEmail(ws, deps, 'reminder', m.id, `reminder:${m.id}:${m.paid_through}:${tag}`, { days_until_due: Math.max(days, 0), due_date: longDate(m.paid_through) });
        if (r.queued) queued++;
      }
      return { queued };
    },
  };
}

/** Integrity failure → an email to the Owner (§6.9 layer 1), once per day. */
export function alertOwnerOfIntegrityProblems(ctx: SystemContext, clock: Clock, problems: string[]): void {
  const owner = ctx.sqlite.prepare(`SELECT id, email FROM accounts WHERE role = 'owner'`).get() as { id: number; email: string } | undefined;
  if (!owner) return;
  const ws = forWorkspace(ctx, owner.id);
  const day = localDate(clock.now(), getWorkspaceSettings(ws).timezone);
  const list = problems.slice(0, 20);
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  enqueue(ws, clock, {
    kind: 'test',
    memberId: null,
    to: owner.email,
    rendered: {
      subject: `Subscriberr: the nightly integrity check found ${problems.length} problem(s)`,
      html: `<p>The nightly integrity and ledger verification at ${nowIso(clock)} found problems. Nothing was changed automatically.</p><ul>${list.map((p) => `<li><code>${escape(p)}</code></li>`).join('')}</ul><p>Open Subscriberr → System for details. If data looks wrong, restore the latest good backup (see the README) and use "Rescan mailbox from date".</p>`,
      text: `The nightly integrity and ledger verification found problems. Nothing was changed automatically.\n\n${list.map((p) => `- ${p}`).join('\n')}\n\nOpen Subscriberr → System for details.`,
      attachments: [],
    },
    priority: PRIORITY.transactional,
    dedupeKey: `integrity:${day}`,
  });
}
