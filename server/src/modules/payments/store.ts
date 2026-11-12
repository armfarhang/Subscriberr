import { type PaymentList, type PaymentListQuery, paymentListQuerySchema, type PaymentStatus, type PaymentView, normalizeName } from '@subscriberr/shared';
import { notFound } from '../../core/errors.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';

// Payment rows (Spec §6.5). Payments are never deleted (a trigger enforces it).

export interface PaymentRow {
  id: number;
  member_id: number | null;
  member_name: string | null;
  amount_cents: number | null;
  currency: string;
  received_at: string;
  sender_name: string | null;
  sender_email: string | null;
  interac_reference: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  memo: string | null;
  message_type: PaymentView['messageType'];
  expires_on: string | null;
  status: PaymentStatus;
  matched_by: PaymentView['matchedBy'];
  matched_rule_id: number | null;
  review_reason: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  void_reason: string | null;
  source: PaymentView['source'];
  raw_snapshot: string | null;
  created_at: string;
}

/** Snapshot kept with an e-Transfer payment: parsed facts and the verdicts, never the body (§7.2, §16). */
export interface PaymentSnapshot {
  kind: string;
  verdict: string;
  reason: string | null;
  auth: { ok: boolean; reason: string | null; dkim: string; dkimDomain: string | null; dmarc: string | null };
  proposal?: { memberId: number; score: number } | null;
  dismissed?: { by: string; at: string; note: string | null };
}

/** Statuses that wait in the Review Queue until someone resolves them (§7.5). */
export const REVIEW_STATUSES: PaymentStatus[] = ['needs_review', 'unmatched', 'rejected', 'duplicate'];

const SELECT = `SELECT p.*, m.display_name AS member_name FROM payments p LEFT JOIN members m ON m.account_id = p.account_id AND m.id = p.member_id`;

export function inReview(r: Pick<PaymentRow, 'status' | 'resolved_at'>): boolean {
  return REVIEW_STATUSES.includes(r.status) && r.resolved_at === null;
}

export function toPaymentView(r: PaymentRow, memberNames: Map<number, string>): PaymentView {
  const snap = r.raw_snapshot ? (JSON.parse(r.raw_snapshot) as PaymentSnapshot) : null;
  const proposal = snap?.proposal ? { ...snap.proposal, displayName: memberNames.get(snap.proposal.memberId) ?? `#${snap.proposal.memberId}` } : null;
  return {
    id: r.id,
    memberId: r.member_id,
    memberName: r.member_name,
    amountCents: r.amount_cents,
    currency: r.currency,
    receivedAt: r.received_at,
    senderName: r.sender_name,
    senderEmail: r.sender_email,
    reference: r.interac_reference,
    memo: r.memo,
    messageType: r.message_type,
    expiresOn: r.expires_on,
    status: r.status,
    matchedBy: r.matched_by,
    matchedRuleId: r.matched_rule_id,
    reviewReason: r.review_reason,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    voidReason: r.void_reason,
    source: r.source,
    createdAt: r.created_at,
    proposal,
    auth: snap?.auth ? { ok: snap.auth.ok, reason: snap.auth.reason, dkim: snap.auth.dkim, dmarc: snap.auth.dmarc } : null,
    inReview: inReview(r),
  };
}

function memberNames(ws: WorkspaceContext): Map<number, string> {
  const rows = ws.sqlite.prepare('SELECT id, display_name FROM members WHERE account_id = ?').all(ws.accountId) as Array<{ id: number; display_name: string }>;
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

export function getPaymentRow(ws: WorkspaceContext, id: number): PaymentRow {
  const row = ws.sqlite.prepare(`${SELECT} WHERE p.account_id = ? AND p.id = ?`).get(ws.accountId, id) as PaymentRow | undefined;
  if (!row) throw notFound('Payment not found');
  return row;
}

export function getPayment(ws: WorkspaceContext, id: number): PaymentView {
  return toPaymentView(getPaymentRow(ws, id), memberNames(ws));
}

export function reviewCounts(ws: WorkspaceContext): PaymentList['counts'] {
  const review = ws.sqlite
    .prepare(`SELECT count(*) AS n FROM payments WHERE account_id = ? AND resolved_at IS NULL AND status IN (${REVIEW_STATUSES.map(() => '?').join(',')})`)
    .get(ws.accountId, ...REVIEW_STATUSES) as { n: number };
  const awaiting = ws.sqlite.prepare(`SELECT count(*) AS n FROM payments WHERE account_id = ? AND status = 'pending_deposit'`).get(ws.accountId) as { n: number };
  return { review: review.n, awaiting: awaiting.n };
}

export function listPayments(ws: WorkspaceContext, raw: PaymentListQuery = {}): PaymentList {
  const q = paymentListQuerySchema.parse(raw);
  const where = ['p.account_id = ?'];
  const args: unknown[] = [ws.accountId];
  if (q.tab === 'review') {
    where.push(`p.resolved_at IS NULL AND p.status IN (${REVIEW_STATUSES.map(() => '?').join(',')})`);
    args.push(...REVIEW_STATUSES);
  }
  if (q.tab === 'awaiting') where.push(`p.status = 'pending_deposit'`);
  if (q.status) {
    where.push('p.status = ?');
    args.push(q.status);
  }
  if (q.memberId) {
    where.push('p.member_id = ?');
    args.push(q.memberId);
  }
  let rows = ws.sqlite.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY p.received_at DESC, p.id DESC`).all(...args) as PaymentRow[];
  if (q.q) {
    const needle = normalizeName(q.q);
    rows = rows.filter((r) => normalizeName([r.sender_name, r.sender_email, r.member_name, r.interac_reference, r.memo].filter(Boolean).join('\n')).includes(needle));
  }
  const names = memberNames(ws);
  const start = (q.page - 1) * q.pageSize;
  return { items: rows.slice(start, start + q.pageSize).map((r) => toPaymentView(r, names)), total: rows.length, page: q.page, pageSize: q.pageSize, counts: reviewCounts(ws) };
}
