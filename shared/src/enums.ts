// Enumerations shared by server (CHECK constraints, Zod) and web (labels, filters). Spec §6.

export const ACCOUNT_ROLES = ['owner', 'operator'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const GMAIL_STATUSES = ['connected', 'disconnected', 'error'] as const;
export type GmailStatus = (typeof GMAIL_STATUSES)[number];

export const JOB_RUN_STATUSES = ['running', 'ok', 'error'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

export const BACKUP_KINDS = ['nightly', 'manual', 'pre_migration', 'pre_import'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BACKUP_TIERS = ['daily', 'weekly', 'monthly', 'safety'] as const;
export type BackupTier = (typeof BACKUP_TIERS)[number];

export const MEMBER_STATUSES = ['active', 'grace', 'expired', 'paused', 'archived'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const ALIAS_KINDS = ['name', 'email'] as const;
export type AliasKind = (typeof ALIAS_KINDS)[number];

export const ALIAS_SOURCES = ['manual', 'learned', 'import'] as const;
export type AliasSource = (typeof ALIAS_SOURCES)[number];

export const MEMO_MODES = ['contains', 'equals', 'regex'] as const;
export type MemoMode = (typeof MEMO_MODES)[number];

export const RULE_ACTIONS = ['assign', 'review'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export const MEDIA_SERVER_TYPES = ['plex', 'jellyfin'] as const;
export type MediaServerType = (typeof MEDIA_SERVER_TYPES)[number];

export const ACCESS_STATES = ['granted', 'revoked', 'unknown', 'error'] as const;
export type AccessState = (typeof ACCESS_STATES)[number];

export const PAYMENT_MESSAGE_TYPES = ['autodeposit', 'awaiting_deposit', 'manual'] as const;
export type PaymentMessageType = (typeof PAYMENT_MESSAGE_TYPES)[number];

export const PAYMENT_STATUSES = [
  'matched',
  'unmatched',
  'needs_review',
  'underpaid',
  'overpaid',
  'pending_deposit',
  'expired',
  'duplicate',
  'rejected',
  'manual',
  'voided',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const MATCHED_BY = ['name', 'email', 'rule', 'manual'] as const;
export type MatchedBy = (typeof MATCHED_BY)[number];

export const PAYMENT_SOURCES = ['gmail', 'manual'] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export const LEDGER_KINDS = ['payment', 'manual_set', 'manual_adjust', 'void'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const EMAIL_KINDS = ['reminder', 'thanks', 'deficit', 'expired', 'announcement', 'test'] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

export const EMAIL_STATUSES = ['queued', 'sending', 'sent', 'failed', 'cancelled'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const ANNOUNCEMENT_STATUSES = ['draft', 'sending', 'sent', 'cancelled'] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

export const IMPORT_BATCH_STATUSES = ['staged', 'committed', 'undone', 'abandoned'] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export const IMPORT_ROW_ACTIONS = ['create', 'update', 'skip'] as const;
export type ImportRowAction = (typeof IMPORT_ROW_ACTIONS)[number];
