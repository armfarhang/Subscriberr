import type { BackupRun, Me } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, DatabaseBackup, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatAge, formatBytes, formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { BackupSummary, BackupWarnings } from './backup-health';

const KIND_LABEL: Record<BackupRun['kind'], string> = {
  nightly: 'Nightly',
  manual: 'Manual',
  pre_migration: 'Before migration',
  pre_import: 'Before import',
};

function BackupRow({ run, timeZone }: { run: BackupRun; timeZone: string }) {
  return (
    <tr className="border-t">
      <td className="whitespace-nowrap py-2 pr-4">
        {formatDateTime(run.startedAt, timeZone)}
        <div className="text-xs text-muted-foreground">{formatAge(run.startedAt)}</div>
      </td>
      <td className="py-2 pr-4">{KIND_LABEL[run.kind]}</td>
      <td className="py-2 pr-4">
        <Badge variant="neutral" className="capitalize">
          {run.tier}
        </Badge>
      </td>
      <td className="whitespace-nowrap py-2 pr-4">{formatBytes(run.bytes)}</td>
      <td className="py-2 pr-4">
        {run.verified ? (
          <span className="inline-flex items-center gap-1 text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden /> Verified
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-destructive" title={run.error ?? undefined}>
            <XCircle className="h-4 w-4" aria-hidden /> Failed
          </span>
        )}
      </td>
      <td className="max-w-[18rem] truncate py-2 font-mono text-xs text-muted-foreground" title={run.error ?? run.file ?? ''}>
        {run.error ?? (run.prunedAt ? `pruned ${formatAge(run.prunedAt)}` : run.file)}
      </td>
    </tr>
  );
}

export function SystemPage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const isOwner = me.role === 'owner';
  const status = useQuery({ queryKey: queryKeys.systemStatus, queryFn: api.systemStatus });
  const backups = useQuery({ queryKey: queryKeys.backups, queryFn: api.backups, enabled: isOwner });
  const backupNow = useMutation({
    mutationFn: api.backupNow,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups });
      void queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus });
    },
  });

  return (
    <div className="space-y-6">
      {status.data && <BackupWarnings status={status.data} />}

      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Backups &amp; integrity</CardTitle>
            <CardDescription>
              Nightly at 03:00, verified immediately. Kept: 2 daily, 4 weekly, 6 monthly. Backups are not encrypted and contain member names and emails.
            </CardDescription>
          </div>
          {isOwner && (
            <Button onClick={() => backupNow.mutate()} disabled={backupNow.isPending}>
              <DatabaseBackup /> {backupNow.isPending ? 'Backing up…' : 'Back up now'}
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-5">
          {status.isPending && <div className="h-16 animate-pulse rounded-md bg-muted" />}
          {status.data && <BackupSummary status={status.data} me={me} />}
          {backupNow.isError && (
            <p role="alert" className="text-sm text-destructive">
              Backup failed: {backupNow.error.message}
            </p>
          )}

          {isOwner ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">Taken</th>
                    <th className="pb-2 pr-4 font-medium">Kind</th>
                    <th className="pb-2 pr-4 font-medium">Tier</th>
                    <th className="pb-2 pr-4 font-medium">Size</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 font-medium">File</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.data?.items.map((run) => <BackupRow key={run.id} run={run} timeZone={me.timezone} />)}
                </tbody>
              </table>
              {backups.data?.items.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No backups yet.</p>}
              {backups.isError && <p className="py-4 text-sm text-destructive">Could not load backups: {backups.error.message}</p>}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Only the owner can see and create backups.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Restore</CardTitle>
          <CardDescription>Restore is deliberately not available here, so a misclick can never overwrite live data.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Stop the app, then run the image once with both volumes:</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            docker run --rm -v /path/to/data:/data -v /path/to/backups:/backups subscriberr restore /backups/&lt;file&gt;.zip
          </pre>
          <p className="text-muted-foreground">Then start the app again. The current data is moved aside, never deleted.</p>
        </CardContent>
      </Card>

      {status.data && (
        <p className="text-xs text-muted-foreground">
          Subscriberr {status.data.version} · schema v{status.data.schemaVersion}
        </p>
      )}
    </div>
  );
}
