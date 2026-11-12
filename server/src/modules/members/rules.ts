import { normalizeName, type ManagedMemoRule } from '@subscriberr/shared';
import type { WorkspaceContext } from '../../core/workspace-context.js';

// Matching rules belong to members (Member detail → Matching rules, Spec §7.4.1). This milestone
// maintains the *managed* rule generated from `payment_memo_code` ("easy mode"); advanced rules,
// the rule tester and the matcher that evaluates rules arrive with Gmail ingestion (M5).

interface RuleRow {
  id: number;
  label: string;
  sender_name: string | null;
  memo_value: string;
  enabled: number;
}

export interface ManagedRuleSource {
  id: number;
  displayName: string;
  etransferName: string | null;
  paymentMemoCode: string | null;
}

/**
 * The sender name the managed rule requires. Spec: "sender name = this member's e-Transfer name".
 * [ASSUMPTION] A member without an e-Transfer name falls back to the display name, so the rule
 * never matches *any* sender whose memo happens to contain the code.
 */
export function managedRuleSenderName(m: Pick<ManagedRuleSource, 'displayName' | 'etransferName'>): string {
  return normalizeName(m.etransferName ?? m.displayName);
}

/** Creates, updates or removes the member's managed memo rule so it mirrors the member fields. Call inside a transaction. */
export function syncManagedRule(ws: WorkspaceContext, member: ManagedRuleSource, at: string): void {
  const existing = ws.sqlite
    .prepare('SELECT id FROM matching_rules WHERE account_id = ? AND member_id = ? AND managed = 1 ORDER BY id')
    .all(ws.accountId, member.id) as Array<{ id: number }>;

  if (!member.paymentMemoCode) {
    if (existing.length > 0) ws.sqlite.prepare('DELETE FROM matching_rules WHERE account_id = ? AND member_id = ? AND managed = 1').run(ws.accountId, member.id);
    return;
  }

  const label = `Memo contains "${member.paymentMemoCode}"`;
  const senderName = managedRuleSenderName(member);
  const [keep, ...extra] = existing;
  for (const row of extra) ws.sqlite.prepare('DELETE FROM matching_rules WHERE account_id = ? AND id = ?').run(ws.accountId, row.id);
  if (keep) {
    ws.sqlite
      .prepare(
        `UPDATE matching_rules SET label = ?, sender_name = ?, memo_mode = 'contains', memo_value = ?, action = 'assign', enabled = 1, updated_at = ?
         WHERE account_id = ? AND id = ?`,
      )
      .run(label, senderName, member.paymentMemoCode, at, ws.accountId, keep.id);
  } else {
    ws.sqlite
      .prepare(
        `INSERT INTO matching_rules (account_id, member_id, label, enabled, priority, managed, sender_name, memo_mode, memo_value, action, created_at, updated_at)
         VALUES (?, ?, ?, 1, 100, 1, ?, 'contains', ?, 'assign', ?, ?)`,
      )
      .run(ws.accountId, member.id, label, senderName, member.paymentMemoCode, at, at);
  }
}

export function getManagedRule(ws: WorkspaceContext, memberId: number): ManagedMemoRule | null {
  const row = ws.sqlite
    .prepare('SELECT id, label, sender_name, memo_value, enabled FROM matching_rules WHERE account_id = ? AND member_id = ? AND managed = 1 ORDER BY id LIMIT 1')
    .get(ws.accountId, memberId) as RuleRow | undefined;
  return row ? { id: row.id, label: row.label, senderName: row.sender_name, memoValue: row.memo_value, enabled: row.enabled === 1 } : null;
}
