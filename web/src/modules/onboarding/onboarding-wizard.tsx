import type { Me, PublicConfig, WorkspaceSettings } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, KeyRound, Server } from 'lucide-react';
import * as React from 'react';
import { Logo } from '@/components/layout/sidebar';
import { ThemeToggle } from '@/components/layout/theme';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { GoogleConnection } from '@/modules/settings/google-connection';
import { type FormErrors, formFromSettings, formToPatch, MemberDefaultsFields, PaymentFields, type WorkspaceFormState } from '@/modules/settings/workspace-form';

// First-run wizard (Spec §13.1): connect Google → timezone, receiving address and payment
// instructions → member defaults → add first server. Each workspace runs it once.

const STEPS = [
  { id: 'google', title: 'Google account' },
  { id: 'payments', title: 'Payments' },
  { id: 'defaults', title: 'Member defaults' },
  { id: 'servers', title: 'Media servers' },
  { id: 'finish', title: 'Finish' },
] as const;

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-2 text-sm" aria-label="Setup steps">
      {STEPS.map((s, i) => (
        <li key={s.id} className={cn('flex items-center gap-2', i === current ? 'font-medium text-foreground' : 'text-muted-foreground')} aria-current={i === current ? 'step' : undefined}>
          <span
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-full border text-xs',
              i < current && 'border-transparent bg-primary text-primary-foreground',
              i === current && 'border-primary text-primary',
            )}
          >
            {i < current ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
          </span>
          <span className="hidden sm:inline">{s.title}</span>
        </li>
      ))}
    </ol>
  );
}

function WizardBody({ me, config, settings }: { me: Me; config: PublicConfig; settings: WorkspaceSettings }) {
  const queryClient = useQueryClient();
  const [step, setStep] = React.useState(0);
  const [form, setForm] = React.useState<WorkspaceFormState>(() => formFromSettings(settings));
  const [errors, setErrors] = React.useState<FormErrors>({});
  const save = useMutation({ mutationFn: api.updateWorkspaceSettings, onSuccess: (s) => queryClient.setQueryData(queryKeys.workspaceSettings, s) });
  const complete = useMutation({
    mutationFn: api.completeOnboarding,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
  const onChange = (patch: Partial<WorkspaceFormState>) => setForm((f) => ({ ...f, ...patch }));
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => headingRef.current?.focus(), [step]);

  const saveAndNext = async (fields: Array<keyof WorkspaceFormState>) => {
    const { patch, errors: all } = formToPatch(form, { requireAll: true });
    const stepErrors = Object.fromEntries(Object.entries(all).filter(([k]) => fields.includes(k as keyof WorkspaceFormState))) as FormErrors;
    setErrors(stepErrors);
    if (Object.keys(stepErrors).length > 0) return;
    // Only this step's fields are required to be valid now; send what is valid so far.
    const partial = formToPatch(form, { requireAll: false });
    const toSend = patch ?? partial.patch;
    if (toSend) await save.mutateAsync(toSend);
    setStep((s) => s + 1);
  };

  const current = STEPS[step]!;
  return (
    <div className="space-y-6">
      <Stepper current={step} />
      <Card>
        <CardContent className="space-y-6 p-6">
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
            {current.title}
          </h2>

          {current.id === 'google' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Subscriberr reads e-Transfer notifications from this Gmail account and sends reminders and confirmations from it. If e-Transfers arrive at another
                address, set that mailbox to auto-forward them here.
              </p>
              <GoogleConnection me={me} canReconnect={config.googleSignIn} />
            </div>
          )}

          {current.id === 'payments' && (
            <div className="space-y-4">
              <PaymentFields form={form} errors={errors} onChange={onChange} />
              <p className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
                <strong>Tip:</strong> turn on <em>Interac Autodeposit</em> at your bank. Auto-deposited e-Transfers are applied automatically; other transfers wait
                until you deposit them and click “Mark as deposited”.
              </p>
            </div>
          )}

          {current.id === 'defaults' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">New members start with these values. You can change any of them for an individual member later.</p>
              <MemberDefaultsFields form={form} errors={errors} onChange={onChange} />
            </div>
          )}

          {current.id === 'servers' && (
            <div className="flex gap-4 rounded-md border bg-muted/40 p-4 text-sm">
              <Server className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="space-y-1">
                <p className="font-medium">Plex and Jellyfin are added on the Servers page.</p>
                <p className="text-muted-foreground">
                  Server linking and access enforcement arrive in a later version of this build. You can finish setup now and add servers when that page is ready.
                </p>
              </div>
            </div>
          )}

          {current.id === 'finish' && (
            <div className="space-y-4 text-sm">
              <ul className="space-y-2">
                <li>
                  <strong>Payments to:</strong> {form.etransferEmail || '—'}
                </li>
                <li>
                  <strong>Plan:</strong> ${form.amount} {form.currency} every {form.periodDays} days · grace {form.graceDays} days · tolerance ${form.tolerance}
                </li>
                <li>
                  <strong>Timezone:</strong> {form.timezone}
                </li>
              </ul>
              {me.role === 'owner' && (
                <div className="flex gap-3 rounded-md border border-warning/40 bg-warning/10 p-3">
                  <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
                  <p>
                    <strong>Store your APP_SECRET in a password manager.</strong> Backups do not contain it. Without it the stored Google and media-server
                    credentials cannot be read after a restore.
                  </p>
                </div>
              )}
              {complete.isError && (
                <p role="alert" className="text-destructive">
                  {complete.error.message}
                </p>
              )}
            </div>
          )}

          {save.isError && (
            <p role="alert" className="text-sm text-destructive">
              {save.error.message}
            </p>
          )}

          <div className="flex items-center justify-between gap-2 border-t pt-4">
            <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
              <ArrowLeft /> Back
            </Button>
            {current.id === 'payments' && (
              <Button onClick={() => void saveAndNext(['timezone', 'etransferEmail', 'etransferInstructions'])} disabled={save.isPending}>
                Next <ArrowRight />
              </Button>
            )}
            {current.id === 'defaults' && (
              <Button onClick={() => void saveAndNext(['amount', 'periodDays', 'currency', 'tolerance', 'graceDays'])} disabled={save.isPending}>
                Next <ArrowRight />
              </Button>
            )}
            {(current.id === 'google' || current.id === 'servers') && (
              <Button onClick={() => setStep((s) => s + 1)}>
                {current.id === 'servers' ? 'Skip for now' : 'Next'} <ArrowRight />
              </Button>
            )}
            {current.id === 'finish' && (
              <Button onClick={() => complete.mutate()} disabled={complete.isPending}>
                <Check /> {complete.isPending ? 'Finishing…' : 'Finish setup'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function OnboardingWizard({ me, config }: { me: Me; config: PublicConfig }) {
  const settings = useQuery({ queryKey: queryKeys.workspaceSettings, queryFn: api.workspaceSettings });
  return (
    <div className="mx-auto min-h-screen w-full max-w-2xl space-y-6 p-4 sm:p-8">
      <header className="flex items-center justify-between">
        <Logo />
        <ThemeToggle />
      </header>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Set up your workspace</h1>
        <p className="text-sm text-muted-foreground">A few answers and Subscriberr is ready. You can change everything later in Settings.</p>
      </div>
      {settings.isPending && <div className="h-64 animate-pulse rounded-lg bg-muted" />}
      {settings.isError && <p className="text-sm text-destructive">Could not load settings: {settings.error.message}</p>}
      {settings.data && <WizardBody me={me} config={config} settings={settings.data} />}
    </div>
  );
}
