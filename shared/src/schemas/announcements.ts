import { z } from 'zod';
import { type EmailStatus, MEMBER_STATUSES } from '../enums.js';

// Mass announcements (Spec §9.4).

export const AUDIENCE_TYPES = ['active', 'non_archived', 'status', 'server', 'expiring', 'picked'] as const;

export const audienceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('active') }).strict(),
  z.object({ type: z.literal('non_archived') }).strict(),
  z.object({ type: z.literal('status'), statuses: z.array(z.enum(MEMBER_STATUSES)).min(1).max(5) }).strict(),
  z.object({ type: z.literal('server'), serverId: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('expiring'), days: z.number().int().min(0).max(365) }).strict(),
  z.object({ type: z.literal('picked'), memberIds: z.array(z.number().int().positive()).min(1).max(5000) }).strict(),
]);
export type Audience = z.infer<typeof audienceSchema>;

export const announcementDraftSchema = z
  .object({
    subject: z.string().trim().min(1, 'Add a subject').max(200),
    /** Rich text from the composer; sanitized on save. Variables like {{member.display_name}} are allowed. */
    body: z.string().max(100_000),
    audience: audienceSchema,
    /** Optional footer appended to every copy (saved as the default for next time). */
    footer: z.string().max(2000).default(''),
  })
  .strict();
export type AnnouncementDraft = z.input<typeof announcementDraftSchema>;

export const sendAnnouncementSchema = z
  .object({
    /** The recipient count the admin confirmed; refused when it no longer matches (§9.4 "explicit confirm"). */
    confirmRecipients: z.number().int().min(1),
  })
  .strict();

export interface AnnouncementRecipient {
  memberId: number;
  displayName: string;
  email: string | null;
  /** Why this member will not get it (no email, emails turned off). */
  excluded: string | null;
}

export interface AnnouncementProgress {
  total: number;
  queued: number;
  sent: number;
  failed: number;
  cancelled: number;
}

export interface AnnouncementView {
  id: number;
  subject: string;
  body: string;
  footer: string;
  audience: Audience;
  status: 'draft' | 'sending' | 'sent' | 'cancelled';
  createdAt: string;
  progress: AnnouncementProgress | null;
}

export interface AnnouncementRecipientStatus {
  memberId: number | null;
  displayName: string | null;
  email: string;
  status: EmailStatus;
  sentAt: string | null;
  error: string | null;
  emailId: number;
}
