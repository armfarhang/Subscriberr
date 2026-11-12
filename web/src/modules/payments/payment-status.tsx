import type { PaymentStatus, PaymentView } from '@subscriberr/shared';
import { formatCents } from '@subscriberr/shared';
import { Badge, type BadgeProps } from '@/components/ui/badge';

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  matched: 'Matched',
  unmatched: 'Unmatched',
  needs_review: 'Needs review',
  underpaid: 'Underpaid',
  overpaid: 'Overpaid',
  pending_deposit: 'Awaiting deposit',
  expired: 'Expired',
  duplicate: 'Duplicate',
  rejected: 'Rejected',
  manual: 'Manual',
  voided: 'Voided',
};

const VARIANT: Record<PaymentStatus, BadgeProps['variant']> = {
  matched: 'success',
  manual: 'success',
  overpaid: 'success',
  underpaid: 'warning',
  pending_deposit: 'warning',
  needs_review: 'warning',
  unmatched: 'warning',
  duplicate: 'neutral',
  expired: 'neutral',
  voided: 'neutral',
  rejected: 'destructive',
};

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return <Badge variant={VARIANT[status]}>{PAYMENT_STATUS_LABEL[status]}</Badge>;
}

export const paymentAmount = (p: Pick<PaymentView, 'amountCents' | 'currency'>) => (p.amountCents === null ? '—' : formatCents(p.amountCents, p.currency));
