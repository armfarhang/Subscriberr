import { formatCents, type LedgerEntryView, type MemberDetail, parseMoneyToCents } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Plus, SlidersHorizontal } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { dueLabel } from '@/modules/members/status';

// Member detail → Balance (Spec §8, §13.1 #4): paid-through, credit, and the actions that write
// the billing ledger. Every change is an entry in the history below; nothing edits the balance directly.

type Panel = 'payment' | 'adjust' | 'set' | null;

function useRefresh(memberId: number) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.member(memberId) });
    void queryClient.invalidateQueries({ queryKey: ['ledger', memberId] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.payments });
    void queryClient.invalidateQueries({ queryKey: [...queryKeys.members, 'list'] });
  };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

export function BalanceCard({ member: m, timeZone }: { member: MemberDetail; timeZone: string }) {
  const [panel, setPanel] = React.useState<Panel>(null);
  const [history, setHistory] = React.useState(false);
  const toggle = (p: Panel) => setPanel((x) => (x === p ? null : p));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Balance</CardTitle>
        <CardDescription>Calculated from the payment history.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="divide-y">
          <Row label="Paid through">{formatDate(m.paidThrough)}</Row>
          <Row label="Due">{dueLabel(m)}</Row>
          <Row label="Credit">{formatCents(m.creditCents, m.currency)}</Row>
          <Row label="Last payment">{m.lastPaymentAt ? formatDateTime(m.lastPaymentAt, timeZone) : '—'}</Row>
        </dl>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant={panel === 'payment' ? 'default' : 'outline'} onClick={() => toggle('payment')}>
            <Plus /> Record payment
          </Button>
          <Button size="sm" variant={panel === 'adjust' ? 'default' : 'outline'} onClick={() => toggle('adjust')}>
            <SlidersHorizontal /> Adjust
          </Button>
          <Button size="sm" variant={panel === 'set' ? 'default' : 'ghost'} onClick={() => toggle('set')}>
            Set balance
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setHistory((h) => !h)} aria-expanded={history}>
            <History /> History
          </Button>
        </div>
        {panel === 'payment' && <RecordPaymentForm member={m} timeZone={timeZone} onDone={() => setPanel(null)} />}
        {panel === 'adjust' && <AdjustForm member={m} onDone={() => setPanel(null)} />}
        {panel === 'set' && <SetForm member={m} onDone={() => setPanel(null)} />}
        {history && <LedgerHistory member={m} timeZone={timeZone} />}
      </CardContent>
    </Card>
  );
}

const todayIn = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function FormShell({ children, onSubmit, pending, error, submitLabel, onCancel }: { children: React.ReactNode; onSubmit: () => void; pending: boolean; error: string | null; submitLabel: string; onCancel: () => void }) {
  return (
    <form
      className="space-y-3 rounded-md border bg-muted/20 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {submitLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {error && (
          <span role="alert" className="text-sm text-destructive">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

function RecordPaymentForm({ member: m, timeZone, onDone }: { member: MemberDetail; timeZone: string; onDone: () => void }) {
  const refresh = useRefresh(m.id);
  const [amount, setAmount] = React.useState(m.terms.planAmountCents.value ? (m.terms.planAmountCents.value / 100).toFixed(2) : '');
  const [date, setDate] = React.useState(todayIn(timeZone));
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const save = useMutation({
    mutationFn: api.recordPayment,
    onSuccess: () => {
      refresh();
      onDone();
    },
    onError: (e) => setError(e.message),
  });
  return (
    <FormShell
      submitLabel="Record and apply"
      pending={save.isPending}
      error={error}
      onCancel={onDone}
      onSubmit={() => {
        const cents = parseMoneyToCents(amount);
        if (!cents || cents <= 0) return setError('Enter an amount such as 15.00');
        save.mutate({ memberId: m.id, amountCents: cents, date, note: note.trim() || null });
      }}
    >
      <p className="text-xs text-muted-foreground">For money that did not come as a readable e-Transfer (cash, another transfer). It is applied exactly like an e-Transfer.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="pay-amount" label="Amount">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field id="pay-date" label="Received on">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field id="pay-note" label="Note" className="sm:col-span-2">
          <Input value={note} maxLength={500} placeholder="Cash at the cottage" onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </FormShell>
  );
}

function AdjustForm({ member: m, onDone }: { member: MemberDetail; onDone: () => void }) {
  const refresh = useRefresh(m.id);
  const [days, setDays] = React.useState('');
  const [credit, setCredit] = React.useState('');
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.adjustBalance>[1]) => api.adjustBalance(m.id, body),
    onSuccess: () => {
      refresh();
      onDone();
    },
    onError: (e) => setError(e.message),
  });
  return (
    <FormShell
      submitLabel="Apply adjustment"
      pending={save.isPending}
      error={error}
      onCancel={onDone}
      onSubmit={() => {
        const d = days.trim() === '' ? 0 : Number(days);
        const c = credit.trim() === '' ? 0 : parseMoneyToCents(credit);
        if (!Number.isInteger(d)) return setError('Days must be a whole number (negative to shorten)');
        if (c === null) return setError('Enter credit like 5.00 or -5.00');
        if (!note.trim()) return setError('Add a note: it is kept in the history');
        save.mutate({ days: d, creditCents: c, note: note.trim() });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="adj-days" label="Days (+/−)" hint="Moves the paid-through date.">
          <Input inputMode="numeric" placeholder="7" value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
        <Field id="adj-credit" label="Credit (+/−)" hint={`Now ${formatCents(m.creditCents, m.currency)}.`}>
          <Input inputMode="decimal" placeholder="-5.00" value={credit} onChange={(e) => setCredit(e.target.value)} />
        </Field>
        <Field id="adj-note" label="Why" className="sm:col-span-2">
          <Input value={note} maxLength={500} placeholder="Server was down for a week" onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </FormShell>
  );
}

function SetForm({ member: m, onDone }: { member: MemberDetail; onDone: () => void }) {
  const refresh = useRefresh(m.id);
  const [paidThrough, setPaidThrough] = React.useState(m.paidThrough ?? '');
  const [credit, setCredit] = React.useState((m.creditCents / 100).toFixed(2));
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.setBalance>[1]) => api.setBalance(m.id, body),
    onSuccess: () => {
      refresh();
      onDone();
    },
    onError: (e) => setError(e.message),
  });
  return (
    <FormShell
      submitLabel="Set balance"
      pending={save.isPending}
      error={error}
      onCancel={onDone}
      onSubmit={() => {
        const c = parseMoneyToCents(credit || '0');
        if (c === null || c < 0) return setError('Credit must be 0.00 or more');
        if (!note.trim()) return setError('Add a note: it is kept in the history');
        save.mutate({ ...(paidThrough && paidThrough !== m.paidThrough ? { paidThrough } : {}), ...(c !== m.creditCents ? { creditCents: c } : {}), note: note.trim() });
      }}
    >
      <p className="text-xs text-muted-foreground">For opening balances and corrections: sets absolute values. Later payments stack on top of them.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="set-pt" label="Paid through">
          <Input type="date" value={paidThrough} onChange={(e) => setPaidThrough(e.target.value)} />
        </Field>
        <Field id="set-credit" label="Credit">
          <Input inputMode="decimal" value={credit} onChange={(e) => setCredit(e.target.value)} />
        </Field>
        <Field id="set-note" label="Why" className="sm:col-span-2">
          <Input value={note} maxLength={500} placeholder="Opening balance from the old spreadsheet" onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </FormShell>
  );
}

const KIND_LABEL: Record<LedgerEntryView['kind'], string> = { payment: 'Payment', manual_set: 'Balance set', manual_adjust: 'Adjustment', void: 'Reversal' };

function describeEntry(e: LedgerEntryView, currency: string): string {
  const o = e.output;
  if (e.kind === 'payment') {
    const base = `${formatCents(e.amountCents, currency)}: `;
    if (e.reversed) return `${base}voided`;
    if (o.periodsApplied === 0) return `${base}not enough for a period, held as credit`;
    return `${base}${o.periodsApplied} period${o.periodsApplied === 1 ? '' : 's'}${o.forgivenCents > 0 ? ` (${formatCents(o.forgivenCents, currency)} short, within tolerance)` : ''}`;
  }
  if (e.kind === 'void') return `reverses entry #${e.reversesEntryId}`;
  return e.note ?? '';
}

function LedgerHistory({ member: m, timeZone }: { member: MemberDetail; timeZone: string }) {
  const ledger = useQuery({ queryKey: ['ledger', m.id, m.updatedAt], queryFn: () => api.ledger(m.id) });
  if (!ledger.data) return <div className="h-16 animate-pulse rounded bg-muted" />;
  if (ledger.data.items.length === 0) return <p className="text-sm text-muted-foreground">No balance history yet.</p>;
  return (
    <ol className="space-y-1.5 text-sm">
      {ledger.data.items.map((e) => (
        <li key={e.id} className={e.reversed ? 'text-muted-foreground line-through' : undefined}>
          <div className="flex flex-wrap justify-between gap-2">
            <span className="font-medium">
              {KIND_LABEL[e.kind]} <span className="font-normal">{describeEntry(e, m.currency)}</span>
            </span>
            <span className="text-xs text-muted-foreground">{formatDateTime(e.effectiveAt, timeZone)}</span>
          </div>
          {e.kind !== 'void' && !e.reversed && (
            <div className="text-xs text-muted-foreground">
              → paid through {formatDate(e.output.paidThroughAfter)}, credit {formatCents(e.output.creditAfterCents, m.currency)} · {e.createdBy.replace(/^admin:/, '')}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
