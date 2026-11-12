import { diffDays, type LedgerKind } from '@subscriberr/shared';

// The pure billing engine (Spec §6.5a, §8). Given a member's ordered ledger inputs it computes
// every entry's outputs and the final cached state. No DB, no clock, no I/O.
//
// Milestone 4 needs only `manual_set` (opening balances / CSV import) and `void`. Payments and
// relative adjustments are added with the billing engine milestone (M6); until then the engine
// refuses them loudly instead of guessing.

export interface LedgerState {
  paidThrough: string | null;
  creditCents: number;
}

export interface LedgerEntryInput {
  id: number;
  kind: LedgerKind;
  effectiveAt: string;
  reversesEntryId: number | null;
  setPaidThrough: string | null;
  setCreditCents: number | null;
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

export const EMPTY_LEDGER_STATE: LedgerState = { paidThrough: null, creditCents: 0 };

function passthrough(state: LedgerState): LedgerEntryOutput {
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

/** Orders entries by (effective_at, id), the replay order of §6.5a. */
export function sortEntries<T extends Pick<LedgerEntryInput, 'id' | 'effectiveAt'>>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : a.id - b.id));
}

/**
 * Replays a member's ledger. A `void` entry and the entry it reverses are both skipped (their
 * outputs show no change), so voiding is exactly "as if the entry never happened".
 */
export function replayLedger(entries: LedgerEntryInput[], start: LedgerState = EMPTY_LEDGER_STATE): ReplayResult {
  const reversed = new Set(entries.filter((e) => e.kind === 'void' && e.reversesEntryId !== null).map((e) => e.reversesEntryId!));
  const outputs = new Map<number, LedgerEntryOutput>();
  let state: LedgerState = { ...start };

  for (const e of sortEntries(entries)) {
    if (e.kind === 'void' || reversed.has(e.id)) {
      outputs.set(e.id, passthrough(state));
      continue;
    }
    if (e.kind === 'manual_set') {
      const next: LedgerState = {
        paidThrough: e.setPaidThrough ?? state.paidThrough,
        creditCents: e.setCreditCents ?? state.creditCents,
      };
      outputs.set(e.id, {
        ...passthrough(state),
        daysDelta: state.paidThrough && next.paidThrough ? diffDays(state.paidThrough, next.paidThrough) : 0,
        creditDeltaCents: next.creditCents - state.creditCents,
        paidThroughAfter: next.paidThrough,
        creditAfterCents: next.creditCents,
      });
      state = next;
      continue;
    }
    throw new Error(`Ledger entry #${e.id} has kind "${e.kind}", which this version of the billing engine cannot replay yet.`);
  }
  return { outputs, final: state };
}
