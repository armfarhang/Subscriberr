import {
  type CreateMember,
  derivedStatus,
  diffDays,
  type MemberDefaults,
  type MemberDetail,
  type MemberList,
  type MemberListQuery,
  memberListQuerySchema,
  type MemberServerLink,
  type MemberStatus,
  type MemberStatusAction,
  type MemberSummary,
  type MemberTerms,
  MEMBER_STATUSES,
  normalizeMemoCode,
  normalizeName,
  type TimelineEvent,
  type UpdateMember,
} from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import { conflict, notFound } from '../../core/errors.js';
import { type Clock, nowIso, today } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import { getWorkspaceSettings } from '../workspaces/settings.js';
import { listAliases } from './aliases.js';
import { getManagedRule, syncManagedRule } from './rules.js';
import { memberWarnings } from './warnings.js';

// Members (Spec §6.2). This module owns the member's *descriptive* columns. The balance columns
// (paid_through, credit_cents, last_payment_at) are caches of the billing ledger and are never
// written here (§6.5a); status is written here only for the manual transitions of §8.3.

interface MemberRow {
  id: number;
  display_name: string;
  etransfer_name: string | null;
  payment_memo_code: string | null;
  email: string | null;
  notes: string | null;
  plan_amount_cents: number | null;
  plan_period_days: number | null;
  currency: string;
  tolerance_cents: number | null;
  grace_days: number | null;
  last_payment_at: string | null;
  paid_through: string | null;
  credit_cents: number;
  status: MemberStatus;
  reminders_enabled: number;
  emails_enabled: number;
  created_at: string;
  updated_at: string;
  import_batch_id: number | null;
}

const SELECT_MEMBER = `SELECT id, display_name, etransfer_name, payment_memo_code, email, notes, plan_amount_cents, plan_period_days,
  currency, tolerance_cents, grace_days, last_payment_at, paid_through, credit_cents, status, reminders_enabled, emails_enabled,
  created_at, updated_at, import_batch_id FROM members`;

/** API field → column. Deliberately has no entry for the ledger caches. */
const COLUMNS = {
  displayName: 'display_name',
  etransferName: 'etransfer_name',
  paymentMemoCode: 'payment_memo_code',
  email: 'email',
  notes: 'notes',
  planAmountCents: 'plan_amount_cents',
  planPeriodDays: 'plan_period_days',
  currency: 'currency',
  toleranceCents: 'tolerance_cents',
  graceDays: 'grace_days',
  remindersEnabled: 'reminders_enabled',
  emailsEnabled: 'emails_enabled',
} as const satisfies Record<keyof UpdateMember, string>;

type Field = keyof typeof COLUMNS;

const toDb = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null));

/** Resolves NULL overrides against the workspace member defaults (D11). */
export function resolveTerms(row: Pick<MemberRow, 'plan_amount_cents' | 'plan_period_days' | 'tolerance_cents' | 'grace_days'>, defaults: MemberDefaults): MemberTerms {
  const pick = <T>(own: T | null, fallback: T) => (own === null ? { value: fallback, inherited: true } : { value: own, inherited: false });
  return {
    planAmountCents: pick(row.plan_amount_cents, defaults.planAmountCents),
    planPeriodDays: pick(row.plan_period_days, defaults.planPeriodDays),
    toleranceCents: pick(row.tolerance_cents, defaults.toleranceCents),
    graceDays: pick(row.grace_days, defaults.graceDays),
  };
}

function findRow(ws: WorkspaceContext, id: number): MemberRow | undefined {
  return ws.sqlite.prepare(`${SELECT_MEMBER} WHERE account_id = ? AND id = ?`).get(ws.accountId, id) as MemberRow | undefined;
}

function requireRow(ws: WorkspaceContext, id: number): MemberRow {
  const row = findRow(ws, id);
  if (!row) throw notFound('Member not found');
  return row;
}

function serverLinks(ws: WorkspaceContext, memberId?: number): Map<number, MemberServerLink[]> {
  const rows = ws.sqlite
    .prepare(
      `SELECT msa.member_id, s.id AS server_id, s.name, s.type, msa.external_username, msa.access_state, msa.last_synced_at
       FROM member_server_accounts msa JOIN media_servers s ON s.account_id = msa.account_id AND s.id = msa.server_id
       WHERE msa.account_id = ? ${memberId === undefined ? '' : 'AND msa.member_id = ?'} ORDER BY s.name, s.id`,
    )
    .all(...(memberId === undefined ? [ws.accountId] : [ws.accountId, memberId])) as Array<{
    member_id: number;
    server_id: number;
    name: string;
    type: MemberServerLink['serverType'];
    external_username: string | null;
    access_state: MemberServerLink['accessState'];
    last_synced_at: string | null;
  }>;
  const map = new Map<number, MemberServerLink[]>();
  for (const r of rows) {
    const link: MemberServerLink = { serverId: r.server_id, serverName: r.name, serverType: r.type, externalUsername: r.external_username, accessState: r.access_state, lastSyncedAt: r.last_synced_at };
    map.set(r.member_id, [...(map.get(r.member_id) ?? []), link]);
  }
  return map;
}

function toSummary(row: MemberRow, defaults: MemberDefaults, todayDate: string, servers: MemberServerLink[]): MemberSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    etransferName: row.etransfer_name,
    email: row.email,
    status: row.status,
    currency: row.currency,
    terms: resolveTerms(row, defaults),
    paidThrough: row.paid_through,
    creditCents: row.credit_cents,
    dueInDays: row.paid_through ? diffDays(todayDate, row.paid_through) : null,
    servers,
  };
}

function hasHistory(ws: WorkspaceContext, memberId: number): boolean {
  const n = ws.sqlite
    .prepare(
      `SELECT (SELECT count(*) FROM payments WHERE account_id = ? AND member_id = ?)
            + (SELECT count(*) FROM ledger_entries WHERE account_id = ? AND member_id = ?) AS n`,
    )
    .get(ws.accountId, memberId, ws.accountId, memberId) as { n: number };
  return n.n > 0;
}

function timeline(ws: WorkspaceContext, memberId: number): TimelineEvent[] {
  const rows = ws.sqlite
    .prepare(`SELECT id, at, actor, action, details FROM audit_log WHERE account_id = ? AND entity = 'member' AND entity_id = ? ORDER BY at DESC, id DESC LIMIT 200`)
    .all(ws.accountId, memberId) as Array<{ id: number; at: string; actor: string; action: string; details: string | null }>;
  return rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, details: r.details === null ? null : (JSON.parse(r.details) as unknown) }));
}

export function getMemberDetail(ws: WorkspaceContext, clock: Clock, id: number): MemberDetail {
  const row = requireRow(ws, id);
  const settings = getWorkspaceSettings(ws);
  const summary = toSummary(row, settings.memberDefaults, today(clock, settings.timezone), serverLinks(ws, id).get(id) ?? []);
  const aliases = listAliases(ws, id);
  return {
    ...summary,
    paymentMemoCode: row.payment_memo_code,
    notes: row.notes,
    overrides: { planAmountCents: row.plan_amount_cents, planPeriodDays: row.plan_period_days, toleranceCents: row.tolerance_cents, graceDays: row.grace_days },
    remindersEnabled: row.reminders_enabled === 1,
    emailsEnabled: row.emails_enabled === 1,
    lastPaymentAt: row.last_payment_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    importBatchId: row.import_batch_id,
    aliases,
    managedRule: getManagedRule(ws, id),
    warnings: memberWarnings(ws, {
      id,
      displayName: row.display_name,
      etransferName: row.etransfer_name,
      email: row.email,
      paymentMemoCode: row.payment_memo_code,
      aliases,
      planAmountCents: summary.terms.planAmountCents.value,
    }),
    canDelete: !hasHistory(ws, id),
    timeline: timeline(ws, id),
  };
}

const STATUS_ORDER: Record<MemberStatus, number> = { active: 0, grace: 1, expired: 2, paused: 3, archived: 4 };

/**
 * Search / filter / sort / paginate. A workspace has at most a few hundred members, so the
 * filtering runs in memory, which also makes the search diacritic- and case-insensitive.
 */
export function listMembers(ws: WorkspaceContext, clock: Clock, rawQuery: MemberListQuery = {}): MemberList {
  const query = memberListQuerySchema.parse(rawQuery);
  const settings = getWorkspaceSettings(ws);
  const todayDate = today(clock, settings.timezone);
  const rows = ws.sqlite.prepare(`${SELECT_MEMBER} WHERE account_id = ?`).all(ws.accountId) as MemberRow[];

  const counts = Object.fromEntries(MEMBER_STATUSES.map((s) => [s, 0])) as MemberList['counts'];
  for (const r of rows) counts[r.status]++;

  let selected = rows.filter((r) => (query.status === 'all' ? true : query.status === 'current' ? r.status !== 'archived' : r.status === query.status));

  const needle = query.q ? normalizeName(query.q) : '';
  if (needle) {
    const aliasText = new Map<number, string>();
    const aliasRows = ws.sqlite.prepare('SELECT member_id, value FROM member_aliases WHERE account_id = ?').all(ws.accountId) as Array<{ member_id: number; value: string }>;
    for (const a of aliasRows) aliasText.set(a.member_id, `${aliasText.get(a.member_id) ?? ''}\n${a.value}`);
    selected = selected.filter((r) =>
      normalizeName([r.display_name, r.etransfer_name, r.email, r.payment_memo_code, r.notes, aliasText.get(r.id)].filter(Boolean).join('\n')).includes(needle),
    );
  }

  const byName = (a: MemberRow, b: MemberRow) => normalizeName(a.display_name).localeCompare(normalizeName(b.display_name)) || a.id - b.id;
  const sign = query.dir === 'desc' ? -1 : 1;
  selected.sort((a, b) => {
    switch (query.sort) {
      case 'status':
        return sign * (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || byName(a, b);
      case 'due':
        // Members without a due date always sort last.
        if (a.paid_through === b.paid_through) return byName(a, b);
        if (a.paid_through === null) return 1;
        if (b.paid_through === null) return -1;
        return sign * a.paid_through.localeCompare(b.paid_through);
      case 'created':
        return sign * (a.created_at.localeCompare(b.created_at) || a.id - b.id);
      default:
        return sign * byName(a, b);
    }
  });

  const total = selected.length;
  const start = (query.page - 1) * query.pageSize;
  const links = serverLinks(ws);
  const items = selected.slice(start, start + query.pageSize).map((r) => toSummary(r, settings.memberDefaults, todayDate, links.get(r.id) ?? []));
  return { items, total, page: query.page, pageSize: query.pageSize, counts };
}

/** Memo codes must be unique per workspace, compared case- and whitespace-insensitively (§6.2, §7.4.1). */
function assertMemoCodeFree(ws: WorkspaceContext, code: string | null | undefined, exceptId: number | null): void {
  if (!code) return;
  const wanted = normalizeMemoCode(code);
  const rows = ws.sqlite
    .prepare('SELECT id, display_name, payment_memo_code FROM members WHERE account_id = ? AND payment_memo_code IS NOT NULL AND id <> ?')
    .all(ws.accountId, exceptId ?? 0) as Array<{ id: number; display_name: string; payment_memo_code: string }>;
  const clash = rows.find((r) => normalizeMemoCode(r.payment_memo_code) === wanted);
  if (clash) {
    throw conflict(`The memo code "${clash.payment_memo_code}" is already used by ${clash.display_name}.`, {
      field: 'paymentMemoCode',
      reason: 'memo_code_taken',
      memberId: clash.id,
      displayName: clash.display_name,
    });
  }
}

export function createMember(ws: WorkspaceContext, clock: Clock, actor: string, input: CreateMember): MemberDetail {
  assertMemoCodeFree(ws, input.paymentMemoCode, null);
  const defaults = getWorkspaceSettings(ws).memberDefaults;
  const at = nowIso(clock);
  const values: Record<Field, unknown> = {
    displayName: input.displayName,
    etransferName: input.etransferName ?? null,
    paymentMemoCode: input.paymentMemoCode ?? null,
    email: input.email ?? null,
    notes: input.notes ?? null,
    planAmountCents: input.planAmountCents ?? null,
    planPeriodDays: input.planPeriodDays ?? null,
    // [ASSUMPTION] currency is a NOT NULL column, so a new member takes the workspace currency.
    currency: input.currency ?? defaults.currency,
    toleranceCents: input.toleranceCents ?? null,
    graceDays: input.graceDays ?? null,
    remindersEnabled: input.remindersEnabled ?? true,
    emailsEnabled: input.emailsEnabled ?? true,
  };
  const fields = Object.keys(COLUMNS) as Field[];
  const id = ws.sqlite.transaction(() => {
    const newId = Number(
      ws.sqlite
        .prepare(
          `INSERT INTO members (account_id, ${fields.map((f) => COLUMNS[f]).join(', ')}, created_at, updated_at)
           VALUES (?, ${fields.map(() => '?').join(', ')}, ?, ?)`,
        )
        .run(ws.accountId, ...fields.map((f) => toDb(values[f])), at, at).lastInsertRowid,
    );
    syncManagedRule(ws, { id: newId, displayName: input.displayName, etransferName: input.etransferName ?? null, paymentMemoCode: input.paymentMemoCode ?? null }, at);
    writeAudit(ws, clock, { actor, action: 'member.created', entity: 'member', entityId: newId, details: { displayName: input.displayName } });
    return newId;
  })();
  return getMemberDetail(ws, clock, id);
}

/** Field values as the API reports them, for change detection and the audit trail. */
function apiValue(row: MemberRow, field: Field): unknown {
  const v = row[COLUMNS[field]];
  return field === 'remindersEnabled' || field === 'emailsEnabled' ? v === 1 : v;
}

export function updateMember(ws: WorkspaceContext, clock: Clock, actor: string, id: number, patch: UpdateMember): MemberDetail {
  const before = requireRow(ws, id);
  const changed = (Object.keys(patch) as Field[]).filter((f) => patch[f] !== undefined && JSON.stringify(toDb(patch[f])) !== JSON.stringify(toDb(apiValue(before, f))));
  if (changed.length === 0) return getMemberDetail(ws, clock, id);
  if (changed.includes('paymentMemoCode')) assertMemoCodeFree(ws, patch.paymentMemoCode, id);

  const at = nowIso(clock);
  ws.sqlite.transaction(() => {
    ws.sqlite
      .prepare(`UPDATE members SET ${changed.map((f) => `${COLUMNS[f]} = ?`).join(', ')}, updated_at = ? WHERE account_id = ? AND id = ?`)
      .run(...changed.map((f) => toDb(patch[f])), at, ws.accountId, id);
    if (changed.some((f) => f === 'paymentMemoCode' || f === 'etransferName' || f === 'displayName')) {
      const after = requireRow(ws, id);
      syncManagedRule(ws, { id, displayName: after.display_name, etransferName: after.etransfer_name, paymentMemoCode: after.payment_memo_code }, at);
    }
    // Notes can be long and personal: the audit trail records that they changed, not their text.
    const changes = Object.fromEntries(changed.map((f) => [f, f === 'notes' ? { changed: true } : { from: apiValue(before, f), to: patch[f] }]));
    writeAudit(ws, clock, { actor, action: 'member.updated', entity: 'member', entityId: id, details: { fields: changed, changes } });
  })();
  return getMemberDetail(ws, clock, id);
}

/** Manual status transitions (§8.3). `reactivate` hands the member back to the automatic lifecycle. */
export function changeMemberStatus(ws: WorkspaceContext, clock: Clock, actor: string, id: number, action: MemberStatusAction): MemberDetail {
  const row = requireRow(ws, id);
  let next: MemberStatus;
  if (action === 'pause') {
    if (row.status === 'archived') throw conflict('Reactivate this member before pausing them.');
    if (row.status === 'paused') throw conflict('This member is already paused.');
    next = 'paused';
  } else if (action === 'archive') {
    if (row.status === 'archived') throw conflict('This member is already archived.');
    next = 'archived';
  } else {
    if (row.status !== 'paused' && row.status !== 'archived') throw conflict('Only paused or archived members can be reactivated.');
    const settings = getWorkspaceSettings(ws);
    next = derivedStatus(row.paid_through, resolveTerms(row, settings.memberDefaults).graceDays.value, today(clock, settings.timezone));
  }
  const at = nowIso(clock);
  ws.sqlite.transaction(() => {
    ws.sqlite.prepare('UPDATE members SET status = ?, updated_at = ? WHERE account_id = ? AND id = ?').run(next, at, ws.accountId, id);
    writeAudit(ws, clock, { actor, action: 'member.status_changed', entity: 'member', entityId: id, details: { action, from: row.status, to: next } });
  })();
  return getMemberDetail(ws, clock, id);
}

/** "Delete member with no history" (§6.0 rule 5). Anyone with payments or ledger entries can only be archived. */
export function deleteMember(ws: WorkspaceContext, clock: Clock, actor: string, id: number): void {
  const row = requireRow(ws, id);
  if (hasHistory(ws, id)) throw conflict('This member has payment history and cannot be deleted. Archive them instead.', { reason: 'has_history' });
  ws.sqlite.transaction(() => {
    ws.sqlite.prepare('DELETE FROM members WHERE account_id = ? AND id = ?').run(ws.accountId, id);
    writeAudit(ws, clock, { actor, action: 'member.deleted', entity: 'member', entityId: id, details: { displayName: row.display_name } });
  })();
}
