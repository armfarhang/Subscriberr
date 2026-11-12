import path from 'node:path';
import {
  CSV_BASE_FIELDS,
  type ImportBatchView,
  type ImportBulk,
  type ImportMapping,
  importMappingSchema,
  type ImportResult,
  type ImportRowPatch,
  type ImportRowsPage,
  type ImportRowView,
  IMPORT_LIMITS,
  IMPORT_UNDO_WINDOW_HOURS,
  isServerField,
  SERVER_FIELD_PREFIX,
} from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { type Clock, nowIso } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import { recordManualSet, voidLedgerEntry } from '../billing/ledger.js';
import { getMemberLink, listServers, type MemberLink, restoreMemberLink, type ServerUserDirectory, setMemberLink } from '../media/links.js';
import { addAlias, removeAlias } from '../members/aliases.js';
import {
  applyMemberPatch,
  applyStatusAction,
  deleteMember,
  getMemberRow,
  insertMember,
  memberHasHistory,
  memberSnapshot,
  type MemberSnapshot,
  restoreMemberSnapshot,
} from '../members/members.js';
import { type BackupEnv, runBackup } from '../system/backup.js';
import { CsvParseError, decodeCsvBytes, detectDelimiter, parseCsv } from './csv.js';
import { autoMap } from './fields.js';
import {
  type BatchMeta,
  evaluateRows,
  filterRows,
  loadBatch,
  loadImportContext,
  loadRows,
  persistEvaluations,
  type RowEdits,
  type RowEval,
  saveEdits,
  saveMeta,
  summarize,
} from './staging.js';

export interface ImportDeps {
  clock: Clock;
  log: Logger;
  directory: ServerUserDirectory;
  backupEnv: BackupEnv;
}

const DELIMITER_NAMES: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab' };

// ---- Step 1: upload -------------------------------------------------------------------------

/** Parses an uploaded file into a new staged batch (rows only; nothing is matched yet). */
export function createImport(ws: WorkspaceContext, deps: Pick<ImportDeps, 'clock'>, actor: string, fileName: string, bytes: Uint8Array): number {
  if (bytes.length === 0) throw badRequest('The file is empty.');
  if (bytes.length > IMPORT_LIMITS.maxBytes) throw new AppError(413, 'too_large', `The file is larger than ${IMPORT_LIMITS.maxBytes / 1024 / 1024} MB.`);
  const { text, encoding } = decodeCsvBytes(bytes);
  const delimiter = detectDelimiter(text);
  let table: string[][];
  try {
    table = parseCsv(text, delimiter);
  } catch (err) {
    if (err instanceof CsvParseError) throw badRequest(err.message);
    throw err;
  }
  const [headerRow, ...dataRows] = table;
  if (!headerRow || dataRows.length === 0) throw badRequest('The file needs a header row and at least one data row.');
  if (dataRows.length > IMPORT_LIMITS.maxRows) throw new AppError(413, 'too_many_rows', `The file has ${dataRows.length} rows; the limit is ${IMPORT_LIMITS.maxRows}.`);
  const headers = headerRow.map((h, i) => h.trim() || `Column ${i + 1}`);
  const servers = listServers(ws).map((s) => s.name);
  const meta: BatchMeta = {
    fileName: path.basename(fileName.replace(/\\/g, '/')).slice(0, 200) || 'upload.csv',
    encoding,
    delimiter: DELIMITER_NAMES[delimiter] ?? delimiter,
    headers,
    columns: autoMap(headers, servers),
    defaults: {},
    stage: 'mapping',
  };
  const at = nowIso(deps.clock);
  return ws.sqlite.transaction(() => {
    const id = Number(
      ws.sqlite.prepare(`INSERT INTO import_batches (account_id, status, mapping, created_at) VALUES (?, 'staged', ?, ?)`).run(ws.accountId, JSON.stringify(meta), at).lastInsertRowid,
    );
    const insert = ws.sqlite.prepare(`INSERT INTO import_rows (account_id, batch_id, row_number, raw, action) VALUES (?, ?, ?, ?, 'skip')`);
    // Row numbers are spreadsheet line numbers: the header is row 1.
    dataRows.forEach((cells, i) => insert.run(ws.accountId, id, i + 2, JSON.stringify(cells)));
    writeAudit(ws, deps.clock, { actor, action: 'import.uploaded', entity: 'import', entityId: id, details: { fileName: meta.fileName, rows: dataRows.length, encoding, delimiter: meta.delimiter } });
    return id;
  })();
}

function requireStaged(ws: WorkspaceContext, id: number) {
  const batch = loadBatch(ws, id);
  if (batch.status !== 'staged') throw conflict(`This import is already ${batch.status}.`);
  return batch;
}

export function availableFields(ws: WorkspaceContext): string[] {
  return [...CSV_BASE_FIELDS, ...listServers(ws).map((s) => `${SERVER_FIELD_PREFIX}${s.name}`)];
}

// ---- Step 2: mapping ------------------------------------------------------------------------

export async function setMapping(ws: WorkspaceContext, deps: ImportDeps, id: number, input: ImportMapping): Promise<void> {
  const mapping = importMappingSchema.parse(input);
  const batch = requireStaged(ws, id);
  if (mapping.columns.length !== batch.meta.headers.length) throw badRequest(`Expected ${batch.meta.headers.length} column choices.`);
  const allowed = new Set(availableFields(ws));
  const seen = new Set<string>();
  for (const f of mapping.columns) {
    if (f === null) continue;
    if (!allowed.has(f)) throw badRequest(`Unknown field "${f}".`);
    if (seen.has(f)) throw badRequest(`"${f}" is mapped to more than one column.`);
    seen.add(f);
  }
  for (const f of Object.keys(mapping.defaults)) {
    if (!allowed.has(f)) throw badRequest(`Unknown field "${f}" in defaults.`);
    if (f === 'id' || f === 'display_name' || f === 'email' || f === 'etransfer_name' || f === 'payment_memo_code' || f === 'aliases' || isServerField(f)) {
      throw badRequest(`"${f}" identifies a person and cannot have a default for every row.`);
    }
  }
  if (!['id', 'display_name', 'email', 'etransfer_name'].some((f) => seen.has(f))) {
    throw badRequest('Map at least one column that identifies the member: display_name, email, etransfer_name or id.');
  }
  const defaults = Object.fromEntries(Object.entries(mapping.defaults).filter(([f, v]) => !seen.has(f) && v.trim() !== ''));
  const meta: BatchMeta = { ...batch.meta, columns: mapping.columns, defaults, stage: mapping.stage ? 'review' : 'mapping' };
  saveMeta(ws, id, meta);
  if (meta.stage === 'review') await evaluateAndPersist(ws, deps, id);
}

async function evaluate(ws: WorkspaceContext, deps: Pick<ImportDeps, 'clock' | 'directory'>, id: number) {
  const batch = loadBatch(ws, id);
  const rows = loadRows(ws, id);
  const ctx = await loadImportContext(ws, deps.clock, deps.directory, batch.meta);
  const evals = evaluateRows(rows, batch.meta, ctx);
  return { batch, rows, ctx, evals, summary: summarize(evals, ctx) };
}

async function evaluateAndPersist(ws: WorkspaceContext, deps: Pick<ImportDeps, 'clock' | 'directory'>, id: number) {
  const result = await evaluate(ws, deps, id);
  persistEvaluations(ws, result.evals);
  return result;
}

// ---- Views ------------------------------------------------------------------------------------

function undoState(ws: WorkspaceContext, deps: Pick<ImportDeps, 'clock'>, batch: ReturnType<typeof loadBatch>): ImportBatchView['undo'] {
  if (batch.status !== 'committed' || !batch.committedAt) return { available: false, reason: null, until: null };
  const until = new Date(Date.parse(batch.committedAt) + IMPORT_UNDO_WINDOW_HOURS * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (deps.clock.now().getTime() > Date.parse(until)) return { available: false, reason: `Undo was available for ${IMPORT_UNDO_WINDOW_HOURS} hours after the import.`, until };
  const blocked = laterActivity(ws, batch.id, batch.meta.auditHighWater ?? 0);
  if (blocked.length > 0) {
    return { available: false, reason: `These members changed after the import, so it can no longer be undone automatically: ${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? '…' : ''}.`, until };
  }
  return { available: true, reason: null, until };
}

export async function getBatchView(ws: WorkspaceContext, deps: ImportDeps, id: number): Promise<ImportBatchView> {
  const batch = loadBatch(ws, id);
  const rows = batch.status === 'abandoned' ? [] : loadRows(ws, id);
  let summary = null;
  if (batch.status === 'staged' && batch.meta.stage === 'review') summary = (await evaluate(ws, deps, id)).summary;
  return {
    id: batch.id,
    status: batch.status,
    stage: batch.meta.stage,
    fileName: batch.meta.fileName,
    encoding: batch.meta.encoding,
    delimiter: batch.meta.delimiter,
    headers: batch.meta.headers,
    sample: rows.slice(0, 5).map((r) => r.raw),
    columns: batch.meta.columns,
    defaults: batch.meta.defaults,
    availableFields: availableFields(ws),
    createdAt: batch.createdAt,
    committedAt: batch.committedAt,
    undoneAt: batch.undoneAt,
    summary,
    result: batch.meta.result ?? null,
    undoSummary: batch.meta.undoSummary ?? null,
    undo: undoState(ws, deps, batch),
  };
}

export async function getRowsPage(ws: WorkspaceContext, deps: ImportDeps, id: number, query: { filter: Parameters<typeof filterRows>[1]; page: number; pageSize: number }): Promise<ImportRowsPage> {
  const batch = requireStaged(ws, id);
  if (batch.meta.stage !== 'review') throw conflict('Finish the column mapping first.');
  const { evals, summary } = await evaluate(ws, deps, id);
  const filtered = filterRows(evals, query.filter);
  const start = (query.page - 1) * query.pageSize;
  return { items: filtered.slice(start, start + query.pageSize).map((e) => e.view), total: filtered.length, page: query.page, pageSize: query.pageSize, summary };
}

// ---- Step 4: corrections --------------------------------------------------------------------

export async function patchRow(ws: WorkspaceContext, deps: ImportDeps, id: number, rowId: number, patch: ImportRowPatch): Promise<{ row: ImportRowView; summary: ImportRowsPage['summary'] }> {
  const batch = requireStaged(ws, id);
  if (batch.meta.stage !== 'review') throw conflict('Finish the column mapping first.');
  const row = loadRows(ws, id).find((r) => r.id === rowId);
  if (!row) throw notFound('Row not found');
  let edits: RowEdits = patch.reset ? {} : { ...row.edits };
  if (patch.values) {
    const fields = new Set([...batch.meta.columns.filter((c): c is string => c !== null), ...Object.keys(batch.meta.defaults)]);
    const values = { ...(edits.values ?? {}) };
    for (const [f, v] of Object.entries(patch.values)) {
      if (!fields.has(f)) throw badRequest(`"${f}" is not a column of this import.`);
      values[f] = v;
    }
    edits.values = values;
  }
  if (patch.use) edits.use = { ...(edits.use ?? {}), ...patch.use };
  if (patch.matchMemberId !== undefined) {
    if (patch.matchMemberId !== null && !getMemberRow(ws, patch.matchMemberId)) throw notFound('Member not found');
    edits.matchMemberId = patch.matchMemberId;
    // A new match redraws the diff: earlier per-field choices and the action no longer apply.
    delete edits.use;
    delete edits.action;
  }
  if (patch.action) edits.action = patch.action;
  if (edits.values && Object.keys(edits.values).length === 0) delete edits.values;
  if (edits.use && Object.keys(edits.use).length === 0) delete edits.use;
  edits = { ...edits };
  saveEdits(ws, rowId, edits);
  const { evals, summary } = await evaluateAndPersist(ws, deps, id);
  return { row: evals.find((e) => e.view.id === rowId)!.view, summary };
}

export async function bulkUpdate(ws: WorkspaceContext, deps: ImportDeps, id: number, bulk: ImportBulk): Promise<ImportRowsPage['summary']> {
  const batch = requireStaged(ws, id);
  if (batch.meta.stage !== 'review') throw conflict('Finish the column mapping first.');
  const { rows, evals } = await evaluate(ws, deps, id);
  const only = bulk.rowIds ? new Set(bulk.rowIds) : null;
  ws.sqlite.transaction(() => {
    for (const e of evals) {
      if (only && !only.has(e.view.id)) continue;
      const row = rows.find((r) => r.id === e.view.id)!;
      const edits: RowEdits = { ...row.edits };
      if (bulk.op === 'skip_errors' && e.view.action !== 'skip' && e.view.errors.length > 0) edits.action = 'skip';
      else if (bulk.op === 'accept_valid' && e.view.errors.length === 0 && e.view.action === 'skip' && e.view.match.type !== 'ambiguous') {
        edits.action = e.view.match.memberId !== null ? 'update' : 'create';
      } else if (bulk.op === 'use_csv_all' && e.view.match.memberId !== null) delete edits.use;
      else continue;
      saveEdits(ws, row.id, edits);
    }
  })();
  if (bulk.op === 'accept_valid') {
    // Rows that only conflict with each other (e.g. a repeated memo code) become invalid once
    // both are active again: put those back to skipped.
    const after = await evaluate(ws, deps, id);
    const reverted = after.evals.filter((e) => e.view.action !== 'skip' && e.view.errors.length > 0 && rows.find((r) => r.id === e.view.id)?.edits.action === 'skip');
    for (const e of reverted) saveEdits(ws, e.view.id, { ...rows.find((r) => r.id === e.view.id)!.edits, action: 'skip' });
  }
  return (await evaluateAndPersist(ws, deps, id)).summary;
}

export function abandonImport(ws: WorkspaceContext, clock: Clock, actor: string, id: number): void {
  requireStaged(ws, id);
  ws.sqlite.transaction(() => {
    ws.sqlite.prepare('DELETE FROM import_rows WHERE account_id = ? AND batch_id = ?').run(ws.accountId, id);
    ws.sqlite.prepare(`UPDATE import_batches SET status = 'abandoned' WHERE account_id = ? AND id = ?`).run(ws.accountId, id);
    writeAudit(ws, clock, { actor, action: 'import.abandoned', entity: 'import', entityId: id });
  })();
}

// ---- Step 6: commit and undo ------------------------------------------------------------------

/** What undo needs for one member (stored in import_before_images.row). */
interface BeforeImage {
  kind: 'created' | 'updated';
  snapshot?: MemberSnapshot;
  ledgerEntryIds: number[];
  aliasIds: number[];
  links: Array<{ serverId: number; previous: MemberLink | null }>;
}

const committing = new Set<string>();

export async function commitImport(ws: WorkspaceContext, deps: ImportDeps, actor: string, id: number): Promise<void> {
  const key = `${ws.accountId}:${id}`;
  if (committing.has(key)) throw conflict('This import is already being committed.');
  committing.add(key);
  try {
    const batch = requireStaged(ws, id);
    if (batch.meta.stage !== 'review') throw conflict('Finish the column mapping first.');
    const { evals, summary } = await evaluate(ws, deps, id);
    if (summary.errorRows > 0) throw conflict(`${summary.errorRows} row(s) still have errors. Fix or skip them first.`, { errorRows: summary.errorRows });
    const work = evals.filter((e): e is RowEval & { apply: NonNullable<RowEval['apply']> } => e.apply !== null && (e.apply.action === 'create' || e.apply.fields.length > 0));
    if (work.length === 0) throw badRequest('There is nothing to import: every row is skipped or unchanged.');

    // Safety snapshot first (§6.9); no backup, no import.
    const backup = await runBackup(deps.backupEnv, 'pre_import');
    if (!backup.outcome.verified) throw new AppError(500, 'backup_failed', `The safety backup before the import failed (${backup.outcome.error ?? 'not verified'}). Nothing was imported.`);

    // Re-check right before writing: the database may have changed while the backup ran.
    const fresh = await evaluate(ws, deps, id);
    if (fresh.summary.errorRows > 0) throw conflict('Members changed while the backup was running; review the rows again.');
    const freshWork = fresh.evals.filter((e): e is RowEval & { apply: NonNullable<RowEval['apply']> } => e.apply !== null && (e.apply.action === 'create' || e.apply.fields.length > 0));

    const note = `CSV import #${id}`;
    const result: ImportResult = { created: 0, updated: 0, skipped: fresh.summary.skip + fresh.summary.unchanged, ledgerEntries: 0, aliasesAdded: 0, serverLinks: 0, backupFile: backup.outcome.file ?? null, members: [] };
    const saveImage = ws.sqlite.prepare('INSERT INTO import_before_images (account_id, batch_id, member_id, row) VALUES (?, ?, ?, ?)');
    ws.sqlite.transaction(() => {
      for (const { apply } of freshWork) {
        const image: BeforeImage = { kind: apply.action === 'create' ? 'created' : 'updated', ledgerEntryIds: [], aliasIds: [], links: [] };
        let memberId: number;
        if (apply.action === 'create') {
          memberId = insertMember(ws, deps.clock, actor, { ...apply.patch, displayName: apply.patch.displayName! }, { importBatchId: id });
          result.created++;
        } else {
          memberId = apply.memberId!;
          image.snapshot = memberSnapshot(ws, memberId);
          applyMemberPatch(ws, deps.clock, actor, memberId, apply.patch, { importBatchId: id });
          result.updated++;
        }
        // Balances only through the ledger (§6.5a).
        if (apply.paidThrough !== undefined || apply.creditCents !== undefined) {
          image.ledgerEntryIds.push(recordManualSet(ws, deps.clock, actor, memberId, { paidThrough: apply.paidThrough, creditCents: apply.creditCents, note }));
          result.ledgerEntries++;
        }
        if (apply.status) {
          const current = getMemberRow(ws, memberId)!.status;
          const manual = current === 'paused' || current === 'archived';
          if (apply.status === 'automatic' && manual) applyStatusAction(ws, deps.clock, actor, memberId, 'reactivate', { importBatchId: id });
          else if (apply.status === 'archived' && current !== 'archived') applyStatusAction(ws, deps.clock, actor, memberId, 'archive', { importBatchId: id });
          else if (apply.status === 'paused' && current !== 'paused') {
            if (current === 'archived') applyStatusAction(ws, deps.clock, actor, memberId, 'reactivate', { importBatchId: id });
            applyStatusAction(ws, deps.clock, actor, memberId, 'pause', { importBatchId: id });
          }
        }
        for (const a of apply.aliases) {
          image.aliasIds.push(addAlias(ws, deps.clock, actor, memberId, a, 'import').id);
          result.aliasesAdded++;
        }
        for (const l of apply.links) {
          image.links.push({ serverId: l.serverId, previous: setMemberLink(ws, deps.clock, actor, memberId, l.serverId, l.user, { importBatchId: id }) });
          result.serverLinks++;
        }
        saveImage.run(ws.accountId, id, memberId, JSON.stringify(image));
        result.members.push({ id: memberId, displayName: apply.displayName, action: image.kind, fields: apply.fields });
      }
      const at = nowIso(deps.clock);
      writeAudit(ws, deps.clock, { actor, action: 'import.committed', entity: 'import', entityId: id, details: { created: result.created, updated: result.updated, ledgerEntries: result.ledgerEntries, backup: result.backupFile } });
      const highWater = (ws.sqlite.prepare('SELECT max(id) AS id FROM audit_log').get() as { id: number }).id;
      const batchNow = loadBatch(ws, id);
      saveMeta(ws, id, { ...batchNow.meta, result, auditHighWater: highWater });
      ws.sqlite.prepare(`UPDATE import_batches SET status = 'committed', committed_at = ? WHERE account_id = ? AND id = ?`).run(at, ws.accountId, id);
    })();
    deps.log.info('import committed', { accountId: ws.accountId, batchId: id, created: result.created, updated: result.updated });
  } finally {
    committing.delete(key);
  }
}

/** Display names of imported members that changed after the import (their audit trail continued). */
function laterActivity(ws: WorkspaceContext, batchId: number, highWater: number): string[] {
  const rows = ws.sqlite
    .prepare(
      `SELECT DISTINCT m.display_name FROM import_before_images b
       JOIN audit_log a ON a.account_id = b.account_id AND a.entity = 'member' AND a.entity_id = b.member_id AND a.id > ?
       JOIN members m ON m.account_id = b.account_id AND m.id = b.member_id
       WHERE b.account_id = ? AND b.batch_id = ?`,
    )
    .all(highWater, ws.accountId, batchId) as Array<{ display_name: string }>;
  return rows.map((r) => r.display_name);
}

export function undoImport(ws: WorkspaceContext, deps: Pick<ImportDeps, 'clock' | 'log'>, actor: string, id: number): void {
  const batch = loadBatch(ws, id);
  const state = undoState(ws, deps, batch);
  if (!state.available) throw conflict(state.reason ?? `This import is ${batch.status} and cannot be undone.`);
  const images = ws.sqlite.prepare('SELECT member_id, row FROM import_before_images WHERE account_id = ? AND batch_id = ? ORDER BY id DESC').all(ws.accountId, id) as Array<{ member_id: number; row: string }>;
  const note = `Undo of CSV import #${id}`;
  const summary = { deleted: 0, archived: 0, restored: 0 };
  ws.sqlite.transaction(() => {
    for (const { member_id: memberId, row } of images) {
      const image = JSON.parse(row) as BeforeImage;
      for (const entryId of [...image.ledgerEntryIds].reverse()) voidLedgerEntry(ws, deps.clock, actor, entryId, note);
      for (const aliasId of image.aliasIds) {
        try {
          removeAlias(ws, deps.clock, actor, memberId, aliasId);
        } catch {
          /* already removed */
        }
      }
      for (const l of [...image.links].reverse()) {
        if (getMemberLink(ws, memberId, l.serverId) || l.previous) restoreMemberLink(ws, deps.clock, actor, memberId, l.serverId, l.previous, { importBatchId: id });
      }
      if (image.kind === 'updated' && image.snapshot) {
        restoreMemberSnapshot(ws, deps.clock, actor, memberId, image.snapshot, note);
        summary.restored++;
      } else if (image.kind === 'created') {
        // Ledger rows are append-only, so a created member that got a balance keeps its (voided)
        // history and is archived instead of deleted.
        if (memberHasHistory(ws, memberId)) {
          if (getMemberRow(ws, memberId)?.status !== 'archived') applyStatusAction(ws, deps.clock, actor, memberId, 'archive', { importBatchId: id });
          summary.archived++;
        } else {
          deleteMember(ws, deps.clock, actor, memberId, { importBatchId: id, reason: 'import undone' });
          summary.deleted++;
        }
      }
    }
    const at = nowIso(deps.clock);
    saveMeta(ws, id, { ...loadBatch(ws, id).meta, undoSummary: summary });
    ws.sqlite.prepare(`UPDATE import_batches SET status = 'undone', undone_at = ? WHERE account_id = ? AND id = ?`).run(at, ws.accountId, id);
    writeAudit(ws, deps.clock, { actor, action: 'import.undone', entity: 'import', entityId: id, details: summary });
  })();
  deps.log.info('import undone', { accountId: ws.accountId, batchId: id, ...summary });
}

/** Daily job (§11): staged imports older than 7 days are abandoned and their rows deleted. */
export function purgeAbandonedStaging(ws: WorkspaceContext, clock: Clock): number {
  const cutoff = new Date(clock.now().getTime() - 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const old = ws.sqlite.prepare(`SELECT id FROM import_batches WHERE account_id = ? AND status = 'staged' AND created_at < ?`).all(ws.accountId, cutoff) as Array<{ id: number }>;
  for (const b of old) abandonImport(ws, clock, 'system', b.id);
  return old.length;
}
