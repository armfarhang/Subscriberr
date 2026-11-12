import { addDays, type Dashboard, diffDays, type GmailStatus, localDate, MEMBER_STATUSES, monthKey } from '@subscriberr/shared';
import { type Clock, today } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import { queueStatus } from '../email/queue.js';
import { allMemberRows } from '../members/members.js';
import { getScanState } from '../payments/ingest.js';
import { reviewCounts } from '../payments/store.js';
import { getWorkspaceSettings } from '../workspaces/settings.js';

/** "Due soon" window: a week, the first default reminder (Spec §9.2). */
export const DUE_SOON_DAYS = 7;

/** Payment statuses that credited a member (applied by the billing engine). */
const CREDITED = ['matched', 'manual', 'underpaid', 'overpaid'];

export function getDashboard(ws: WorkspaceContext, clock: Clock): Dashboard {
  const settings = getWorkspaceSettings(ws);
  const todayDate = today(clock, settings.timezone);

  const counts = { ...(Object.fromEntries(MEMBER_STATUSES.map((s) => [s, 0])) as Record<(typeof MEMBER_STATUSES)[number], number>), dueSoon: 0 };
  const dueSoon: Dashboard['dueSoon'] = [];
  for (const r of allMemberRows(ws)) {
    counts[r.status]++;
    if (r.status !== 'active' || !r.paid_through) continue;
    const dueInDays = diffDays(todayDate, r.paid_through);
    if (dueInDays >= 0 && dueInDays < DUE_SOON_DAYS) dueSoon.push({ id: r.id, displayName: r.display_name, paidThrough: r.paid_through, dueInDays });
  }
  dueSoon.sort((a, b) => a.dueInDays - b.dueInDays || a.displayName.localeCompare(b.displayName));
  counts.dueSoon = dueSoon.length;

  // Coarse SQL filter (UTC month ± a day), exact month in the workspace timezone in JS.
  const month = monthKey(todayDate);
  const rows = ws.sqlite
    .prepare(
      `SELECT amount_cents, received_at FROM payments
        WHERE account_id = ? AND member_id IS NOT NULL AND amount_cents IS NOT NULL
          AND status IN (${CREDITED.map(() => '?').join(',')}) AND received_at >= ?`,
    )
    .all(ws.accountId, ...CREDITED, addDays(`${month}-01`, -1)) as Array<{
    amount_cents: number;
    received_at: string;
  }>;
  const inMonth = rows.filter((r) => monthKey(localDate(r.received_at, settings.timezone)) === month);

  const reviews = reviewCounts(ws);
  const gmail = ws.sqlite.prepare('SELECT gmail_status FROM accounts WHERE id = ?').get(ws.accountId) as { gmail_status: GmailStatus };
  return {
    today: todayDate,
    counts,
    dueSoon: dueSoon.slice(0, 25),
    dueSoonDays: DUE_SOON_DAYS,
    paymentsThisMonth: { count: inMonth.length, totalCents: inMonth.reduce((s, r) => s + r.amount_cents, 0), currency: settings.memberDefaults.currency },
    reviewQueue: reviews.review,
    awaitingDeposit: reviews.awaiting,
    gmail: { status: gmail.gmail_status, scan: getScanState(ws) },
    emailQueue: queueStatus(ws, clock),
  };
}
