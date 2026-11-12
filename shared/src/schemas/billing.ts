import { z } from 'zod';
import type { LedgerKind } from '../enums.js';

// Billing actions (Spec §8): manual payments, voids, deposits, balance corrections, ledger history.

const note = z.string().trim().max(500);
const isoDate = z.iso.date();

export const manualPaymentSchema = z
  .object({ memberId: z.number().int().positive(), amountCents: z.number().int().positive().max(100_000_000), date: isoDate, note: note.nullable().default(null) })
  .strict();
export type ManualPayment = z.input<typeof manualPaymentSchema>;

export const voidPaymentSchema = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(500) }).strict();
export type VoidPayment = z.infer<typeof voidPaymentSchema>;

/** "Mark as deposited" (§8.4): the amount may be corrected to match the bank; the date defaults to today. */
export const markDepositedSchema = z
  .object({ amountCents: z.number().int().positive().max(100_000_000).optional(), date: isoDate.optional(), memberId: z.number().int().positive().optional() })
  .strict();
export type MarkDeposited = z.infer<typeof markDepositedSchema>;

export const balanceAdjustSchema = z
  .object({ days: z.number().int().min(-3650).max(3650).default(0), creditCents: z.number().int().min(-100_000_000).max(100_000_000).default(0), note: z.string().trim().min(1, 'Add a note').max(500) })
  .strict()
  .refine((v) => v.days !== 0 || v.creditCents !== 0, { message: 'Nothing to adjust' });
export type BalanceAdjust = z.input<typeof balanceAdjustSchema>;

export const balanceSetSchema = z
  .object({ paidThrough: isoDate.optional(), creditCents: z.number().int().min(0).max(100_000_000).optional(), note: z.string().trim().min(1, 'Add a note').max(500) })
  .strict()
  .refine((v) => v.paidThrough !== undefined || v.creditCents !== undefined, { message: 'Nothing to set' });
export type BalanceSet = z.infer<typeof balanceSetSchema>;

export interface LedgerOutputView {
  periodsApplied: number;
  daysDelta: number;
  creditDeltaCents: number;
  forgivenCents: number;
  paidThroughBefore: string | null;
  paidThroughAfter: string | null;
  creditBeforeCents: number;
  creditAfterCents: number;
}

export interface LedgerEntryView {
  id: number;
  kind: LedgerKind;
  effectiveAt: string;
  createdAt: string;
  createdBy: string;
  note: string | null;
  paymentId: number | null;
  reversesEntryId: number | null;
  /** True when a later `void` entry reversed this one. */
  reversed: boolean;
  amountCents: number;
  output: LedgerOutputView;
}
