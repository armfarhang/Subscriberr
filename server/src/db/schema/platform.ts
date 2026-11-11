import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AccountRole, BackupKind, BackupTier, GmailStatus, JobRunStatus } from '@subscriberr/shared';

// Typed mirror of migrations/*.sql for the query builder. The SQL migrations are the source of
// truth for constraints (STRICT, CHECKs, composite FKs, triggers); a test asserts that the
// columns declared here match the real database.

export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey(),
  googleSub: text('google_sub').notNull(),
  email: text('email').notNull(),
  role: text('role').$type<AccountRole>().notNull(),
  gmailStatus: text('gmail_status').$type<GmailStatus>().notNull().default('disconnected'),
  refreshTokenEnc: text('refresh_token_enc'),
  scopes: text('scopes'),
  timezone: text('timezone').notNull().default('America/Toronto'),
  createdAt: text('created_at').notNull(),
});

export const allowedAccounts = sqliteTable('allowed_accounts', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  email: text('email').notNull(),
  addedBy: text('added_by'),
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  userAgent: text('user_agent'),
  ip: text('ip'),
});

export const settings = sqliteTable(
  'settings',
  {
    accountId: integer('account_id').notNull(),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.key] })],
);

export const jobRuns = sqliteTable('job_runs', {
  id: integer('id').primaryKey(),
  job: text('job').notNull(),
  accountId: integer('account_id'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  status: text('status').$type<JobRunStatus>().notNull(),
  error: text('error'),
  stats: text('stats', { mode: 'json' }),
});

export const backupRuns = sqliteTable('backup_runs', {
  id: integer('id').primaryKey(),
  kind: text('kind').$type<BackupKind>().notNull(),
  tier: text('tier').$type<BackupTier>().notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  file: text('file'),
  bytes: integer('bytes'),
  sha256: text('sha256'),
  schemaVersion: integer('schema_version'),
  verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
  verifiedAt: text('verified_at'),
  prunedAt: text('pruned_at'),
  error: text('error'),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  at: text('at').notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: integer('entity_id'),
  details: text('details', { mode: 'json' }),
});
