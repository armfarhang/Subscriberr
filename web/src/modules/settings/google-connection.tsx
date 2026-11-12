import type { Me } from '@subscriberr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Mail, Unplug } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api, googleStartUrl } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

const STATUS: Record<Me['gmailStatus'], { label: string; variant: 'success' | 'warning' | 'destructive' }> = {
  connected: { label: 'Connected', variant: 'success' },
  disconnected: { label: 'Disconnected', variant: 'warning' },
  error: { label: 'Error', variant: 'destructive' },
};

/** Google account card: status, reconnect, and "Disconnect Google account" (Spec §5.3). */
export function GoogleConnection({ me, canReconnect }: { me: Me; canReconnect: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);
  const disconnect = useMutation({
    mutationFn: api.disconnectGoogle,
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
  const status = STATUS[me.gmailStatus];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Mail className="h-5 w-5 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{me.email}</div>
          <div className="text-xs text-muted-foreground">Gmail is scanned for e-Transfers and used to send all member emails.</div>
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>

      {me.gmailStatus !== 'connected' && (
        <p className="text-sm text-muted-foreground">
          {me.gmailStatus === 'error'
            ? 'The stored Google credentials cannot be read (for example after APP_SECRET changed). Sign in with Google again to reconnect.'
            : 'Scanning and sending are paused until you reconnect. If this happens about every 7 days, set your Google OAuth consent screen to "In production" (see README).'}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {me.gmailStatus === 'connected' ? (
          confirming ? (
            <>
              <Button variant="destructive" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                <Unplug /> {disconnect.isPending ? 'Disconnecting…' : 'Yes, disconnect'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <p className="basis-full text-xs text-muted-foreground">This revokes Subscriberr’s access at Google and pauses scanning and sending. You stay signed in.</p>
            </>
          ) : (
            <Button variant="outline" onClick={() => setConfirming(true)}>
              <Unplug /> Disconnect Google account
            </Button>
          )
        ) : (
          canReconnect && (
            <Button asChild>
              <a href={googleStartUrl()}>
                <CheckCircle2 /> Reconnect Google
              </a>
            </Button>
          )
        )}
      </div>
      {disconnect.isError && (
        <p role="alert" className="text-sm text-destructive">
          {disconnect.error.message}
        </p>
      )}
    </div>
  );
}
