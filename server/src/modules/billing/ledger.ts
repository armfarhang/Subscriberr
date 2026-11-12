import { derivedStatus, type MemberStatus } from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import { badRequest, notFound } from '../../core/errors.js';
import { type Clock, nowIso, today } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import { resolveTerms } from '../members/members.js';
import { getWorkspaceSettings } from '../workspaces/settings.js';
import { type LedgerEntryInput, replayLedger } from './engine.js';

// The ONLY writer of ledger entries and of the member balance caches (paid_through,
// credit_cents, last_payment_at) — Spec §6.5a. Callers run these inside their own transaction
// when they need atomicity with other writes (better-sqlite3 nests them as savepoints).

interface EntryRow {
  id: number;
  kind: LedgerEntryInput['kind'];
  effective_at: string;
  reverses_entry_id: number | null;
  set_paid_through: string | null;
  set_credit_cents: number | null;
}

export interface ManualSetInput {
  /** New paid-through date (YYYY-MM-DD); undefined = unchanged. */
  paidThrough?: string;
  /** New credit in cents (≥ 0); undefined = unchanged. */
  creditCents?: number;
  note: string;
}

/** Replays the member's ledger, rewrites every entry's outputs and the member's caches, and recomputes the automatic status. */
export function recomputeMember(ws: WorkspaceContext, clock: Clock, memberId: number): { paidThrough: string | null; creditCents: number; status: MemberStatus } {
  const member = ws.sqlite
    .prepare('SELECT status, plan_amount_cents, plan_period_days, tolerance_cents, grace_days FROM members WHERE account_id = ? AND id = ?')
    .get(ws.accountId, memberId) as
    | { status: MemberStatus; plan_amount_cents: number | null; plan_period_days: number | null; tolerance_cents: number | null; grace_days: number | null }
    | undefined;
  if (!member) throw notFound('Member not found');

  const rows = ws.sqlite
    .prepare('SELECT id, kind, effective_at, reverses_entry_id, set_paid_through, set_credit_cents FROM ledger_entries WHERE account_id = ? AND member_id = ?')
    .all(ws.accountId, memberId) as EntryRow[];
  const { outputs, final } = replayLedger(
    rows.map((r) => ({ id: r.id, kind: r.kind, effectiveAt: r.effective_at, reversesEntryId: r.reverses_entry_id, setPaidThrough: r.set_paid_through, setCreditCents: r.set_credit_cents })),
  );

  const writeOutputs = ws.sqlite.prepare(
    `UPDATE ledger_entries SET periods_applied = ?, days_delta = ?, credit_delta_cents = ?, forgiven_cents = ?, paid_through_before = ?, paid_through_after = ?,
       credit_before_cents = ?, credit_after_cents = ? WHERE account_id = ? AND id = ?`,
  );
  for (const [id, o] of outputs) {
    writeOutputs.run(o.periodsApplied, o.daysDelta, o.creditDeltaCents, o.forgivenCents, o.paidThroughBefore, o.paidThroughAfter, o.creditBeforeCents, o.creditAfterCents, ws.accountId, id);
  }

  let status = member.status;
  if (status !== 'paused' && status !== 'archived') {
    const settings = getWorkspaceSettings(ws);
    status = derivedStatus(final.paidThrough, resolveTerms(member, settings.memberDefaults).graceDays.value, today(clock, settings.timezone));
  }
  ws.sqlite
    .prepare('UPDATE members SET paid_through = ?, credit_cents = ?, status = ?, updated_at = ? WHERE account_id = ? AND id = ?')
    .run(final.paidThrough, final.creditCents, status, nowIso(clock), ws.accountId, memberId);
  return { ...final, status };
}

/** An absolute paid-through and/or credit (opening balance, CSV import, correction). Returns the entry id. */
export function recordManualSet(ws: WorkspaceContext, clock: Clock, actor: string, memberId: number, input: ManualSetInput): number {
  if (input.paidThrough === undefined && input.creditCents === undefined) throw badRequest('Nothing to set');
  if (input.creditCents !== undefined && (!Number.isInteger(input.creditCents) || input.creditCents < 0)) throw badRequest('Credit must be a whole number of cents ≥ 0');
  const at = nowIso(clock);
  return ws.sqlite.transaction(() => {
    const id = Number(
      ws.sqlite
        .prepare(
          `INSERT INTO ledger_entries (account_id, member_id, created_at, created_by, note, kind, effective_at, set_paid_through, set_credit_cents)
           VALUES (?, ?, ?, ?, ?, 'manual_set', ?, ?, ?)`,
        )
        .run(ws.accountId, memberId, at, actor, input.note, at, input.paidThrough ?? null, input.creditCents ?? null).lastInsertRowid,
    );
    const after = recomputeMember(ws, clock, memberId);
    writeAudit(ws, clock, {
      actor,
      action: 'ledger.manual_set',
      entity: 'member',
      entityId: memberId,
      details: { entryId: id, paidThrough: input.paidThrough ?? null, creditCents: input.creditCents ?? null, note: input.note, result: after },
    });
    return id;
  })();
}

/** Reverses an entry (a `void` entry) and replays. The original entry stays in the history. */
export function voidLedgerEntry(ws: WorkspaceContext, clock: Clock, actor: string, entryId: number, note: string): number {
  const entry = ws.sqlite.prepare('SELECT id, member_id, kind FROM ledger_entries WHERE account_id = ? AND id = ?').get(ws.accountId, entryId) as
    | { id: number; member_id: number; kind: string }
    | undefined;
  if (!entry) throw notFound('Ledger entry not found');
  if (entry.kind === 'void') throw badRequest('A void entry cannot itself be voided');
  const at = nowIso(clock);
  return ws.sqlite.transaction(() => {
    const id = Number(
      ws.sqlite
        .prepare(
          `INSERT INTO ledger_entries (account_id, member_id, created_at, created_by, note, kind, reverses_entry_id, effective_at)
           VALUES (?, ?, ?, ?, ?, 'void', ?, ?)`,
        )
        .run(ws.accountId, entry.member_id, at, actor, note, entryId, at).lastInsertRowid,
    );
    const after = recomputeMember(ws, clock, entry.member_id);
    writeAudit(ws, clock, { actor, action: 'ledger.voided', entity: 'member', entityId: entry.member_id, details: { entryId: id, reverses: entryId, note, result: after } });
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
