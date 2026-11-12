import type { MemberStatus, MemberSummary } from '@subscriberr/shared';
import { formatCents } from '@subscriberr/shared';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { formatDate } from '@/lib/format';

export const STATUS_LABEL: Record<MemberStatus, string> = {
  active: 'Active',
  grace: 'Grace period',
  expired: 'Expired',
  paused: 'Paused',
  archived: 'Archived',
};

const STATUS_VARIANT: Record<MemberStatus, BadgeProps['variant']> = {
  active: 'success',
  grace: 'warning',
  expired: 'destructive',
  paused: 'neutral',
  archived: 'neutral',
};

export function StatusBadge({ status }: { status: MemberStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>;
}

/** "Due in 8 days", "Due today", "3 days overdue", "No payment yet". */
export function dueLabel(m: Pick<MemberSummary, 'paidThrough' | 'dueInDays'>): string {
  if (m.paidThrough === null || m.dueInDays === null) return 'No payment yet';
  const d = m.dueInDays;
  if (d === 0) return 'Due today';
  if (d === 1) return 'Due tomorrow';
  if (d > 1) return `Due in ${d} days`;
  return d === -1 ? '1 day overdue' : `${-d} days overdue`;
}

export function DueCell({ m }: { m: Pick<MemberSummary, 'paidThrough' | 'dueInDays' | 'status'> }) {
  const overdue = m.dueInDays !== null && m.dueInDays < 0 && m.status !== 'paused' && m.status !== 'archived';
  return (
    <div className="leading-tight">
      <div className={overdue ? 'text-destructive' : undefined}>{dueLabel(m)}</div>
      {m.paidThrough && <div className="text-xs text-muted-foreground">{formatDate(m.paidThrough)}</div>}
    </div>
  );
}

/** "$15.00 / 30 days", or "$15.00 / month" for the presets. */
export function planLabel(m: Pick<MemberSummary, 'terms' | 'currency'>): string {
  const amount = m.terms.planAmountCents.value;
  const days = m.terms.planPeriodDays.value;
  const period = days === 30 ? 'month' : days === 365 ? 'year' : `${days} days`;
  return amount === null ? `No amount / ${period}` : `${formatCents(amount, m.currency)} / ${period}`;
}
