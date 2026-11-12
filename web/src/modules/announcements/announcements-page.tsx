import { type Audience, type AnnouncementDraft, type AnnouncementView, MEMBER_STATUSES, type MemberStatus } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bold, Italic, Link2, List, Plus, Send, Trash2, X } from 'lucide-react';
import * as React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MemberPicker } from '@/components/member-picker';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { api, ApiRequestError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { STATUS_LABEL } from '@/modules/members/status';

const KEY = ['announcements'] as const;
const STATUS_VARIANT: Record<AnnouncementView['status'], BadgeProps['variant']> = { draft: 'neutral', sending: 'warning', sent: 'success', cancelled: 'neutral' };

/** Announcements (Spec §9.4): composer, audience, preview, confirm, progress and history. */
export function AnnouncementsPage({ timeZone }: { timeZone: string }) {
  const list = useQuery({ queryKey: KEY, queryFn: api.announcements, refetchInterval: 30_000 });
  // Members list → "Announcement to selected" arrives with the picked members in the router state.
  const location = useLocation();
  const navigate = useNavigate();
  const fromList = (location.state as { picked?: Picked[] } | null)?.picked;
  const [prefill] = React.useState<Picked[] | null>(fromList && fromList.length > 0 ? fromList : null);
  React.useEffect(() => {
    if (fromList) navigate('.', { replace: true, state: null });
  }, [fromList, navigate]);
  const [editing, setEditing] = React.useState<AnnouncementView | 'new' | null>(prefill ? 'new' : null);
  const [viewing, setViewing] = React.useState<number | null>(null);
  if (editing)
    return <Composer initial={editing === 'new' ? null : editing} picked={editing === 'new' ? prefill : null} defaultFooter={list.data?.footer ?? ''} onClose={() => setEditing(null)} />;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">Write once, send to many: each member gets their own copy in your template. Large sends spread over several days within the daily limit.</p>
        <Button onClick={() => setEditing('new')}>
          <Plus /> New announcement
        </Button>
      </div>
      {list.data && list.data.items.length === 0 && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No announcements yet.</p>}
      <ul className="space-y-2">
        {list.data?.items.map((a) => (
          <li key={a.id} className="rounded-lg border bg-card">
            <button type="button" className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left text-sm" onClick={() => (a.status === 'draft' ? setEditing(a) : setViewing(viewing === a.id ? null : a.id))}>
              <span className="min-w-0 flex-1 truncate font-medium">{a.subject}</span>
              {a.progress && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {a.progress.sent} of {a.progress.total} sent{a.progress.queued ? ` · ${a.progress.queued} queued` : ''}
                  {a.progress.failed ? ` · ${a.progress.failed} failed` : ''}
                </span>
              )}
              <span className="text-xs text-muted-foreground">{formatDateTime(a.createdAt, timeZone)}</span>
              <Badge variant={STATUS_VARIANT[a.status]}>{a.status === 'draft' ? 'Draft' : a.status}</Badge>
            </button>
            {viewing === a.id && <Progress announcement={a} timeZone={timeZone} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Progress({ announcement: a, timeZone }: { announcement: AnnouncementView; timeZone: string }) {
  const queryClient = useQueryClient();
  const recipients = useQuery({ queryKey: [...KEY, a.id, 'recipients'], queryFn: () => api.announcementRecipients(a.id), refetchInterval: 30_000 });
  const status = useQuery({ queryKey: ['email', 'status'], queryFn: api.emailStatus });
  const cancel = useMutation({ mutationFn: () => api.cancelAnnouncement(a.id), onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }) });
  const retry = useMutation({ mutationFn: api.retryEmail, onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }) });
  const p = a.progress!;
  const pct = p.total ? Math.round(((p.sent + p.failed + p.cancelled) / p.total) * 100) : 100;
  return (
    <div className="space-y-3 border-t px-4 py-3 text-sm">
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Announcement progress">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      {a.status === 'sending' && status.data && (
        <p className="text-xs text-muted-foreground">
          {status.data.sentLast24h} of {status.data.cap} daily emails used · {p.queued} of this announcement queued
          {status.data.resumesAt ? `, resuming around ${formatDateTime(status.data.resumesAt, timeZone)}` : ', sending now'}.
        </p>
      )}
      <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
        {recipients.data?.items.map((r) => (
          <li key={r.emailId} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate">{r.displayName ?? r.email}</span>
            <span className="text-xs text-muted-foreground">{r.sentAt ? formatDateTime(r.sentAt, timeZone) : r.error ?? ''}</span>
            <Badge variant={r.status === 'sent' ? 'success' : r.status === 'failed' ? 'destructive' : 'neutral'}>{r.status}</Badge>
            {r.status === 'failed' && (
              <Button size="sm" variant="ghost" className="h-6" onClick={() => retry.mutate(r.emailId)}>
                Retry
              </Button>
            )}
          </li>
        ))}
      </ul>
      {a.status === 'sending' && (
        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
          <X /> Stop sending the remaining {p.queued}
        </Button>
      )}
    </div>
  );
}

function RichText({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = value;
    // only on mount: the editor owns its content afterwards
     
  }, []);
  const cmd = (command: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    onChange(ref.current?.innerHTML ?? '');
  };
  return (
    <div className="rounded-md border">
      <div className="flex gap-1 border-b p-1" role="toolbar" aria-label="Formatting">
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Bold" onClick={() => cmd('bold')}>
          <Bold />
        </Button>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Italic" onClick={() => cmd('italic')}>
          <Italic />
        </Button>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Bulleted list" onClick={() => cmd('insertUnorderedList')}>
          <List />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label="Link"
          onClick={() => {
            const url = window.prompt('Link address (https://…)');
            if (url && /^(https?:|mailto:)/i.test(url)) cmd('createLink', url);
          }}
        >
          <Link2 />
        </Button>
      </div>
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        contentEditable
        suppressContentEditableWarning
        className="prose-sm min-h-[10rem] px-3 py-2 text-sm outline-none [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5"
        onInput={(e) => onChange((e.target as HTMLDivElement).innerHTML)}
      />
    </div>
  );
}

type AudienceType = Audience['type'];
const AUDIENCE_LABEL: Record<AudienceType, string> = {
  active: 'Members with access (active or in grace)',
  non_archived: 'Everyone except archived',
  status: 'By status',
  server: 'Members of a server',
  expiring: 'Due within N days',
  picked: 'Hand-picked members',
};

type Picked = { id: number; name: string };

function AudienceForm({ audience, onChange, initialPicked }: { audience: Audience; onChange: (a: Audience) => void; initialPicked?: Picked[] | null }) {
  const servers = useQuery({ queryKey: ['media', 'servers'], queryFn: api.servers, retry: false });
  const [picking, setPicking] = React.useState(false);
  const [picked, setPicked] = React.useState<Picked[]>(initialPicked ?? []);
  const types = (Object.keys(AUDIENCE_LABEL) as AudienceType[]).filter((t) => t !== 'server' || (servers.data?.items.length ?? 0) > 0);
  const setType = (type: AudienceType) => {
    if (type === 'status') onChange({ type, statuses: ['active', 'grace'] });
    else if (type === 'server') onChange({ type, serverId: servers.data!.items[0]!.id });
    else if (type === 'expiring') onChange({ type, days: 7 });
    else if (type === 'picked') onChange({ type, memberIds: picked.length ? picked.map((p) => p.id) : [0] });
    else onChange({ type });
  };
  return (
    <div className="space-y-3">
      <Select aria-label="Audience" value={audience.type} onChange={(e) => setType(e.target.value as AudienceType)}>
        {types.map((t) => (
          <option key={t} value={t}>
            {AUDIENCE_LABEL[t]}
          </option>
        ))}
      </Select>
      {audience.type === 'status' && (
        <div className="flex flex-wrap gap-3 text-sm">
          {MEMBER_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={audience.statuses.includes(s)}
                onChange={(e) => {
                  const next = e.target.checked ? [...audience.statuses, s] : audience.statuses.filter((x) => x !== s);
                  if (next.length > 0) onChange({ type: 'status', statuses: next as MemberStatus[] });
                }}
              />
              {STATUS_LABEL[s]}
            </label>
          ))}
        </div>
      )}
      {audience.type === 'server' && (
        <Select aria-label="Server" value={String(audience.serverId)} onChange={(e) => onChange({ type: 'server', serverId: Number(e.target.value) })}>
          {servers.data?.items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      )}
      {audience.type === 'expiring' && (
        <label className="flex items-center gap-2 text-sm">
          Due within
          <Input className="w-20" inputMode="numeric" value={String(audience.days)} onChange={(e) => onChange({ type: 'expiring', days: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })} aria-label="Days" />
          days
        </label>
      )}
      {audience.type === 'picked' && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {picked.map((p) => (
              <Badge key={p.id} variant="neutral" className="gap-1">
                {p.name}
                <button
                  type="button"
                  aria-label={`Remove ${p.name}`}
                  onClick={() => {
                    const next = picked.filter((x) => x.id !== p.id);
                    setPicked(next);
                    onChange({ type: 'picked', memberIds: next.length ? next.map((x) => x.id) : [0] });
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            <Button type="button" size="sm" variant="outline" onClick={() => setPicking((x) => !x)}>
              <Plus /> Add member
            </Button>
          </div>
          {picking && (
            <MemberPicker
              onPick={(id, name) => {
                if (picked.some((p) => p.id === id)) return;
                const next = [...picked, { id, name }];
                setPicked(next);
                onChange({ type: 'picked', memberIds: next.map((x) => x.id) });
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Composer({ initial, picked, defaultFooter, onClose }: { initial: AnnouncementView | null; picked?: Picked[] | null; defaultFooter: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [id, setId] = React.useState<number | null>(initial?.id ?? null);
  const [subject, setSubject] = React.useState(initial?.subject ?? '');
  const [body, setBody] = React.useState(initial?.body ?? '');
  const [footer, setFooter] = React.useState(initial?.footer ?? defaultFooter.replace(/<[^>]+>/g, ''));
  const [audience, setAudience] = React.useState<Audience>(initial?.audience ?? (picked ? { type: 'picked', memberIds: picked.map((p) => p.id) } : { type: 'active' }));
  const [confirming, setConfirming] = React.useState(false);
  const draft: AnnouncementDraft = { subject, body, audience, footer: footer.trim() ? `<p>${footer.trim().replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</p>` : '' };
  const validAudience = !(audience.type === 'picked' && audience.memberIds.includes(0));
  const recipients = useQuery({ queryKey: [...KEY, 'recipients', audience], queryFn: () => api.audienceRecipients(audience), enabled: validAudience });
  const [debounced, setDebounced] = React.useState(draft);
  React.useEffect(() => {
    const t = window.setTimeout(() => setDebounced(draft), 400);
    return () => window.clearTimeout(t);
     
  }, [subject, body, footer, JSON.stringify(audience)]);
  const preview = useQuery({ queryKey: [...KEY, 'preview', debounced], queryFn: () => api.previewAnnouncement(debounced), enabled: Boolean(debounced.subject.trim()) && validAudience, retry: false, placeholderData: (p) => p });

  const save = useMutation({
    mutationFn: () => (id ? api.updateAnnouncement(id, draft) : api.createAnnouncement(draft)),
    onSuccess: (a) => {
      setId(a.id);
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  const sendIt = useMutation({
    mutationFn: async (count: number) => {
      const saved = id ? await api.updateAnnouncement(id, draft) : await api.createAnnouncement(draft);
      setId(saved.id);
      return api.sendAnnouncement(saved.id, count);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAnnouncement(id!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  const included = recipients.data?.items.filter((r) => !r.excluded) ?? [];
  const excluded = recipients.data?.items.filter((r) => r.excluded) ?? [];
  const error = save.error ?? sendIt.error ?? preview.error;
  const problems = error instanceof ApiRequestError && Array.isArray(error.details) ? (error.details as Array<{ message: string }>).map((d) => d.message) : error ? [error.message] : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-xl font-semibold">{id ? 'Edit announcement' : 'New announcement'}</h2>
        <Button variant="ghost" onClick={onClose}>
          Back
        </Button>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-2">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Message</CardTitle>
              <CardDescription>Variables work here, e.g. {'{{member.display_name}}'}, {'{{paid_through}}'}, {'{{amount_expected}}'}.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field id="ann-subject" label="Subject">
                <Input value={subject} maxLength={200} placeholder="New 4K library this weekend" onChange={(e) => setSubject(e.target.value)} />
              </Field>
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Text</span>
                <RichText value={body} onChange={setBody} />
              </div>
              <Field id="ann-footer" label="Footer" hint="Added under every announcement; remembered for next time.">
                <Input value={footer} maxLength={500} placeholder="Questions? Just reply to this email." onChange={(e) => setFooter(e.target.value)} />
              </Field>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Audience</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <AudienceForm audience={audience} onChange={setAudience} initialPicked={picked} />
              {recipients.data && (
                <details className="text-sm">
                  <summary className="cursor-pointer">
                    <strong>{included.length}</strong> recipient(s){excluded.length > 0 && `, ${excluded.length} excluded`} (show)
                  </summary>
                  <ul className="mt-2 max-h-56 divide-y overflow-y-auto rounded-md border">
                    {recipients.data.items.map((r) => (
                      <li key={r.memberId} className={cn('flex justify-between gap-2 px-3 py-1', r.excluded && 'text-muted-foreground line-through')}>
                        <span>{r.displayName}</span>
                        <span className="text-xs">{r.excluded ?? r.email}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </CardContent>
          </Card>
          {problems.length > 0 && (
            <ul role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {confirming ? (
              <>
                <span className="w-full text-sm">
                  Send “{subject}” to <strong>{included.length}</strong> member(s)? Each gets their own email; this cannot be undone (remaining copies can be stopped).
                </span>
                <Button onClick={() => sendIt.mutate(included.length)} disabled={sendIt.isPending}>
                  <Send /> Yes, send to {included.length}
                </Button>
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => setConfirming(true)} disabled={!subject.trim() || included.length === 0 || !validAudience}>
                  <Send /> Send…
                </Button>
                <Button variant="outline" onClick={() => save.mutate()} disabled={!subject.trim() || !validAudience || save.isPending}>
                  Save draft
                </Button>
                {save.isSuccess && <span className="text-sm text-success">Saved</span>}
                {id && (
                  <Button variant="ghost" className="ml-auto text-destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
                    <Trash2 /> Delete draft
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
        <Card className="xl:sticky xl:top-16 xl:self-start">
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>{preview.data ? `Subject: ${preview.data.subject}` : 'Shown for the first recipient, in your active template.'}</CardDescription>
          </CardHeader>
          <CardContent>
            <iframe title="Announcement preview" sandbox="" srcDoc={preview.data?.html ?? ''} className="h-[32rem] w-full rounded-md border bg-white" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
