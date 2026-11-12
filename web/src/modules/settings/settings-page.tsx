import type { AllowedAccount, BackupRetention, Me, PublicConfig, WorkspaceSettings } from '@subscriberr/shared';
import { backupRetentionSchema } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { GoogleConnection } from './google-connection';
import { type FormErrors, formFromSettings, formToPatch, MemberDefaultsFields, PaymentFields, type WorkspaceFormState } from './workspace-form';

function SavedNote({ show }: { show: boolean }) {
  return show ? (
    <span role="status" className="inline-flex items-center gap-1 text-sm text-success">
      <Check className="h-4 w-4" aria-hidden /> Saved
    </span>
  ) : null;
}

function WorkspaceSettingsForm({ settings }: { settings: WorkspaceSettings }) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<WorkspaceFormState>(() => formFromSettings(settings));
  const [errors, setErrors] = React.useState<FormErrors>({});
  const save = useMutation({
    mutationFn: api.updateWorkspaceSettings,
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.workspaceSettings, next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
  const onChange = (patch: Partial<WorkspaceFormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    save.reset();
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const { patch, errors: errs } = formToPatch(form, { requireAll: true });
    setErrors(errs);
    if (patch) save.mutate(patch);
  };

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <Card>
        <CardHeader>
          <CardTitle>Payments</CardTitle>
          <CardDescription>Where members send money, and the timezone used for due dates.</CardDescription>
        </CardHeader>
        <CardContent>
          <PaymentFields form={form} errors={errors} onChange={onChange} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Member defaults</CardTitle>
          <CardDescription>New members inherit these. Any member can override them individually.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <MemberDefaultsFields form={form} errors={errors} onChange={onChange} />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save settings'}
            </Button>
            <SavedNote show={save.isSuccess} />
            {save.isError && (
              <span role="alert" className="text-sm text-destructive">
                {save.error.message}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

function AllowlistCard({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: queryKeys.allowlist, queryFn: api.allowlist });
  const [email, setEmail] = React.useState('');
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const setItems = (data: { items: AllowedAccount[] }) => queryClient.setQueryData(queryKeys.allowlist, { items: data.items });
  const add = useMutation({
    mutationFn: api.addAllowed,
    onSuccess: (data) => {
      setItems(data);
      setEmail('');
    },
  });
  const remove = useMutation({
    mutationFn: api.removeAllowed,
    onSuccess: (data) => {
      setItems(data);
      setConfirming(null);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Allowed Google accounts</CardTitle>
        <CardDescription>
          Only these people can sign in. Each gets their own separate workspace (own members, Gmail and servers); nobody can see anyone else’s.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y rounded-md border">
          <li className="flex items-center gap-3 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{me.email}</span>
            <Badge>Owner</Badge>
          </li>
          {list.data?.items
            .filter((i) => i.email !== me.email)
            .map((item) => (
              <li key={item.email} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{item.email}</span>
                {item.role ? <Badge variant="success">Signed in before</Badge> : <Badge variant="neutral">Not signed in yet</Badge>}
                {item.source === 'env' ? (
                  <Badge variant="neutral" title="From the ADMIN_EMAILS environment variable">
                    ADMIN_EMAILS
                  </Badge>
                ) : confirming === item.email ? (
                  <span className="flex items-center gap-2">
                    <Button size="sm" variant="destructive" onClick={() => remove.mutate(item.email)} disabled={remove.isPending}>
                      Remove access
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Remove ${item.email}`} onClick={() => setConfirming(item.email)}>
                    <Trash2 />
                  </Button>
                )}
              </li>
            ))}
        </ul>
        {confirming && (
          <p className="text-xs text-muted-foreground">
            Removing signs this person out immediately and blocks future sign-ins. Their workspace data is kept.
          </p>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) add.mutate(email.trim());
          }}
        >
          <Field id="allow-email" label="Add a Google account" className="min-w-[16rem] flex-1" error={add.isError ? add.error.message : undefined}>
            <Input type="email" placeholder="friend@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" disabled={add.isPending || !email.trim()}>
            <Plus /> Allow
          </Button>
        </form>
        {remove.isError && <p className="text-sm text-destructive">{remove.error.message}</p>}
      </CardContent>
    </Card>
  );
}

function RetentionCard() {
  const queryClient = useQueryClient();
  const retention = useQuery({ queryKey: queryKeys.backupRetention, queryFn: api.backupRetention });
  const [form, setForm] = React.useState<Record<keyof BackupRetention, string> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (retention.data && !form) setForm({ daily: String(retention.data.daily), weekly: String(retention.data.weekly), monthly: String(retention.data.monthly) });
  }, [retention.data, form]);
  const save = useMutation({
    mutationFn: api.setBackupRetention,
    onSuccess: (data) => queryClient.setQueryData(queryKeys.backupRetention, data),
  });
  if (!form) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Backup retention</CardTitle>
        <CardDescription>How many nightly backups to keep. Safety snapshots before migrations and imports are kept separately (newest 3 of each).</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = backupRetentionSchema.safeParse({ daily: Number(form.daily), weekly: Number(form.weekly), monthly: Number(form.monthly) });
            if (!parsed.success) {
              setError('Daily must be at least 1; all values are whole numbers.');
              return;
            }
            setError(null);
            save.mutate(parsed.data);
          }}
        >
          {(['daily', 'weekly', 'monthly'] as const).map((k) => (
            <Field key={k} id={`retention-${k}`} label={k[0]!.toUpperCase() + k.slice(1)} className="w-24">
              <Input inputMode="numeric" value={form[k]} onChange={(e) => (setForm({ ...form, [k]: e.target.value }), save.reset())} />
            </Field>
          ))}
          <Button type="submit" variant="outline" disabled={save.isPending}>
            Save
          </Button>
          <SavedNote show={save.isSuccess} />
        </form>
        {(error || save.isError) && <p className="mt-2 text-sm text-destructive">{error ?? save.error?.message}</p>}
      </CardContent>
    </Card>
  );
}

export function SettingsPage({ me, config }: { me: Me; config: PublicConfig }) {
  const settings = useQuery({ queryKey: queryKeys.workspaceSettings, queryFn: api.workspaceSettings });
  const isOwner = me.role === 'owner';
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Google account</CardTitle>
        </CardHeader>
        <CardContent>
          <GoogleConnection me={me} canReconnect={config.googleSignIn} />
        </CardContent>
      </Card>
      {settings.isPending && <div className="h-40 animate-pulse rounded-lg bg-muted" />}
      {settings.isError && <p className="text-sm text-destructive">Could not load settings: {settings.error.message}</p>}
      {settings.data && <WorkspaceSettingsForm settings={settings.data} />}
      {isOwner && <AllowlistCard me={me} />}
      {isOwner && <RetentionCard />}
    </div>
  );
}
