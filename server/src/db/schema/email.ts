import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AnnouncementStatus, EmailKind, EmailStatus } from '@subscriberr/shared';

export const announcements = sqliteTable('announcements', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  audience: text('audience', { mode: 'json' }).notNull(),
  status: text('status').$type<AnnouncementStatus>().notNull().default('draft'),
  createdAt: text('created_at').notNull(),
});

export const emailQueue = sqliteTable('email_queue', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  kind: text('kind').$type<EmailKind>().notNull(),
  memberId: integer('member_id'),
  toAddress: text('to_address').notNull(),
  subject: text('subject').notNull(),
  html: text('html').notNull(),
  text: text('text').notNull(),
  priority: integer('priority').notNull().default(100),
  status: text('status').$type<EmailStatus>().notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  notBefore: text('not_before'),
  sentAt: text('sent_at'),
  gmailMessageId: text('gmail_message_id'),
  error: text('error'),
  dedupeKey: text('dedupe_key'),
  announcementId: integer('announcement_id'),
  templatePack: text('template_pack'),
  templateVersion: text('template_version'),
  createdAt: text('created_at').notNull(),
});
