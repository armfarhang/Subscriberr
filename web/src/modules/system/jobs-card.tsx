import type { JobInfo, LogLine } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, RefreshCw } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatAge, formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';

// System → Jobs, recent errors and log tail (Spec §11, §13.1 #11). Owner only: the jobs work
// across every workspace and the log lines can mention any of them.

const JOB_LABEL: Record<string, string> = {
  'gmail-scan': 'Gmail scan',
  'daily-workspace': 'Daily run (statuses, reminders, access)',
  'email-drain': 'Send queued emails',
  'media-sync': 'Media-server sync',
  backup: 'Nightly backup',
  'backup-destination-health': 'Backup destination check',
  'integrity-check': 'Integrity + ledger check',
  'token-health': 'Google token health',
  'import-staging-cleanup': 'Clean up old CSV imports',
};

function statusBadge(run: JobInfo['lastRun']) {
  if (!run) return <Badge variant="neutral">Never run</Badge>;
  if (run.status === 'running') return <Badge variant="warning">Running</Badge>;
  return run.status === 'ok' ? <Badge variant="success">OK</Badge> : <Badge variant="destructive">Error</Badge>;
}

function summarizeStats(stats: Record<string, unknown> | null): string {
  if (!stats) return '';
  return Object.entries(stats)
    .filter(([, v]) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(' · ');
}

export function JobsCard({ timeZone }: { timeZone: string }) {
  const queryClient = useQueryClient();
  const jobs = useQuery({ queryKey: queryKeys.jobs, queryFn: api.jobs, refetchInterval: 30_000 });
  const [lastResult, setLastResult] = React.useState<{ name: string; text: string; ok: boolean } | null>(null);
  const run = useMutation({
    mutationFn: api.runJob,
    onSuccess: (r, name) =>
      setLastResult({
        name,
        ok: r.status !== 'error',
        text: r.status === 'skipped' ? 'it is already running' : r.status === 'error' ? `failed: ${r.error ?? ''}` : `done${r.stats ? ` (${summarizeStats(r.stats)})` : ''}`,
      }),
    onError: (e, name) => setLastResult({ name, ok: false, text: e.message }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['system'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Jobs</CardTitle>
        <CardDescription>Background work runs on its own. “Run now” starts a job immediately, for every workspace; a job never runs twice at the same time.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {jobs.isPending && <div className="h-32 animate-pulse rounded-md bg-muted" />}
        {jobs.isError && <p className="text-sm text-destructive">Could not load jobs: {jobs.error.message}</p>}
        {lastResult && (
          <p role="status" className={`text-sm ${lastResult.ok ? 'text-success' : 'text-destructive'}`}>
            {JOB_LABEL[lastResult.name] ?? lastResult.name}: {lastResult.text}
          </p>
        )}
        <ul className="divide-y rounded-md border">
          {jobs.data?.items.map((j) => (
            <li key={j.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{JOB_LABEL[j.name] ?? j.name}</div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-mono">{j.name}</span>
                  {j.schedule ? ` · cron ${j.schedule}` : ' · on demand'}
                  {j.lastRun && ` · last run ${formatAge(j.lastRun.startedAt)}`}
                  {j.lastRun?.stats && summarizeStats(j.lastRun.stats) && ` · ${summarizeStats(j.lastRun.stats)}`}
                </div>
                {j.lastError && (
                  <div className="truncate text-xs text-destructive" title={j.lastError.error}>
                    Last error {formatDateTime(j.lastError.startedAt, timeZone)}: {j.lastError.error}
                  </div>
                )}
              </div>
              {statusBadge(j.lastRun)}
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => run.mutate(j.name)} disabled={run.isPending}>
                <Play /> {run.isPending && run.variables === j.name ? 'Running…' : 'Run now'}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

const LEVEL_VARIANT: Record<LogLine['level'], 'neutral' | 'warning' | 'destructive'> = { debug: 'neutral', info: 'neutral', warn: 'warning', error: 'destructive' };

export function LogsCard({ timeZone }: { timeZone: string }) {
  const [level, setLevel] = React.useState<'info' | 'warn' | 'error'>('warn');
  const logs = useQuery({ queryKey: queryKeys.logs(level), queryFn: () => api.logs(level), refetchInterval: 30_000 });
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>Recent errors &amp; log</CardTitle>
          <CardDescription>The last few hundred lines since the app started (newest first). The full log is the container’s output.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select aria-label="Log level" className="h-8 w-auto" value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
            <option value="error">Errors</option>
            <option value="warn">Warnings and errors</option>
            <option value="info">Everything</option>
          </Select>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void logs.refetch()} aria-label="Refresh log">
            <RefreshCw className={logs.isFetching ? 'animate-spin' : undefined} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {logs.isError && <p className="text-sm text-destructive">Could not load the log: {logs.error.message}</p>}
        {logs.data?.items.length === 0 && <p className="text-sm text-muted-foreground">{level === 'info' ? 'Nothing logged yet.' : 'No warnings or errors since the app started.'}</p>}
        {logs.data && logs.data.items.length > 0 && (
          <ol className="max-h-96 space-y-1 overflow-y-auto rounded-md bg-muted/40 p-2 font-mono text-xs">
            {logs.data.items.map((l, i) => (
              <li key={`${l.time}-${i}`} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground">{formatDateTime(l.time, timeZone)}</span>
                <Badge variant={LEVEL_VARIANT[l.level]} className="h-4 shrink-0 px-1 text-[10px] uppercase">
                  {l.level}
                </Badge>
                <span className="min-w-0 break-words">
                  {l.msg}
                  {Object.keys(l.fields).length > 0 && <span className="text-muted-foreground"> {JSON.stringify(l.fields)}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
