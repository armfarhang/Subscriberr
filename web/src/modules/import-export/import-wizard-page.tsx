import { csvFieldLabel, type ImportBatchView } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Undo2 } from 'lucide-react';
import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiRequestError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { MappingStep } from './mapping-step';
import { ReviewStep } from './review-step';

const STEPS = ['Upload', 'Match columns', 'Review', 'Done'] as const;

function stepOf(batch: ImportBatchView): number {
  if (batch.status !== 'staged') return 3;
  return batch.stage === 'mapping' ? 1 : 2;
}

/** The import wizard for one uploaded file (Spec §12.2). */
export function ImportWizardPage() {
  const { id: raw } = useParams();
  const id = Number(raw);
  const batch = useQuery({ queryKey: queryKeys.importBatch(id), queryFn: () => api.importBatch(id), enabled: Number.isInteger(id) && id > 0 });
  const settings = useQuery({ queryKey: queryKeys.workspaceSettings, queryFn: api.workspaceSettings });

  if (batch.error instanceof ApiRequestError && batch.error.status === 404) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">This import does not exist.</p>
        <Button asChild variant="outline">
          <Link to="/import-export">
            <ArrowLeft /> Back
          </Link>
        </Button>
      </div>
    );
  }
  if (batch.isPending) return <div className="h-64 animate-pulse rounded-lg bg-muted" />;
  if (batch.isError) return <p className="text-sm text-destructive">Could not load this import: {batch.error.message}</p>;
  const b = batch.data;
  const step = stepOf(b);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="icon" aria-label="Back to import / export">
          <Link to="/import-export">
            <ArrowLeft />
          </Link>
        </Button>
        <h2 className="min-w-0 truncate text-2xl font-semibold tracking-tight">Import {b.fileName}</h2>
      </div>
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Import steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-3 py-1',
              i < step && 'border-success/40 text-success',
              i === step && 'border-primary bg-primary/15 font-medium text-primary',
              i > step && 'text-muted-foreground',
            )}
          >
            {i < step ? <Check className="h-3.5 w-3.5" aria-hidden /> : <span className="tabular-nums">{i + 1}</span>}
            {label}
          </li>
        ))}
      </ol>
      {b.status === 'staged' && b.stage === 'mapping' && <MappingStep key={`map-${b.id}`} batch={b} />}
      {b.status === 'staged' && b.stage === 'review' && <ReviewStep key={`review-${b.id}`} batch={b} />}
      {b.status !== 'staged' && <ResultStep batch={b} timeZone={settings.data?.timezone ?? 'UTC'} />}
    </div>
  );
}

function ResultStep({ batch: b, timeZone }: { batch: ImportBatchView; timeZone: string }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);
  const undo = useMutation({
    mutationFn: () => api.undoImport(b.id),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.importBatch(b.id), next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.members });
      void queryClient.invalidateQueries({ queryKey: queryKeys.imports });
      setConfirming(false);
    },
  });

  if (b.status === 'abandoned') return <p className="text-sm text-muted-foreground">This import was cancelled; nothing was changed.</p>;
  const r = b.result;
  return (
    <div className="space-y-6">
      {b.status === 'undone' && (
        <div role="status" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          Undone on {formatDateTime(b.undoneAt, timeZone)}: {b.undoSummary?.restored ?? 0} member(s) got their previous values back and balances set by the import were reversed in the payment history.{' '}
          {b.undoSummary?.deleted ?? 0} new member(s) were removed
          {b.undoSummary?.archived ? `; ${b.undoSummary.archived} new member(s) were archived instead, because their balance entries stay in the history` : ''}.
        </div>
      )}
      {r && (
        <Card>
          <CardHeader>
            <CardTitle>{b.status === 'undone' ? 'What the import had changed' : 'Imported'}</CardTitle>
            <CardDescription>
              Imported on {formatDateTime(b.committedAt, timeZone)} · safety backup {r.backupFile ?? '—'} · no emails were sent and no media-server access was changed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2 text-sm">
              {[
                ['created', r.created],
                ['updated', r.updated],
                ['skipped or unchanged', r.skipped],
                ['balance entries', r.ledgerEntries],
                ['aliases added', r.aliasesAdded],
                ['server links', r.serverLinks],
              ].map(([label, n]) => (
                <span key={label as string} className="rounded-md border px-2.5 py-1">
                  <span className="font-semibold tabular-nums">{n}</span> {label}
                </span>
              ))}
            </div>
            <ul className="max-h-80 divide-y overflow-y-auto rounded-md border text-sm">
              {r.members.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                  {b.status === 'committed' ? (
                    <Link to={`/members/${m.id}`} className="font-medium hover:underline">
                      {m.displayName}
                    </Link>
                  ) : (
                    <span className="font-medium">{m.displayName}</span>
                  )}
                  <Badge variant={m.action === 'created' ? 'success' : 'warning'}>{m.action}</Badge>
                  <span className="text-xs text-muted-foreground">{m.fields.map(csvFieldLabel).join(', ')}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {b.status === 'committed' && (
        <Card>
          <CardHeader>
            <CardTitle>Undo this import</CardTitle>
            <CardDescription>
              {b.undo.available
                ? `Available until ${formatDateTime(b.undo.until, timeZone)}, as long as none of these members change in the meantime.`
                : (b.undo.reason ?? 'Not available.')}
            </CardDescription>
          </CardHeader>
          {b.undo.available && (
            <CardContent className="flex flex-wrap items-center gap-3">
              {confirming ? (
                <>
                  <span className="w-full text-sm">
                    Updated members get their previous values back, balances set by the import are reversed, and new members are removed (or archived if they got a balance).
                  </span>
                  <Button variant="destructive" onClick={() => undo.mutate()} disabled={undo.isPending}>
                    <Undo2 /> {undo.isPending ? 'Undoing…' : 'Yes, undo the import'}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="outline" onClick={() => setConfirming(true)}>
                  <Undo2 /> Undo this import
                </Button>
              )}
              {undo.isError && <p className="w-full text-sm text-destructive">{undo.error.message}</p>}
            </CardContent>
          )}
        </Card>
      )}
      <Button asChild variant="outline">
        <Link to="/members">Go to members</Link>
      </Button>
    </div>
  );
}
