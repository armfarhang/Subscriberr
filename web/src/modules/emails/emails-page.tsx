import { type EmailQueueItem, type EmailSettings, emailSettingsSchema } from '@subscriberr/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, Send } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

const STATUS_VARIANT: Record<EmailQueueItem['status'], BadgeProps['variant']> = { queued: 'neutral', sending: 'warning', sent: 'success', failed: 'destructive', cancelled: 'neutral' };
const KIND_LABEL: Record<EmailQueueItem['kind'], string> = { thanks: 'Thank-you', deficit: 'Deficit', reminder: 'Reminder', expired: 'Access paused', announcement: 'Announcement', test: 'Test / system' };

/** Emails (Spec §9.3, §9.5): the outbound queue, the daily cap and the automated-email settings. */
export function EmailsPage({ timeZone }: { timeZone: string }) {
  const [status, setStatus] = React.useState('');
  const [kind, setKind] = React.useState('');
  const [page, setPage] = React.useState(1);
  const q = { status: status || undefined, kind: kind || undefined, page };
  const list = useQuery({ queryKey: queryKeys.emailQueue(q), queryFn: () => api.emailQueue(q), placeholderData: keepPreviousData, refetchInterval: 30_000 });
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight lg:hidden">Emails</h2>
        <p className="text-sm text-muted-foreground">Every email is queued first and sent from your Gmail, one recipient at a time, within the daily limit.</p>
      </div>
      <StatusCard timeZone={timeZone} />
      <Card>
        <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0">
          <CardTitle className="mr-auto">Queue and history</CardTitle>
          <Select aria-label="Filter by status" className="w-auto" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            <option value="">All statuses</option>
            {['queued', 'sent', 'failed', 'cancelled'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select aria-label="Filter by kind" className="w-auto" value={kind} onChange={(e) => (setKind(e.target.value), setPage(1))}>
            <option value="">All kinds</option>
            {Object.entries(KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </CardHeader>
        <CardContent>
          {list.data && list.data.items.length === 0 && <p className="text-sm text-muted-foreground">No emails yet.</p>}
          <ul className="space-y-1.5">
            {list.data?.items.map((e) => (
              <EmailRow key={e.id} email={e} timeZone={timeZone} />
            ))}
          </ul>
          {list.data && list.data.total > list.data.pageSize && (
            <div className="mt-3 flex items-center justify-end gap-1 text-sm text-muted-foreground">
              <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                <ChevronLeft />
              </Button>
              <span className="px-2 tabular-nums">Page {page}</span>
              <Button variant="outline" size="icon" aria-label="Next page" disabled={page * list.data.pageSize >= list.data.total} onClick={() => setPage(page + 1)}>
                <ChevronRight />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <SettingsCard />
    </div>
  );
}

function StatusCard({ timeZone }: { timeZone: string }) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: queryKeys.emailStatus, queryFn: api.emailStatus, refetchInterval: 30_000 });
  const drain = useMutation({ mutationFn: api.drainNow, onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.email }) });
  const s = status.data;
  if (!s) return <div className="h-24 animate-pulse rounded-lg bg-muted" />;
  const pct = Math.min(100, Math.round((s.sentLast24h / s.cap) * 100));
  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm">
              <span className="text-lg font-semibold tabular-nums">{s.sentLast24h}</span> of {s.cap} sent in the last 24 hours · <span className="tabular-nums">{s.queued}</span> queued
              {s.queuedAnnouncements > 0 && ` (${s.queuedAnnouncements} announcement emails)`}
              {s.failed > 0 && (
                <>
                  {' '}
                  · <span className="text-destructive">{s.failed} failed</span>
                </>
              )}
            </div>
            {s.resumesAt && <p className="text-xs text-warning">At the daily limit. Sending resumes around {formatDateTime(s.resumesAt, timeZone)}.</p>}
            {s.dryRun && <p className="text-xs text-warning">Dry run is on: emails are prepared and listed, but nothing is sent.</p>}
            {!s.gmailConnected && <p className="text-xs text-destructive">Gmail is not connected: nothing can be sent until you reconnect Google.</p>}
          </div>
          <Button variant="outline" onClick={() => drain.mutate()} disabled={drain.isPending || s.queued === 0}>
            <Send /> {drain.isPending ? 'Sending…' : 'Send queued now'}
          </Button>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={s.sentLast24h} aria-valuemin={0} aria-valuemax={s.cap} aria-label="Daily sending limit used">
          <div className={cn('h-full rounded-full', pct >= 90 ? 'bg-warning' : 'bg-primary')} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">{s.transactionalReserve} of the daily limit is kept for thank-you, deficit and reminder emails, so a big announcement never delays them.</p>
        {drain.data && <p className="text-xs text-muted-foreground">{drain.data.skipped ?? `Sent ${drain.data.sent}${drain.data.failed ? `, ${drain.data.failed} failed` : ''}${drain.data.retried ? `, ${drain.data.retried} will be retried` : ''}.`}</p>}
      </CardContent>
    </Card>
  );
}

function EmailRow({ email: e, timeZone }: { email: EmailQueueItem; timeZone: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const detail = useQuery({ queryKey: ['email', 'item', e.id], queryFn: () => api.emailItem(e.id), enabled: open });
  const [asText, setAsText] = React.useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.email });
  const retry = useMutation({ mutationFn: () => api.retryEmail(e.id), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: () => api.cancelEmail(e.id), onSuccess: refresh });
  return (
    <li className="rounded-md border">
      <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="w-32 shrink-0 text-xs text-muted-foreground">{formatDateTime(e.sentAt ?? e.createdAt, timeZone)}</span>
        <Badge variant="neutral">{KIND_LABEL[e.kind]}</Badge>
        <span className="min-w-0 flex-1 truncate">{e.subject}</span>
        <span className="hidden truncate text-muted-foreground sm:inline">{e.memberName ?? e.toAddress}</span>
        <Badge variant={STATUS_VARIANT[e.status]}>{e.status}</Badge>
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="space-y-2 border-t p-3 text-sm">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>To {e.toAddress}</span>
            {e.memberId && (
              <Link className="underline underline-offset-2" to={`/members/${e.memberId}`}>
                {e.memberName}
              </Link>
            )}
            <span>Attempts {e.attempts}</span>
            {e.notBefore && e.status === 'queued' && <span>Next try {formatDateTime(e.notBefore, timeZone)}</span>}
            {e.templatePack && <span>Template {e.templatePack}</span>}
          </div>
          {e.error && <p className="text-destructive">{e.error}</p>}
          <div className="flex flex-wrap gap-2">
            {(e.status === 'failed' || e.status === 'cancelled') && (
              <Button size="sm" variant="outline" onClick={() => retry.mutate()} disabled={retry.isPending}>
                Retry
              </Button>
            )}
            {e.status === 'queued' && (
              <Button size="sm" variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                Cancel
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setAsText((t) => !t)}>
              {asText ? 'Show HTML' : 'Show plain text'}
            </Button>
          </div>
          {detail.data &&
            (asText ? (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{detail.data.text}</pre>
            ) : (
              <iframe title={`Email ${e.id}`} sandbox="" srcDoc={detail.data.html} className="h-[28rem] w-full rounded-md border bg-white" />
            ))}
        </div>
      )}
    </li>
  );
}

const nums = (s: string) =>
  s
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);

function SettingsCard() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: queryKeys.emailSettings, queryFn: api.emailSettings });
  const [form, setForm] = React.useState<(Omit<EmailSettings, 'reminderOffsets' | 'overdueOffsets'> & { reminderOffsets: string; overdueOffsets: string }) | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (settings.data && !form) setForm({ ...settings.data, reminderOffsets: settings.data.reminderOffsets.join(', '), overdueOffsets: settings.data.overdueOffsets.join(', ') });
  }, [settings.data, form]);
  const save = useMutation({
    mutationFn: api.saveEmailSettings,
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.emailSettings, next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.emailStatus });
    },
  });
  if (!form) return null;
  const set = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch });
    save.reset();
  };
  const toggle = (k: keyof EmailSettings['enabled'], label: string, hint: string) => (
    <label key={k} className="flex items-start gap-3 rounded-md border p-3 text-sm">
      <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.enabled[k]} onChange={(e) => set({ enabled: { ...form.enabled, [k]: e.target.checked } })} />
      <span>
        <span className="block font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email settings</CardTitle>
        <CardDescription>Automated emails go only to the member’s email on file, never to the address an e-Transfer came from.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = emailSettingsSchema.safeParse({ ...form, reminderOffsets: nums(form.reminderOffsets), overdueOffsets: nums(form.overdueOffsets) });
            if (!parsed.success) return setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
            if (parsed.data.transactionalReserve >= parsed.data.dailyCap) return setError('The reserve must be smaller than the daily limit');
            setError(null);
            save.mutate(parsed.data);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {toggle('thanks', 'Thank-you / confirmation', 'After a payment is applied.')}
            {toggle('deficit', 'Deficit notice', 'When a payment is less than the plan amount.')}
            {toggle('reminder', 'Payment reminders', 'Before and after the due date (below).')}
            {toggle('expired', 'Access paused', 'When a member passes the grace period. Off by default.')}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field id="em-from" label="From name" hint="Shown as the sender; the address is your Gmail.">
              <Input value={form.fromName} maxLength={100} placeholder="Movie Club" onChange={(e) => set({ fromName: e.target.value })} />
            </Field>
            <Field id="em-before" label="Remind days before" hint="Comma separated. Default 7, 3, 1.">
              <Input value={form.reminderOffsets} onChange={(e) => set({ reminderOffsets: e.target.value })} />
            </Field>
            <Field id="em-after" label="Remind days after (overdue)" hint="Default 1, 3. Empty = none.">
              <Input value={form.overdueOffsets} onChange={(e) => set({ overdueOffsets: e.target.value })} />
            </Field>
            <Field id="em-cap" label="Daily limit (24 h)" hint="Gmail allows about 500 a day; default 400.">
              <Input inputMode="numeric" value={String(form.dailyCap)} onChange={(e) => set({ dailyCap: Number(e.target.value) || 0 })} />
            </Field>
            <Field id="em-reserve" label="Kept for transactional" hint="Of the daily limit. Default 100.">
              <Input inputMode="numeric" value={String(form.transactionalReserve)} onChange={(e) => set({ transactionalReserve: Number(e.target.value) || 0 })} />
            </Field>
            <Field id="em-window" label="Confirm payments up to (days old)" hint="Older payments (first scan, rescans) get no email. Default 3.">
              <Input inputMode="numeric" value={String(form.rescanResendWindowDays)} onChange={(e) => set({ rescanResendWindowDays: Number(e.target.value) || 0 })} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4" checked={form.remindDueToday} onChange={(e) => set({ remindDueToday: e.target.checked })} /> Remind on the due date
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4" checked={form.dryRun} onChange={(e) => set({ dryRun: e.target.checked })} /> Dry run (prepare and list emails, send nothing)
            </label>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              Save email settings
            </Button>
            {save.isSuccess && <span className="text-sm text-success">Saved</span>}
            {(error || save.isError) && <span className="text-sm text-destructive">{error ?? save.error?.message}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
