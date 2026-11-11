import type { Me } from '@subscriberr/shared';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, Inbox, Mail, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { BackupSummary, BackupWarnings } from '@/modules/system/backup-health';

const UPCOMING = [
  { label: 'Members', icon: Users, to: '/members', note: 'Active, due soon, grace and expired counts' },
  { label: 'Payments', icon: CreditCard, to: '/payments', note: 'Payments this month and the last Gmail scan' },
  { label: 'Review queue', icon: Inbox, to: '/review-queue', note: 'Payments waiting for your decision' },
  { label: 'Email queue', icon: Mail, to: '/emails', note: 'Sent today and queued messages' },
];

export function DashboardPage({ me }: { me: Me }) {
  const status = useQuery({ queryKey: queryKeys.systemStatus, queryFn: api.systemStatus, refetchInterval: 60_000 });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
        <p className="text-sm text-muted-foreground">Signed in as {me.email}.</p>
      </div>

      {status.data && <BackupWarnings status={status.data} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {UPCOMING.map((c) => (
          <Link key={c.label} to={c.to} className="rounded-lg">
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardHeader className="flex-row items-center justify-between pb-2">
                <CardTitle className="text-muted-foreground">{c.label}</CardTitle>
                <c.icon className="h-4 w-4 text-muted-foreground" aria-hidden />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold text-muted-foreground/60">—</div>
                <p className="mt-1 text-xs text-muted-foreground">{c.note}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

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
  );
}
