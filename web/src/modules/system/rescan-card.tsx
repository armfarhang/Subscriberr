import type { RescanResult } from '@subscriberr/shared';
import { formatCents } from '@subscriberr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MailSearch } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

/** System → Rescan mailbox from date (Spec §6.9 layer 4): always a dry run first. */
export function RescanCard() {
  const queryClient = useQueryClient();
  const [since, setSince] = React.useState('');
  const [preview, setPreview] = React.useState<RescanResult | null>(null);
  const dry = useMutation({ mutationFn: () => api.rescan({ since, dryRun: true }), onSuccess: setPreview });
  const run = useMutation({
    mutationFn: () => api.rescan({ since, dryRun: false }),
    onSuccess: () => {
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.payments });
      void queryClient.invalidateQueries({ queryKey: queryKeys.members });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Rescan mailbox from date</CardTitle>
        <CardDescription>
          Re-reads e-Transfer notices from this workspace’s Gmail since a date, even ones already labelled Processed. Known payments are skipped, so nothing is counted twice. Use it after restoring a backup: it
          cannot bring back manual payments, voids, adjustments or member edits made since the backup.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (since) dry.mutate();
          }}
        >
          <Field id="rescan-since" label="From date">
            <Input
              type="date"
              value={since}
              onChange={(e) => {
                setSince(e.target.value);
                setPreview(null);
              }}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={!since || dry.isPending}>
            <MailSearch /> {dry.isPending ? 'Checking…' : 'Preview (dry run)'}
          </Button>
        </form>
        {preview && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p>
              {preview.stats.messages} message(s) since {preview.since}: {preview.stats.known} already known, <strong>{preview.stats.stored} new payment(s) would be added</strong>
              {preview.stats.stored > 0 && ` (${preview.stats.matched} matched, ${preview.stats.review} for review, ${preview.stats.pendingDeposit} awaiting deposit)`}.
            </p>
            {preview.preview.length > 0 && (
              <ul className="max-h-48 overflow-y-auto text-xs text-muted-foreground">
                {preview.preview.map((p, i) => (
                  <li key={i}>
                    {p.receivedAt.slice(0, 10)} · {p.senderName ?? '?'} · {p.amountCents === null ? '—' : formatCents(p.amountCents)} → {p.memberName ?? p.status}
                  </li>
                ))}
              </ul>
            )}
            {preview.stats.stored > 0 && (
              <Button onClick={() => run.mutate()} disabled={run.isPending}>
                {run.isPending ? 'Rescanning…' : `Add ${preview.stats.stored} payment(s)`}
              </Button>
            )}
          </div>
        )}
        {run.isSuccess && <p className="text-sm text-success">Rescan finished: {run.data.stats.stored} payment(s) added.</p>}
        {(dry.isError || run.isError) && <p className="text-sm text-destructive">{(dry.error ?? run.error)?.message}</p>}
      </CardContent>
    </Card>
  );
}
