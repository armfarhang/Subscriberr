import { z } from 'zod';
import { type AccessState, ALIAS_KINDS, type AliasKind, type AliasSource, type MediaServerType, MEMBER_STATUSES, type MemberStatus } from '../enums.js';

// Member API contracts (Spec §6.2, §13.1 screens 3–4). Money is integer cents; dates are
// YYYY-MM-DD in the workspace timezone; instants are UTC ISO strings.

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Optional free text: trimmed, "" becomes null. */
const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable());

const optionalEmail = z.preprocess(blankToNull, z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')).nullable());

export const MEMBER_LIMITS = {
  displayName: 100,
  etransferName: 100,
  memoCode: 40,
  notes: 10_000,
  alias: 200,
} as const;

/** Fields an admin can set on a member. NULL plan terms mean "inherit the workspace default" (D11). */
export const memberFieldsSchema = z.object({
  displayName: z.string().trim().min(1, 'Required').max(MEMBER_LIMITS.displayName),
  etransferName: optionalText(MEMBER_LIMITS.etransferName),
  paymentMemoCode: z.preprocess(
    blankToNull,
    z
      .string()
      .trim()
      .min(2, 'Use at least 2 characters')
      .max(MEMBER_LIMITS.memoCode)
      .regex(/^[\p{L}\p{N} ._#/-]+$/u, 'Use letters, numbers, spaces and . _ # / - only')
      .nullable(),
  ),
  email: optionalEmail,
  notes: optionalText(MEMBER_LIMITS.notes),
  planAmountCents: z.number().int().positive().max(10_000_000).nullable(),
  planPeriodDays: z.number().int().min(1).max(3650).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code such as CAD'),
  toleranceCents: z.number().int().min(0).max(1_000_000).nullable(),
  graceDays: z.number().int().min(0).max(365).nullable(),
  remindersEnabled: z.boolean(),
  emailsEnabled: z.boolean(),
});

/** POST /api/members — only the display name is required; everything else defaults (plan terms inherit). */
export const createMemberSchema = memberFieldsSchema.partial().required({ displayName: true }).strict();
export type CreateMember = z.infer<typeof createMemberSchema>;

/** PATCH /api/members/:id. Balances (paid-through, credit) are never writable here (§6.5a). */
export const updateMemberSchema = memberFieldsSchema.partial().strict();
export type UpdateMember = z.infer<typeof updateMemberSchema>;
export type UpdateMemberInput = z.input<typeof updateMemberSchema>;

/** Manual status changes (§8.3). `reactivate` returns a paused/archived member to the automatic lifecycle. */
export const MEMBER_STATUS_ACTIONS = ['pause', 'archive', 'reactivate'] as const;
export type MemberStatusAction = (typeof MEMBER_STATUS_ACTIONS)[number];
export const memberStatusActionSchema = z.object({ action: z.enum(MEMBER_STATUS_ACTIONS) }).strict();

export const addAliasSchema = z
  .object({
    kind: z.enum(ALIAS_KINDS),
    value: z.string().trim().min(1, 'Required').max(MEMBER_LIMITS.alias),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === 'email' && !z.email().safeParse(v.value.toLowerCase()).success) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Enter a valid email address' });
    }
  });
export type AddAlias = z.infer<typeof addAliasSchema>;

export const MEMBER_LIST_FILTERS = ['current', 'all', ...MEMBER_STATUSES] as const;
export type MemberListFilter = (typeof MEMBER_LIST_FILTERS)[number];
export const MEMBER_SORTS = ['name', 'status', 'due', 'created'] as const;
export type MemberSort = (typeof MEMBER_SORTS)[number];

/** GET /api/members query. `current` (default) hides archived members. */
export const memberListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(MEMBER_LIST_FILTERS).default('current'),
  sort: z.enum(MEMBER_SORTS).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type MemberListQuery = z.input<typeof memberListQuerySchema>;

// ---- Responses ---------------------------------------------------------------------------------

/** A plan term after resolving inheritance: the effective value and whether it came from the workspace default. */
export interface ResolvedTerm<T> {
  value: T;
  inherited: boolean;
}

export interface MemberTerms {
  /** Null only when neither the member nor the workspace has an amount. */
  planAmountCents: ResolvedTerm<number | null>;
  planPeriodDays: ResolvedTerm<number>;
  toleranceCents: ResolvedTerm<number>;
  graceDays: ResolvedTerm<number>;
}

export interface MemberServerLink {
  serverId: number;
  serverName: string;
  serverType: MediaServerType;
  externalUsername: string | null;
  accessState: AccessState;
  lastSyncedAt: string | null;
}

export interface MemberSummary {
  id: number;
  displayName: string;
  etransferName: string | null;
  email: string | null;
  status: MemberStatus;
  currency: string;
  terms: MemberTerms;
  /** Cache from the billing ledger (§6.5a); read-only here. */
  paidThrough: string | null;
  creditCents: number;
  /** Whole days from today (workspace timezone) to the due date; negative when overdue. */
  dueInDays: number | null;
  servers: MemberServerLink[];
}

export interface MemberAlias {
  id: number;
  kind: AliasKind;
  value: string;
  source: AliasSource;
  createdAt: string;
}

export const MEMBER_WARNING_CODES = ['shared_name', 'memo_overlap', 'shared_email', 'no_email', 'no_plan_amount'] as const;
export type MemberWarningCode = (typeof MEMBER_WARNING_CODES)[number];

export interface MemberWarning {
  code: MemberWarningCode;
  message: string;
  /** The other members involved, for links. */
  others: Array<{ id: number; displayName: string }>;
}

/** The managed memo rule generated from `paymentMemoCode` (§7.4.1, easy mode). */
export interface ManagedMemoRule {
  id: number;
  label: string;
  senderName: string | null;
  memoValue: string;
  enabled: boolean;
}

export interface TimelineEvent {
  id: number;
  at: string;
  actor: string;
  action: string;
  details: unknown;
}

export interface MemberDetail extends MemberSummary {
  paymentMemoCode: string | null;
  notes: string | null;
  /** Raw per-member overrides (null = inherit). */
  overrides: {
    planAmountCents: number | null;
    planPeriodDays: number | null;
    toleranceCents: number | null;
    graceDays: number | null;
  };
  remindersEnabled: boolean;
  emailsEnabled: boolean;
  lastPaymentAt: string | null;
  createdAt: string;
  updatedAt: string;
  importBatchId: number | null;
  aliases: MemberAlias[];
  managedRule: ManagedMemoRule | null;
  warnings: MemberWarning[];
  /** True when the member has no payments and no ledger entries (§6.0 rule 5). */
  canDelete: boolean;
  timeline: TimelineEvent[];
}

export interface MemberList {
  items: MemberSummary[];
  total: number;
  page: number;
  pageSize: number;
  /** Members per status in the whole workspace (for the filter chips). */
  counts: Record<MemberStatus, number>;
}
