import { centsToDecimal, CSV_BASE_FIELDS, type MemberListQuery, SERVER_FIELD_PREFIX } from '@subscriberr/shared';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import { linkLabel, linksByMember, listServers } from '../media/links.js';
import { selectMembers } from '../members/members.js';
import { serializeCsv } from './csv.js';
import { aliasesText } from './fields.js';

// CSV export (Spec §12.1): stable headers, blank override = inherit, aliases pipe-separated,
// one `server:<name>` column per configured server. The serializer adds the BOM, RFC 4180
// quoting and the formula-injection guard.

export function exportMembersCsv(ws: WorkspaceContext, query: MemberListQuery): { csv: string; count: number } {
  const { rows } = selectMembers(ws, { ...query, page: 1, pageSize: 200 });
  const servers = listServers(ws);
  const links = linksByMember(ws);
  const aliasRows = ws.sqlite.prepare('SELECT member_id, kind, value FROM member_aliases WHERE account_id = ? ORDER BY kind, value').all(ws.accountId) as Array<{
    member_id: number;
    kind: string;
    value: string;
  }>;
  const aliases = new Map<number, Array<{ kind: string; value: string }>>();
  for (const a of aliasRows) aliases.set(a.member_id, [...(aliases.get(a.member_id) ?? []), a]);

  const header = [...CSV_BASE_FIELDS, ...servers.map((s) => `${SERVER_FIELD_PREFIX}${s.name}`)];
  const money = (c: number | null) => (c === null ? '' : centsToDecimal(c));
  const body = rows.map((m) => [
    String(m.id),
    m.display_name,
    m.etransfer_name ?? '',
    m.email ?? '',
    m.notes ?? '',
    money(m.plan_amount_cents),
    m.plan_period_days === null ? '' : String(m.plan_period_days),
    m.currency,
    money(m.tolerance_cents),
    m.grace_days === null ? '' : String(m.grace_days),
    m.paid_through ?? '',
    centsToDecimal(m.credit_cents),
    m.status,
    m.reminders_enabled === 1 ? 'true' : 'false',
    m.emails_enabled === 1 ? 'true' : 'false',
    aliasesText([...(aliases.get(m.id) ?? [])].sort((a, b) => (a.kind + a.value).localeCompare(b.kind + b.value))),
    m.payment_memo_code ?? '',
    ...servers.map((s) => {
      const link = links.get(m.id)?.find((l) => l.serverId === s.id);
      return link ? linkLabel(link) : '';
    }),
  ]);
  return { csv: serializeCsv([header, ...body]), count: rows.length };
}

/** A blank template with two fictional example rows (§12.1). */
export function templateCsv(ws: WorkspaceContext): string {
  const servers = listServers(ws);
  const header = [...CSV_BASE_FIELDS, ...servers.map((s) => `${SERVER_FIELD_PREFIX}${s.name}`)];
  const example = (values: Partial<Record<string, string>>) => header.map((h) => values[h] ?? '');
  return serializeCsv([
    header,
    example({
      display_name: 'Ann (neighbour)',
      etransfer_name: 'ANN SMITH',
      email: 'ann@example.com',
      notes: 'Example row: delete it. Empty plan cells use your workspace defaults.',
      paid_through: '2026-12-01',
      reminders_enabled: 'true',
      emails_enabled: 'true',
      aliases: 'A SMITH|ann.work@example.com',
    }),
    example({
      display_name: 'Bob (yearly)',
      etransfer_name: 'Robert Example',
      email: 'bob@example.com',
      notes: 'Example row: pays yearly at a custom price.',
      plan_amount: '150.00',
      plan_period_days: '365',
      paid_through: '2027-03-15',
      credit: '0.00',
      payment_memo_code: 'BOB-1',
    }),
  ]);
}
