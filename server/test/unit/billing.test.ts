import { describe, expect, it } from 'vitest';
import { applyPaymentTerms, type LedgerEntryInput, replayLedger } from '../../src/modules/billing/engine.js';

const base = { creditBeforeCents: 0, planAmountCents: 1500, periodDays: 30, toleranceCents: 0, paymentDate: '2026-11-01', paidThroughBefore: null as string | null };

describe('applying a payment (Spec §8.1–§8.2)', () => {
  const cases: Array<[string, Partial<typeof base> & { amountCents: number }, { periods: number; paidThroughAfter: string | null; creditAfterCents: number; forgivenCents: number }]> = [
    ['exact, first payment', { amountCents: 1500 }, { periods: 1, paidThroughAfter: '2026-12-01', creditAfterCents: 0, forgivenCents: 0 }],
    ['overpaid keeps the rest as credit', { amountCents: 2000 }, { periods: 1, paidThroughAfter: '2026-12-01', creditAfterCents: 500, forgivenCents: 0 }],
    ['multi-period', { amountCents: 4500 }, { periods: 3, paidThroughAfter: '2027-01-30', creditAfterCents: 0, forgivenCents: 0 }],
    ['deficit holds everything as credit, no extension', { amountCents: 1000 }, { periods: 0, paidThroughAfter: null, creditAfterCents: 1000, forgivenCents: 0 }],
    ['within tolerance counts as paid; the difference is forgiven, not credit', { amountCents: 1450, toleranceCents: 50 }, { periods: 1, paidThroughAfter: '2026-12-01', creditAfterCents: 0, forgivenCents: 50 }],
    ['just outside tolerance is a deficit', { amountCents: 1449, toleranceCents: 50 }, { periods: 0, paidThroughAfter: null, creditAfterCents: 1449, forgivenCents: 0 }],
    ['credit tops up a later payment', { amountCents: 500, creditBeforeCents: 1000 }, { periods: 1, paidThroughAfter: '2026-12-01', creditAfterCents: 0, forgivenCents: 0 }],
    ['early payment stacks on the current due date', { amountCents: 1500, paidThroughBefore: '2026-11-20' }, { periods: 1, paidThroughAfter: '2026-12-20', creditAfterCents: 0, forgivenCents: 0 }],
    ['payment on the due date still stacks', { amountCents: 1500, paidThroughBefore: '2026-11-01' }, { periods: 1, paidThroughAfter: '2026-12-01', creditAfterCents: 0, forgivenCents: 0 }],
    ['lapsed: restarts from the payment date', { amountCents: 1500, paidThroughBefore: '2026-10-01' }, { periods: 1, paidThroughAfter: '2026-12-01', creditAfterCents: 0, forgivenCents: 0 }],
    ['yearly plan', { amountCents: 15000, planAmountCents: 15000, periodDays: 365 }, { periods: 1, paidThroughAfter: '2027-11-01', creditAfterCents: 0, forgivenCents: 0 }],
    ['deficit keeps an existing due date', { amountCents: 100, paidThroughBefore: '2026-11-20' }, { periods: 0, paidThroughAfter: '2026-11-20', creditAfterCents: 100, forgivenCents: 0 }],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => expect(applyPaymentTerms({ ...base, ...input })).toEqual(expected));
  }
  it('refuses to apply without a plan amount', () => {
    expect(() => applyPaymentTerms({ ...base, amountCents: 1500, planAmountCents: 0 })).toThrow(/plan amount/);
  });
});

const pay = (id: number, at: string, amountCents: number, plan = 1500): LedgerEntryInput => ({
  id,
  kind: 'payment',
  effectiveAt: at,
  reversesEntryId: null,
  amountCents,
  planAmountSnapshotCents: plan,
  periodDaysSnapshot: 30,
  toleranceSnapshotCents: 0,
  setPaidThrough: null,
  setCreditCents: null,
});
const voidOf = (id: number, at: string, target: number): LedgerEntryInput => ({ id, kind: 'void', effectiveAt: at, reversesEntryId: target, setPaidThrough: null, setCreditCents: null });

describe('replay', () => {
  it('uses the workspace timezone for the payment day', () => {
    // 03:00 UTC on Nov 2 is still Nov 1 in Toronto.
    expect(replayLedger([pay(1, '2026-11-02T03:00:00Z', 1500)], 'America/Toronto').final.paidThrough).toBe('2026-12-01');
    expect(replayLedger([pay(1, '2026-11-02T03:00:00Z', 1500)], 'UTC').final.paidThrough).toBe('2026-12-02');
  });

  it('voiding a mid-stack payment replays the later ones on top', () => {
    const entries = [pay(1, '2026-01-01T12:00:00Z', 1500), pay(2, '2026-01-10T12:00:00Z', 1500), pay(3, '2026-01-20T12:00:00Z', 1500)];
    expect(replayLedger(entries, 'UTC').final.paidThrough).toBe('2026-04-01');
    const r = replayLedger([...entries, voidOf(4, '2026-02-01T00:00:00Z', 2)], 'UTC');
    expect(r.final).toEqual({ paidThrough: '2026-03-02', creditCents: 0, lastPaymentAt: '2026-01-20T12:00:00Z' });
    expect(r.outputs.get(3)).toMatchObject({ paidThroughBefore: '2026-01-31', paidThroughAfter: '2026-03-02', periodsApplied: 1 });
    expect(r.outputs.get(2)).toMatchObject({ periodsApplied: 0, paidThroughBefore: r.outputs.get(2)!.paidThroughAfter });
  });

  it('a payment arriving later but dated earlier is placed in date order (rescan)', () => {
    const a = replayLedger([pay(2, '2026-02-01T12:00:00Z', 1500), pay(1, '2026-01-01T12:00:00Z', 1500)], 'UTC');
    expect(a.final.paidThrough).toBe('2026-03-03'); // Jan 1 → Jan 31 (lapsed by Feb 1) → Feb 1 + 30
  });

  it('manual adjustments move the due date and credit, never below zero', () => {
    const adjust = (id: number, days: number, credit: number): LedgerEntryInput => ({
      id,
      kind: 'manual_adjust',
      effectiveAt: `2026-03-0${id}T00:00:00Z`,
      reversesEntryId: null,
      setPaidThrough: null,
      setCreditCents: null,
      adjustDays: days,
      adjustCreditCents: credit,
    });
    const r = replayLedger([pay(1, '2026-01-01T12:00:00Z', 2000), adjust(2, 7, -200), adjust(3, 0, -900)], 'UTC');
    expect(r.final).toMatchObject({ paidThrough: '2026-02-07', creditCents: 0 });
  });
});
