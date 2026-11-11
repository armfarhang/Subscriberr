import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AliasKind, AliasSource, MemberStatus, MemoMode, RuleAction } from '@subscriberr/shared';

export const members = sqliteTable('members', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  displayName: text('display_name').notNull(),
  etransferName: text('etransfer_name'),
  paymentMemoCode: text('payment_memo_code'),
  email: text('email'),
  notes: text('notes'),
  planAmountCents: integer('plan_amount_cents'),
  planPeriodDays: integer('plan_period_days'),
  currency: text('currency').notNull().default('CAD'),
  toleranceCents: integer('tolerance_cents'),
  graceDays: integer('grace_days'),
  // Caches derived from ledger_entries — written only by the billing module (§6.5a).
  lastPaymentAt: text('last_payment_at'),
  paidThrough: text('paid_through'),
  creditCents: integer('credit_cents').notNull().default(0),
  status: text('status').$type<MemberStatus>().notNull().default('expired'),
  remindersEnabled: integer('reminders_enabled', { mode: 'boolean' }).notNull().default(true),
  emailsEnabled: integer('emails_enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  importBatchId: integer('import_batch_id'),
});

export const memberAliases = sqliteTable('member_aliases', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  memberId: integer('member_id').notNull(),
  kind: text('kind').$type<AliasKind>().notNull(),
  value: text('value').notNull(),
  source: text('source').$type<AliasSource>().notNull().default('manual'),
  createdAt: text('created_at').notNull(),
});

export const matchingRules = sqliteTable('matching_rules', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  memberId: integer('member_id').notNull(),
  label: text('label').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  priority: integer('priority').notNull().default(100),
  managed: integer('managed', { mode: 'boolean' }).notNull().default(false),
  senderName: text('sender_name'),
  senderEmail: text('sender_email'),
  memoMode: text('memo_mode').$type<MemoMode>(),
  memoValue: text('memo_value'),
  amountMinCents: integer('amount_min_cents'),
  amountMaxCents: integer('amount_max_cents'),
  action: text('action').$type<RuleAction>().notNull().default('assign'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
