import type { PAYMENT_TABS} from '@subscriberr/shared';
import { type PaymentView } from '@subscriberr/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Search, ShieldAlert, UserPlus } from 'lucide-react';
import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MemberPicker } from '@/components/member-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatAge, formatDate, formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { paymentAmount, PaymentStatusBadge } from './payment-status';
import { RulesList, RuleTester } from './rules-panel';

type Tab = (typeof PAYMENT_TABS)[number] | 'rules';
const TAB_LABEL: Record<Tab, string> = { all: 'All payments', review: 'Review', awaiting: 'Awaiting deposit', rules: 'Matching rules' };
const PAGE_SIZE = 50;

/** Payments (Spec §13.1 #6): list, Review tab, Awaiting deposit tab, and matching rules. */
export function PaymentsPage({ timeZone }: { timeZone: string }) {
  const [params, setParams] = useSearchParams();
  const tab = (['all', 'review', 'awaiting', 'rules'] as const).find((t) => t === params.get('tab')) ?? 'all';
  const [q, setQ] = React.useState('');
  const [page, setPage] = React.useState(1);
  const query = { tab: tab === 'rules' ? 'all' : tab, q: q.trim() || undefined, page, pageSize: PAGE_SIZE } as const;
  const list = useQuery({ queryKey: queryKeys.paymentList(query), queryFn: () => api.payments(query), placeholderData: keepPreviousData, enabled: tab !== 'rules' });
  const counts = list.data?.counts;
  const setTab = (t: Tab) => {
    setPage(1);
    setParams(t === 'all' ? {} : { tab: t }, { replace: true });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-semibold tracking-tight lg:hidden">Payments</h2>
          <p className="text-sm text-muted-foreground">Every e-Transfer notice the app has read, and the ones waiting for your decision.</p>
        </div>
        <ScanButton timeZone={timeZone} />
      </div>

      <div role="tablist" aria-label="Payments" className="flex flex-wrap gap-1.5 border-b pb-2">
        {(['all', 'review', 'awaiting', 'rules'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn('rounded-md px-3 py-1.5 text-sm font-medium transition-colors', tab === t ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}
          >
            {TAB_LABEL[t]}
            {t === 'review' && counts && counts.review > 0 && <Badge variant="warning" className="ml-1.5">{counts.review}</Badge>}
            {t === 'awaiting' && counts && counts.awaiting > 0 && <Badge variant="neutral" className="ml-1.5">{counts.awaiting}</Badge>}
          </button>
        ))}
      </div>

      {tab === 'rules' ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>All matching rules</CardTitle>
              <CardDescription>Tell apart people who share an e-Transfer name, or send special cases to review. Rules from memo codes are managed on the member.</CardDescription>
            </CardHeader>
            <CardContent>
              <RulesList />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Rule tester</CardTitle>
              <CardDescription>Type what a payment would look like and see which member it goes to, and why.</CardDescription>
            </CardHeader>
            <CardContent>
              <RuleTester />
            </CardContent>
          </Card>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[14rem] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                type="search"
                aria-label="Search payments"
                placeholder="Search sender, member, reference, message…"
                className="pl-9"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            {tab === 'review' && <RerunButton />}
          </div>
          {tab === 'awaiting' && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
              These transfers are not in your account yet: deposit them at your bank before they expire. They do not extend anyone’s access until they are marked as deposited.
            </p>
          )}
          {list.isPending && <div className="h-48 animate-pulse rounded-lg bg-muted" />}
          {list.isError && <p className="text-sm text-destructive">Could not load payments: {list.error.message}</p>}
          {list.data && list.data.items.length === 0 && (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              {tab === 'review' ? 'Nothing waiting for a decision.' : tab === 'awaiting' ? 'No transfers awaiting deposit.' : 'No payments yet. Use “Scan now” to read the mailbox.'}
            </p>
          )}
          <ul className="space-y-2">
            {list.data?.items.map((p) => (
              <PaymentRow key={p.id} payment={p} timeZone={timeZone} defaultOpen={tab === 'review'} />
            ))}
          </ul>
          {list.data && list.data.total > PAGE_SIZE && (
            <div className="flex items-center justify-end gap-1 text-sm text-muted-foreground">
              <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                <ChevronLeft />
              </Button>
              <span className="px-2 tabular-nums">
                Page {page} of {Math.ceil(list.data.total / PAGE_SIZE)}
              </span>
              <Button variant="outline" size="icon" aria-label="Next page" disabled={page * PAGE_SIZE >= list.data.total} onClick={() => setPage(page + 1)}>
                <ChevronRight />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ScanButton({ timeZone }: { timeZone: string }) {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: queryKeys.scanState, queryFn: api.scanState, refetchInterval: 60_000 });
  const scan = useMutation({
    mutationFn: api.scanNow,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.payments });
      void queryClient.invalidateQueries({ queryKey: queryKeys.members });
    },
  });
  const s = state.data;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" onClick={() => scan.mutate()} disabled={scan.isPending || s?.running}>
        <RefreshCw className={cn(scan.isPending && 'animate-spin')} /> {scan.isPending ? 'Scanning…' : 'Scan now'}
      </Button>
      <span className="text-xs text-muted-foreground" title={s?.lastScanAt ? formatDateTime(s.lastScanAt, timeZone) : undefined}>
        {scan.isError ? (
          <span className="text-destructive">{scan.error.message}</span>
        ) : scan.data ? (
          `Read ${scan.data.stats.messages} message(s), ${scan.data.stats.stored} new`
        ) : s?.lastError ? (
          <span className="text-destructive">Last scan failed: {s.lastError}</span>
        ) : (
          `Last scan ${formatAge(s?.lastScanAt)}`
        )}
      </span>
    </div>
  );
}

function RerunButton() {
  const queryClient = useQueryClient();
  const rerun = useMutation({ mutationFn: api.rerunReview, onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.payments }) });
  return (
    <span className="flex items-center gap-2 text-sm">
      <Button variant="outline" onClick={() => rerun.mutate()} disabled={rerun.isPending} title="Match unresolved items again, e.g. after adding a rule or an alias">
        Re-run against rules
      </Button>
      {rerun.data && (
        <span className="text-muted-foreground">
          {rerun.data.matched} of {rerun.data.checked} matched
        </span>
      )}
    </span>
  );
}

function PaymentRow({ payment: p, timeZone, defaultOpen }: { payment: PaymentView; timeZone: string; defaultOpen: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen && p.inReview);
  return (
    <li className={cn('rounded-lg border bg-card', p.inReview && 'border-warning/50')}>
      <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left text-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="w-24 shrink-0 text-xs text-muted-foreground">{formatDate(p.receivedAt.slice(0, 10))}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{p.senderName ?? 'Unknown sender'}</span>
        <span className="tabular-nums">{paymentAmount(p)}</span>
        <span className="hidden min-w-[8rem] truncate text-muted-foreground sm:inline">{p.memberName ? `→ ${p.memberName}` : '—'}</span>
        <PaymentStatusBadge status={p.status} />
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && <PaymentDetail payment={p} timeZone={timeZone} />}
    </li>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function PaymentDetail({ payment: p, timeZone }: { payment: PaymentView; timeZone: string }) {
  return (
    <div className="space-y-3 border-t px-3 py-3 text-sm">
      {p.reviewReason && (
        <p className="flex gap-2 rounded-md bg-warning/10 p-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden /> {p.reviewReason}
        </p>
      )}
      <dl className="grid gap-1.5 sm:grid-cols-2">
        <Detail label="Received">{formatDateTime(p.receivedAt, timeZone)}</Detail>
        <Detail label="Kind">{p.messageType === 'autodeposit' ? 'Auto-deposit' : p.messageType === 'awaiting_deposit' ? 'Awaiting deposit' : 'Manual'}</Detail>
        <Detail label="Sender email">{p.senderEmail ?? '—'}</Detail>
        <Detail label="Reference">{p.reference ?? '—'}</Detail>
        {p.memo && <Detail label="Message">“{p.memo}”</Detail>}
        {p.expiresOn && <Detail label="Expires">{formatDate(p.expiresOn)}</Detail>}
        <Detail label="Member">{p.memberId ? <Link className="underline underline-offset-2" to={`/members/${p.memberId}`}>{p.memberName}</Link> : '—'}</Detail>
        <Detail label="Matched by">{p.matchedBy ? `${p.matchedBy}${p.matchedRuleId ? ` (rule #${p.matchedRuleId})` : ''}` : '—'}</Detail>
        {p.auth && (
          <Detail label="Authenticity">
            {p.auth.ok ? `Verified by Gmail (DKIM ${p.auth.dkim}${p.auth.dmarc ? `, DMARC ${p.auth.dmarc}` : ''})` : <span className="text-destructive">Failed: {p.auth.reason}</span>}
          </Detail>
        )}
        {p.resolvedAt && <Detail label="Resolved">{`${formatDateTime(p.resolvedAt, timeZone)} by ${p.resolvedBy?.replace(/^admin:/, '')}`}</Detail>}
      </dl>
      {(p.inReview || (p.status === 'pending_deposit' && !p.memberId)) && <ResolveActions payment={p} />}
    </div>
  );
}

function ResolveActions({ payment: p }: { payment: PaymentView }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [picking, setPicking] = React.useState(false);
  const [remember, setRemember] = React.useState(true);
  const [verified, setVerified] = React.useState(false);
  const [showTester, setShowTester] = React.useState(false);
  const resolve = useMutation({
    mutationFn: (body: Parameters<typeof api.resolvePayment>[1]) => api.resolvePayment(p.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.payments });
      void queryClient.invalidateQueries({ queryKey: queryKeys.members });
    },
  });
  const rejected = p.status === 'rejected';
  const assign = (memberId: number) => resolve.mutate({ action: 'assign', memberId, rememberSender: remember, verifiedInBank: verified });
  const createParams = new URLSearchParams({ payment: String(p.id), ...(p.senderName ? { etransferName: p.senderName, displayName: p.senderName } : {}), ...(p.senderEmail ? { email: p.senderEmail } : {}) });

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      {rejected && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
          <span>
            <ShieldAlert className="mr-1 inline h-4 w-4 text-destructive" aria-hidden />I checked my bank account and this money really arrived.
          </span>
        </label>
      )}
      {p.status !== 'duplicate' && p.amountCents !== null && (
        <>
          <div className="flex flex-wrap gap-2">
            {p.proposal && (
              <Button size="sm" disabled={resolve.isPending || (rejected && !verified)} onClick={() => assign(p.proposal!.memberId)}>
                Assign to {p.proposal.displayName}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={rejected && !verified} onClick={() => setPicking((x) => !x)}>
              Choose member…
            </Button>
            <Button size="sm" variant="outline" disabled={rejected && !verified} onClick={() => navigate(`/members/new?${createParams.toString()}`)}>
              <UserPlus /> New member from this payment
            </Button>
          </div>
          {picking && <MemberPicker onPick={(id) => assign(id)} />}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember this sender (adds the name and email as aliases, so the next payment matches by itself)
          </label>
        </>
      )}
      {p.inReview && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ action: 'dismiss' })}>
            Dismiss (keep for the record)
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowTester((x) => !x)}>
            Why? (rule tester)
          </Button>
        </div>
      )}
      {showTester && <RuleTester paymentId={p.id} />}
      {resolve.isError && <p className="text-sm text-destructive">{resolve.error.message}</p>}
    </div>
  );
}
