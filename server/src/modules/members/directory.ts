import { type MatchingRuleView, normalizeName, type RuleFields, ruleFieldsSchema } from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { type Clock, nowIso } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import type { MatchMember } from '../payments/matching/matcher.js';
import { type RuleInput, validateRegex } from '../payments/matching/rules.js';

// What payment matching needs from the members module (Spec §7.4): every member's identity
// (names, emails, aliases) and the matching rules. Also the CRUD for advanced rules (§7.4.1);
// managed rules (from payment_memo_code) are maintained by rules.ts and are read-only here.

export function matchDirectory(ws: WorkspaceContext): MatchMember[] {
  const members = ws.sqlite.prepare('SELECT id, display_name, etransfer_name, email, status FROM members WHERE account_id = ?').all(ws.accountId) as Array<{
    id: number;
    display_name: string;
    etransfer_name: string | null;
    email: string | null;
    status: string;
  }>;
  const aliases = ws.sqlite.prepare('SELECT member_id, kind, value FROM member_aliases WHERE account_id = ?').all(ws.accountId) as Array<{ member_id: number; kind: string; value: string }>;
  return members.map((m) => ({
    id: m.id,
    displayName: m.display_name,
    etransferName: m.etransfer_name,
    email: m.email,
    archived: m.status === 'archived',
    nameAliases: aliases.filter((a) => a.member_id === m.id && a.kind === 'name').map((a) => a.value),
    emailAliases: aliases.filter((a) => a.member_id === m.id && a.kind === 'email').map((a) => a.value),
  }));
}

interface RuleRow {
  id: number;
  member_id: number;
  member_name: string;
  label: string;
  enabled: number;
  priority: number;
  managed: number;
  sender_name: string | null;
  sender_email: string | null;
  memo_mode: MatchingRuleView['memoMode'];
  memo_value: string | null;
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  action: MatchingRuleView['action'];
}

const toView = (r: RuleRow): MatchingRuleView => ({
  id: r.id,
  memberId: r.member_id,
  memberName: r.member_name,
  label: r.label,
  enabled: r.enabled === 1,
  priority: r.priority,
  managed: r.managed === 1,
  senderName: r.sender_name,
  senderEmail: r.sender_email,
  memoMode: r.memo_mode,
  memoValue: r.memo_value,
  amountMinCents: r.amount_min_cents,
  amountMaxCents: r.amount_max_cents,
  action: r.action,
});

export function listRules(ws: WorkspaceContext, memberId?: number): MatchingRuleView[] {
  const rows = ws.sqlite
    .prepare(
      `SELECT r.*, m.display_name AS member_name FROM matching_rules r JOIN members m ON m.account_id = r.account_id AND m.id = r.member_id
       WHERE r.account_id = ? ${memberId === undefined ? '' : 'AND r.member_id = ?'} ORDER BY r.priority, r.id`,
    )
    .all(...(memberId === undefined ? [ws.accountId] : [ws.accountId, memberId])) as RuleRow[];
  return rows.map(toView);
}

export function ruleInputs(ws: WorkspaceContext): RuleInput[] {
  return listRules(ws).map((r) => ({ ...r, senderName: r.senderName ? normalizeName(r.senderName) : null }));
}

function requireRule(ws: WorkspaceContext, id: number): MatchingRuleView {
  const rule = listRules(ws).find((r) => r.id === id);
  if (!rule) throw notFound('Rule not found');
  return rule;
}

function validate(ws: WorkspaceContext, input: RuleFields) {
  const r = ruleFieldsSchema.parse(input);
  const member = ws.sqlite.prepare('SELECT id FROM members WHERE account_id = ? AND id = ?').get(ws.accountId, r.memberId);
  if (!member) throw notFound('Member not found');
  if (r.memoMode === 'regex' && r.memoValue) {
    const problem = validateRegex(r.memoValue);
    if (problem) throw badRequest('Invalid regular expression', [{ path: 'memoValue', message: problem }]);
  }
  return { ...r, senderName: r.senderName ? normalizeName(r.senderName) : null, memoValue: r.memoMode ? r.memoValue : null };
}

export function createRule(ws: WorkspaceContext, clock: Clock, actor: string, input: RuleFields): MatchingRuleView {
  const r = validate(ws, input);
  const at = nowIso(clock);
  const id = ws.sqlite.transaction(() => {
    const newId = Number(
      ws.sqlite
        .prepare(
          `INSERT INTO matching_rules (account_id, member_id, label, enabled, priority, managed, sender_name, sender_email, memo_mode, memo_value, amount_min_cents, amount_max_cents, action, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ws.accountId, r.memberId, r.label, r.enabled ? 1 : 0, r.priority, r.senderName, r.senderEmail, r.memoMode, r.memoValue, r.amountMinCents, r.amountMaxCents, r.action, at, at).lastInsertRowid,
    );
    writeAudit(ws, clock, { actor, action: 'rule.created', entity: 'member', entityId: r.memberId, details: { ruleId: newId, label: r.label } });
    return newId;
  })();
  return requireRule(ws, id);
}

export function updateRule(ws: WorkspaceContext, clock: Clock, actor: string, id: number, input: RuleFields): MatchingRuleView {
  const existing = requireRule(ws, id);
  if (existing.managed) throw conflict('This rule comes from the member’s memo code; change the code on the member instead.');
  const r = validate(ws, input);
  ws.sqlite.transaction(() => {
    ws.sqlite
      .prepare(
        `UPDATE matching_rules SET member_id = ?, label = ?, enabled = ?, priority = ?, sender_name = ?, sender_email = ?, memo_mode = ?, memo_value = ?, amount_min_cents = ?, amount_max_cents = ?, action = ?, updated_at = ?
         WHERE account_id = ? AND id = ?`,
      )
      .run(r.memberId, r.label, r.enabled ? 1 : 0, r.priority, r.senderName, r.senderEmail, r.memoMode, r.memoValue, r.amountMinCents, r.amountMaxCents, r.action, nowIso(clock), ws.accountId, id);
    writeAudit(ws, clock, { actor, action: 'rule.updated', entity: 'member', entityId: r.memberId, details: { ruleId: id, label: r.label } });
  })();
  return requireRule(ws, id);
}

export function deleteRule(ws: WorkspaceContext, clock: Clock, actor: string, id: number): void {
  const existing = requireRule(ws, id);
  if (existing.managed) throw conflict('This rule comes from the member’s memo code; clear the code on the member instead.');
  ws.sqlite.transaction(() => {
    ws.sqlite.prepare('DELETE FROM matching_rules WHERE account_id = ? AND id = ?').run(ws.accountId, id);
    writeAudit(ws, clock, { actor, action: 'rule.deleted', entity: 'member', entityId: existing.memberId, details: { ruleId: id, label: existing.label } });
  })();
}
