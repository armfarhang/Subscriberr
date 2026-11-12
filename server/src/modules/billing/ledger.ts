import { derivedStatus, isIsoDate, localDate, type MemberStatus, type PaymentStatus } from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { type Clock, nowIso, today } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import { resolveTerms } from '../members/members.js';
import { getWorkspaceSettings } from '../workspaces/settings.js';
import { type LedgerEntryInput, type LedgerEntryOutput, type LedgerState, replayLedger } from './engine.js';

// The ONLY writer of ledger entries and of the member balance caches (paid_through,
// credit_cents, last_payment_at) — Spec §6.5a. Every change is an entry plus a full replay of the
// member's ledger, so live results and the nightly verification use the same code.

/** What happened, for emails (M7) and media access (M9). */
export interface BillingEvents {
  paymentApplied?: (ws: WorkspaceContext, e: PaymentAppliedEvent) => void;
  statusChanged?: (ws: WorkspaceContext, e: { memberId: number; from: MemberStatus; to: MemberStatus }) => void;
}

export interface PaymentAppliedEvent {
  paymentId: number;
  memberId: number;
  entryId: number;
  output: LedgerEntryOutput;
  amountCents: number;
  planAmountCents: number;
  /** Re-applied from "Rescan mailbox" (emails for old payments are not re-sent). */
  rescan: boolean;
  receivedAt: string;
}

export interface BillingDeps {
  clock: Clock;
  events?: BillingEvents;
}

interface EntryRow {
  id: number;
  kind: LedgerEntryInput['kind'];
  effective_at: string;
  reverses_entry_id: number | null;
  payment_id: number | null;
  amount_cents: number;
  plan_amount_snapshot_cents: number | null;
  period_days_snapshot: number | null;
  tolerance_snapshot_cents: number | null;
  set_paid_through: string | null;
  set_credit_cents: number | null;
  adjust_days: number | null;
  adjust_credit_cents: number | null;
}

const toInput = (r: EntryRow): LedgerEntryInput => ({
  id: r.id,
  kind: r.kind,
  effectiveAt: r.effective_at,
  reversesEntryId: r.reverses_entry_id,
  amountCents: r.amount_cents,
  planAmountSnapshotCents: r.plan_amount_snapshot_cents,
  periodDaysSnapshot: r.period_days_snapshot,
  toleranceSnapshotCents: r.tolerance_snapshot_cents,
  setPaidThrough: r.set_paid_through,
  setCreditCents: r.set_credit_cents,
  adjustDays: r.adjust_days,
  adjustCreditCents: r.adjust_credit_cents,
});

function entryRows(ws: WorkspaceContext, memberId: number): EntryRow[] {
  return ws.sqlite.prepare('SELECT * FROM ledger_entries WHERE account_id = ? AND member_id = ?').all(ws.accountId, memberId) as EntryRow[];
}

interface MemberBillingRow {
  status: MemberStatus;
  plan_amount_cents: number | null;
  plan_period_days: number | null;
  tolerance_cents: number | null;
  grace_days: number | null;
  paid_through: string | null;
  credit_cents: number;
  last_payment_at: string | null;
}

function memberRow(ws: WorkspaceContext, memberId: number): MemberBillingRow {
  const m = ws.sqlite
    .prepare('SELECT status, plan_amount_cents, plan_period_days, tolerance_cents, grace_days, paid_through, credit_cents, last_payment_at FROM members WHERE account_id = ? AND id = ?')
    .get(ws.accountId, memberId) as MemberBillingRow | undefined;
  if (!m) throw notFound('Member not found');
  return m;
}

/** Payment status after billing (§8.2): deficit → underpaid, credit left over → overpaid. */
function paymentStatusFor(o: LedgerEntryOutput, current: PaymentStatus): PaymentStatus {
  if (current === 'manual') return 'manual';
  if (o.periodsApplied === 0) return 'underpaid';
  // Money left over after the periods it paid for became (more) credit.
  return o.creditAfterCents > o.creditBeforeCents ? 'overpaid' : 'matched';
}

/** The automatic status of a member right now (manual statuses are kept). */
export function statusFor(ws: WorkspaceContext, clock: Clock, m: MemberBillingRow, paidThrough: string | null): MemberStatus {
  if (m.status === 'paused' || m.status === 'archived') return m.status;
  const settings = getWorkspaceSettings(ws);
  return derivedStatus(paidThrough, resolveTerms(m, settings.memberDefaults).graceDays.value, today(clock, settings.timezone));
}

/** Replays the member's ledger, rewrites every entry's outputs, the payment statuses and the member caches, and recomputes the status. */
export function recomputeMember(ws: WorkspaceContext, deps: BillingDeps, memberId: number): LedgerState & { status: MemberStatus } {
  const m = memberRow(ws, memberId);
  const rows = entryRows(ws, memberId);
  const { outputs, final } = replayLedger(rows.map(toInput), getWorkspaceSettings(ws).timezone);

  const writeOutputs = ws.sqlite.prepare(
    `UPDATE ledger_entries SET periods_applied = ?, days_delta = ?, credit_delta_cents = ?, forgiven_cents = ?, paid_through_before = ?, paid_through_after = ?,
       credit_before_cents = ?, credit_after_cents = ? WHERE account_id = ? AND id = ?`,
  );
  const reversed = new Set(rows.filter((r) => r.kind === 'void').map((r) => r.reverses_entry_id));
  for (const [id, o] of outputs) {
    writeOutputs.run(o.periodsApplied, o.daysDelta, o.creditDeltaCents, o.forgivenCents, o.paidThroughBefore, o.paidThroughAfter, o.creditBeforeCents, o.creditAfterCents, ws.accountId, id);
    const row = rows.find((r) => r.id === id)!;
    if (row.kind === 'payment' && row.payment_id !== null && !reversed.has(id)) {
      const p = ws.sqlite.prepare('SELECT status FROM payments WHERE account_id = ? AND id = ?').get(ws.accountId, row.payment_id) as { status: PaymentStatus };
      const next = paymentStatusFor(o, p.status);
      if (next !== p.status) ws.sqlite.prepare('UPDATE payments SET status = ? WHERE account_id = ? AND id = ?').run(next, ws.accountId, row.payment_id);
    }
  }

  const status = statusFor(ws, deps.clock, m, final.paidThrough);
  ws.sqlite
    .prepare('UPDATE members SET paid_through = ?, credit_cents = ?, last_payment_at = ?, status = ?, updated_at = ? WHERE account_id = ? AND id = ?')
    .run(final.paidThrough, final.creditCents, final.lastPaymentAt, status, nowIso(deps.clock), ws.accountId, memberId);
  if (status !== m.status) {
    writeAudit(ws, deps.clock, { actor: 'system', action: 'member.status_changed', entity: 'member', entityId: memberId, details: { action: 'recompute', from: m.status, to: status } });
    deps.events?.statusChanged?.(ws, { memberId, from: m.status, to: status });
  }
  return { ...final, status };
}

function insertEntry(ws: WorkspaceContext, clock: Clock, actor: string, memberId: number, e: Partial<EntryRow> & { kind: EntryRow['kind']; effective_at: string; note: string | null }): number {
  return Number(
    ws.sqlite
      .prepare(
        `INSERT INTO ledger_entries (account_id, member_id, created_at, created_by, note, kind, payment_id, reverses_entry_id, effective_at, amount_cents,
           plan_amount_snapshot_cents, period_days_snapshot, tolerance_snapshot_cents, set_paid_through, set_credit_cents, adjust_days, adjust_credit_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ws.accountId,
        memberId,
        nowIso(clock),
        actor,
        e.note,
        e.kind,
        e.payment_id ?? null,
        e.reverses_entry_id ?? null,
        e.effective_at,
        e.amount_cents ?? 0,
        e.plan_amount_snapshot_cents ?? null,
        e.period_days_snapshot ?? null,
        e.tolerance_snapshot_cents ?? null,
        e.set_paid_through ?? null,
        e.set_credit_cents ?? null,
        e.adjust_days ?? null,
        e.adjust_credit_cents ?? null,
      ).lastInsertRowid,
  );
}

export interface ManualSetInput {
  /** New paid-through date (YYYY-MM-DD); undefined = unchanged. */
  paidThrough?: string;
  /** New credit in cents (≥ 0); undefined = unchanged. */
  creditCents?: number;
  note: string;
}

/** An absolute paid-through and/or credit (opening balance, CSV import, correction). Returns the entry id. */
export function recordManualSet(ws: WorkspaceContext, clock: Clock | BillingDeps, actor: string, memberId: number, input: ManualSetInput): number {
  const deps = 'now' in clock ? { clock } : clock;
  if (input.paidThrough === undefined && input.creditCents === undefined) throw badRequest('Nothing to set');
  if (input.paidThrough !== undefined && !isIsoDate(input.paidThrough)) throw badRequest('The paid-through date must be YYYY-MM-DD');
  if (input.creditCents !== undefined && (!Number.isInteger(input.creditCents) || input.creditCents < 0)) throw badRequest('Credit must be a whole number of cents ≥ 0');
  memberRow(ws, memberId);
  return ws.sqlite.transaction(() => {
    const id = insertEntry(ws, deps.clock, actor, memberId, { kind: 'manual_set', effective_at: nowIso(deps.clock), note: input.note, set_paid_through: input.paidThrough ?? null, set_credit_cents: input.creditCents ?? null });
    const after = recomputeMember(ws, deps, memberId);
    writeAudit(ws, deps.clock, {
      actor,
      action: 'ledger.manual_set',
      entity: 'member',
      entityId: memberId,
      details: { entryId: id, paidThrough: input.paidThrough ?? null, creditCents: input.creditCents ?? null, note: input.note, result: after },
    });
    return id;
  })();
}

/** A relative correction: ± days on the due date and/or ± credit (§8.2). */
export function recordManualAdjust(ws: WorkspaceContext, deps: BillingDeps, actor: string, memberId: number, input: { days?: number; creditCents?: number; note: string }): number {
  const days = input.days ?? 0;
  const credit = input.creditCents ?? 0;
  if (days === 0 && credit === 0) throw badRequest('Nothing to adjust');
  if (!Number.isInteger(days) || !Number.isInteger(credit) || Math.abs(days) > 3650) throw badRequest('Use whole days (up to ±3650) and whole cents');
  const m = memberRow(ws, memberId);
  if (m.credit_cents + credit < 0) throw badRequest(`Credit cannot go below zero (it is ${m.credit_cents} cents).`);
  return ws.sqlite.transaction(() => {
    const id = insertEntry(ws, deps.clock, actor, memberId, { kind: 'manual_adjust', effective_at: nowIso(deps.clock), note: input.note, adjust_days: days || null, adjust_credit_cents: credit || null });
    const after = recomputeMember(ws, deps, memberId);
    writeAudit(ws, deps.clock, { actor, action: 'ledger.manual_adjust', entity: 'member', entityId: memberId, details: { entryId: id, days, creditCents: credit, note: input.note, result: after } });
    return id;
  })();
}

/** Reverses an entry (a `void` entry) and replays. The original entry stays in the history. */
export function voidLedgerEntry(ws: WorkspaceContext, clock: Clock | BillingDeps, actor: string, entryId: number, note: string): number {
  const deps = 'now' in clock ? { clock } : clock;
  const entry = ws.sqlite.prepare('SELECT id, member_id, kind FROM ledger_entries WHERE account_id = ? AND id = ?').get(ws.accountId, entryId) as
    | { id: number; member_id: number; kind: string }
    | undefined;
  if (!entry) throw notFound('Ledger entry not found');
  if (entry.kind === 'void') throw badRequest('A void entry cannot itself be voided');
  const already = ws.sqlite.prepare('SELECT id FROM ledger_entries WHERE account_id = ? AND reverses_entry_id = ?').get(ws.accountId, entryId);
  if (already) throw conflict('This entry was already reversed.');
  return ws.sqlite.transaction(() => {
    const id = insertEntry(ws, deps.clock, actor, entry.member_id, { kind: 'void', reverses_entry_id: entryId, effective_at: nowIso(deps.clock), note });
    const after = recomputeMember(ws, deps, entry.member_id);
    writeAudit(ws, deps.clock, { actor, action: 'ledger.voided', entity: 'member', entityId: entry.member_id, details: { entryId: id, reverses: entryId, note, result: after } });
    return id;
  })();
}

/** True when the member has ledger entries other than the given ones (used by import undo). */
export function hasOtherLedgerEntries(ws: WorkspaceContext, memberId: number, except: number[]): boolean {
  const rows = ws.sqlite.prepare('SELECT id, reverses_entry_id FROM ledger_entries WHERE account_id = ? AND member_id = ?').all(ws.accountId, memberId) as Array<{
    id: number;
    reverses_entry_id: number | null;
  }>;
  const mine = new Set(except);
  return rows.some((r) => !mine.has(r.id) && !(r.reverses_entry_id !== null && mine.has(r.reverses_entry_id)));
}

// ---- Payments ---------------------------------------------------------------------------------

interface PaymentBillingRow {
  id: number;
  member_id: number | null;
  amount_cents: number | null;
  status: PaymentStatus;
  received_at: string;
  message_type: string;
}

function paymentRow(ws: WorkspaceContext, id: number): PaymentBillingRow {
  const p = ws.sqlite.prepare('SELECT id, member_id, amount_cents, status, received_at, message_type FROM payments WHERE account_id = ? AND id = ?').get(ws.accountId, id) as
    | PaymentBillingRow
    | undefined;
  if (!p) throw notFound('Payment not found');
  return p;
}

function liveEntryFor(ws: WorkspaceContext, paymentId: number): number | null {
  const row = ws.sqlite
    .prepare(
      `SELECT e.id FROM ledger_entries e WHERE e.account_id = ? AND e.payment_id = ? AND e.kind = 'payment'
         AND NOT EXISTS (SELECT 1 FROM ledger_entries v WHERE v.account_id = e.account_id AND v.reverses_entry_id = e.id)`,
    )
    .get(ws.accountId, paymentId) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Applies a matched payment to its member (§8.2) as a `payment` ledger entry carrying the plan
 * terms of today (snapshots: a later plan change never rewrites history). Idempotent: an already
 * applied payment is left alone. A member without a plan amount sends the payment to review.
 */
export function applyPayment(
  ws: WorkspaceContext,
  deps: BillingDeps,
  actor: string,
  paymentId: number,
  opts: { rescan?: boolean; effectiveAt?: string } = {},
): { applied: boolean; reason?: string } {
  const p = paymentRow(ws, paymentId);
  if (!['matched', 'manual'].includes(p.status) || p.member_id === null) return { applied: false, reason: `payment is ${p.status}` };
  if (liveEntryFor(ws, paymentId) !== null) return { applied: false, reason: 'already applied' };
  if (p.amount_cents === null || p.amount_cents <= 0) return { applied: false, reason: 'no amount' };
  const memberId = p.member_id;
  const m = memberRow(ws, memberId);
  const terms = resolveTerms(m, getWorkspaceSettings(ws).memberDefaults);
  if (terms.planAmountCents.value === null) {
    ws.sqlite
      .prepare(`UPDATE payments SET status = 'needs_review', member_id = NULL, review_reason = ? WHERE account_id = ? AND id = ?`)
      .run('The member has no plan amount, so the payment cannot be applied. Set a plan amount, then assign it again.', ws.accountId, paymentId);
    return { applied: false, reason: 'no plan amount' };
  }
  const effectiveAt = opts.effectiveAt ?? p.received_at;
  return ws.sqlite.transaction(() => {
    const entryId = insertEntry(ws, deps.clock, actor, memberId, {
      kind: 'payment',
      payment_id: paymentId,
      effective_at: effectiveAt,
      note: null,
      amount_cents: p.amount_cents!,
      plan_amount_snapshot_cents: terms.planAmountCents.value,
      period_days_snapshot: terms.planPeriodDays.value,
      tolerance_snapshot_cents: terms.toleranceCents.value,
    });
    recomputeMember(ws, deps, memberId);
    const output = ws.sqlite.prepare('SELECT * FROM ledger_entries WHERE account_id = ? AND id = ?').get(ws.accountId, entryId) as {
      periods_applied: number;
      days_delta: number;
      credit_delta_cents: number;
      forgiven_cents: number;
      paid_through_before: string | null;
      paid_through_after: string | null;
      credit_before_cents: number;
      credit_after_cents: number;
    };
    const o: LedgerEntryOutput = {
      periodsApplied: output.periods_applied,
      daysDelta: output.days_delta,
      creditDeltaCents: output.credit_delta_cents,
      forgivenCents: output.forgiven_cents,
      paidThroughBefore: output.paid_through_before,
      paidThroughAfter: output.paid_through_after,
      creditBeforeCents: output.credit_before_cents,
      creditAfterCents: output.credit_after_cents,
    };
    writeAudit(ws, deps.clock, {
      actor,
      action: 'payment.applied',
      entity: 'member',
      entityId: memberId,
      details: { paymentId, entryId, amountCents: p.amount_cents, periods: o.periodsApplied, paidThroughAfter: o.paidThroughAfter, creditAfterCents: o.creditAfterCents, forgivenCents: o.forgivenCents },
    });
    deps.events?.paymentApplied?.(ws, {
      paymentId,
      memberId,
      entryId,
      output: o,
      amountCents: p.amount_cents!,
      planAmountCents: terms.planAmountCents.value!,
      rescan: Boolean(opts.rescan),
      receivedAt: p.received_at,
    });
    return { applied: true };
  })();
}

/** Records a payment by hand (cash, a transfer the app could not read…) and applies it. */
export function recordManualPayment(
  ws: WorkspaceContext,
  deps: BillingDeps,
  actor: string,
  input: { memberId: number; amountCents: number; date: string; note: string | null },
): number {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw badRequest('Enter an amount above zero');
  if (!isIsoDate(input.date)) throw badRequest('The date must be YYYY-MM-DD');
  const m = ws.sqlite.prepare('SELECT currency FROM members WHERE account_id = ? AND id = ?').get(ws.accountId, input.memberId) as { currency: string } | undefined;
  if (!m) throw notFound('Member not found');
  // Noon UTC keeps the chosen calendar day in every North American timezone.
  const receivedAt = `${input.date}T12:00:00Z`;
  return ws.sqlite.transaction(() => {
    const id = Number(
      ws.sqlite
        .prepare(
          `INSERT INTO payments (account_id, member_id, amount_cents, currency, received_at, message_type, status, matched_by, source, raw_snapshot, created_at, resolved_by, resolved_at)
           VALUES (?, ?, ?, ?, ?, 'manual', 'manual', 'manual', 'manual', ?, ?, ?, ?)`,
        )
        .run(ws.accountId, input.memberId, input.amountCents, m.currency, receivedAt, JSON.stringify({ kind: 'manual', note: input.note }), nowIso(deps.clock), actor, nowIso(deps.clock)).lastInsertRowid,
    );
    writeAudit(ws, deps.clock, { actor, action: 'payment.recorded', entity: 'member', entityId: input.memberId, details: { paymentId: id, amountCents: input.amountCents, date: input.date, note: input.note } });
    const result = applyPayment(ws, deps, actor, id);
    if (!result.applied) throw badRequest(`The payment could not be applied: ${result.reason}`);
    return id;
  })();
}

/** Voids a payment: a `void` ledger entry, replay, status `voided` (§8.2). The row is kept. */
export function voidPayment(ws: WorkspaceContext, deps: BillingDeps, actor: string, paymentId: number, reason: string): void {
  const p = paymentRow(ws, paymentId);
  if (p.status === 'voided') throw conflict('This payment is already voided.');
  if (!reason.trim()) throw badRequest('Give a reason for voiding the payment');
  const entryId = liveEntryFor(ws, paymentId);
  ws.sqlite.transaction(() => {
    if (entryId !== null) voidLedgerEntry(ws, deps, actor, entryId, `Payment #${paymentId} voided: ${reason}`);
    ws.sqlite.prepare(`UPDATE payments SET status = 'voided', void_reason = ?, resolved_by = COALESCE(resolved_by, ?), resolved_at = COALESCE(resolved_at, ?) WHERE account_id = ? AND id = ?`).run(
      reason,
      actor,
      nowIso(deps.clock),
      ws.accountId,
      paymentId,
    );
    writeAudit(ws, deps.clock, { actor, action: 'payment.voided', entity: p.member_id ? 'member' : 'payment', entityId: p.member_id ?? paymentId, details: { paymentId, reason, ledgerEntry: entryId } });
  })();
}

/** "Mark as deposited" (§8.4): the admin deposited the transfer; amount and date may be corrected. */
export function markDeposited(
  ws: WorkspaceContext,
  deps: BillingDeps,
  actor: string,
  paymentId: number,
  input: { amountCents?: number; date?: string; memberId?: number },
): void {
  const p = paymentRow(ws, paymentId);
  if (p.status !== 'pending_deposit') throw conflict('Only transfers awaiting deposit can be marked as deposited.');
  const memberId = input.memberId ?? p.member_id;
  if (!memberId) throw badRequest('Choose the member this transfer is from.');
  if (!ws.sqlite.prepare('SELECT 1 FROM members WHERE account_id = ? AND id = ?').get(ws.accountId, memberId)) throw notFound('Member not found');
  const amount = input.amountCents ?? p.amount_cents;
  if (!amount || amount <= 0) throw badRequest('Enter the deposited amount');
  const settings = getWorkspaceSettings(ws);
  const date = input.date ?? localDate(deps.clock.now(), settings.timezone);
  if (!isIsoDate(date)) throw badRequest('The date must be YYYY-MM-DD');
  ws.sqlite.transaction(() => {
    ws.sqlite
      .prepare(`UPDATE payments SET status = 'matched', member_id = ?, amount_cents = ?, matched_by = COALESCE(matched_by, 'manual'), resolved_by = ?, resolved_at = ? WHERE account_id = ? AND id = ?`)
      .run(memberId, amount, actor, nowIso(deps.clock), ws.accountId, paymentId);
    writeAudit(ws, deps.clock, { actor, action: 'payment.deposited', entity: 'member', entityId: memberId, details: { paymentId, amountCents: amount, originalAmountCents: p.amount_cents, date } });
    const result = applyPayment(ws, deps, actor, paymentId, { effectiveAt: `${date}T12:00:00Z` });
    if (!result.applied) throw badRequest(`The payment could not be applied: ${result.reason}`);
  })();
}

/** Daily: transfers whose deposit window passed become `expired`; nothing else happens (§8.4). */
export function expirePendingDeposits(ws: WorkspaceContext, clock: Clock): number {
  const todayDate = today(clock, getWorkspaceSettings(ws).timezone);
  const rows = ws.sqlite
    .prepare(`SELECT id, member_id, expires_on FROM payments WHERE account_id = ? AND status = 'pending_deposit' AND expires_on IS NOT NULL AND expires_on < ?`)
    .all(ws.accountId, todayDate) as Array<{ id: number; member_id: number | null; expires_on: string }>;
  for (const r of rows) {
    ws.sqlite.transaction(() => {
      ws.sqlite.prepare(`UPDATE payments SET status = 'expired' WHERE account_id = ? AND id = ?`).run(ws.accountId, r.id);
      writeAudit(ws, clock, { actor: 'system', action: 'payment.deposit_expired', entity: r.member_id ? 'member' : 'payment', entityId: r.member_id ?? r.id, details: { paymentId: r.id, expiresOn: r.expires_on } });
    })();
  }
  return rows.length;
}

/** Daily: brings every member's automatic status up to date (grace / expired as days pass). */
export function recomputeStatuses(ws: WorkspaceContext, deps: BillingDeps): { changed: number } {
  const rows = ws.sqlite.prepare(`SELECT id FROM members WHERE account_id = ? AND status NOT IN ('paused', 'archived')`).all(ws.accountId) as Array<{ id: number }>;
  let changed = 0;
  for (const { id } of rows) {
    const m = memberRow(ws, id);
    const next = statusFor(ws, deps.clock, m, m.paid_through);
    if (next === m.status) continue;
    changed++;
    ws.sqlite.transaction(() => {
      ws.sqlite.prepare('UPDATE members SET status = ?, updated_at = ? WHERE account_id = ? AND id = ?').run(next, nowIso(deps.clock), ws.accountId, id);
      writeAudit(ws, deps.clock, { actor: 'system', action: 'member.status_changed', entity: 'member', entityId: id, details: { action: 'daily', from: m.status, to: next } });
      deps.events?.statusChanged?.(ws, { memberId: id, from: m.status, to: next });
    })();
  }
  return { changed };
}

// ---- Verification (§6.9 layer 1) ------------------------------------------------------------

export interface LedgerMismatch {
  memberId: number;
  field: string;
  cached: unknown;
  replayed: unknown;
}

/** Replays every member and compares with the caches and stored outputs. Never fixes anything. */
export function verifyLedger(ws: WorkspaceContext): LedgerMismatch[] {
  const tz = getWorkspaceSettings(ws).timezone;
  const members = ws.sqlite.prepare('SELECT id, paid_through, credit_cents, last_payment_at FROM members WHERE account_id = ?').all(ws.accountId) as Array<{
    id: number;
    paid_through: string | null;
    credit_cents: number;
    last_payment_at: string | null;
  }>;
  const problems: LedgerMismatch[] = [];
  for (const m of members) {
    const rows = entryRows(ws, m.id);
    let result;
    try {
      result = replayLedger(rows.map(toInput), tz);
    } catch (err) {
      problems.push({ memberId: m.id, field: 'replay', cached: null, replayed: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const { outputs, final } = result;
    if (final.paidThrough !== m.paid_through) problems.push({ memberId: m.id, field: 'paid_through', cached: m.paid_through, replayed: final.paidThrough });
    if (final.creditCents !== m.credit_cents) problems.push({ memberId: m.id, field: 'credit_cents', cached: m.credit_cents, replayed: final.creditCents });
    if (final.lastPaymentAt !== m.last_payment_at) problems.push({ memberId: m.id, field: 'last_payment_at', cached: m.last_payment_at, replayed: final.lastPaymentAt });
    for (const r of rows as Array<EntryRow & { paid_through_after: string | null; credit_after_cents: number }>) {
      const o = outputs.get(r.id)!;
      if (o.paidThroughAfter !== r.paid_through_after || o.creditAfterCents !== r.credit_after_cents) {
        problems.push({ memberId: m.id, field: `entry #${r.id}`, cached: { paidThroughAfter: r.paid_through_after, creditAfterCents: r.credit_after_cents }, replayed: { paidThroughAfter: o.paidThroughAfter, creditAfterCents: o.creditAfterCents } });
      }
    }
  }
  return problems;
}

export interface LedgerEntryView {
  id: number;
  kind: EntryRow['kind'];
  effectiveAt: string;
  createdAt: string;
  createdBy: string;
  note: string | null;
  paymentId: number | null;
  reversesEntryId: number | null;
  reversed: boolean;
  amountCents: number;
  output: LedgerEntryOutput;
}

export function listLedger(ws: WorkspaceContext, memberId: number): LedgerEntryView[] {
  memberRow(ws, memberId);
  const rows = ws.sqlite.prepare('SELECT * FROM ledger_entries WHERE account_id = ? AND member_id = ? ORDER BY effective_at DESC, id DESC').all(ws.accountId, memberId) as Array<
    EntryRow & { created_at: string; created_by: string; note: string | null; periods_applied: number; days_delta: number; credit_delta_cents: number; forgiven_cents: number; paid_through_before: string | null; paid_through_after: string | null; credit_before_cents: number; credit_after_cents: number }
  >;
  const reversed = new Set(rows.filter((r) => r.kind === 'void').map((r) => r.reverses_entry_id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    effectiveAt: r.effective_at,
    createdAt: r.created_at,
    createdBy: r.created_by,
    note: r.note,
    paymentId: r.payment_id,
    reversesEntryId: r.reverses_entry_id,
    reversed: reversed.has(r.id),
    amountCents: r.amount_cents,
    output: {
      periodsApplied: r.periods_applied,
      daysDelta: r.days_delta,
      creditDeltaCents: r.credit_delta_cents,
      forgivenCents: r.forgiven_cents,
      paidThroughBefore: r.paid_through_before,
      paidThroughAfter: r.paid_through_after,
      creditBeforeCents: r.credit_before_cents,
      creditAfterCents: r.credit_after_cents,
    },
  }));
}
