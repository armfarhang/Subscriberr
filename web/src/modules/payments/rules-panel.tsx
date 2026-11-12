import type { MEMO_MODES} from '@subscriberr/shared';
import { formatCents, type MatchingRuleView, parseMoneyToCents, type RuleFields, type RuleTestResult } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { MemberPicker } from '@/components/member-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { api, ApiRequestError } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

// Matching rules (Spec §7.4.1): list, add/edit advanced rules, and the rule tester.

export function describeRule(r: MatchingRuleView): string {
  const parts = [`sender is “${r.senderName ?? 'the member’s e-Transfer name'}”`];
  if (r.senderEmail) parts.push(`email is ${r.senderEmail}`);
  if (r.memoMode) parts.push(`message ${r.memoMode === 'regex' ? 'matches' : r.memoMode} “${r.memoValue}”`);
  if (r.amountMinCents !== null || r.amountMaxCents !== null) {
    parts.push(
      r.amountMinCents !== null && r.amountMaxCents !== null
        ? r.amountMinCents === r.amountMaxCents
          ? `amount is ${formatCents(r.amountMinCents)}`
          : `amount between ${formatCents(r.amountMinCents)} and ${formatCents(r.amountMaxCents)}`
        : r.amountMinCents !== null
          ? `amount at least ${formatCents(r.amountMinCents)}`
          : `amount at most ${formatCents(r.amountMaxCents!)}`,
    );
  }
  return `${parts.join(' and ')} → ${r.action === 'assign' ? `assign to ${r.memberName}` : 'send to review'}`;
}

export interface RuleDraft {
  memberId: number | null;
  memberName: string;
  label: string;
  senderName: string;
  senderEmail: string;
  memoMode: '' | (typeof MEMO_MODES)[number];
  memoValue: string;
  amountMin: string;
  amountMax: string;
  priority: string;
  action: 'assign' | 'review';
  enabled: boolean;
}

export const emptyDraft = (init: Partial<RuleDraft> = {}): RuleDraft => ({
  memberId: null,
  memberName: '',
  label: '',
  senderName: '',
  senderEmail: '',
  memoMode: '',
  memoValue: '',
  amountMin: '',
  amountMax: '',
  priority: '100',
  action: 'assign',
  enabled: true,
  ...init,
});

const fromRule = (r: MatchingRuleView): RuleDraft => ({
  memberId: r.memberId,
  memberName: r.memberName,
  label: r.label,
  senderName: r.senderName ?? '',
  senderEmail: r.senderEmail ?? '',
  memoMode: r.memoMode ?? '',
  memoValue: r.memoValue ?? '',
  amountMin: r.amountMinCents === null ? '' : String(r.amountMinCents / 100),
  amountMax: r.amountMaxCents === null ? '' : String(r.amountMaxCents / 100),
  priority: String(r.priority),
  action: r.action,
  enabled: r.enabled,
});

function toFields(d: RuleDraft): RuleFields | string {
  if (!d.memberId) return 'Choose the member';
  const cents = (s: string) => (s.trim() === '' ? null : parseMoneyToCents(s));
  const min = cents(d.amountMin);
  const max = cents(d.amountMax);
  if ((d.amountMin.trim() && min === null) || (d.amountMax.trim() && max === null)) return 'Enter amounts like 15.00';
  return {
    memberId: d.memberId,
    label: d.label.trim() || 'Rule',
    enabled: d.enabled,
    priority: Number(d.priority) || 100,
    senderName: d.senderName.trim() || null,
    senderEmail: d.senderEmail.trim() || null,
    memoMode: d.memoMode || null,
    memoValue: d.memoMode ? d.memoValue : null,
    amountMinCents: min,
    amountMaxCents: max,
    action: d.action,
  };
}

export function RuleForm({ initial, ruleId, fixedMember, onDone }: { initial: RuleDraft; ruleId?: number; fixedMember?: boolean; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [d, setD] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [picking, setPicking] = React.useState(false);
  const save = useMutation({
    mutationFn: (fields: RuleFields) => (ruleId ? api.updateRule(ruleId, fields) : api.createRule(fields)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.payments });
      onDone();
    },
    onError: (err) => setError(err instanceof ApiRequestError && Array.isArray(err.details) ? (err.details as Array<{ message: string }>).map((x) => x.message).join('; ') : err.message),
  });
  const set = (patch: Partial<RuleDraft>) => setD((x) => ({ ...x, ...patch }));
  return (
    <form
      className="space-y-3 rounded-md border bg-muted/20 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = toFields(d);
        if (typeof f === 'string') setError(f);
        else save.mutate(f);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <span className="text-sm font-medium">Member</span>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{d.memberName || <em className="text-muted-foreground">none chosen</em>}</span>
            {!fixedMember && (
              <Button type="button" size="sm" variant="outline" onClick={() => setPicking((p) => !p)}>
                Choose…
              </Button>
            )}
          </div>
          {picking && (
            <MemberPicker
              onPick={(id, name) => {
                set({ memberId: id, memberName: name });
                setPicking(false);
              }}
            />
          )}
        </div>
        <Field id="rule-label" label="Label">
          <Input value={d.label} maxLength={100} placeholder="John (cousin) uses JS-2" onChange={(e) => set({ label: e.target.value })} />
        </Field>
        <Field id="rule-sender" label="Sender name is" hint="Empty = the member’s e-Transfer name.">
          <Input value={d.senderName} maxLength={100} onChange={(e) => set({ senderName: e.target.value })} />
        </Field>
        <Field id="rule-email" label="Sender email is" hint="Optional.">
          <Input type="email" value={d.senderEmail} onChange={(e) => set({ senderEmail: e.target.value })} />
        </Field>
        <div className="grid grid-cols-[8rem_1fr] gap-2">
          <Field id="rule-memo-mode" label="Message">
            <Select value={d.memoMode} onChange={(e) => set({ memoMode: e.target.value as RuleDraft['memoMode'] })}>
              <option value="">any</option>
              <option value="contains">contains</option>
              <option value="equals">equals</option>
              <option value="regex">matches regex</option>
            </Select>
          </Field>
          <Field id="rule-memo" label="Text">
            <Input value={d.memoValue} disabled={!d.memoMode} maxLength={200} placeholder="JS-2" onChange={(e) => set({ memoValue: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field id="rule-min" label="Amount from">
            <Input inputMode="decimal" value={d.amountMin} onChange={(e) => set({ amountMin: e.target.value })} />
          </Field>
          <Field id="rule-max" label="Amount to">
            <Input inputMode="decimal" value={d.amountMax} onChange={(e) => set({ amountMax: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field id="rule-action" label="Then">
            <Select value={d.action} onChange={(e) => set({ action: e.target.value as RuleDraft['action'] })}>
              <option value="assign">Assign to the member</option>
              <option value="review">Send to review</option>
            </Select>
          </Field>
          <Field id="rule-priority" label="Priority" hint="Lower runs first.">
            <Input inputMode="numeric" value={d.priority} onChange={(e) => set({ priority: e.target.value })} />
          </Field>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">A payment without a message never matches a message condition. Regular expressions are case-insensitive and stopped after 50 ms.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {ruleId ? 'Save rule' : 'Add rule'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
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

export function RulesList({ memberId, memberName }: { memberId?: number; memberName?: string }) {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: queryKeys.rules(memberId), queryFn: () => api.rules(memberId) });
  const [editing, setEditing] = React.useState<number | 'new' | null>(null);
  const remove = useMutation({ mutationFn: api.deleteRule, onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.payments }) });
  const items = rules.data?.items ?? [];
  return (
    <div className="space-y-3">
      {items.length === 0 && editing !== 'new' && <p className="text-sm text-muted-foreground">No rules yet.</p>}
      <ul className="space-y-2">
        {items.map((r) =>
          editing === r.id ? (
            <li key={r.id}>
              <RuleForm initial={fromRule(r)} ruleId={r.id} fixedMember={memberId !== undefined} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={r.id} className="flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 font-medium">
                  {r.label}
                  {r.managed && (
                    <Badge variant="neutral" title="Created from the member’s memo code">
                      <Lock className="h-3 w-3" aria-hidden /> memo code
                    </Badge>
                  )}
                  {!r.enabled && <Badge variant="neutral">disabled</Badge>}
                  <span className="text-xs font-normal text-muted-foreground">priority {r.priority}</span>
                </div>
                <div className="text-xs text-muted-foreground">{describeRule(r)}</div>
              </div>
              {!r.managed && (
                <span className="flex gap-1">
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Edit rule ${r.label}`} onClick={() => setEditing(r.id)}>
                    <Pencil />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Delete rule ${r.label}`} disabled={remove.isPending} onClick={() => remove.mutate(r.id)}>
                    <Trash2 />
                  </Button>
                </span>
              )}
            </li>
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <RuleForm initial={emptyDraft(memberId ? { memberId, memberName: memberName ?? '' } : {})} fixedMember={memberId !== undefined} onDone={() => setEditing(null)} />
      ) : (
        <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
          <Plus /> Add rule
        </Button>
      )}
      {remove.isError && <p className="text-sm text-destructive">{remove.error.message}</p>}
    </div>
  );
}

export function RuleTester({ paymentId: initialPaymentId }: { paymentId?: number }) {
  const [sample, setSample] = React.useState({ senderName: '', senderEmail: '', memo: '', amount: '' });
  const [result, setResult] = React.useState<RuleTestResult | null>(null);
  const test = useMutation({ mutationFn: api.testRules, onSuccess: setResult });
  React.useEffect(() => {
    if (initialPaymentId) test.mutate({ paymentId: initialPaymentId });
  }, [initialPaymentId]);
  return (
    <div className="space-y-3">
      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          test.mutate({
            senderName: sample.senderName || undefined,
            senderEmail: sample.senderEmail || undefined,
            memo: sample.memo || undefined,
            amountCents: sample.amount ? (parseMoneyToCents(sample.amount) ?? undefined) : undefined,
          });
        }}
      >
        <Input aria-label="Sample sender name" placeholder="Sender name" value={sample.senderName} onChange={(e) => setSample((s) => ({ ...s, senderName: e.target.value }))} />
        <Input aria-label="Sample sender email" placeholder="Sender email" value={sample.senderEmail} onChange={(e) => setSample((s) => ({ ...s, senderEmail: e.target.value }))} />
        <Input aria-label="Sample message" placeholder="Message (memo)" value={sample.memo} onChange={(e) => setSample((s) => ({ ...s, memo: e.target.value }))} />
        <div className="flex gap-2">
          <Input aria-label="Sample amount" inputMode="decimal" placeholder="Amount" value={sample.amount} onChange={(e) => setSample((s) => ({ ...s, amount: e.target.value }))} />
          <Button type="submit" variant="outline" disabled={test.isPending}>
            <FlaskConical /> Test
          </Button>
        </div>
      </form>
      {result && (
        <div className="space-y-2 rounded-md border p-3 text-sm">
          <div>
            <span className="font-medium">Result: </span>
            {result.decision.status === 'matched'
              ? `assigned to ${result.decision.memberName} (by ${result.decision.matchedBy}${result.decision.ruleId ? ` rule #${result.decision.ruleId}` : ''})`
              : `${result.decision.status.replace('_', ' ')}${result.decision.reason ? `: ${result.decision.reason}` : ''}`}
          </div>
          <div className="text-xs text-muted-foreground">
            Tested: {result.facts.senderName ?? '—'} · {result.facts.senderEmail ?? '—'} · message {result.facts.memo ? `“${result.facts.memo}”` : 'none'} ·{' '}
            {result.facts.amountCents === null ? '—' : formatCents(result.facts.amountCents)}
          </div>
          <ul className="space-y-1">
            {result.rules.map((r) => (
              <li key={r.id} className={r.matches ? 'text-success' : 'text-muted-foreground'}>
                {r.matches ? '✓' : '✗'} {r.label} ({r.memberName}){r.why ? ` — ${r.why}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {test.isError && <p className="text-sm text-destructive">{test.error.message}</p>}
    </div>
  );
}
