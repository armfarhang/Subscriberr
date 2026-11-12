import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AccessState, MediaServerType } from '@subscriberr/shared';

export const mediaServers = sqliteTable('media_servers', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  type: text('type').$type<MediaServerType>().notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  credentialsEnc: text('credentials_enc'),
  enforcementEnabled: integer('enforcement_enabled', { mode: 'boolean' }).notNull().default(false),
  defaultLibraryIds: text('default_library_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastCheckedAt: text('last_checked_at'),
  lastStatus: text('last_status'),
  createdAt: text('created_at').notNull(),
  options: text('options', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  enforcementConfirmed: integer('enforcement_confirmed', { mode: 'boolean' }).notNull().default(false),
});

export const memberServerAccounts = sqliteTable('member_server_accounts', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  memberId: integer('member_id').notNull(),
  serverId: integer('server_id').notNull(),
  externalUserId: text('external_user_id').notNull(),
  externalUsername: text('external_username'),
  externalEmail: text('external_email'),
  libraryIdsOverride: text('library_ids_override', { mode: 'json' }).$type<string[]>(),
  lastGrantedLibraryIds: text('last_granted_library_ids', { mode: 'json' }).$type<string[]>(),
  accessState: text('access_state').$type<AccessState>().notNull().default('unknown'),
  lastSyncedAt: text('last_synced_at'),
  lastError: text('last_error'),
  syncPending: integer('sync_pending', { mode: 'boolean' }).notNull().default(false),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: text('next_attempt_at'),
});
