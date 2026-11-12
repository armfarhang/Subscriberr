import type { TimelineEvent } from '@subscriberr/shared';
import { formatCents } from '@subscriberr/shared';
import { formatDateTime } from '@/lib/format';
import { STATUS_LABEL } from './status';

// Member timeline (Spec §13.1 #4). Fed by the audit log; payments, emails and access changes
// join it in later milestones.

const FIELD_LABEL: Record<string, string> = {
  displayName: 'display name',
  etransferName: 'e-Transfer name',
  paymentMemoCode: 'memo code',
  email: 'email',
  notes: 'notes',
  planAmountCents: 'plan amount',
  planPeriodDays: 'period',
  currency: 'currency',
  toleranceCents: 'tolerance',
  graceDays: 'grace days',
  remindersEnabled: 'reminders',
  emailsEnabled: 'emails',
};

function show(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return field.endsWith('Cents') || field.endsWith('Days') ? 'default' : 'empty';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (field.endsWith('Cents') && typeof v === 'number') return formatCents(v);
  return String(v);
}

const fromImport = (d: Record<string, unknown>) => (typeof d.importBatchId === 'number' ? ` (CSV import #${d.importBatchId})` : '');

export function describeEvent(e: TimelineEvent): string {
  const d = (e.details ?? {}) as Record<string, unknown>;
  switch (e.action) {
    case 'member.created':
      return `Member added${fromImport(d)}`;
    case 'member.updated': {
      const changes = (d.changes ?? {}) as Record<string, { from?: unknown; to?: unknown; changed?: boolean }>;
      const parts = Object.entries(changes).map(([field, c]) => {
        const label = FIELD_LABEL[field] ?? field;
        return c.changed ? `${label} edited` : `${label}: ${show(field, c.from)} → ${show(field, c.to)}`;
      });
      return `${parts.length > 0 ? `Changed ${parts.join('; ')}` : 'Details changed'}${fromImport(d)}`;
    }
    case 'member.status_changed':
      return `Status: ${STATUS_LABEL[d.from as keyof typeof STATUS_LABEL] ?? String(d.from)} → ${STATUS_LABEL[d.to as keyof typeof STATUS_LABEL] ?? String(d.to)}`;
    case 'member.alias_added':
      return `${d.kind === 'email' ? 'Email' : 'Name'} alias added: ${String(d.value)}${d.source === 'learned' ? ' (learned from a payment)' : ''}`;
    case 'ledger.manual_set': {
      const set = [d.paidThrough ? `paid through ${String(d.paidThrough)}` : null, typeof d.creditCents === 'number' ? `credit ${formatCents(d.creditCents)}` : null].filter(Boolean).join(', ');
      return `Balance set: ${set || 'no change'}${d.note ? ` (${String(d.note)})` : ''}`;
    }
    case 'ledger.voided':
      return `Balance entry reversed${d.note ? ` (${String(d.note)})` : ''}`;
    case 'member.server_linked':
      return `Linked to media-server user ${String(d.username ?? d.externalUserId)}${fromImport(d)}`;
    case 'member.server_link_restored':
      return `Media-server link put back as before${fromImport(d)}`;
    case 'member.deleted':
      return 'Member deleted';
    case 'member.alias_removed':
      return `${d.kind === 'email' ? 'Email' : 'Name'} alias removed: ${String(d.value)}`;
    default:
      return e.action;
  }
}

export function Timeline({ events, timeZone }: { events: TimelineEvent[]; timeZone: string }) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">Nothing yet.</p>;
  return (
    <ol className="relative space-y-4 border-l pl-5">
      {events.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute -left-[1.6rem] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary" aria-hidden />
          <div className="text-sm">{describeEvent(e)}</div>
          <div className="text-xs text-muted-foreground">
            {formatDateTime(e.at, timeZone)} · {e.actor.replace(/^admin:/, '')}
          </div>
        </li>
      ))}
    </ol>
  );
}
