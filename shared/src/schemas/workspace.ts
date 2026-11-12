import { z } from 'zod';
import { isValidTimeZone } from '../dates.js';
import { ACCOUNT_ROLES } from '../enums.js';

/** Workspace-wide member defaults (Spec §6.2, D11). Members inherit these unless overridden. */
export const memberDefaultsSchema = z.object({
  /** Expected amount per period. Null until the owner sets it in the first-run wizard. */
  planAmountCents: z.number().int().positive().max(10_000_000).nullable(),
  /** Days per paid period: monthly = 30, yearly = 365 (D6). */
  planPeriodDays: z.number().int().min(1).max(3650),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code such as CAD'),
  /** Underpayment tolerated before it counts as a deficit (D3, default 0). */
  toleranceCents: z.number().int().min(0).max(1_000_000),
  /** Days after the due date before access is revoked (D5, default 3). */
  graceDays: z.number().int().min(0).max(365),
});
export type MemberDefaults = z.infer<typeof memberDefaultsSchema>;

export const DEFAULT_MEMBER_DEFAULTS: MemberDefaults = {
  planAmountCents: null,
  planPeriodDays: 30,
  currency: 'CAD',
  toleranceCents: 0,
  graceDays: 3,
};

export const timeZoneSchema = z.string().refine(isValidTimeZone, 'Unknown timezone');

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .nullable();

/** Settings of one workspace (one Google account). Spec §5.5, §13.1 (Settings, first-run wizard). */
export const workspaceSettingsSchema = z.object({
  timezone: timeZoneSchema,
  /** The address members send e-Transfers TO (§7.1). Shown in emails as {{etransfer_email}}. */
  etransferEmail: optionalEmail,
  /** Free text shown to members as {{etransfer_instructions}}. */
  etransferInstructions: z.string().max(2000),
  memberDefaults: memberDefaultsSchema,
  onboardingCompleted: z.boolean(),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const updateWorkspaceSettingsSchema = workspaceSettingsSchema.omit({ onboardingCompleted: true }).partial().strict();
export type UpdateWorkspaceSettings = z.infer<typeof updateWorkspaceSettingsSchema>;

/** One entry of the sign-in allowlist (§5.5). `env` entries come from ADMIN_EMAILS and cannot be removed in the UI. */
export const allowedAccountSchema = z.object({
  email: z.string(),
  source: z.enum(['settings', 'env']),
  addedBy: z.string().nullable(),
  createdAt: z.string().nullable(),
  /** Role of the account if this person has already signed in. */
  role: z.enum(ACCOUNT_ROLES).nullable(),
});
export type AllowedAccount = z.infer<typeof allowedAccountSchema>;

export const addAllowedAccountSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
});
export type AddAllowedAccount = z.infer<typeof addAllowedAccountSchema>;

/** Reasons a Google sign-in is refused; passed back to the sign-in page as `?auth_error=`. */
export const AUTH_ERRORS = [
  'not_authorized',
  'email_unverified',
  'account_mismatch',
  'state_mismatch',
  'access_denied',
  'exchange_failed',
  'rate_limited',
  'google_unavailable',
] as const;
export type AuthErrorCode = (typeof AUTH_ERRORS)[number];

/** Non-fatal outcomes of a sign-in; passed as `?auth_notice=`. */
export const AUTH_NOTICES = ['gmail_not_connected'] as const;
export type AuthNoticeCode = (typeof AUTH_NOTICES)[number];
