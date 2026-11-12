import { z } from 'zod';
import { MEMO_MODES, PAYMENT_STATUSES, RULE_ACTIONS, type MatchedBy, type PaymentMessageType, type PaymentSource, type PaymentStatus } from '../enums.js';

// Payments, the Review Queue, matching rules and mailbox scanning (Spec §7, §8.4).

export interface PaymentView {
  id: number;
  memberId: number | null;
  memberName: string | null;
  amountCents: number | null;
  currency: string;
  receivedAt: string;
  senderName: string | null;
  senderEmail: string | null;
  reference: string | null;
  /** Auto-deposit only (§7.2). */
  memo: string | null;
  messageType: PaymentMessageType;
  expiresOn: string | null;
  status: PaymentStatus;
  matchedBy: MatchedBy | null;
  matchedRuleId: number | null;
  reviewReason: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  voidReason: string | null;
  source: PaymentSource;
  createdAt: string;
  /** A fuzzy near-miss proposed by the matcher (never applied by itself). */
  proposal: { memberId: number; displayName: string; score: number } | null;
  /** Gmail's authenticity verdict, for e-Transfers. */
  auth: { ok: boolean; reason: string | null; dkim: string; dmarc: string | null } | null;
  /** True while it is waiting in the Review Queue. */
  inReview: boolean;
}

export const PAYMENT_TABS = ['all', 'review', 'awaiting'] as const;
export const paymentListQuerySchema = z.object({
  tab: z.enum(PAYMENT_TABS).default('all'),
  status: z.enum(PAYMENT_STATUSES).optional(),
  memberId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type PaymentListQuery = z.input<typeof paymentListQuerySchema>;

export interface PaymentList {
  items: PaymentView[];
  total: number;
  page: number;
  pageSize: number;
  counts: { review: number; awaiting: number };
}

/** Review Queue resolutions (§7.5). */
export const resolvePaymentSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('assign'),
      memberId: z.number().int().positive(),
      /** Remember the sender name / email as aliases of this member. */
      rememberSender: z.boolean().default(false),
      /** Required to approve a payment that failed the authenticity check (§7.5). */
      verifiedInBank: z.boolean().default(false),
    })
    .strict(),
  z.object({ action: z.literal('dismiss'), note: z.string().trim().max(500).optional() }).strict(),
]);
export type ResolvePayment = z.input<typeof resolvePaymentSchema>;

// ---- Rules ----------------------------------------------------------------------------------

const optionalCents = z.number().int().min(0).max(100_000_000).nullable();

export const ruleFieldsSchema = z
  .object({
    memberId: z.number().int().positive(),
    label: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    priority: z.number().int().min(0).max(10_000).default(100),
    senderName: z.string().trim().max(100).nullable().default(null),
    senderEmail: z.string().trim().toLowerCase().pipe(z.email()).nullable().default(null),
    memoMode: z.enum(MEMO_MODES).nullable().default(null),
    memoValue: z.string().trim().max(200).nullable().default(null),
    amountMinCents: optionalCents.default(null),
    amountMaxCents: optionalCents.default(null),
    action: z.enum(RULE_ACTIONS).default('assign'),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.memoMode === null) !== (r.memoValue === null || r.memoValue === '')) ctx.addIssue({ code: 'custom', path: ['memoValue'], message: 'Set both the memo condition and its value, or neither' });
    if (r.amountMinCents !== null && r.amountMaxCents !== null && r.amountMinCents > r.amountMaxCents) ctx.addIssue({ code: 'custom', path: ['amountMaxCents'], message: 'Maximum is below minimum' });
  });
export type RuleFields = z.input<typeof ruleFieldsSchema>;

export interface MatchingRuleView {
  id: number;
  memberId: number;
  memberName: string;
  label: string;
  enabled: boolean;
  priority: number;
  managed: boolean;
  senderName: string | null;
  senderEmail: string | null;
  memoMode: (typeof MEMO_MODES)[number] | null;
  memoValue: string | null;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  action: (typeof RULE_ACTIONS)[number];
}

/** Rule tester (§7.4.1): a past payment, or sample facts. */
export const ruleTestSchema = z
  .object({
    paymentId: z.number().int().positive().optional(),
    senderName: z.string().max(200).optional(),
    senderEmail: z.string().max(200).optional(),
    memo: z.string().max(500).optional(),
    amountCents: z.number().int().min(0).optional(),
  })
  .strict();
export type RuleTest = z.infer<typeof ruleTestSchema>;

export interface RuleTestResult {
  facts: { senderName: string | null; senderEmail: string | null; memo: string | null; amountCents: number | null };
  rules: Array<{ id: number; label: string; memberName: string; matches: boolean; why: string | null }>;
  decision: { status: string; memberId: number | null; memberName: string | null; matchedBy: string | null; ruleId: number | null; reason: string | null };
}

// ---- Scanning ---------------------------------------------------------------------------------

export interface ScanStats {
  messages: number;
  known: number;
  ignored: number;
  stored: number;
  matched: number;
  review: number;
  pendingDeposit: number;
  duplicate: number;
  rejected: number;
  errors: number;
}

export interface ScanState {
  lastScanAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  running: boolean;
}

export const rescanSchema = z
  .object({
    since: z.iso.date(),
    dryRun: z.boolean().default(true),
  })
  .strict();
export type Rescan = z.input<typeof rescanSchema>;

export interface RescanResult {
  dryRun: boolean;
  since: string;
  stats: ScanStats;
  /** Dry run: the payments that would be added. */
  preview: Array<{ receivedAt: string; senderName: string | null; amountCents: number | null; status: string; memberName: string | null }>;
}



