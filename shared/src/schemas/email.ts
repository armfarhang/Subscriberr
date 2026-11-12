import { z } from 'zod';
import type { EmailKind, EmailStatus } from '../enums.js';

// Email system (Spec §9): template packs, rendering, the persistent queue and automated emails.

export const TEMPLATE_KINDS = ['thanks', 'deficit', 'reminder', 'expired', 'announcement'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** The fixed, documented variable set templates may use (§9.2). `theme.*` comes from the pack's theme. */
export const TEMPLATE_VARIABLES = [
  'member.display_name',
  'plan.amount',
  'plan.period_days',
  'paid_through',
  'due_date',
  'days_until_due',
  'grace_days',
  'amount_received',
  'amount_expected',
  'shortfall',
  'credit',
  'periods_covered',
  'etransfer_email',
  'etransfer_instructions',
  'payment_memo_code',
  'app_name',
  'subject',
  'content',
] as const;

export const TEMPLATE_LIMITS = { packBytes: 2 * 1024 * 1024, fileBytes: 512 * 1024, files: 60 } as const;
export const TEMPLATE_FILE_TYPES = ['html', 'txt', 'json', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg'] as const;

export const emailSettingsSchema = z.object({
  /** From display name (the address is always the connected Gmail account). */
  fromName: z.string().trim().max(100),
  /** Rolling 24h cap per Gmail account (default 400, Gmail allows ~500/day). */
  dailyCap: z.number().int().min(1).max(2000),
  /** Part of the cap kept for transactional mail so announcements can never starve it. */
  transactionalReserve: z.number().int().min(0).max(1000),
  /** Days before the due date (default 7, 3, 1). */
  reminderOffsets: z.array(z.number().int().min(1).max(60)).max(10),
  remindDueToday: z.boolean(),
  /** Days after the due date (default 1, 3). */
  overdueOffsets: z.array(z.number().int().min(1).max(60)).max(10),
  enabled: z.object({ thanks: z.boolean(), deficit: z.boolean(), reminder: z.boolean(), expired: z.boolean() }),
  /** Show what would be sent, send nothing. */
  dryRun: z.boolean(),
  /** A rescan re-applying old payments does not re-send thanks/deficit emails older than this. */
  rescanResendWindowDays: z.number().int().min(0).max(60),
});
export type EmailSettings = z.infer<typeof emailSettingsSchema>;

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  fromName: '',
  dailyCap: 400,
  transactionalReserve: 100,
  reminderOffsets: [7, 3, 1],
  remindDueToday: true,
  overdueOffsets: [1, 3],
  enabled: { thanks: true, deficit: true, reminder: true, expired: false },
  dryRun: false,
  rescanResendWindowDays: 3,
};

export interface EmailQueueItem {
  id: number;
  kind: EmailKind;
  memberId: number | null;
  memberName: string | null;
  toAddress: string;
  subject: string;
  status: EmailStatus;
  priority: number;
  attempts: number;
  notBefore: string | null;
  sentAt: string | null;
  error: string | null;
  createdAt: string;
  announcementId: number | null;
  templatePack: string | null;
}

export interface EmailQueueStatus {
  sentLast24h: number;
  cap: number;
  transactionalReserve: number;
  queued: number;
  queuedAnnouncements: number;
  failed: number;
  /** When the rolling window frees a slot again (only when at the cap). */
  resumesAt: string | null;
  dryRun: boolean;
  gmailConnected: boolean;
}

export const emailListQuerySchema = z.object({
  status: z.enum(['queued', 'sending', 'sent', 'failed', 'cancelled']).optional(),
  kind: z.enum(['reminder', 'thanks', 'deficit', 'expired', 'announcement', 'test']).optional(),
  memberId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export interface EmailPreview {
  subject: string;
  html: string;
  text: string;
}

// ---- Template packs ---------------------------------------------------------------------------

export interface ThemeVariable {
  label: string;
  type: 'color' | 'number' | 'text';
  default: string;
}

export interface PackSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  builtin: boolean;
  active: boolean;
}

export interface PackDetail extends PackSummary {
  files: Array<{ path: string; bytes: number; text: boolean }>;
  theme: Record<string, ThemeVariable>;
  /** Saved theme values for this workspace (defaults filled in). */
  themeValues: Record<string, string>;
  subjects: Record<TemplateKind, string>;
}

export interface PackProblem {
  file: string;
  message: string;
}

export const packFileWriteSchema = z.object({ path: z.string().min(1).max(200), content: z.string().max(TEMPLATE_LIMITS.fileBytes) }).strict();
export const packCreateSchema = z.object({ fromPackId: z.string().min(1).max(64), name: z.string().trim().min(1).max(60) }).strict();
export const themeValuesSchema = z.object({ values: z.record(z.string().max(64), z.string().max(400)) }).strict();
export const previewSchema = z
  .object({
    packId: z.string().min(1).max(64),
    kind: z.enum(TEMPLATE_KINDS),
    /** Unsaved edits to preview: path → content. */
    files: z.record(z.string().max(200), z.string().max(TEMPLATE_LIMITS.fileBytes)).optional(),
    theme: z.record(z.string().max(64), z.string().max(400)).optional(),
  })
  .strict();
export type PreviewRequest = z.infer<typeof previewSchema>;
