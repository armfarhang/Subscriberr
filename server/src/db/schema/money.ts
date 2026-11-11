import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { LedgerKind, MatchedBy, PaymentMessageType, PaymentSource, PaymentStatus } from '@subscriberr/shared';

export const gmailScanState = sqliteTable('gmail_scan_state', {
  accountId: integer('account_id').primaryKey(),
  lastHistoryId: text('last_history_id'),
  lastScanAt: text('last_scan_at'),
  lastSuccessAt: text('last_success_at'),
  lastError: text('last_error'),
});

export const payments = sqliteTable('payments', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  memberId: integer('member_id'),
  amountCents: integer('amount_cents'),
  currency: text('currency').notNull().default('CAD'),
  receivedAt: text('received_at').notNull(),
  senderName: text('sender_name'),
  senderEmail: text('sender_email'),
  interacReference: text('interac_reference'),
  gmailMessageId: text('gmail_message_id'),
  gmailThreadId: text('gmail_thread_id'),
  memo: text('memo'),
  messageType: text('message_type').$type<PaymentMessageType>().notNull(),
  expiresOn: text('expires_on'),
  status: text('status').$type<PaymentStatus>().notNull(),
  matchedBy: text('matched_by').$type<MatchedBy>(),
  matchedRuleId: integer('matched_rule_id'),
  reviewReason: text('review_reason'),
  resolvedBy: text('resolved_by'),
  resolvedAt: text('resolved_at'),
  voidReason: text('void_reason'),
  source: text('source').$type<PaymentSource>().notNull(),
  rawSnapshot: text('raw_snapshot', { mode: 'json' }),
  createdAt: text('created_at').notNull(),
});

export const ledgerEntries = sqliteTable('ledger_entries', {
  // identity
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  memberId: integer('member_id').notNull(),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').notNull(),
  note: text('note'),
  // inputs (immutable)
  kind: text('kind').$type<LedgerKind>().notNull(),
  paymentId: integer('payment_id'),
  reversesEntryId: integer('reverses_entry_id'),
  effectiveAt: text('effective_at').notNull(),
  amountCents: integer('amount_cents').notNull().default(0),
  planAmountSnapshotCents: integer('plan_amount_snapshot_cents'),
  periodDaysSnapshot: integer('period_days_snapshot'),
  toleranceSnapshotCents: integer('tolerance_snapshot_cents'),
  setPaidThrough: text('set_paid_through'),
  setCreditCents: integer('set_credit_cents'),
  adjustDays: integer('adjust_days'),
  adjustCreditCents: integer('adjust_credit_cents'),
  // outputs (rewritten only by replay)
  periodsApplied: integer('periods_applied').notNull().default(0),
  daysDelta: integer('days_delta').notNull().default(0),
  creditDeltaCents: integer('credit_delta_cents').notNull().default(0),
  forgivenCents: integer('forgiven_cents').notNull().default(0),
  paidThroughBefore: text('paid_through_before'),
  paidThroughAfter: text('paid_through_after'),
  creditBeforeCents: integer('credit_before_cents').notNull().default(0),
  creditAfterCents: integer('credit_after_cents').notNull().default(0),
});
