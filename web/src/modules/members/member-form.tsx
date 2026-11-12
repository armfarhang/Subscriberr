import {
  centsToDecimal,
  formatCents,
  type MemberDefaults,
  type MemberDetail,
  MEMBER_LIMITS,
  parseMoneyToCents,
  type UpdateMember,
  updateMemberSchema,
} from '@subscriberr/shared';
import { RotateCcw } from 'lucide-react';
import type * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { ApiRequestError } from '@/lib/api';

// Form state for creating and editing a member. Plan terms are strings where "" means
// "inherit the workspace default" (D11); money is typed as dollars and converted to cents.

export interface MemberFormState {
  displayName: string;
  etransferName: string;
  email: string;
  paymentMemoCode: string;
  notes: string;
  amount: string;
  periodDays: string;
  tolerance: string;
  graceDays: string;
  currency: string;
  remindersEnabled: boolean;
  emailsEnabled: boolean;
}

export type MemberFormErrors = Partial<Record<keyof MemberFormState, string>>;

export function emptyMemberForm(defaults: MemberDefaults | undefined): MemberFormState {
  return {
    displayName: '',
    etransferName: '',
    email: '',
    paymentMemoCode: '',
    notes: '',
    amount: '',
    periodDays: '',
    tolerance: '',
    graceDays: '',
    currency: defaults?.currency ?? 'CAD',
    remindersEnabled: true,
    emailsEnabled: true,
  };
}

export function formFromMember(m: MemberDetail): MemberFormState {
  const o = m.overrides;
  return {
    displayName: m.displayName,
    etransferName: m.etransferName ?? '',
    email: m.email ?? '',
    paymentMemoCode: m.paymentMemoCode ?? '',
    notes: m.notes ?? '',
    amount: o.planAmountCents === null ? '' : centsToDecimal(o.planAmountCents),
    periodDays: o.planPeriodDays === null ? '' : String(o.planPeriodDays),
    tolerance: o.toleranceCents === null ? '' : centsToDecimal(o.toleranceCents),
    graceDays: o.graceDays === null ? '' : String(o.graceDays),
    currency: m.currency,
    remindersEnabled: m.remindersEnabled,
    emailsEnabled: m.emailsEnabled,
  };
}

const PATH_TO_FIELD: Record<string, keyof MemberFormState> = {
  displayName: 'displayName',
  etransferName: 'etransferName',
  email: 'email',
  paymentMemoCode: 'paymentMemoCode',
  notes: 'notes',
  planAmountCents: 'amount',
  planPeriodDays: 'periodDays',
  toleranceCents: 'tolerance',
  graceDays: 'graceDays',
  currency: 'currency',
};

const intOrNull = (s: string): number | null => (s.trim() === '' ? null : /^\s*\d+\s*$/.test(s) ? Number(s) : Number.NaN);

/** Converts the form to an API body, validated with the same Zod schema the server uses. */
export function formToPayload(form: MemberFormState): { payload: UpdateMember & { displayName: string }; errors: MemberFormErrors } | { payload: null; errors: MemberFormErrors } {
  const errors: MemberFormErrors = {};
  const amount = form.amount.trim() === '' ? null : parseMoneyToCents(form.amount);
  if (form.amount.trim() !== '' && (amount === null || amount <= 0)) errors.amount = 'Enter an amount such as 15.00, or leave empty to inherit';
  const tolerance = form.tolerance.trim() === '' ? null : parseMoneyToCents(form.tolerance);
  if (form.tolerance.trim() !== '' && (tolerance === null || tolerance < 0)) errors.tolerance = 'Enter an amount such as 0.50, or leave empty to inherit';

  const candidate = {
    displayName: form.displayName,
    etransferName: form.etransferName,
    email: form.email,
    paymentMemoCode: form.paymentMemoCode,
    notes: form.notes,
    planAmountCents: errors.amount ? 1 : amount,
    planPeriodDays: intOrNull(form.periodDays),
    toleranceCents: errors.tolerance ? 0 : tolerance,
    graceDays: intOrNull(form.graceDays),
    currency: form.currency.trim().toUpperCase(),
    remindersEnabled: form.remindersEnabled,
    emailsEnabled: form.emailsEnabled,
  };
  const parsed = updateMemberSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = PATH_TO_FIELD[issue.path.join('.')];
      if (field && !errors[field]) errors[field] = Number.isNaN(issue.input as number) ? 'Enter a whole number, or leave empty to inherit' : issue.message;
    }
  }
  if (!parsed.success || Object.keys(errors).length > 0) return { payload: null, errors };
  return { payload: { ...parsed.data, displayName: parsed.data.displayName ?? form.displayName.trim() }, errors };
}

/** Maps a server validation/conflict error onto form fields. */
export function serverErrors(err: unknown): MemberFormErrors {
  if (!(err instanceof ApiRequestError)) return {};
  const out: MemberFormErrors = {};
  if (Array.isArray(err.details)) {
    for (const d of err.details as Array<{ path?: string; message?: string }>) {
      const field = d.path ? PATH_TO_FIELD[d.path] : undefined;
      if (field && d.message) out[field] = d.message;
    }
  } else if (err.details && typeof err.details === 'object' && 'field' in err.details) {
    const field = PATH_TO_FIELD[String((err.details as { field: unknown }).field)];
    if (field) out[field] = err.message;
  }
  return out;
}

const FIELD_ORDER: Array<keyof MemberFormState> = ['displayName', 'etransferName', 'email', 'paymentMemoCode', 'amount', 'periodDays', 'tolerance', 'graceDays', 'notes'];

/** Moves focus (and the scroll position) to the first field with an error. */
export function focusFirstError(errors: MemberFormErrors): void {
  const first = FIELD_ORDER.find((k) => errors[k]);
  if (first) requestAnimationFrame(() => document.getElementById(first)?.focus());
}

type FieldsProps = {
  form: MemberFormState;
  errors: MemberFormErrors;
  onChange: (patch: Partial<MemberFormState>) => void;
};

export function IdentityFields({ form, errors, onChange }: FieldsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="displayName" label="Display name" hint="Your own friendly name for this person; shown everywhere in the app." error={errors.displayName}>
        <Input required maxLength={MEMBER_LIMITS.displayName} placeholder="Ann (neighbour)" value={form.displayName} onChange={(e) => onChange({ displayName: e.target.value })} />
      </Field>
      <Field id="etransferName" label="Name on their e-Transfers" hint="Exactly as their bank shows it; used to match payments." error={errors.etransferName}>
        <Input maxLength={MEMBER_LIMITS.etransferName} autoComplete="off" placeholder="ANN SMITH" value={form.etransferName} onChange={(e) => onChange({ etransferName: e.target.value })} />
      </Field>
      <Field id="email" label="Email" hint="Reminders and confirmations go here." error={errors.email}>
        <Input type="email" autoComplete="off" placeholder="ann@example.com" value={form.email} onChange={(e) => onChange({ email: e.target.value })} />
      </Field>
      <Field
        id="paymentMemoCode"
        label="Payment memo code"
        hint="Optional. Only needed when two people share an e-Transfer name: ask this member to put the code in the e-Transfer message."
        error={errors.paymentMemoCode}
      >
        <Input maxLength={MEMBER_LIMITS.memoCode} autoComplete="off" placeholder="JS-1" value={form.paymentMemoCode} onChange={(e) => onChange({ paymentMemoCode: e.target.value })} />
      </Field>
    </div>
  );
}

function InheritBadge({ inherited, onReset }: { inherited: boolean; onReset: () => void }) {
  return inherited ? (
    <Badge variant="neutral">Workspace default</Badge>
  ) : (
    <span className="inline-flex items-center gap-1">
      <Badge>Custom</Badge>
      <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={onReset}>
        <RotateCcw className="h-3 w-3" aria-hidden /> Use default
      </Button>
    </span>
  );
}

function TermField({
  id,
  label,
  value,
  defaultText,
  error,
  inputMode,
  onChange,
}: {
  id: keyof MemberFormState;
  label: string;
  value: string;
  defaultText: string;
  error?: string;
  inputMode: 'decimal' | 'numeric';
  onChange: (v: string) => void;
}) {
  const inherited = value.trim() === '';
  return (
    <div className="space-y-1.5">
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <InheritBadge inherited={inherited} onReset={() => onChange('')} />
      </div>
      <Input
        id={id}
        inputMode={inputMode}
        placeholder={defaultText}
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={`${id}-hint`} className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
        {error ?? (inherited ? `Inherits the workspace default (${defaultText}). Type a value to override.` : `Workspace default: ${defaultText}.`)}
      </p>
    </div>
  );
}

export function PlanFields({ form, errors, onChange, defaults }: FieldsProps & { defaults: MemberDefaults | undefined }) {
  const d = defaults;
  const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? 'not set' : formatCents(cents, form.currency));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TermField id="amount" label="Plan amount per period" inputMode="decimal" value={form.amount} defaultText={money(d?.planAmountCents)} error={errors.amount} onChange={(amount) => onChange({ amount })} />
      <TermField id="periodDays" label="Period length (days)" inputMode="numeric" value={form.periodDays} defaultText={d ? `${d.planPeriodDays} days` : '—'} error={errors.periodDays} onChange={(periodDays) => onChange({ periodDays })} />
      <TermField id="tolerance" label="Underpayment tolerance" inputMode="decimal" value={form.tolerance} defaultText={money(d?.toleranceCents)} error={errors.tolerance} onChange={(tolerance) => onChange({ tolerance })} />
      <TermField id="graceDays" label="Grace period (days)" inputMode="numeric" value={form.graceDays} defaultText={d ? `${d.graceDays} days` : '—'} error={errors.graceDays} onChange={(graceDays) => onChange({ graceDays })} />
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <span className="text-xs text-muted-foreground">Period presets:</span>
        <Button type="button" variant="outline" size="sm" className="h-6 px-2" onClick={() => onChange({ periodDays: '30' })}>
          Monthly (30)
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-6 px-2" onClick={() => onChange({ periodDays: '365' })}>
          Yearly (365)
        </Button>
      </div>
    </div>
  );
}

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

export function EmailAndNotesFields({ form, errors, onChange }: FieldsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Toggle id="emailsEnabled" label="Send emails" hint="Payment confirmations, deficit notices and announcements." checked={form.emailsEnabled} onChange={(emailsEnabled) => onChange({ emailsEnabled })} />
      <Toggle id="remindersEnabled" label="Send reminders" hint="Reminders before the due date." checked={form.remindersEnabled} onChange={(remindersEnabled) => onChange({ remindersEnabled })} />
      <Field id="notes" label="Notes" className="sm:col-span-2" hint="Private to you. Searchable." error={errors.notes}>
        <Textarea rows={4} maxLength={MEMBER_LIMITS.notes} value={form.notes} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ notes: e.target.value })} />
      </Field>
    </div>
  );
}
