import { type ScanSettings, scanSettingsSchema, type WorkspaceSettings } from '@subscriberr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

/** Settings → Gmail scanning (Spec §7.1, §7.4, §13.1 #10). */
export function ScanningCard({ settings }: { settings: WorkspaceSettings }) {
  const queryClient = useQueryClient();
  const s = settings.scanning;
  const [interval, setInterval] = React.useState(String(s.intervalMinutes));
  const [senders, setSenders] = React.useState(s.senders.join('\n'));
  const [lookback, setLookback] = React.useState(String(s.initialLookbackDays));
  const [reviewNew, setReviewNew] = React.useState(s.reviewNewEmailForKnownName);
  const [error, setError] = React.useState<string | null>(null);
  const save = useMutation({
    mutationFn: (scanning: ScanSettings) => api.updateWorkspaceSettings({ scanning }),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.workspaceSettings, next),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Gmail scanning</CardTitle>
        <CardDescription>
          The app reads e-Transfer notices from the connected Gmail account. If they arrive at another address, set that mailbox to auto-forward them to this Gmail account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = scanSettingsSchema.safeParse({
              intervalMinutes: Number(interval),
              senders: senders.split(/[\s,]+/).filter(Boolean),
              initialLookbackDays: Number(lookback),
              reviewNewEmailForKnownName: reviewNew,
            });
            if (!parsed.success) {
              setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
              return;
            }
            setError(null);
            save.mutate(parsed.data);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="scan-interval" label="Scan every (minutes)" hint="Default 5.">
              <Input inputMode="numeric" value={interval} onChange={(e) => setInterval(e.target.value)} />
            </Field>
            <Field id="scan-lookback" label="First scan looks back (days)" hint="Older notices: System → Rescan mailbox from date.">
              <Input inputMode="numeric" value={lookback} onChange={(e) => setLookback(e.target.value)} />
            </Field>
            <Field id="scan-senders" label="Accepted senders" className="sm:col-span-2" hint="One address per line. Mail from any other sender is never treated as a payment.">
              <textarea
                className="flex min-h-[64px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={senders}
                onChange={(e) => setSenders(e.target.value)}
              />
            </Field>
          </div>
          <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={reviewNew} onChange={(e) => setReviewNew(e.target.checked)} />
            <span>
              <span className="font-medium">Review payments from a new email address</span>
              <span className="block text-xs text-muted-foreground">
                Off (default): when a known name pays from a new address, the payment is applied and the address is remembered. On: such payments wait in the Review Queue.
              </span>
            </span>
          </label>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              Save scanning settings
            </Button>
            {save.isSuccess && <span className="text-sm text-success">Saved</span>}
            {(error || save.isError) && <span className="text-sm text-destructive">{error ?? save.error?.message}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
