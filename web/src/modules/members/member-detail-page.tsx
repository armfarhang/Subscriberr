import { type MemberDetail, type MemberStatusAction, formatCents, type MemberStatus, type WorkspaceSettings } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, ArrowLeft, AtSign, Check, Pause, Play, Plus, Tag, Trash2, X } from 'lucide-react';
import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { api, ApiRequestError } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { EmailAndNotesFields, focusFirstError, formFromMember, formToPayload, IdentityFields, type MemberFormErrors, type MemberFormState, PlanFields, serverErrors } from './member-form';
import { accessStateLabel } from './server-chips';
import { dueLabel, STATUS_LABEL, StatusBadge } from './status';
import { Timeline } from './timeline';
import { paymentAmount, PaymentStatusBadge } from '@/modules/payments/payment-status';
import { RulesList } from '@/modules/payments/rules-panel';

function useMemberCache() {
  const queryClient = useQueryClient();
  return (member: MemberDetail) => {
    queryClient.setQueryData(queryKeys.member(member.id), member);
    void queryClient.invalidateQueries({ queryKey: [...queryKeys.members, 'list'] });
  };
}

/** Member detail (Spec §13.1 #4). */
export function MemberDetailPage() {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const valid = Number.isInteger(id) && id > 0;
  const member = useQuery({ queryKey: queryKeys.member(id), queryFn: () => api.member(id), enabled: valid, retry: (n, err) => !(err instanceof ApiRequestError && err.status === 404) && n < 2 });
  const settings = useQuery({ queryKey: queryKeys.workspaceSettings, queryFn: api.workspaceSettings });

  if (!valid || (member.error instanceof ApiRequestError && member.error.status === 404)) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">This member does not exist (or was deleted).</p>
        <Button asChild variant="outline">
          <Link to="/members">
            <ArrowLeft /> Back to members
          </Link>
        </Button>
      </div>
    );
  }
  if (member.isPending || settings.isPending) return <div className="h-64 animate-pulse rounded-lg bg-muted" />;
  if (member.isError) return <p className="text-sm text-destructive">Could not load this member: {member.error.message}</p>;
  if (settings.isError) return <p className="text-sm text-destructive">Could not load workspace settings: {settings.error.message}</p>;

  const m = member.data;
  return (
    <div className="space-y-6">
      <Header member={m} />
      <Warnings member={m} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <EditForm key={m.id} member={m} settings={settings.data} />
        </div>
        <div className="space-y-6">
          <BalanceCard member={m} />
          <AliasesCard member={m} />
          <PaymentsCard member={m} timeZone={settings.data.timezone} />
          <MemoRuleCard member={m} />
          <ServersCard member={m} timeZone={settings.data.timezone} />
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>Everything that happened to this member. Payments, emails and access changes appear here once those features exist.</CardDescription>
        </CardHeader>
        <CardContent>
          <Timeline events={m.timeline} timeZone={settings.data.timezone} />
        </CardContent>
      </Card>
    </div>
  );
}

const AUTOMATIC: MemberStatus[] = ['active', 'grace', 'expired'];

function Header({ member: m }: { member: MemberDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const cache = useMemberCache();
  const [confirm, setConfirm] = React.useState<'archive' | 'delete' | null>(null);
  const [undo, setUndo] = React.useState<{ label: string } | null>(null);

  const status = useMutation({
    mutationFn: (action: MemberStatusAction) => api.memberStatus(m.id, action),
    onSuccess: (next, action) => {
      const wasAutomatic = AUTOMATIC.includes(m.status);
      cache(next);
      setConfirm(null);
      setUndo(action !== 'reactivate' && wasAutomatic ? { label: `${m.displayName} is now ${STATUS_LABEL[next.status].toLowerCase()}.` } : null);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteMember(m.id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.member(m.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.members });
      navigate('/members', { replace: true });
    },
  });
  const busy = status.isPending || remove.isPending;
  const manual = m.status === 'paused' || m.status === 'archived';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="icon" aria-label="Back to members">
          <Link to="/members">
            <ArrowLeft />
          </Link>
        </Button>
        <h2 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{m.displayName}</h2>
        <StatusBadge status={m.status} />
        <div className="ml-auto flex flex-wrap gap-2">
          {manual ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => status.mutate('reactivate')}>
              <Play /> Reactivate
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => status.mutate('pause')} title="Paused members get no reminders and no access changes.">
              <Pause /> Pause
            </Button>
          )}
          {m.status !== 'archived' && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirm('archive')}>
              <Archive /> Archive
            </Button>
          )}
          {m.canDelete && (
            <Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => setConfirm('delete')}>
              <Trash2 /> Delete
            </Button>
          )}
        </div>
      </div>

      {confirm === 'archive' && (
        <ConfirmBar
          text="Archive this member? Archived members are hidden from the list, get no emails, and lose media-server access once enforcement is on. Their history is kept and you can reactivate them later."
          action="Archive"
          busy={busy}
          onConfirm={() => status.mutate('archive')}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'delete' && (
        <ConfirmBar
          destructive
          text={`Permanently delete ${m.displayName}? This member has no payment history, so nothing financial is lost, but this cannot be undone. Their aliases and memo rule are deleted too.`}
          action="Delete permanently"
          busy={busy}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirm(null)}
        />
      )}
      {undo && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2 text-sm">
          <Check className="h-4 w-4 text-success" aria-hidden />
          <span className="flex-1">{undo.label}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => status.mutate('reactivate')}>
            Undo
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Dismiss" onClick={() => setUndo(null)}>
            <X />
          </Button>
        </div>
      )}
      {(status.isError || remove.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {(status.error ?? remove.error)?.message}
        </p>
      )}
    </div>
  );
}

function ConfirmBar({ text, action, destructive, busy, onConfirm, onCancel }: { text: string; action: string; destructive?: boolean; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="alertdialog" aria-label={action} className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm">
      <span className="min-w-[14rem] flex-1">{text}</span>
      <span className="flex gap-2">
        <Button size="sm" variant={destructive ? 'destructive' : 'default'} disabled={busy} onClick={onConfirm} autoFocus>
          {action}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

function Warnings({ member }: { member: MemberDetail }) {
  if (member.warnings.length === 0) return null;
  return (
    <div role="note" className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
      {member.warnings.map((w, i) => (
        <div key={`${w.code}-${i}`} className="flex gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div>
            {w.message}
            {w.others.length > 0 && (
              <span className="ml-1">
                {w.others.map((o, j) => (
                  <React.Fragment key={o.id}>
                    {j > 0 && ', '}
                    <Link className="underline underline-offset-2" to={`/members/${o.id}`}>
                      Open {o.displayName}
                    </Link>
                  </React.Fragment>
                ))}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function EditForm({ member, settings }: { member: MemberDetail; settings: WorkspaceSettings }) {
  const cache = useMemberCache();
  const initial = React.useMemo(() => formFromMember(member), [member]);
  const [form, setForm] = React.useState<MemberFormState>(initial);
  const [errors, setErrors] = React.useState<MemberFormErrors>({});
  const [saved, setSaved] = React.useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const save = useMutation({
    mutationFn: (payload: Parameters<typeof api.updateMember>[1]) => api.updateMember(member.id, payload),
    onSuccess: (next) => {
      cache(next);
      setForm(formFromMember(next));
      setSaved(true);
    },
    onError: (err) => {
      const errs = serverErrors(err);
      setErrors(errs);
      focusFirstError(errs);
    },
  });
  const onChange = (patch: Partial<MemberFormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaved(false);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const { payload, errors: errs } = formToPayload(form);
    setErrors(errs);
    focusFirstError(errs);
    if (payload) save.mutate(payload);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <IdentityFields form={form} errors={errors} onChange={onChange} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Plan</CardTitle>
          <CardDescription>Empty fields inherit the workspace defaults (Settings → Member defaults). Changing a plan never rewrites past payments.</CardDescription>
        </CardHeader>
        <CardContent>
          <PlanFields form={form} errors={errors} onChange={onChange} defaults={settings.memberDefaults} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Emails and notes</CardTitle>
        </CardHeader>
        <CardContent>
          <EmailAndNotesFields form={form} errors={errors} onChange={onChange} />
        </CardContent>
      </Card>
      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 rounded-md bg-background/90 px-1 py-2 backdrop-blur">
        <Button type="submit" disabled={save.isPending || !dirty}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        {dirty && (
          <Button type="button" variant="ghost" onClick={() => { setForm(initial); setErrors({}); }}>
            Discard
          </Button>
        )}
        {saved && !dirty && (
          <span role="status" className="inline-flex items-center gap-1 text-sm text-success">
            <Check className="h-4 w-4" aria-hidden /> Saved
          </span>
        )}
        {save.isError && Object.keys(serverErrors(save.error)).length === 0 && (
          <span role="alert" className="text-sm text-destructive">
            {save.error.message}
          </span>
        )}
      </div>
    </form>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function BalanceCard({ member: m }: { member: MemberDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Balance</CardTitle>
        <CardDescription>Calculated from the payment history.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          <Row label="Paid through">{formatDate(m.paidThrough)}</Row>
          <Row label="Due">{dueLabel(m)}</Row>
          <Row label="Credit">{formatCents(m.creditCents, m.currency)}</Row>
          <Row label="Last payment">{m.lastPaymentAt ? m.lastPaymentAt.slice(0, 10) : '—'}</Row>
        </dl>
      </CardContent>
    </Card>
  );
}

function AliasesCard({ member: m }: { member: MemberDetail }) {
  const cache = useMemberCache();
  const [kind, setKind] = React.useState<'name' | 'email'>('name');
  const [value, setValue] = React.useState('');
  const add = useMutation({
    mutationFn: () => api.addAlias(m.id, { kind, value }),
    onSuccess: (next) => {
      cache(next);
      setValue('');
    },
  });
  const remove = useMutation({ mutationFn: (aliasId: number) => api.removeAlias(m.id, aliasId), onSuccess: cache });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Aliases</CardTitle>
        <CardDescription>Other names or emails this person pays from. Payments from these match this member.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {m.aliases.length === 0 ? (
          <p className="text-sm text-muted-foreground">No aliases.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {m.aliases.map((a) => (
              <li key={a.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                {a.kind === 'email' ? <AtSign className="h-3.5 w-3.5 text-muted-foreground" aria-label="Email" /> : <Tag className="h-3.5 w-3.5 text-muted-foreground" aria-label="Name" />}
                <span className="min-w-0 flex-1 truncate">{a.value}</span>
                {a.source !== 'manual' && <Badge variant="neutral">{a.source}</Badge>}
                <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Remove alias ${a.value}`} disabled={remove.isPending} onClick={() => remove.mutate(a.id)}>
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) add.mutate();
          }}
        >
          <Select aria-label="Alias type" className="w-auto" value={kind} onChange={(e) => setKind(e.target.value as 'name' | 'email')}>
            <option value="name">Name</option>
            <option value="email">Email</option>
          </Select>
          <Field id="alias-value" label="New alias" className="min-w-[10rem] flex-1 [&>label]:sr-only" error={add.isError ? add.error.message : undefined}>
            <Input
              type={kind === 'email' ? 'email' : 'text'}
              placeholder={kind === 'email' ? 'other@example.com' : 'A. SMITH'}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                add.reset();
              }}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={add.isPending || !value.trim()}>
            <Plus /> Add
          </Button>
        </form>
        {remove.isError && <p className="text-sm text-destructive">{remove.error.message}</p>}
      </CardContent>
    </Card>
  );
}

function MemoRuleCard({ member: m }: { member: MemberDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Matching rules</CardTitle>
        <CardDescription>
          Tell apart people who share an e-Transfer name. A memo code (under Details) creates a rule automatically; add others here. <Link className="underline underline-offset-2" to="/payments?tab=rules">Rule tester</Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        <RulesList memberId={m.id} memberName={m.displayName} />
      </CardContent>
    </Card>
  );
}

function PaymentsCard({ member: m, timeZone }: { member: MemberDetail; timeZone: string }) {
  const query = { memberId: m.id, pageSize: 20 };
  const list = useQuery({ queryKey: queryKeys.paymentList(query), queryFn: () => api.payments(query) });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments</CardTitle>
        <CardDescription>The latest e-Transfers from this member.</CardDescription>
      </CardHeader>
      <CardContent>
        {list.data && list.data.items.length === 0 && <p className="text-sm text-muted-foreground">No payments yet.</p>}
        <ul className="divide-y text-sm">
          {list.data?.items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="w-28 text-xs text-muted-foreground">{formatDateTime(p.receivedAt, timeZone).split(',').slice(0, 2).join(',')}</span>
              <span className="flex-1 tabular-nums">{paymentAmount(p)}</span>
              <PaymentStatusBadge status={p.status} />
            </li>
          ))}
        </ul>
        {list.data && list.data.total > list.data.items.length && (
          <Link className="text-sm underline underline-offset-2" to="/payments">
            All payments
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function ServersCard({ member: m, timeZone }: { member: MemberDetail; timeZone: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Media servers</CardTitle>
        <CardDescription>Linked Plex / Jellyfin accounts. Linking and library choices arrive with server integration.</CardDescription>
      </CardHeader>
      <CardContent>
        {m.servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not linked to any server.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {m.servers.map((s) => (
              <li key={s.serverId} className="rounded-md border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{s.serverName}</span>
                  <Badge variant={s.accessState === 'granted' ? 'success' : s.accessState === 'revoked' ? 'destructive' : s.accessState === 'error' ? 'warning' : 'neutral'}>{accessStateLabel(s.accessState)}</Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  {s.serverType === 'plex' ? 'Plex' : 'Jellyfin'} user {s.externalUsername ?? '—'} · last synced {s.lastSyncedAt ? formatDateTime(s.lastSyncedAt, timeZone) : 'never'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
