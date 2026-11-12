import type { Dashboard, Me } from '@subscriberr/shared';
import { formatCents } from '@subscriberr/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CheckCircle2, Clock, CreditCard, Hourglass, Inbox, type LucideIcon, Mail, UserX, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatAge, formatDate } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { BackupSummary, BackupWarnings } from '@/modules/system/backup-health';

// Dashboard (Spec §13.1 #2): counts, payments this month, Review Queue badge, Gmail health,
// last scan, email-queue status and the due-soon list.

function Stat({ label, value, icon: Icon, to, note, tone }: { label: string; value: string | number; icon: LucideIcon; to: string; note?: string; tone?: 'warning' | 'destructive' | 'success' }) {
  return (
    <Link to={to} className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Card className="h-full transition-colors hover:border-primary/50">
        <CardHeader className="flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
          <Icon className={cn('h-4 w-4 text-muted-foreground', tone === 'warning' && 'text-warning', tone === 'destructive' && 'text-destructive', tone === 'success' && 'text-success')} aria-hidden />
        </CardHeader>
        <CardContent>
          <div className={cn('text-2xl font-semibold tabular-nums', tone === 'warning' && 'text-warning', tone === 'destructive' && 'text-destructive')}>{value}</div>
          {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
        </CardContent>
      </Card>
    </Link>
  );
}

function dueText(days: number): string {
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
}

function Health({ d }: { d: Dashboard }) {
  const gmailOk = d.gmail.status === 'connected';
  const scanError = d.gmail.scan.lastError;
  const q = d.emailQueue;
  const rows: Array<{ ok: boolean; label: string; value: string; to: string }> = [
    { ok: gmailOk, label: 'Gmail', value: gmailOk ? 'Connected' : d.gmail.status === 'error' ? 'Credentials unreadable, reconnect Google' : 'Disconnected, reconnect Google', to: '/settings' },
    {
      ok: !scanError,
      label: 'Last scan',
      value: scanError ? `Failed: ${scanError}` : d.gmail.scan.lastSuccessAt ? `${formatAge(d.gmail.scan.lastSuccessAt)}${d.gmail.scan.running ? ' · scanning now' : ''}` : 'Not scanned yet',
      to: '/payments',
    },
    {
      ok: q.failed === 0,
      label: 'Email queue',
      value: `${q.sentLast24h} / ${q.cap} sent in 24 h · ${q.queued} queued${q.failed ? ` · ${q.failed} failed` : ''}${q.dryRun ? ' · dry run on' : ''}${q.resumesAt ? ` · daily limit reached, resumes ${formatAge(q.resumesAt)}` : ''}`,
      to: '/emails',
    },
  ];
  return (
    <ul className="space-y-2 text-sm">
      {rows.map((r) => (
        <li key={r.label}>
          <Link to={r.to} className="flex items-start gap-2 rounded-md px-1 py-0.5 hover:bg-accent">
            {r.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />}
            <span className="w-24 shrink-0 text-muted-foreground">{r.label}</span>
            <span className="min-w-0 break-words">{r.value}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function DashboardPage({ me }: { me: Me }) {
  const status = useQuery({ queryKey: queryKeys.systemStatus, queryFn: api.systemStatus, refetchInterval: 60_000 });
  const dash = useQuery({ queryKey: queryKeys.dashboard, queryFn: api.dashboard, refetchInterval: 60_000 });
  const d = dash.data;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
        <p className="text-sm text-muted-foreground">
          Signed in as {me.email}. Press <kbd className="rounded border bg-muted px-1 font-mono text-xs">Ctrl</kbd> + <kbd className="rounded border bg-muted px-1 font-mono text-xs">K</kbd> to jump to a member.
        </p>
      </div>

      {status.data && <BackupWarnings status={status.data} />}
      {dash.isError && <p className="text-sm text-destructive">Could not load the dashboard: {dash.error.message}</p>}

      {d && d.reviewQueue > 0 && (
        <Link to="/payments?tab=review" className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm hover:bg-warning/15">
          <Inbox className="h-4 w-4 shrink-0 text-warning" aria-hidden />
          <span className="flex-1">
            <strong>{d.reviewQueue}</strong> payment{d.reviewQueue === 1 ? '' : 's'} waiting for your decision in the Review Queue. Nobody’s access changes until you resolve them.
          </span>
          <Badge variant="warning">{d.reviewQueue}</Badge>
        </Link>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {d ? (
          <>
            <Stat label="Active" value={d.counts.active} icon={Users} to="/members?status=active" tone="success" note={`${d.counts.paused} paused · ${d.counts.archived} archived`} />
            <Stat label={`Due within ${d.dueSoonDays} days`} value={d.counts.dueSoon} icon={CalendarClock} to="/members?status=active" note="Still active, reminders go out on their own" />
            <Stat label="Grace period" value={d.counts.grace} icon={Hourglass} to="/members?status=grace" tone={d.counts.grace ? 'warning' : undefined} note="Overdue, access kept for now" />
            <Stat label="Expired" value={d.counts.expired} icon={UserX} to="/members?status=expired" tone={d.counts.expired ? 'destructive' : undefined} note="Access removed (when enforced)" />
            <Stat
              label="Payments this month"
              value={formatCents(d.paymentsThisMonth.totalCents, d.paymentsThisMonth.currency)}
              icon={CreditCard}
              to="/payments"
              note={`${d.paymentsThisMonth.count} payment${d.paymentsThisMonth.count === 1 ? '' : 's'} credited`}
            />
            <Stat label="Review queue" value={d.reviewQueue} icon={Inbox} to="/payments?tab=review" tone={d.reviewQueue ? 'warning' : undefined} note="Payments not applied automatically" />
            <Stat label="Awaiting deposit" value={d.awaitingDeposit} icon={Clock} to="/payments?tab=awaiting" tone={d.awaitingDeposit ? 'warning' : undefined} note="Deposit them at your bank" />
            <Stat label="Emails queued" value={d.emailQueue.queued} icon={Mail} to="/emails" tone={d.emailQueue.failed ? 'destructive' : undefined} note={`${d.emailQueue.sentLast24h} sent in the last 24 h`} />
          </>
        ) : (
          Array.from({ length: 8 }, (_, i) => <div key={i} className="h-28 animate-pulse rounded-lg bg-muted" />)
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Due soon</CardTitle>
            <CardDescription>Active members whose paid period ends within {d?.dueSoonDays ?? 7} days.</CardDescription>
          </CardHeader>
          <CardContent>
            {!d && <div className="h-24 animate-pulse rounded-md bg-muted" />}
            {d && d.dueSoon.length === 0 && <p className="text-sm text-muted-foreground">Nobody is due in the next {d.dueSoonDays} days.</p>}
            {d && d.dueSoon.length > 0 && (
              <ul className="divide-y text-sm">
                {d.dueSoon.map((m) => (
                  <li key={m.id}>
                    <Link to={`/members/${m.id}`} className="flex items-center justify-between gap-3 px-1 py-2 hover:bg-accent">
                      <span className="min-w-0 truncate font-medium">{m.displayName}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {dueText(m.dueInDays)} · paid through {formatDate(m.paidThrough)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Health</CardTitle>
            </CardHeader>
            <CardContent>{d ? <Health d={d} /> : <div className="h-20 animate-pulse rounded-md bg-muted" />}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Data safety</CardTitle>
              <CardDescription>Nightly verified backups to a separate volume.</CardDescription>
            </CardHeader>
            <CardContent>
              {status.isPending && <div className="h-16 animate-pulse rounded-md bg-muted" />}
              {status.isError && <p className="text-sm text-destructive">Could not load system status: {status.error.message}</p>}
              {status.data && <BackupSummary status={status.data} me={me} />}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
