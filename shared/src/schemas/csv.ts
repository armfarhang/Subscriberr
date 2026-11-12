import { z } from 'zod';
import type { MemberStatus } from '../enums.js';

// CSV import / export contracts (Spec §12, D13).

/** Stable export columns, in order. Server columns (`server:<name>`) follow, one per configured server. */
export const CSV_BASE_FIELDS = [
  'id',
  'display_name',
  'etransfer_name',
  'email',
  'notes',
  'plan_amount',
  'plan_period_days',
  'currency',
  'tolerance',
  'grace_days',
  'paid_through',
  'credit',
  'status',
  'reminders_enabled',
  'emails_enabled',
  'aliases',
  'payment_memo_code',
] as const;
export type CsvBaseField = (typeof CSV_BASE_FIELDS)[number];
/** A base field or `server:<server name>`. */
export type CsvField = CsvBaseField | `server:${string}`;

export const SERVER_FIELD_PREFIX = 'server:';
export const isServerField = (f: string): f is `server:${string}` => f.startsWith(SERVER_FIELD_PREFIX);

export const CSV_FIELD_LABELS: Record<CsvBaseField, string> = {
  id: 'Member id',
  display_name: 'Display name',
  etransfer_name: 'e-Transfer name',
  email: 'Email',
  notes: 'Notes',
  plan_amount: 'Plan amount',
  plan_period_days: 'Period (days)',
  currency: 'Currency',
  tolerance: 'Tolerance',
  grace_days: 'Grace days',
  paid_through: 'Paid through',
  credit: 'Credit',
  status: 'Status',
  reminders_enabled: 'Reminders',
  emails_enabled: 'Emails',
  aliases: 'Aliases',
  payment_memo_code: 'Memo code',
};

export const csvFieldLabel = (f: string): string => (isServerField(f) ? `${f.slice(SERVER_FIELD_PREFIX.length)} user` : (CSV_FIELD_LABELS[f as CsvBaseField] ?? f));

/** Upload limits (§12.2 step 1). */
export const IMPORT_LIMITS = { maxBytes: 5 * 1024 * 1024, maxRows: 5000 } as const;

/** How long an import can be undone (§12.2 step 6, [ASSUMPTION: 24h]). */
export const IMPORT_UNDO_WINDOW_HOURS = 24;

// ---- Requests -------------------------------------------------------------------------------

const fieldName = z.string().min(1).max(120);

/** Step 2: header index → field (null = ignore), plus default values for fields with no column. */
export const importMappingSchema = z
  .object({
    columns: z.array(fieldName.nullable()).max(500),
    defaults: z.record(fieldName, z.string().max(2000)).default({}),
    /** Move on to review (stages and matches every row). */
    stage: z.boolean().default(true),
  })
  .strict();
export type ImportMapping = z.input<typeof importMappingSchema>;

export const IMPORT_ROW_ACTIONS_UI = ['create', 'update', 'skip'] as const;

/** Edits to one staged row (never touches members). */
export const importRowPatchSchema = z
  .object({
    /** CSV-side cell edits: field → new text. */
    values: z.record(fieldName, z.string().max(10_000)).optional(),
    /** Per-field choice for matched rows. */
    use: z.record(fieldName, z.enum(['csv', 'db'])).optional(),
    action: z.enum(IMPORT_ROW_ACTIONS_UI).optional(),
    /** Pick the member this row updates (null = treat as a new member). */
    matchMemberId: z.number().int().positive().nullable().optional(),
    /** Back to the original CSV values, automatic match and default action. */
    reset: z.literal(true).optional(),
  })
  .strict();
export type ImportRowPatch = z.infer<typeof importRowPatchSchema>;

export const IMPORT_BULK_OPS = ['accept_valid', 'skip_errors', 'use_csv_all'] as const;
export const importBulkSchema = z
  .object({
    op: z.enum(IMPORT_BULK_OPS),
    /** Limit to these rows (default: all rows). */
    rowIds: z.array(z.number().int().positive()).max(10_000).optional(),
  })
  .strict();
export type ImportBulk = z.infer<typeof importBulkSchema>;

export const IMPORT_ROW_FILTERS = ['all', 'errors', 'changes', 'new', 'unmatched', 'skipped'] as const;
export type ImportRowFilter = (typeof IMPORT_ROW_FILTERS)[number];
export const importRowsQuerySchema = z.object({
  filter: z.enum(IMPORT_ROW_FILTERS).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const mappingPresetSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    /** Normalized header → field. */
    columns: z.record(z.string().max(200), fieldName.nullable()),
    defaults: z.record(fieldName, z.string().max(2000)).default({}),
  })
  .strict();
export type MappingPreset = z.infer<typeof mappingPresetSchema>;

// ---- Responses ------------------------------------------------------------------------------

export type CellState = 'new' | 'changed' | 'unchanged';

export interface ImportCell {
  field: string;
  /** CSV-side text after edits. */
  csv: string;
  /** The text originally in the file (or the mapping default). */
  original: string;
  edited: boolean;
  /** Canonical value that would be written (e.g. "15.00", "2026-12-01"), or null when blank/invalid. */
  value: string | null;
  /** The current database value in the same format, for matched rows. */
  db: string | null;
  state: CellState;
  use: 'csv' | 'db';
  error?: string;
  warning?: string;
}

export type MatchType = 'id' | 'email' | 'etransfer_name' | 'display_name' | 'manual' | 'none' | 'ambiguous';

export interface ImportRowView {
  id: number;
  rowNumber: number;
  action: 'create' | 'update' | 'skip';
  match: {
    type: MatchType;
    confidence: 'exact' | 'high' | 'medium' | null;
    memberId: number | null;
    displayName: string | null;
    status: MemberStatus | null;
    /** For ambiguous matches: the members that matched the same key. */
    candidates: Array<{ id: number; displayName: string }>;
  };
  cells: ImportCell[];
  errors: string[];
  warnings: string[];
  /** Fields that would change (create rows: every non-blank field). */
  changes: number;
  edited: boolean;
}

export interface ImportSummary {
  rows: number;
  create: number;
  update: number;
  /** Update rows with nothing to change. */
  unchanged: number;
  skip: number;
  /** Non-skipped rows with at least one error (they block the commit). */
  errorRows: number;
  warningRows: number;
  /** "7 imported members are already past their grace period…" */
  safetyWarnings: string[];
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  ledgerEntries: number;
  aliasesAdded: number;
  serverLinks: number;
  backupFile: string | null;
  members: Array<{ id: number; displayName: string; action: 'created' | 'updated'; fields: string[] }>;
}

export interface ImportBatchView {
  id: number;
  status: 'staged' | 'committed' | 'undone' | 'abandoned';
  stage: 'mapping' | 'review';
  fileName: string;
  encoding: string;
  delimiter: string;
  headers: string[];
  /** First rows of the file (raw cells) for the mapping step. */
  sample: string[][];
  columns: Array<string | null>;
  defaults: Record<string, string>;
  /** Every field the file may map to (base fields + configured servers). */
  availableFields: string[];
  createdAt: string;
  committedAt: string | null;
  undoneAt: string | null;
  summary: ImportSummary | null;
  result: ImportResult | null;
  /** What the undo did (undone imports only). */
  undoSummary: { deleted: number; archived: number; restored: number } | null;
  undo: { available: boolean; reason: string | null; until: string | null };
}

export interface ImportRowsPage {
  items: ImportRowView[];
  total: number;
  page: number;
  pageSize: number;
  summary: ImportSummary;
}

export interface ImportBatchListItem {
  id: number;
  status: ImportBatchView['status'];
  stage: ImportBatchView['stage'];
  fileName: string;
  rows: number;
  createdAt: string;
  committedAt: string | null;
  undoneAt: string | null;
}

/** Header text → comparable key ("E-Transfer Name" → "e_transfer_name"); used for auto-mapping and presets. */
export function csvHeaderKey(header: string): string {
  return header
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}:]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}
