import { addDays, diffDays, type LedgerKind, localDate } from '@subscriberr/shared';

// The pure billing engine (Spec §6.5a, §8). Given a member's ledger inputs it computes every
// entry's outputs and the final cached state. No DB, no clock, no I/O: the same code applies live
// payments, voids and the nightly verification.

export interface LedgerState {
  paidThrough: string | null;
  creditCents: number;
  /** effective_at of the latest applied payment (cache `last_payment_at`). */
  lastPaymentAt: string | null;
}

export interface LedgerEntryInput {
  id: number;
  kind: LedgerKind;
  /** Ordering key; for payments the moment the money arrived. */
  effectiveAt: string;
  reversesEntryId: number | null;
  amountCents?: number;
  planAmountSnapshotCents?: number | null;
  periodDaysSnapshot?: number | null;
  toleranceSnapshotCents?: number | null;
  setPaidThrough: string | null;
  setCreditCents: number | null;
  adjustDays?: number | null;
  adjustCreditCents?: number | null;
}

export interface LedgerEntryOutput {
  periodsApplied: number;
  daysDelta: number;
  creditDeltaCents: number;
  forgivenCents: number;
  paidThroughBefore: string | null;
  paidThroughAfter: string | null;
  creditBeforeCents: number;
  creditAfterCents: number;
}

export interface ReplayResult {
  outputs: Map<number, LedgerEntryOutput>;
  final: LedgerState;
}

export const EMPTY_LEDGER_STATE: LedgerState = { paidThrough: null, creditCents: 0, lastPaymentAt: null };

export interface PaymentTerms {
  amountCents: number;
  creditBeforeCents: number;
  planAmountCents: number;
  periodDays: number;
  toleranceCents: number;
  /** Payment day in the workspace timezone. */
  paymentDate: string;
  paidThroughBefore: string | null;
}

export interface PaymentEffect {
  periods: number;
  paidThroughAfter: string | null;
  creditAfterCents: number;
  forgivenCents: number;
}

/**
 * §8.1–§8.2 for one payment. P = payment + existing credit, A = plan amount, T = tolerance.
 * n = floor((P + T) / A). n ≥ 1 → extend n periods (stacking on an unexpired due date, from the
 * payment date otherwise); the remainder max(P − n·A, 0) stays as credit and any shortfall within
 * tolerance is forgiven. n = 0 → deficit: nothing extends and everything is held as credit.
 */
export function applyPaymentTerms(t: PaymentTerms): PaymentEffect {
  if (!Number.isInteger(t.planAmountCents) || t.planAmountCents <= 0) throw new Error('A payment needs a positive plan amount');
  if (!Number.isInteger(t.periodDays) || t.periodDays <= 0) throw new Error('A payment needs a positive period');
  const p = t.amountCents + t.creditBeforeCents;
  const n = Math.floor((p + t.toleranceCents) / t.planAmountCents);
  if (n < 1) return { periods: 0, paidThroughAfter: t.paidThroughBefore, creditAfterCents: p, forgivenCents: 0 };
  const lapsed = t.paidThroughBefore === null || t.paidThroughBefore < t.paymentDate;
  const base = lapsed ? t.paymentDate : t.paidThroughBefore!;
  return {
    periods: n,
    paidThroughAfter: addDays(base, n * t.periodDays),
    creditAfterCents: Math.max(p - n * t.planAmountCents, 0),
    forgivenCents: Math.max(n * t.planAmountCents - p, 0),
  };
}

/** Orders entries by (effective_at, id), the replay order of §6.5a. */
export function sortEntries<T extends Pick<LedgerEntryInput, 'id' | 'effectiveAt'>>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : a.id - b.id));
}

function unchanged(state: LedgerState): LedgerEntryOutput {
  return {
    periodsApplied: 0,
    daysDelta: 0,
    creditDeltaCents: 0,
    forgivenCents: 0,
    paidThroughBefore: state.paidThrough,
    paidThroughAfter: state.paidThrough,
    creditBeforeCents: state.creditCents,
    creditAfterCents: state.creditCents,
  };
}

/**
 * Replays a member's ledger. A `void` entry and the entry it reverses are both skipped, so voiding
 * is exactly "as if the entry never happened" (later entries are recomputed on top).
 */
export function replayLedger(entries: LedgerEntryInput[], timeZone: string, start: LedgerState = EMPTY_LEDGER_STATE): ReplayResult {
  const reversed = new Set(entries.filter((e) => e.kind === 'void' && e.reversesEntryId !== null).map((e) => e.reversesEntryId!));
  const outputs = new Map<number, LedgerEntryOutput>();
  let state: LedgerState = { ...start };

  for (const e of sortEntries(entries)) {
    const before = unchanged(state);
    if (e.kind === 'void' || reversed.has(e.id)) {
      outputs.set(e.id, before);
      continue;
    }
    let next: LedgerState;
    let extra: Partial<LedgerEntryOutput> = {};
    switch (e.kind) {
      case 'manual_set':
        next = { ...state, paidThrough: e.setPaidThrough ?? state.paidThrough, creditCents: e.setCreditCents ?? state.creditCents };
        break;
      case 'manual_adjust': {
        const days = e.adjustDays ?? 0;
        const paidThrough = days === 0 ? state.paidThrough : addDays(state.paidThrough ?? localDate(e.effectiveAt, timeZone), days);
        // Credit never goes below zero, even if an earlier entry was voided since (§6.0 CHECK).
        next = { ...state, paidThrough, creditCents: Math.max(state.creditCents + (e.adjustCreditCents ?? 0), 0) };
        break;
      }
      case 'payment': {
        const effect = applyPaymentTerms({
          amountCents: e.amountCents ?? 0,
          creditBeforeCents: state.creditCents,
          planAmountCents: e.planAmountSnapshotCents ?? 0,
          periodDays: e.periodDaysSnapshot ?? 0,
          toleranceCents: e.toleranceSnapshotCents ?? 0,
          paymentDate: localDate(e.effectiveAt, timeZone),
          paidThroughBefore: state.paidThrough,
        });
        next = { paidThrough: effect.paidThroughAfter, creditCents: effect.creditAfterCents, lastPaymentAt: !state.lastPaymentAt || e.effectiveAt > state.lastPaymentAt ? e.effectiveAt : state.lastPaymentAt };
        extra = { periodsApplied: effect.periods, forgivenCents: effect.forgivenCents };
        break;
      }
      default:
        throw new Error(`Unknown ledger entry kind "${String(e.kind)}"`);
    }
    outputs.set(e.id, {
      ...before,
      ...extra,
      daysDelta: state.paidThrough && next.paidThrough ? diffDays(state.paidThrough, next.paidThrough) : 0,
      creditDeltaCents: next.creditCents - state.creditCents,
      paidThroughAfter: next.paidThrough,
      creditAfterCents: next.creditCents,
    });
    state = next;
  }
  return { outputs, final: state };
}
