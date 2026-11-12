import { centsToDecimal, parseMoneyToCents, type UpdateWorkspaceSettings, updateWorkspaceSettingsSchema, type WorkspaceSettings } from '@subscriberr/shared';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

// Form state for workspace settings, shared by the first-run wizard and the Settings page.
// Money is typed as dollars and converted to integer cents with the shared helper.

export interface WorkspaceFormState {
  timezone: string;
  etransferEmail: string;
  etransferInstructions: string;
  amount: string;
  periodDays: string;
  currency: string;
  tolerance: string;
  graceDays: string;
}

export type FormErrors = Partial<Record<keyof WorkspaceFormState, string>>;

export function formFromSettings(s: WorkspaceSettings): WorkspaceFormState {
  const d = s.memberDefaults;
  return {
    timezone: s.timezone,
    etransferEmail: s.etransferEmail ?? '',
    etransferInstructions: s.etransferInstructions,
    amount: d.planAmountCents === null ? '' : centsToDecimal(d.planAmountCents),
    periodDays: String(d.planPeriodDays),
    currency: d.currency,
    tolerance: centsToDecimal(d.toleranceCents),
    graceDays: String(d.graceDays),
  };
}

const SCHEMA_PATH_TO_FIELD: Record<string, keyof WorkspaceFormState> = {
  timezone: 'timezone',
  etransferEmail: 'etransferEmail',
  etransferInstructions: 'etransferInstructions',
  'memberDefaults.planAmountCents': 'amount',
  'memberDefaults.planPeriodDays': 'periodDays',
  'memberDefaults.currency': 'currency',
  'memberDefaults.toleranceCents': 'tolerance',
  'memberDefaults.graceDays': 'graceDays',
};

const toInt = (s: string) => (/^\s*\d+\s*$/.test(s) ? Number(s) : Number.NaN);

/** Converts the form into an API patch, validated with the same Zod schema the server uses. */
export function formToPatch(form: WorkspaceFormState, options: { requireAll: boolean }): { patch: UpdateWorkspaceSettings | null; errors: FormErrors } {
  const errors: FormErrors = {};
  const amount = form.amount.trim() === '' ? null : parseMoneyToCents(form.amount);
  if (form.amount.trim() !== '' && (amount === null || amount <= 0)) errors.amount = 'Enter an amount such as 15.00';
  if (options.requireAll && amount === null && !errors.amount) errors.amount = 'Required';
  const tolerance = parseMoneyToCents(form.tolerance || '0');
  if (tolerance === null || tolerance < 0) errors.tolerance = 'Enter an amount such as 0.50';
  if (options.requireAll && form.etransferEmail.trim() === '') errors.etransferEmail = 'Required';

  const candidate = {
    timezone: form.timezone,
    etransferEmail: form.etransferEmail.trim() === '' ? null : form.etransferEmail.trim(),
    etransferInstructions: form.etransferInstructions,
    memberDefaults: {
      planAmountCents: amount,
      planPeriodDays: toInt(form.periodDays),
      currency: form.currency.trim().toUpperCase(),
      toleranceCents: tolerance ?? -1,
      graceDays: toInt(form.graceDays),
    },
  };
  const parsed = updateWorkspaceSettingsSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = SCHEMA_PATH_TO_FIELD[issue.path.join('.')];
      if (field && !errors[field]) errors[field] = Number.isNaN(issue.input as number) ? 'Enter a whole number' : issue.message;
    }
  }
  return Object.keys(errors).length > 0 || !parsed.success ? { patch: null, errors } : { patch: parsed.data, errors };
}

function timeZones(current: string): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

type FieldsProps = {
  form: WorkspaceFormState;
  errors: FormErrors;
  onChange: (patch: Partial<WorkspaceFormState>) => void;
};

export function PaymentFields({ form, errors, onChange }: FieldsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="timezone" label="Timezone" hint="Due dates and reminders use this timezone." error={errors.timezone}>
        <Select value={form.timezone} onChange={(e) => onChange({ timezone: e.target.value })}>
          {timeZones(form.timezone).map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="etransferEmail" label="Members send e-Transfers to" hint="Shown in reminders as the payment address." error={errors.etransferEmail}>
        <Input type="email" autoComplete="off" placeholder="payments@example.com" value={form.etransferEmail} onChange={(e) => onChange({ etransferEmail: e.target.value })} />
      </Field>
      <Field
        id="etransferInstructions"
        label="Payment instructions"
        className="sm:col-span-2"
        hint="Optional. Included in reminder and deficit emails."
        error={errors.etransferInstructions}
      >
        <Textarea
          rows={3}
          maxLength={2000}
          placeholder="Send an Interac e-Transfer with your name as it appears on your bank account."
          value={form.etransferInstructions}
          onChange={(e) => onChange({ etransferInstructions: e.target.value })}
        />
      </Field>
    </div>
  );
}

export function MemberDefaultsFields({ form, errors, onChange }: FieldsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="amount" label="Plan amount per period" hint="What a member owes each period, in dollars." error={errors.amount}>
        <Input inputMode="decimal" placeholder="15.00" value={form.amount} onChange={(e) => onChange({ amount: e.target.value })} />
      </Field>
      <Field
        id="periodDays"
        label="Period length (days)"
        error={errors.periodDays}
        hint={
          <span className="flex flex-wrap items-center gap-2">
            Paid time counts from each payment.
            <Button type="button" variant="outline" size="sm" className="h-6 px-2" onClick={() => onChange({ periodDays: '30' })}>
              Monthly (30)
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-6 px-2" onClick={() => onChange({ periodDays: '365' })}>
              Yearly (365)
            </Button>
          </span>
        }
      >
        <Input inputMode="numeric" value={form.periodDays} onChange={(e) => onChange({ periodDays: e.target.value })} />
      </Field>
      <Field id="tolerance" label="Underpayment tolerance" hint="Shortfalls up to this amount count as paid in full. Default 0." error={errors.tolerance}>
        <Input inputMode="decimal" value={form.tolerance} onChange={(e) => onChange({ tolerance: e.target.value })} />
      </Field>
      <Field id="graceDays" label="Grace period (days)" hint="Access stays on this many days after the due date. Default 3." error={errors.graceDays}>
        <Input inputMode="numeric" value={form.graceDays} onChange={(e) => onChange({ graceDays: e.target.value })} />
      </Field>
      <Field id="currency" label="Currency" error={errors.currency}>
        <Input maxLength={3} value={form.currency} onChange={(e) => onChange({ currency: e.target.value.toUpperCase() })} />
      </Field>
    </div>
  );
}
