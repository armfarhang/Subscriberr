import type { MemberServerLink } from '@subscriberr/shared';
import { cn } from '@/lib/utils';

const STATE_CLASS: Record<MemberServerLink['accessState'], string> = {
  granted: 'border-success/40 bg-success/10 text-success',
  revoked: 'border-destructive/40 bg-destructive/10 text-destructive',
  error: 'border-warning/40 bg-warning/10 text-warning',
  unknown: 'border-border bg-muted text-muted-foreground',
};

const STATE_LABEL: Record<MemberServerLink['accessState'], string> = {
  granted: 'access granted',
  revoked: 'access revoked',
  error: 'sync error',
  unknown: 'not synced yet',
};

export const accessStateLabel = (s: MemberServerLink['accessState']) => STATE_LABEL[s];

/** One small chip per linked media-server account: P = Plex, J = Jellyfin, coloured by access state. */
export function ServerChips({ servers }: { servers: MemberServerLink[] }) {
  if (servers.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="inline-flex gap-1">
      {servers.map((s) => {
        const label = `${s.serverName}: ${STATE_LABEL[s.accessState]}`;
        return (
          <span key={s.serverId} title={label} aria-label={label} className={cn('inline-flex h-6 min-w-6 items-center justify-center rounded border px-1 text-[11px] font-semibold', STATE_CLASS[s.accessState])}>
            {s.serverType === 'plex' ? 'P' : 'J'}
          </span>
        );
      })}
    </span>
  );
}
