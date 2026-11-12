import {
  type CellState,
  csvFieldLabel,
  type ImportBatchListItem,
  type ImportCell,
  type ImportResult,
  type ImportRowFilter,
  type ImportRowView,
  type ImportSummary,
  isServerField,
  type MatchType,
  type MemberDefaults,
  type MemberStatus,
  normalizeEmail,
  normalizeMemoCode,
  normalizeName,
  parseMoneyToCents,
  centsToDecimal,
  derivedStatus,
  addDays,
  SERVER_FIELD_PREFIX,
  type UpdateMember,
} from '@subscriberr/shared';
import { notFound } from '../../core/errors.js';
import { type Clock, today } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import { linkLabel, linksByMember, listServers, type MemberLink, type ServerRef, type ServerUserDirectory } from '../media/links.js';
import type { ExternalUser } from '../media/provider.js';
import { allMemberRows, type MemberRow } from '../members/members.js';
import { getWorkspaceSettings } from '../workspaces/settings.js';
import { unguardCell } from './csv.js';
import { aliasesText, blankMeaning, isAutomaticStatus, parseAliases, parseCell } from './fields.js';

// Import staging (Spec §12.2 steps 2–5). Nothing here writes to `members`: rows live in
// import_rows, and every view (match, diff, validation, summary) is computed from the staged row,
// the admin's edits and the current database, so it is always up to date.

export interface BatchMeta {
  fileName: string;
  encoding: string;
  delimiter: string;
  headers: string[];
  columns: Array<string | null>;
  defaults: Record<string, string>;
  stage: 'mapping' | 'review';
  result?: ImportResult;
  /** Highest audit_log id right after the commit: later entries on these members block undo. */
  auditHighWater?: number;
  undoSummary?: { deleted: number; archived: number; restored: number };
}

export interface RowEdits {
  values?: Record<string, string>;
  use?: Record<string, 'csv' | 'db'>;
  action?: 'create' | 'update' | 'skip';
  /** Manual match; null = "this is a new member". Absent = automatic matching. */
  matchMemberId?: number | null;
}

export interface StagedRow {
  id: number;
  rowNumber: number;
  raw: string[];
  edits: RowEdits;
}

export interface BatchRecord {
  id: number;
  status: 'staged' | 'committed' | 'undone' | 'abandoned';
  meta: BatchMeta;
  createdAt: string;
  committedAt: string | null;
  undoneAt: string | null;
}

export function loadBatch(ws: WorkspaceContext, id: number): BatchRecord {
  const row = ws.sqlite.prepare('SELECT id, status, mapping, created_at, committed_at, undone_at FROM import_batches WHERE account_id = ? AND id = ?').get(ws.accountId, id) as
    | { id: number; status: BatchRecord['status']; mapping: string; created_at: string; committed_at: string | null; undone_at: string | null }
    | undefined;
  if (!row) throw notFound('Import not found');
  return { id: row.id, status: row.status, meta: JSON.parse(row.mapping) as BatchMeta, createdAt: row.created_at, committedAt: row.committed_at, undoneAt: row.undone_at };
}

export function saveMeta(ws: WorkspaceContext, id: number, meta: BatchMeta): void {
  ws.sqlite.prepare('UPDATE import_batches SET mapping = ? WHERE account_id = ? AND id = ?').run(JSON.stringify(meta), ws.accountId, id);
}

export function loadRows(ws: WorkspaceContext, batchId: number): StagedRow[] {
  const rows = ws.sqlite.prepare('SELECT id, row_number, raw, edits FROM import_rows WHERE account_id = ? AND batch_id = ? ORDER BY row_number').all(ws.accountId, batchId) as Array<{
    id: number;
    row_number: number;
    raw: string;
    edits: string | null;
  }>;
  return rows.map((r) => ({ id: r.id, rowNumber: r.row_number, raw: JSON.parse(r.raw) as string[], edits: r.edits ? (JSON.parse(r.edits) as RowEdits) : {} }));
}

export function listBatches(ws: WorkspaceContext): ImportBatchListItem[] {
  const rows = ws.sqlite
    .prepare(
      `SELECT b.id, b.status, b.mapping, b.created_at, b.committed_at, b.undone_at, (SELECT count(*) FROM import_rows r WHERE r.account_id = b.account_id AND r.batch_id = b.id) AS n
       FROM import_batches b WHERE b.account_id = ? AND b.status <> 'abandoned' ORDER BY b.id DESC LIMIT 50`,
    )
    .all(ws.accountId) as Array<{ id: number; status: BatchRecord['status']; mapping: string; created_at: string; committed_at: string | null; undone_at: string | null; n: number }>;
  return rows.map((r) => {
    const meta = JSON.parse(r.mapping) as BatchMeta;
    return { id: r.id, status: r.status, stage: meta.stage, fileName: meta.fileName, rows: r.n, createdAt: r.created_at, committedAt: r.committed_at, undoneAt: r.undone_at };
  });
}

// ---- Context: the current database, loaded once per request ---------------------------------

export interface ImportContext {
  defaults: MemberDefaults;
  today: string;
  members: Map<number, MemberRow>;
  /** Normalized key → member ids (for matching). */
  byEmail: Map<string, Set<number>>;
  byName: Map<string, Set<number>>;
  byDisplay: Map<string, Set<number>>;
  /** `${kind}:${value}` → owning member id. */
  aliasOwner: Map<string, number>;
  aliasesOf: Map<number, Array<{ kind: 'name' | 'email'; value: string }>>;
  links: Map<number, MemberLink[]>;
  servers: ServerRef[];
  serverUsers: Map<number, { users: ExternalUser[] | null; error: string | null }>;
}

function addTo(map: Map<string, Set<number>>, key: string | null | undefined, id: number) {
  if (!key) return;
  const set = map.get(key) ?? new Set<number>();
  set.add(id);
  map.set(key, set);
}

export async function loadImportContext(ws: WorkspaceContext, clock: Clock, directory: ServerUserDirectory, meta: BatchMeta): Promise<ImportContext> {
  const settings = getWorkspaceSettings(ws);
  const rows = allMemberRows(ws);
  const ctx: ImportContext = {
    defaults: settings.memberDefaults,
    today: today(clock, settings.timezone),
    members: new Map(rows.map((r) => [r.id, r])),
    byEmail: new Map(),
    byName: new Map(),
    byDisplay: new Map(),
    aliasOwner: new Map(),
    aliasesOf: new Map(),
    links: linksByMember(ws),
    servers: listServers(ws),
    serverUsers: new Map(),
  };
  for (const r of rows) {
    addTo(ctx.byEmail, r.email ? normalizeEmail(r.email) : null, r.id);
    addTo(ctx.byName, r.etransfer_name ? normalizeName(r.etransfer_name) : null, r.id);
    addTo(ctx.byDisplay, normalizeName(r.display_name), r.id);
  }
  const aliases = ws.sqlite.prepare('SELECT member_id, kind, value FROM member_aliases WHERE account_id = ?').all(ws.accountId) as Array<{ member_id: number; kind: 'name' | 'email'; value: string }>;
  for (const a of aliases) {
    ctx.aliasOwner.set(`${a.kind}:${a.value}`, a.member_id);
    ctx.aliasesOf.set(a.member_id, [...(ctx.aliasesOf.get(a.member_id) ?? []), { kind: a.kind, value: a.value }]);
    addTo(a.kind === 'email' ? ctx.byEmail : ctx.byName, a.value, a.member_id);
  }
  const wanted = new Set([...meta.columns.filter((c): c is string => c !== null), ...Object.keys(meta.defaults)].filter(isServerField).map((f) => f.slice(SERVER_FIELD_PREFIX.length)));
  for (const s of ctx.servers) if (wanted.has(s.name)) ctx.serverUsers.set(s.id, await directory.users(s));
  return ctx;
}

// ---- Evaluation -------------------------------------------------------------------------------

/** What committing a row would do (null for skipped rows). */
export interface RowApply {
  action: 'create' | 'update';
  memberId: number | null;
  patch: UpdateMember;
  displayName: string;
  paidThrough?: string;
  creditCents?: number;
  /** 'automatic' = hand a paused/archived member back to the automatic lifecycle. */
  status?: 'paused' | 'archived' | 'automatic';
  aliases: Array<{ kind: 'name' | 'email'; value: string }>;
  links: Array<{ serverId: number; user: Pick<ExternalUser, 'id' | 'username' | 'email'> }>;
  fields: string[];
}

export interface RowEval {
  view: ImportRowView;
  apply: RowApply | null;
  /** Final paid-through / grace / status used for the safety warnings. */
  outcome: { paidThrough: string | null; graceDays: number; status: MemberStatus | 'automatic' } | null;
}

/** Fields present in the file (mapped columns), then mapping defaults for unmapped fields. */
export function batchFields(meta: BatchMeta): Array<{ field: string; column: number | null }> {
  const out: Array<{ field: string; column: number | null }> = [];
  meta.columns.forEach((f, i) => {
    if (f) out.push({ field: f, column: i });
  });
  for (const f of Object.keys(meta.defaults)) if (!out.some((o) => o.field === f)) out.push({ field: f, column: null });
  return out;
}

const centsOf = (v: string | null) => (v === null ? null : parseMoneyToCents(v));

/** The database value of a field, in the same canonical text form as `parseCell`. */
function dbText(field: string, m: MemberRow, ctx: ImportContext): string | null {
  if (isServerField(field)) {
    const server = ctx.servers.find((s) => `${SERVER_FIELD_PREFIX}${s.name}` === field);
    const link = server ? ctx.links.get(m.id)?.find((l) => l.serverId === server.id) : undefined;
    return link ? linkLabel(link) : null;
  }
  switch (field) {
    case 'id':
      return String(m.id);
    case 'display_name':
      return m.display_name;
    case 'etransfer_name':
      return m.etransfer_name;
    case 'email':
      return m.email;
    case 'notes':
      return m.notes;
    case 'payment_memo_code':
      return m.payment_memo_code;
    case 'plan_amount':
      return m.plan_amount_cents === null ? null : centsToDecimal(m.plan_amount_cents);
    case 'plan_period_days':
      return m.plan_period_days === null ? null : String(m.plan_period_days);
    case 'tolerance':
      return m.tolerance_cents === null ? null : centsToDecimal(m.tolerance_cents);
    case 'grace_days':
      return m.grace_days === null ? null : String(m.grace_days);
    case 'currency':
      return m.currency;
    case 'paid_through':
      return m.paid_through;
    case 'credit':
      return centsToDecimal(m.credit_cents);
    case 'status':
      return m.status;
    case 'reminders_enabled':
      return m.reminders_enabled === 1 ? 'true' : 'false';
    case 'emails_enabled':
      return m.emails_enabled === 1 ? 'true' : 'false';
    case 'aliases': {
      const list = ctx.aliasesOf.get(m.id) ?? [];
      return list.length > 0 ? aliasesText([...list].sort((a, b) => (a.kind + a.value).localeCompare(b.kind + b.value))) : null;
    }
    default:
      return null;
  }
}

interface MatchResult {
  type: MatchType;
  confidence: 'exact' | 'high' | 'medium' | null;
  memberId: number | null;
  candidates: number[];
  note?: string;
}

/** §12.2 step 3: id → email → e-Transfer name → display name; more than one hit = ambiguous (never guessed). */
function autoMatch(values: Map<string, string | null>, ctx: ImportContext): MatchResult {
  let note: string | undefined;
  const id = values.get('id');
  if (id) {
    if (ctx.members.has(Number(id))) return { type: 'id', confidence: 'exact', memberId: Number(id), candidates: [] };
    note = `Member id ${id} does not exist in this workspace; matched by the other columns instead.`;
  }
  const steps: Array<[MatchType, 'high' | 'medium', Map<string, Set<number>>, string | null | undefined]> = [
    ['email', 'high', ctx.byEmail, values.get('email') ? normalizeEmail(values.get('email')!) : null],
    ['etransfer_name', 'medium', ctx.byName, values.get('etransfer_name') ? normalizeName(values.get('etransfer_name')!) : null],
    ['display_name', 'medium', ctx.byDisplay, values.get('display_name') ? normalizeName(values.get('display_name')!) : null],
  ];
  for (const [type, confidence, index, key] of steps) {
    if (!key) continue;
    const hits = [...(index.get(key) ?? [])];
    if (hits.length === 1) return { type, confidence, memberId: hits[0]!, candidates: [], note };
    if (hits.length > 1) return { type: 'ambiguous', confidence: null, memberId: null, candidates: hits, note: `More than one member has this ${type.replace('_', ' ')}: choose the right one, or create a new member.` };
  }
  return { type: 'none', confidence: null, memberId: null, candidates: [], note };
}

function findServerUser(users: ExternalUser[], text: string): ExternalUser | undefined {
  const t = text.trim().toLowerCase();
  return users.find((u) => u.username.toLowerCase() === t) ?? users.find((u) => (u.email ? normalizeEmail(u.email) === t : false)) ?? users.find((u) => u.id === text.trim());
}

/** Evaluates one row against the context. Cross-row checks are added by `evaluateRows`. */
function evaluateRow(row: StagedRow, meta: BatchMeta, ctx: ImportContext): RowEval {
  const fields = batchFields(meta);
  const values = new Map<string, string | null>();
  const cells: ImportCell[] = [];
  const parseErrors = new Map<string, string>();
  for (const { field, column } of fields) {
    const original = column === null ? (meta.defaults[field] ?? '') : unguardCell(row.raw[column] ?? '');
    const csv = row.edits.values?.[field] ?? original;
    const parsed = parseCell(field, csv);
    values.set(field, parsed.value);
    if (parsed.error) parseErrors.set(field, parsed.error);
    cells.push({ field, csv, original, edited: csv !== original, value: parsed.value, db: null, state: 'unchanged', use: row.edits.use?.[field] ?? 'csv' });
  }

  // Match.
  let match: MatchResult;
  if (row.edits.matchMemberId !== undefined) {
    const id = row.edits.matchMemberId;
    match = id !== null && ctx.members.has(id) ? { type: 'manual', confidence: 'exact', memberId: id, candidates: [] } : { type: id === null ? 'manual' : 'none', confidence: null, memberId: null, candidates: [] };
  } else match = autoMatch(values, ctx);

  const action = row.edits.action ?? (match.memberId !== null ? 'update' : match.type === 'ambiguous' ? 'skip' : 'create');
  const member = action === 'update' && match.memberId !== null ? (ctx.members.get(match.memberId) ?? null) : null;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (match.note) warnings.push(match.note);
  if (action === 'update' && !member) errors.push('Choose the member this row updates, or switch the row to “Create new”.');
  const extra = row.raw.slice(meta.headers.length).filter((c) => c.trim() !== '');
  if (extra.length > 0) warnings.push(`${extra.length} cell(s) beyond the last header were ignored.`);

  const apply: RowApply = { action: action === 'skip' ? 'create' : action, memberId: member?.id ?? null, patch: {}, displayName: '', aliases: [], links: [], fields: [] };
  const label = (f: string) => csvFieldLabel(f);

  for (const cell of cells) {
    const f = cell.field;
    const v = cell.value;
    cell.db = member ? dbText(f, member, ctx) : null;
    const meaning = blankMeaning(f);
    let state: CellState;
    let warning: string | undefined;
    let error = parseErrors.get(f);

    if (f === 'id') state = 'unchanged';
    else if (!member) state = (v !== null && !(f === 'status' && isAutomaticStatus(v))) || error ? 'new' : 'unchanged';
    else if (error) state = 'changed';
    else if (v === null && meaning === 'keep') state = 'unchanged';
    else if (f === 'aliases') {
      const own = new Set((ctx.aliasesOf.get(member.id) ?? []).map((a) => `${a.kind}:${a.value}`));
      state = parseAliases(v ?? '').aliases.some((a) => !own.has(`${a.kind}:${a.value}`)) ? 'changed' : 'unchanged';
    } else if (f === 'status') {
      const dbManual = member.status === 'paused' || member.status === 'archived';
      state = isAutomaticStatus(v) ? (dbManual ? 'changed' : 'unchanged') : v !== member.status ? 'changed' : 'unchanged';
    } else if (isServerField(f)) state = 'changed'; // refined below once the server user is resolved
    else state = v === cell.db ? 'unchanged' : 'changed';

    // Field-specific checks.
    if (f === 'display_name' && action === 'create' && v === null && !error) error = 'Required for a new member';
    if (f === 'status' && v !== null && isAutomaticStatus(v) && state === 'unchanged' && (!member || v !== member.status)) {
      warning = `Status “${v}” is not imported: active / grace / expired are calculated from the paid-through date.`;
    }
    if (f === 'status' && member && state === 'changed' && isAutomaticStatus(v)) warning = 'Reactivates this member (status is then calculated from the paid-through date).';
    if (meaning === 'clear' && member && v === null && state === 'changed') warning = `Clears the ${label(f).toLowerCase()} (the cell is empty).`;
    if (f === 'paid_through' && v !== null && v > addDays(ctx.today, 5 * 365)) warning = 'This date is more than 5 years away. Is it right?';

    if (isServerField(f) && v !== null && !error) {
      const server = ctx.servers.find((s) => `${SERVER_FIELD_PREFIX}${s.name}` === f);
      const directory = server ? ctx.serverUsers.get(server.id) : undefined;
      const current = member && server ? ctx.links.get(member.id)?.find((l) => l.serverId === server.id) : undefined;
      if (!server) error = `There is no server named “${f.slice(SERVER_FIELD_PREFIX.length)}”.`;
      else if (!directory?.users) {
        warning = `Could not read the users of ${server.name} (${directory?.error ?? 'unavailable'}); the link is left unchanged.`;
        state = 'unchanged';
      } else {
        const user = findServerUser(directory.users, v);
        const linkedTo = user ? [...ctx.links.entries()].find(([mid, ls]) => mid !== member?.id && ls.some((l) => l.serverId === server.id && l.externalUserId === user.id)) : undefined;
        if (!user) {
          warning = `No user “${v}” on ${server.name}; this member is left unlinked there.`;
          state = 'unchanged';
        } else if (user.isAdmin) {
          warning = `“${user.username}” is the admin account of ${server.name}; it is never linked to a member.`;
          state = 'unchanged';
        } else if (linkedTo) {
          warning = `“${user.username}” on ${server.name} is already linked to ${ctx.members.get(linkedTo[0])?.display_name ?? 'another member'}; left unchanged.`;
          state = 'unchanged';
        } else if (current?.externalUserId === user.id) state = 'unchanged';
        else {
          state = member ? 'changed' : 'new';
          if (cell.use === 'csv') apply.links.push({ serverId: server.id, user: { id: user.id, username: user.username, email: user.email ?? null } });
        }
      }
    }

    cell.state = state;
    if (warning) cell.warning = warning;
    // Skipped rows are validated as if they were applied, so their problems stay visible (they just do not block).
    const applied = member === null || (state === 'changed' && cell.use === 'csv');
    if (error && applied) cell.error = error;
    else if (error && member && cell.use === 'db') cell.warning = `Ignored (keeping the database value): ${error}`;
    if (cell.error) errors.push(`${label(f)}: ${cell.error}`);
    if (cell.warning) warnings.push(`${label(f)}: ${cell.warning}`);

    // Build the change set.
    if (!applied || cell.error || state === 'unchanged' || f === 'id' || isServerField(f)) continue;
    apply.fields.push(f);
    switch (f) {
      case 'display_name':
        apply.patch.displayName = v!;
        break;
      case 'etransfer_name':
        apply.patch.etransferName = v;
        break;
      case 'email':
        apply.patch.email = v;
        break;
      case 'notes':
        apply.patch.notes = v;
        break;
      case 'payment_memo_code':
        apply.patch.paymentMemoCode = v;
        break;
      case 'plan_amount':
        apply.patch.planAmountCents = centsOf(v);
        break;
      case 'tolerance':
        apply.patch.toleranceCents = centsOf(v);
        break;
      case 'plan_period_days':
        apply.patch.planPeriodDays = v === null ? null : Number(v);
        break;
      case 'grace_days':
        apply.patch.graceDays = v === null ? null : Number(v);
        break;
      case 'currency':
        if (v) apply.patch.currency = v;
        break;
      case 'reminders_enabled':
        if (v) apply.patch.remindersEnabled = v === 'true';
        break;
      case 'emails_enabled':
        if (v) apply.patch.emailsEnabled = v === 'true';
        break;
      case 'paid_through':
        if (v) apply.paidThrough = v;
        break;
      case 'credit':
        // A new member starts with zero credit, so a 0.00 cell needs no ledger entry.
        if (v && (member || centsOf(v) !== 0)) apply.creditCents = centsOf(v)!;
        break;
      case 'status':
        if (v === 'paused' || v === 'archived') apply.status = v;
        else if (member) apply.status = 'automatic';
        break;
      case 'aliases': {
        const own = new Set(member ? (ctx.aliasesOf.get(member.id) ?? []).map((a) => `${a.kind}:${a.value}`) : []);
        const names = new Set(
          [apply.patch.displayName ?? member?.display_name, apply.patch.etransferName ?? member?.etransfer_name].filter((x): x is string => Boolean(x)).map((x) => `name:${normalizeName(x)}`),
        );
        const email = apply.patch.email ?? member?.email;
        if (email) names.add(`email:${normalizeEmail(email)}`);
        for (const a of parseAliases(v ?? '').aliases) {
          const key = `${a.kind}:${a.value}`;
          if (own.has(key) || names.has(key)) continue;
          const owner = ctx.aliasOwner.get(key);
          if (owner !== undefined && owner !== member?.id) {
            const msg = `Aliases: “${a.value}” already belongs to ${ctx.members.get(owner)?.display_name ?? 'another member'}; skipped.`;
            warnings.push(msg);
            cell.warning = cell.warning ? `${cell.warning} ${msg}` : msg;
            continue;
          }
          apply.aliases.push(a);
        }
        break;
      }
    }
  }
  if (apply.links.length > 0) apply.fields.push(...apply.links.map((l) => `${SERVER_FIELD_PREFIX}${ctx.servers.find((s) => s.id === l.serverId)?.name ?? l.serverId}`));
  apply.displayName = apply.patch.displayName ?? member?.display_name ?? '';

  // Memo code clash with an existing member (other than the one being updated).
  if (apply.patch.paymentMemoCode) {
    const wanted = normalizeMemoCode(apply.patch.paymentMemoCode);
    const clash = [...ctx.members.values()].find((m) => m.id !== member?.id && m.payment_memo_code && normalizeMemoCode(m.payment_memo_code) === wanted);
    if (clash) {
      const msg = `Memo code: “${apply.patch.paymentMemoCode}” is already used by ${clash.display_name}`;
      errors.push(msg);
      const cell = cells.find((c) => c.field === 'payment_memo_code');
      if (cell) cell.error = msg.replace('Memo code: ', '');
    }
  }
  if (action === 'create' && match.memberId !== null) warnings.push(`This row matches ${ctx.members.get(match.memberId)?.display_name ?? 'an existing member'} but will create a new member.`);

  const changes = action === 'skip' ? 0 : cells.filter((c) => (c.state === 'new' || c.state === 'changed') && (member === null || c.use === 'csv') && c.field !== 'id').length;
  const matchedMember = match.memberId !== null ? ctx.members.get(match.memberId) : undefined;
  const view: ImportRowView = {
    id: row.id,
    rowNumber: row.rowNumber,
    action,
    match: {
      type: match.type,
      confidence: match.confidence,
      memberId: match.memberId,
      displayName: matchedMember?.display_name ?? null,
      status: matchedMember?.status ?? null,
      candidates: match.candidates.map((id) => ({ id, displayName: ctx.members.get(id)?.display_name ?? `#${id}` })),
    },
    cells,
    errors,
    warnings,
    changes,
    edited: cells.some((c) => c.edited) || row.edits.action !== undefined || row.edits.matchMemberId !== undefined || Object.keys(row.edits.use ?? {}).length > 0,
  };

  let outcome: RowEval['outcome'] = null;
  if (action !== 'skip') {
    const grace = apply.patch.graceDays !== undefined ? apply.patch.graceDays : (member?.grace_days ?? null);
    const status = apply.status ?? (member && (member.status === 'paused' || member.status === 'archived') ? member.status : 'automatic');
    outcome = { paidThrough: apply.paidThrough ?? member?.paid_through ?? null, graceDays: grace ?? ctx.defaults.graceDays, status };
  }
  return { view, apply: action === 'skip' || errors.length > 0 ? null : apply, outcome };
}

/** Evaluates every row, then adds the cross-row checks (duplicates within the file). */
export function evaluateRows(rows: StagedRow[], meta: BatchMeta, ctx: ImportContext): RowEval[] {
  const evals = rows.map((r) => evaluateRow(r, meta, ctx));
  const active = evals.filter((e) => e.view.action !== 'skip');

  const groups = <K>(keyOf: (e: RowEval) => K | null) => {
    const map = new Map<K, RowEval[]>();
    for (const e of active) {
      const k = keyOf(e);
      if (k !== null) map.set(k, [...(map.get(k) ?? []), e]);
    }
    return [...map.values()].filter((g) => g.length > 1);
  };
  const flag = (group: RowEval[], kind: 'error' | 'warning', message: (other: string) => string) => {
    for (const e of group) {
      const others = group.filter((o) => o !== e).map((o) => `row ${o.view.rowNumber}`).join(', ');
      if (kind === 'error') {
        e.view.errors.push(message(others));
        e.apply = null;
      } else e.view.warnings.push(message(others));
    }
  };
  const cellValue = (e: RowEval, f: string) => e.view.cells.find((c) => c.field === f)?.value ?? null;

  for (const g of groups((e) => (e.view.action === 'update' ? e.view.match.memberId : null))) flag(g, 'error', (o) => `Another row (${o}) updates the same member.`);
  for (const g of groups((e) => {
    const code = cellValue(e, 'payment_memo_code');
    return code ? normalizeMemoCode(code) : null;
  }))
    flag(g, 'error', (o) => `Memo code is repeated in ${o}; each member needs a different code.`);
  for (const g of groups((e) => (e.view.action === 'create' && cellValue(e, 'email') ? normalizeEmail(cellValue(e, 'email')!) : null))) flag(g, 'warning', (o) => `Same email as ${o}.`);
  for (const g of groups((e) => (e.view.action === 'create' && cellValue(e, 'etransfer_name') ? normalizeName(cellValue(e, 'etransfer_name')!) : null)))
    flag(g, 'warning', (o) => `Same e-Transfer name as ${o}: payments from that name will go to the Review Queue until memo codes tell them apart.`);
  return evals;
}

export function summarize(evals: RowEval[], ctx: ImportContext): ImportSummary {
  const s: ImportSummary = { rows: evals.length, create: 0, update: 0, unchanged: 0, skip: 0, errorRows: 0, warningRows: 0, safetyWarnings: [] };
  let pastGrace = 0;
  let noDate = 0;
  let clears = 0;
  let links = 0;
  for (const e of evals) {
    const v = e.view;
    if (v.action === 'skip') {
      s.skip++;
      continue;
    }
    if (v.action === 'create') s.create++;
    else if (v.changes === 0) {
      // Not written at all, so it cannot cause any of the safety warnings below.
      s.unchanged++;
      if (v.errors.length > 0) s.errorRows++;
      continue;
    } else s.update++;
    if (v.errors.length > 0) s.errorRows++;
    if (v.warnings.length > 0) s.warningRows++;
    if (v.cells.some((c) => c.warning?.startsWith('Clears'))) clears++;
    links += e.apply?.links.length ?? 0;
    const o = e.outcome;
    if (o && o.status === 'automatic') {
      if (!o.paidThrough) noDate++;
      else if (derivedStatus(o.paidThrough, o.graceDays, ctx.today) === 'expired') pastGrace++;
    }
  }
  if (pastGrace > 0) s.safetyWarnings.push(`${pastGrace} imported member${pastGrace === 1 ? ' is' : 's are'} already past the grace period and would lose media access on the next enforcement sync.`);
  if (noDate > 0) s.safetyWarnings.push(`${noDate} imported member${noDate === 1 ? ' has' : 's have'} no paid-through date and will count as expired until a payment or opening balance is recorded.`);
  if (clears > 0) s.safetyWarnings.push(`${clears} row${clears === 1 ? '' : 's'} will clear existing values (empty cells in mapped columns).`);
  if (links > 0) s.safetyWarnings.push(`${links} media-server link${links === 1 ? '' : 's'} will be set. Nothing changes on the servers until enforcement runs, and its first run is a dry run.`);
  return s;
}

export function filterRows(evals: RowEval[], filter: ImportRowFilter): RowEval[] {
  switch (filter) {
    case 'errors':
      return evals.filter((e) => e.view.action !== 'skip' && e.view.errors.length > 0);
    case 'changes':
      return evals.filter((e) => e.view.action !== 'skip' && e.view.changes > 0);
    case 'new':
      return evals.filter((e) => e.view.action === 'create');
    case 'unmatched':
      return evals.filter((e) => e.view.match.memberId === null);
    case 'skipped':
      return evals.filter((e) => e.view.action === 'skip');
    default:
      return evals;
  }
}

/** Records the computed match / action / problems on the staged rows (for inspection; views are always recomputed). */
export function persistEvaluations(ws: WorkspaceContext, evals: RowEval[]): void {
  const stmt = ws.sqlite.prepare('UPDATE import_rows SET matched_member_id = ?, action = ?, errors = ? WHERE account_id = ? AND id = ?');
  ws.sqlite.transaction(() => {
    for (const e of evals) {
      const problems = e.view.errors.length + e.view.warnings.length > 0 ? JSON.stringify({ errors: e.view.errors, warnings: e.view.warnings }) : null;
      stmt.run(e.view.match.memberId, e.view.action, problems, ws.accountId, e.view.id);
    }
  })();
}

export function saveEdits(ws: WorkspaceContext, rowId: number, edits: RowEdits): void {
  const empty = !edits.values && !edits.use && edits.action === undefined && edits.matchMemberId === undefined;
  ws.sqlite.prepare('UPDATE import_rows SET edits = ? WHERE account_id = ? AND id = ?').run(empty ? null : JSON.stringify(edits), ws.accountId, rowId);
}
