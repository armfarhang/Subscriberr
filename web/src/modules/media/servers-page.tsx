import { type CreateServer, type ServerView, type SyncPlanItem, type SyncResult } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Plug, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { STATUS_LABEL } from '@/modules/members/status';

export const MEDIA_KEY = ['media'] as const;

/** Servers (Spec §10, §13.1 #9): add / test servers, default libraries, users, enforcement. */
export function ServersPage({ timeZone }: { timeZone: string }) {
  const servers = useQuery({ queryKey: [...MEDIA_KEY, 'servers'], queryFn: api.servers });
  const [selected, setSelected] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  const current = servers.data?.items.find((s) => s.id === selected) ?? servers.data?.items[0] ?? null;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Connect your Plex and Jellyfin servers, link members to their accounts, and let payments turn library access on and off. Nothing changes on a server until you turn enforcement on and approve the first dry run.
        </p>
        <Button onClick={() => setAdding((a) => !a)}>
          <Plus /> Add server
        </Button>
      </div>
      {adding && <AddServer onDone={(id) => (setAdding(false), id && setSelected(id))} />}
      {servers.data && servers.data.items.length === 0 && !adding && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No servers yet.</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {servers.data?.items.map((s) => (
          <button key={s.id} type="button" onClick={() => setSelected(s.id)} className={cn('rounded-lg border bg-card p-3 text-left text-sm hover:border-primary/60', current?.id === s.id && 'border-primary ring-1 ring-primary')}>
            <div className="flex flex-wrap items-center gap-1.5 font-medium">
              {s.name}
              <Badge variant="neutral">{s.type === 'plex' ? 'Plex' : 'Jellyfin'}</Badge>
              {s.enforcementEnabled ? <Badge variant={s.enforcementConfirmed ? 'success' : 'warning'}>{s.enforcementConfirmed ? 'Enforcing' : 'Dry run pending'}</Badge> : <Badge variant="neutral">Not enforcing</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {s.linked} linked member(s){s.failing.length > 0 && <span className="text-destructive"> · {s.failing.length} failing</span>}
            </p>
          </button>
        ))}
      </div>
      {current && <ServerDetail key={current.id} server={current} timeZone={timeZone} />}
    </div>
  );
}

function AddServer({ onDone }: { onDone: (id: number | null) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<CreateServer>({ type: 'plex', name: '', baseUrl: '', token: '' });
  const create = useMutation({
    mutationFn: api.createServer,
    onSuccess: (s) => {
      void queryClient.invalidateQueries({ queryKey: MEDIA_KEY });
      onDone(s.id);
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a server</CardTitle>
        <CardDescription>The token / API key is stored encrypted and never shown again.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(form);
          }}
        >
          <Field id="srv-type" label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as CreateServer['type'] })}>
              <option value="plex">Plex</option>
              <option value="jellyfin">Jellyfin</option>
            </Select>
          </Field>
          <Field id="srv-name" label="Name">
            <Input value={form.name} maxLength={60} placeholder="Home Plex" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field id="srv-url" label="Server address" hint={form.type === 'plex' ? 'e.g. http://192.168.1.10:32400' : 'e.g. http://192.168.1.10:8096'}>
            <Input value={form.baseUrl} placeholder="http://…" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </Field>
          <Field id="srv-token" label={form.type === 'plex' ? 'Plex token (server owner)' : 'Jellyfin API key'} hint={form.type === 'plex' ? 'See the README: “Finding your Plex token”.' : 'Jellyfin Dashboard → API Keys → +'}>
            <Input type="password" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
          </Field>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={create.isPending}>
              Add server
            </Button>
            <Button type="button" variant="ghost" onClick={() => onDone(null)}>
              Cancel
            </Button>
            {create.isError && <span className="text-sm text-destructive">{create.error.message}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ServerDetail({ server: s, timeZone }: { server: ServerView; timeZone: string }) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: MEDIA_KEY });
  const test = useMutation({ mutationFn: () => api.testServer(s.id), onSettled: refresh });
  const libraries = useQuery({ queryKey: [...MEDIA_KEY, s.id, 'libraries'], queryFn: () => api.serverLibraries(s.id), retry: false });
  const users = useQuery({ queryKey: [...MEDIA_KEY, s.id, 'users'], queryFn: () => api.serverUsers(s.id), retry: false });
  const [defaults, setDefaults] = React.useState<string[]>(s.defaultLibraryIds);
  const saveDefaults = useMutation({ mutationFn: () => api.updateServer(s.id, { defaultLibraryIds: defaults }), onSuccess: refresh });
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const remove = useMutation({ mutationFn: () => api.deleteServer(s.id), onSuccess: refresh });
  const [token, setToken] = React.useState('');
  const saveToken = useMutation({ mutationFn: () => api.updateServer(s.id, { token }), onSuccess: () => (setToken(''), refresh()) });
  const saveOptions = useMutation({ mutationFn: (options: ServerView['options']) => api.updateServer(s.id, { options }), onSuccess: refresh });

  return (
    <div className="space-y-6">
      {s.failing.length > 0 && (
        <div role="alert" className="space-y-1 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
          <div className="flex items-center gap-2 font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden /> {s.failing.filter((f) => f.pendingRevoke).length > 0 ? 'Access could not be removed' : 'Some access changes failed'}
          </div>
          <ul className="list-disc pl-5">
            {s.failing.map((f) => (
              <li key={f.memberId}>
                <Link className="underline underline-offset-2" to={`/members/${f.memberId}`}>
                  {f.displayName}
                </Link>
                {f.pendingRevoke && <strong> still has access although unpaid</strong>}: {f.error}. Retried automatically.
              </li>
            ))}
          </ul>
        </div>
      )}
      <Card>
        <CardHeader className="flex-row flex-wrap items-start gap-3 space-y-0">
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle>{s.name}</CardTitle>
            <CardDescription>
              {s.baseUrl} · last check {s.lastCheckedAt ? formatDateTime(s.lastCheckedAt, timeZone) : 'never'}
              {s.lastStatus && ` · ${s.lastStatus}`}
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
            <Plug /> {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
          {confirmDelete ? (
            <span className="flex gap-1">
              <Button size="sm" variant="destructive" onClick={() => remove.mutate()}>
                Delete server and its links
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {test.data && <p className={test.data.ok ? 'text-success' : 'text-destructive'}>{test.data.ok ? `Connected: ${test.data.detail}` : `Failed: ${test.data.detail}`}</p>}
          <div className="flex flex-wrap items-end gap-2">
            <Field id={`tok-${s.id}`} label="Replace token / API key" className="min-w-[16rem] flex-1">
              <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.hasCredentials ? '•••••••• (stored)' : 'not set'} />
            </Field>
            <Button size="sm" variant="outline" disabled={token.length < 8 || saveToken.isPending} onClick={() => saveToken.mutate()}>
              Save
            </Button>
          </div>
          {s.type === 'jellyfin' && (
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4" checked={s.options.disableOnRevoke} onChange={(e) => saveOptions.mutate({ ...s.options, disableOnRevoke: e.target.checked })} />
                Also disable the Jellyfin user when access is removed
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4" checked={s.options.endSessionsOnRevoke} onChange={(e) => saveOptions.mutate({ ...s.options, endSessionsOnRevoke: e.target.checked })} />
                Stop their streams when access is removed
              </label>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Default libraries</CardTitle>
            <CardDescription>What a paying member gets, unless the member has their own selection.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {libraries.isError && <p className="text-destructive">{libraries.error.message}</p>}
            {libraries.data?.items.map((l) => (
              <label key={l.id} className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4" checked={defaults.includes(l.id)} onChange={(e) => setDefaults(e.target.checked ? [...defaults, l.id] : defaults.filter((x) => x !== l.id))} />
                {l.name}
              </label>
            ))}
            <Button size="sm" onClick={() => saveDefaults.mutate()} disabled={saveDefaults.isPending}>
              Save default libraries
            </Button>
            {saveDefaults.isSuccess && <span className="ml-2 text-success">Saved</span>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Users on the server</CardTitle>
            <CardDescription>Link members to these accounts from the member’s page.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            {users.isError && <p className="text-destructive">{users.error.message}</p>}
            <ul className="divide-y rounded-md border">
              {users.data?.users.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate">
                    {u.username}
                    {u.email && <span className="text-xs text-muted-foreground"> · {u.email}</span>}
                  </span>
                  {u.isAdmin ? (
                    <Badge variant="neutral">Admin (never changed)</Badge>
                  ) : u.linkedMember ? (
                    <Link className="text-xs underline underline-offset-2" to={`/members/${u.linkedMember.id}`}>
                      {u.linkedMember.displayName}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">not linked</span>
                  )}
                </li>
              ))}
              {users.data?.pendingInvites.map((p) => (
                <li key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground">
                  <span className="flex-1 truncate">{p.email}</span>
                  <Badge variant="warning">Invitation pending</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      <EnforcementCard server={s} />
    </div>
  );
}

const ACTION_LABEL: Record<SyncPlanItem['action'], string> = { grant: 'Give access', revoke: 'Remove access', none: 'No change', skip: 'Skipped' };

function EnforcementCard({ server: s }: { server: ServerView }) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: MEDIA_KEY });
  const [result, setResult] = React.useState<SyncResult | null>(null);
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.setEnforcement(s.id, enabled), onSuccess: () => (setResult(null), refresh()) });
  const plan = useMutation({ mutationFn: () => api.syncPlan(s.id), onSuccess: setResult });
  const apply = useMutation({ mutationFn: () => api.syncNow(s.id), onSuccess: (r) => (setResult(r), refresh()) });
  const changes = result?.items.filter((i) => i.action === 'grant' || i.action === 'revoke').length ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Enforcement</CardTitle>
        <CardDescription>
          When on, a payment gives access and an expired or archived member loses it (paused members are left as they are). A daily check also fixes anything changed on the server by hand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <label className="flex items-center gap-2 font-medium">
          <input type="checkbox" className="h-4 w-4" checked={s.enforcementEnabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
          Enforce access on {s.name}
        </label>
        {s.enforcementEnabled && !s.enforcementConfirmed && (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-3">Review the planned changes below and apply them once. Until then nothing is changed on the server automatically.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => plan.mutate()} disabled={plan.isPending}>
            <RefreshCw /> {plan.isPending ? 'Checking…' : 'Preview changes (dry run)'}
          </Button>
          {s.enforcementEnabled && result?.dryRun && (
            <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
              <ShieldCheck /> {s.enforcementConfirmed ? 'Sync now' : `Apply ${changes} change(s)`}
            </Button>
          )}
        </div>
        {(plan.isError || apply.isError || toggle.isError) && <p className="text-destructive">{(plan.error ?? apply.error ?? toggle.error)?.message}</p>}
        {result && (
          <div className="space-y-2">
            {result.error && <p className="text-destructive">The server could not be reached: {result.error}</p>}
            <p className="text-muted-foreground">
              {result.dryRun ? `Dry run: ${changes} change(s) would be made.` : `Applied: ${result.changed} changed, ${result.failed} failed.`}
            </p>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Member</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Now</th>
                    <th className="px-3 py-2 font-medium">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {result.items.map((i) => (
                    <tr key={i.memberId} className={cn(i.action === 'grant' && 'bg-success/5', i.action === 'revoke' && 'bg-warning/5')}>
                      <td className="px-3 py-1.5">
                        <Link className="hover:underline" to={`/members/${i.memberId}`}>
                          {i.displayName}
                        </Link>
                        <div className="text-xs text-muted-foreground">{i.externalUsername ?? i.externalUserId}</div>
                      </td>
                      <td className="px-3 py-1.5">{STATUS_LABEL[i.memberStatus]}</td>
                      <td className="px-3 py-1.5 text-xs">{i.current ? (i.current.state === 'granted' ? `${i.current.libraryIds.length} libraries` : 'no access') : '—'}</td>
                      <td className="px-3 py-1.5">
                        <span className={cn('font-medium', i.action === 'revoke' && 'text-warning', i.action === 'grant' && 'text-success')}>{ACTION_LABEL[i.action]}</span>
                        <div className="text-xs text-muted-foreground">{i.error ? <span className="text-destructive">{i.error}</span> : i.reason}</div>
                        {i.accessState && !result.dryRun && !i.error && <Check className="inline h-3.5 w-3.5 text-success" aria-label="done" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
