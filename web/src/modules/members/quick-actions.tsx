import { type MemberSummary, parseMoneyToCents } from '@subscriberr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellRing, CalendarPlus, MoreHorizontal, Pause, Play, Plus } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

// Members list quick actions (Spec §13.1 #3): record payment, send reminder, extend, pause.
// Everything goes through the same API as the member page (billing ledger, email queue).

const todayIn = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

type Mode = 'menu' | 'pay' | 'extend' | null;

export function QuickActions({ member: m, timeZone, onResult }: { member: MemberSummary; timeZone: string; onResult: (text: string, ok: boolean) => void }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = React.useState<Mode>(null);
  const [amount, setAmount] = React.useState('');
  const [days, setDays] = React.useState('');
  const ref = React.useRef<HTMLDivElement>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  // Fixed position, so the table's scroll container never clips the menu.
  const [pos, setPos] = React.useState<{ top: number; left: number }>({ top: 0, left: 0 });

  React.useEffect(() => {
    if (!mode) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setMode(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMode(null);
    const onScroll = () => setMode(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [mode]);

  const done = (text: string, ok = true) => {
    setMode(null);
    onResult(text, ok);
    void queryClient.invalidateQueries({ queryKey: queryKeys.members });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
  };
  const fail = (e: Error) => onResult(`${m.displayName}: ${e.message}`, false);

  const pay = useMutation({
    mutationFn: (cents: number) => api.recordPayment({ memberId: m.id, amountCents: cents, date: todayIn(timeZone), note: 'Recorded from the members list' }),
    onSuccess: (_p, cents) => done(`Payment of $${(cents / 100).toFixed(2)} recorded for ${m.displayName}.`),
    onError: fail,
  });
  const extend = useMutation({
    mutationFn: (n: number) => api.adjustBalance(m.id, { days: n, note: 'Extended from the members list' }),
    onSuccess: (_d, n) => done(`${m.displayName} extended by ${n} day(s).`),
    onError: fail,
  });
  const remind = useMutation({
    mutationFn: () => api.sendReminder(m.id),
    onSuccess: (r) => done(r.queued ? `Reminder queued for ${m.displayName}.` : `No reminder for ${m.displayName}: ${r.reason ?? 'not queued'}.`, r.queued),
    onError: fail,
  });
  const status = useMutation({
    mutationFn: (action: 'pause' | 'reactivate') => api.memberStatus(m.id, action),
    onSuccess: (_d, action) => done(`${m.displayName} ${action === 'pause' ? 'paused' : 'reactivated'}.`),
    onError: fail,
  });

  const open = (next: Mode) => {
    if (next === 'pay') setAmount(m.terms.planAmountCents.value ? (m.terms.planAmountCents.value / 100).toFixed(2) : '');
    if (next === 'extend') setDays(String(m.terms.planPeriodDays.value));
    setMode(next);
  };
  const busy = pay.isPending || extend.isPending || remind.isPending || status.isPending;
  const item = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50';

  return (
    <div ref={ref} className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Quick actions for ${m.displayName}`} aria-haspopup="menu" aria-expanded={mode !== null}
        ref={button}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          if (r) setPos({ top: Math.min(r.bottom + 4, window.innerHeight - 220), left: Math.max(8, r.right - 256) });
          setMode(mode ? null : 'menu');
        }}
      >
        <MoreHorizontal />
      </Button>
      {mode && (
        <div style={{ top: pos.top, left: pos.left }} className="fixed z-40 w-64 rounded-md border bg-card p-1 text-card-foreground shadow-lg" role={mode === 'menu' ? 'menu' : 'dialog'} aria-label={`Quick actions for ${m.displayName}`}>
          {mode === 'menu' && (
            <>
              <button type="button" role="menuitem" className={item} onClick={() => open('pay')} disabled={m.status === 'archived'}>
                <Plus className="h-4 w-4" aria-hidden /> Record payment…
              </button>
              <button type="button" role="menuitem" className={item} onClick={() => remind.mutate()} disabled={busy || !m.email || !m.paidThrough}>
                <BellRing className="h-4 w-4" aria-hidden /> Send reminder
              </button>
              <button type="button" role="menuitem" className={item} onClick={() => open('extend')} disabled={m.status === 'archived'}>
                <CalendarPlus className="h-4 w-4" aria-hidden /> Extend…
              </button>
              {m.status === 'paused' ? (
                <button type="button" role="menuitem" className={item} onClick={() => status.mutate('reactivate')} disabled={busy}>
                  <Play className="h-4 w-4" aria-hidden /> Reactivate
                </button>
              ) : m.status !== 'archived' ? (
                <button type="button" role="menuitem" className={item} onClick={() => status.mutate('pause')} disabled={busy}>
                  <Pause className="h-4 w-4" aria-hidden /> Pause
                </button>
              ) : null}
            </>
          )}
          {mode === 'pay' && (
            <form
              className="space-y-2 p-2"
              onSubmit={(e) => {
                e.preventDefault();
                const cents = parseMoneyToCents(amount);
                if (cents && cents > 0) pay.mutate(cents);
              }}
            >
              <label className="block text-xs font-medium" htmlFor={`qa-pay-${m.id}`}>
                Amount received today
              </label>
              <Input id={`qa-pay-${m.id}`} autoFocus inputMode="decimal" className="h-8" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <div className="flex gap-1">
                <Button type="submit" size="sm" className="h-7 text-xs" disabled={busy || !(parseMoneyToCents(amount) ?? 0)}>
                  Record and apply
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setMode('menu')}>
                  Back
                </Button>
              </div>
            </form>
          )}
          {mode === 'extend' && (
            <form
              className="space-y-2 p-2"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(days);
                if (Number.isInteger(n) && n > 0) extend.mutate(n);
              }}
            >
              <label className="block text-xs font-medium" htmlFor={`qa-ext-${m.id}`}>
                Add days to the paid-through date
              </label>
              <Input id={`qa-ext-${m.id}`} autoFocus inputMode="numeric" className="h-8" value={days} onChange={(e) => setDays(e.target.value)} />
              <p className="text-xs text-muted-foreground">Recorded as a balance adjustment (no payment).</p>
              <div className="flex gap-1">
                <Button type="submit" size="sm" className="h-7 text-xs" disabled={busy || !(Number(days) > 0)}>
                  Extend
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setMode('menu')}>
                  Back
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
