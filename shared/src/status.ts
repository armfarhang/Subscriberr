import { addDays } from './dates.js';
import type { MemberStatus } from './enums.js';

/**
 * The automatic part of the status lifecycle (Spec §8.3), as a pure function of the due date.
 * `paused` and `archived` are manual and never produced here.
 * - no paid-through date → expired
 * - today ≤ paid_through → active
 * - paid_through < today ≤ paid_through + grace_days → grace
 * - otherwise → expired
 */
export function derivedStatus(paidThrough: string | null, graceDays: number, today: string): Extract<MemberStatus, 'active' | 'grace' | 'expired'> {
  if (!paidThrough) return 'expired';
  if (today <= paidThrough) return 'active';
  if (today <= addDays(paidThrough, graceDays)) return 'grace';
  return 'expired';
}
