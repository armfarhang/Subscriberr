import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ImportBatchStatus, ImportRowAction } from '@subscriberr/shared';

export const importBatches = sqliteTable('import_batches', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  status: text('status').$type<ImportBatchStatus>().notNull().default('staged'),
  mapping: text('mapping', { mode: 'json' }),
  createdAt: text('created_at').notNull(),
  committedAt: text('committed_at'),
  undoneAt: text('undone_at'),
});

export const importRows = sqliteTable('import_rows', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  batchId: integer('batch_id').notNull(),
  rowNumber: integer('row_number').notNull(),
  raw: text('raw', { mode: 'json' }).notNull(),
  matchedMemberId: integer('matched_member_id'),
  action: text('action').$type<ImportRowAction>().notNull().default('skip'),
  edits: text('edits', { mode: 'json' }),
  errors: text('errors', { mode: 'json' }),
});

export const importBeforeImages = sqliteTable('import_before_images', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  batchId: integer('batch_id').notNull(),
  memberId: integer('member_id').notNull(),
  row: text('row', { mode: 'json' }).notNull(),
});
