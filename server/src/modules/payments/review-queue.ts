import { normalizeEmail, normalizeName, type ResolvePayment, resolvePaymentSchema, type RuleTest, type RuleTestResult } from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { type Clock, nowIso } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import { addAlias } from '../members/aliases.js';
import { listRules, matchDirectory, ruleInputs } from '../members/directory.js';
import type { IngestDeps } from './ingest.js';
import { matchPayment } from './matching/matcher.js';
import { evaluateRule } from './matching/rules.js';
import { getPaymentRow, inReview, type PaymentSnapshot } from './store.js';

// The Review Queue (Spec §7.5): payments the app declined to apply automatically. Nothing in it
// changes anyone's access until it is resolved here.

export type ReviewDeps = Pick<IngestDeps, 'clock' | 'onStored'>;

export function resolvePayment(ws: WorkspaceContext, deps: ReviewDeps, actor: string, paymentId: number, input: ResolvePayment): void {
  const r = resolvePaymentSchema.parse(input);
  const p = getPaymentRow(ws, paymentId);
  const at = nowIso(deps.clock);
  const pending = p.status === 'pending_deposit';
  if (!inReview(p) && !(pending && r.action === 'assign')) throw conflict('This payment is not waiting for a decision.');

  if (r.action === 'dismiss') {
    const snap = p.raw_snapshot ? (JSON.parse(p.raw_snapshot) as PaymentSnapshot) : null;
    const nextSnap = snap ? { ...snap, dismissed: { by: actor, at, note: r.note ?? null } } : null;
    ws.sqlite.transaction(() => {
      // Kept for audit; a dismissed review item becomes `rejected` (duplicates stay `duplicate`).
      ws.sqlite
        .prepare(`UPDATE payments SET status = ?, resolved_by = ?, resolved_at = ?, raw_snapshot = ? WHERE account_id = ? AND id = ?`)
        .run(p.status === 'duplicate' ? 'duplicate' : 'rejected', actor, at, nextSnap ? JSON.stringify(nextSnap) : p.raw_snapshot, ws.accountId, paymentId);
      writeAudit(ws, deps.clock, { actor, action: 'payment.dismissed', entity: 'payment', entityId: paymentId, details: { from: p.status, note: r.note ?? null } });
    })();
    return;
  }

  if (p.status === 'duplicate') throw conflict('A duplicate notice can only be dismissed; the original payment is already recorded.');
  if (p.status === 'rejected' && !r.verifiedInBank) throw badRequest('This notice failed the authenticity check. Confirm that you verified the deposit in your bank first.', { reason: 'verify_in_bank' });
  if (p.amount_cents === null) throw badRequest('This payment has no readable amount; it can only be dismissed.');
  const member = ws.sqlite.prepare('SELECT id, display_name, status FROM members WHERE account_id = ? AND id = ?').get(ws.accountId, r.memberId) as
    | { id: number; display_name: string; status: string }
    | undefined;
  if (!member) throw notFound('Member not found');

  ws.sqlite.transaction(() => {
    ws.sqlite
      .prepare(`UPDATE payments SET member_id = ?, status = ?, matched_by = 'manual', resolved_by = ?, resolved_at = ? WHERE account_id = ? AND id = ?`)
      .run(member.id, pending ? 'pending_deposit' : 'matched', actor, at, ws.accountId, paymentId);
    if (r.rememberSender) rememberSender(ws, deps.clock, actor, member.id, p.sender_name, p.sender_email);
    writeAudit(ws, deps.clock, { actor, action: 'payment.assigned', entity: 'member', entityId: member.id, details: { paymentId, from: p.status, amountCents: p.amount_cents, rememberSender: r.rememberSender } });
    if (!pending) deps.onStored?.(ws, paymentId, { rescan: false, receivedAt: p.received_at });
  })();
}

/** Adds the payer's name and email as aliases when they are new and not someone else's. */
function rememberSender(ws: WorkspaceContext, clock: Clock, actor: string, memberId: number, name: string | null, email: string | null) {
  for (const [kind, value] of [
    ['name', name ? normalizeName(name) : null],
    ['email', email ? normalizeEmail(email) : null],
  ] as const) {
    if (!value) continue;
    try {
      addAlias(ws, clock, actor, memberId, { kind, value });
    } catch {
      /* already this member's (or someone else's): nothing to remember */
    }
  }
}

/** "Re-run Review Queue against rules" (§7.4.1): unresolved unmatched / needs-review items are matched again. */
export function rerunReviewQueue(ws: WorkspaceContext, deps: ReviewDeps, actor: string): { checked: number; matched: number } {
  const rows = ws.sqlite
    .prepare(`SELECT id FROM payments WHERE account_id = ? AND resolved_at IS NULL AND status IN ('unmatched', 'needs_review') AND amount_cents IS NOT NULL ORDER BY received_at`)
    .all(ws.accountId) as Array<{ id: number }>;
  const directory = matchDirectory(ws);
  const rules = ruleInputs(ws);
  let matched = 0;
  for (const { id } of rows) {
    const p = getPaymentRow(ws, id);
    const snap = p.raw_snapshot ? (JSON.parse(p.raw_snapshot) as PaymentSnapshot) : null;
    // Parser / cross-check problems stay with a human; only matching problems are re-evaluated.
    if (snap && snap.verdict !== 'ok') continue;
    const d = matchPayment({ senderName: p.sender_name, senderEmail: p.sender_email, memo: p.memo, amountCents: p.amount_cents }, directory, rules);
    if (d.status !== 'matched') continue;
    matched++;
    ws.sqlite.transaction(() => {
      ws.sqlite
        .prepare(`UPDATE payments SET member_id = ?, status = 'matched', matched_by = ?, matched_rule_id = ?, review_reason = NULL, resolved_by = ?, resolved_at = ? WHERE account_id = ? AND id = ?`)
        .run(d.memberId, d.matchedBy, d.ruleId, actor, nowIso(deps.clock), ws.accountId, id);
      writeAudit(ws, deps.clock, { actor, action: 'payment.rematched', entity: 'member', entityId: d.memberId, details: { paymentId: id, matchedBy: d.matchedBy, ruleId: d.ruleId } });
      deps.onStored?.(ws, id, { rescan: false, receivedAt: p.received_at });
    })();
  }
  return { checked: rows.length, matched };
}

/** Rule tester (§7.4.1): which rules match a past payment or sample facts, and why. */
export function testRules(ws: WorkspaceContext, input: RuleTest): RuleTestResult {
  let facts: RuleTestResult['facts'];
  if (input.paymentId) {
    const p = getPaymentRow(ws, input.paymentId);
    // Awaiting-deposit memos are never stored, so they cannot be re-tested.
    facts = { senderName: p.sender_name, senderEmail: p.sender_email, memo: p.memo, amountCents: p.amount_cents };
  } else {
    facts = { senderName: input.senderName ?? null, senderEmail: input.senderEmail ?? null, memo: input.memo ?? null, amountCents: input.amountCents ?? null };
  }
  const directory = matchDirectory(ws);
  const views = listRules(ws);
  const inputs = ruleInputs(ws);
  const nameOf = (id: number) => directory.find((m) => m.id === id);
  const rules = inputs.map((r) => {
    const m = nameOf(r.memberId);
    const outcome = r.enabled ? evaluateRule(r, facts, m ? (m.etransferName ?? m.displayName) : '') : { matches: false as const, failed: 'the rule is disabled' };
    return { id: r.id, label: r.label, memberName: views.find((v) => v.id === r.id)?.memberName ?? '', matches: outcome.matches, why: outcome.matches ? null : outcome.failed };
  });
  const d = matchPayment(facts, directory, inputs);
  return { facts, rules, decision: { status: d.status, memberId: d.memberId, memberName: d.memberId ? (nameOf(d.memberId)?.displayName ?? null) : null, matchedBy: d.matchedBy, ruleId: d.ruleId, reason: d.reason } };
}
