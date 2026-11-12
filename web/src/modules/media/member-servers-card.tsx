import type { MemberDetail } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Unlink } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { accessStateLabel } from '@/modules/members/server-chips';

/** Member detail → Media servers (Spec §10.1): link to an existing account, library choice, state. */
export function ServersCard({ member: m, timeZone }: { member: MemberDetail; timeZone: string }) {
  const queryClient = useQueryClient();
  const servers = useQuery({ queryKey: ['media', 'servers'], queryFn: api.servers });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.member(m.id) });
    void queryClient.invalidateQueries({ queryKey: ['media'] });
  };
  const unlink = useMutation({ mutationFn: (serverId: number) => api.unlinkMember(m.id, serverId), onSuccess: refresh });
  const unlinkedServers = servers.data?.items.filter((s) => !m.servers.some((l) => l.serverId === s.id)) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Media servers</CardTitle>
        <CardDescription>
          Link this member to their existing account on each server. <Link className="underline underline-offset-2" to="/media">Servers</Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {m.servers.length === 0 && <p className="text-sm text-muted-foreground">Not linked to any server.</p>}
        <ul className="space-y-2 text-sm">
          {m.servers.map((s) => (
            <li key={s.serverId} className="space-y-2 rounded-md border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{s.serverName}</span>
                <Badge variant={s.accessState === 'granted' ? 'success' : s.accessState === 'revoked' ? 'destructive' : s.accessState === 'error' ? 'warning' : 'neutral'}>{accessStateLabel(s.accessState)}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                {s.serverType === 'plex' ? 'Plex' : 'Jellyfin'} user {s.externalUsername ?? '—'} · last synced {s.lastSyncedAt ? formatDateTime(s.lastSyncedAt, timeZone) : 'never'}
              </div>
              <LibraryChoice memberId={m.id} serverId={s.serverId} onSaved={refresh} />
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => unlink.mutate(s.serverId)} disabled={unlink.isPending} title="Forget the link; nothing changes on the server">
                <Unlink /> Unlink
              </Button>
            </li>
          ))}
        </ul>
        {unlinkedServers.length > 0 && <LinkForm memberId={m.id} servers={unlinkedServers} onLinked={refresh} />}
      </CardContent>
    </Card>
  );
}

function LibraryChoice({ memberId, serverId, onSaved }: { memberId: number; serverId: number; onSaved: () => void }) {
  const [open, setOpen] = React.useState(false);
  const libs = useQuery({ queryKey: ['media', serverId, 'libraries'], queryFn: () => api.serverLibraries(serverId), enabled: open, retry: false });
  const server = useQuery({ queryKey: ['media', 'servers'], queryFn: api.servers });
  const defaults = server.data?.items.find((s) => s.id === serverId)?.defaultLibraryIds ?? [];
  const [chosen, setChosen] = React.useState<string[] | null>(null);
  const save = useMutation({ mutationFn: (ids: string[] | null) => api.setLinkLibraries(memberId, serverId, ids), onSuccess: () => (setOpen(false), onSaved()) });
  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(true)}>
        Libraries…
      </Button>
    );
  }
  const current = chosen ?? defaults;
  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      {libs.isError && <p className="text-xs text-destructive">{libs.error.message}</p>}
      {libs.data?.items.map((l) => (
        <label key={l.id} className="flex items-center gap-2 text-xs">
          <input type="checkbox" className="h-3.5 w-3.5" checked={current.includes(l.id)} onChange={(e) => setChosen(e.target.checked ? [...current, l.id] : current.filter((x) => x !== l.id))} />
          {l.name}
          {defaults.includes(l.id) && <span className="text-muted-foreground">(default)</span>}
        </label>
      ))}
      <div className="flex flex-wrap gap-1">
        <Button size="sm" className="h-7 text-xs" onClick={() => save.mutate(chosen)} disabled={!chosen || save.isPending}>
          Use these for this member
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => save.mutate(null)} disabled={save.isPending}>
          Use the server default
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </div>
  );
}

function LinkForm({ memberId, servers, onLinked }: { memberId: number; servers: Array<{ id: number; name: string }>; onLinked: () => void }) {
  const [serverId, setServerId] = React.useState(servers[0]!.id);
  const [userId, setUserId] = React.useState('');
  const users = useQuery({ queryKey: ['media', serverId, 'users'], queryFn: () => api.serverUsers(serverId), retry: false });
  const link = useMutation({ mutationFn: () => api.linkMember(memberId, { serverId, externalUserId: userId }), onSuccess: () => (setUserId(''), onLinked()) });
  const free = users.data?.users.filter((u) => !u.isAdmin && !u.linkedMember) ?? [];
  return (
    <div className="space-y-2 rounded-md border border-dashed p-2 text-sm">
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Server" className="h-8 w-auto" value={String(serverId)} onChange={(e) => (setServerId(Number(e.target.value)), setUserId(''))}>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Account on the server" className="h-8 min-w-[10rem] flex-1" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">{users.isPending ? 'Loading users…' : free.length ? 'Choose their account…' : 'No unlinked accounts'}</option>
          {free.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
              {u.email ? ` (${u.email})` : ''}
            </option>
          ))}
        </Select>
        <Button size="sm" className="h-8" onClick={() => link.mutate()} disabled={!userId || link.isPending}>
          <Link2 /> Link
        </Button>
      </div>
      {users.data && users.data.pendingInvites.length > 0 && <p className="text-xs text-muted-foreground">Pending invitations can be linked once accepted: {users.data.pendingInvites.map((p) => p.email).join(', ')}.</p>}
      {(users.isError || link.isError) && <p className="text-xs text-destructive">{(users.error ?? link.error)?.message}</p>}
    </div>
  );
}
