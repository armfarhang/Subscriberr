import { MEMBER_LIST_FILTERS, MEMBER_SORTS, type MemberListFilter, type MemberSort, type MemberSummary } from '@subscriberr/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Plus, Search, Users } from 'lucide-react';
import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { ServerChips } from './server-chips';
import { DueCell, planLabel, STATUS_LABEL, StatusBadge } from './status';

const PAGE_SIZE = 50;

const FILTER_LABEL: Record<MemberListFilter, string> = { current: 'Current', all: 'All', ...STATUS_LABEL };
const SORT_LABEL: Record<MemberSort, string> = { name: 'Name', status: 'Status', due: 'Due date', created: 'Date added' };

function oneOf<T extends string>(values: readonly T[], raw: string | null, fallback: T): T {
  return values.includes(raw as T) ? (raw as T) : fallback;
}

/** Members screen (Spec §13.1 #3): search, status filter, sort, table on desktop and cards on phones. */
export function MembersPage() {
  const [params, setParams] = useSearchParams();
  const status = oneOf(MEMBER_LIST_FILTERS, params.get('status'), 'current');
  const sort = oneOf(MEMBER_SORTS, params.get('sort'), 'name');
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const q = params.get('q') ?? '';
  const [search, setSearch] = React.useState(q);

  const update = React.useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '') next.delete(k);
            else next.set(k, v);
          }
          if (!('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Debounced search box → URL.
  React.useEffect(() => {
    if (search === q) return;
    const t = window.setTimeout(() => update({ q: search.trim() || null }), 250);
    return () => window.clearTimeout(t);
  }, [search, q, update]);

  const query = { q: q || undefined, status, sort, dir, page, pageSize: PAGE_SIZE } as const;
  const list = useQuery({ queryKey: queryKeys.memberList(query), queryFn: () => api.members(query), placeholderData: keepPreviousData });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const currentCount = data ? data.counts.active + data.counts.grace + data.counts.expired + data.counts.paused : 0;
  const allCount = data ? currentCount + data.counts.archived : 0;
  const countFor = (f: MemberListFilter) => (!data ? null : f === 'current' ? currentCount : f === 'all' ? allCount : data.counts[f]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-semibold tracking-tight lg:hidden">Members</h2>
          <p className="text-sm text-muted-foreground">Who has access, until when, and on what plan.</p>
        </div>
        <Button asChild>
          <Link to="/members/new">
            <Plus /> Add member
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" aria-label="Search members" placeholder="Search names, e-Transfer names, emails, notes…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex items-center gap-1">
          <Select aria-label="Sort by" className="w-auto" value={sort} onChange={(e) => update({ sort: e.target.value === 'name' ? null : e.target.value })}>
            {MEMBER_SORTS.map((s) => (
              <option key={s} value={s}>
                Sort: {SORT_LABEL[s]}
              </option>
            ))}
          </Select>
          <Button variant="outline" size="icon" aria-label={dir === 'asc' ? 'Ascending (click for descending)' : 'Descending (click for ascending)'} onClick={() => update({ dir: dir === 'asc' ? 'desc' : null })}>
            {dir === 'asc' ? <ArrowUp /> : <ArrowDown />}
          </Button>
        </div>
      </div>

      <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
        {MEMBER_LIST_FILTERS.map((f) => {
          const n = countFor(f);
          return (
            <button
              key={f}
              type="button"
              aria-pressed={status === f}
              onClick={() => update({ status: f === 'current' ? null : f })}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                status === f ? 'border-primary bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {FILTER_LABEL[f]}
              {n !== null && <span className="ml-1.5 tabular-nums opacity-70">{n}</span>}
            </button>
          );
        })}
      </div>

      {list.isPending && <div className="h-48 animate-pulse rounded-lg bg-muted" />}
      {list.isError && <p className="text-sm text-destructive">Could not load members: {list.error.message}</p>}
      {data && data.items.length === 0 && <EmptyState filtered={Boolean(q) || status !== 'current'} hasAny={allCount > 0} />}
      {data && data.items.length > 0 && (
        <>
          <MemberTable items={data.items} />
          <MemberCards items={data.items} />
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {data.total} member{data.total === 1 ? '' : 's'}
            </span>
            {pages > 1 && (
              <span className="flex items-center gap-1">
                <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
                  <ChevronLeft />
                </Button>
                <span className="px-2 tabular-nums">
                  Page {page} of {pages}
                </span>
                <Button variant="outline" size="icon" aria-label="Next page" disabled={page >= pages} onClick={() => update({ page: String(page + 1) })}>
                  <ChevronRight />
                </Button>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState({ filtered, hasAny }: { filtered: boolean; hasAny: boolean }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Users className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        {filtered && hasAny ? (
          <div className="text-sm text-muted-foreground">No members match this search or filter.</div>
        ) : (
          <>
            <div className="text-base font-medium">No members yet</div>
            <p className="max-w-md text-sm text-muted-foreground">Add the people who pay you. Give each one a friendly display name and the name their e-Transfers come from.</p>
            <Button asChild>
              <Link to="/members/new">
                <Plus /> Add your first member
              </Link>
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MemberTable({ items }: { items: MemberSummary[] }) {
  const navigate = useNavigate();
  return (
    <div className="hidden overflow-x-auto rounded-lg border md:block">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2.5 font-medium">Member</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Plan</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Due</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Servers</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((m) => (
            <tr key={m.id} className="cursor-pointer hover:bg-accent/40" onClick={() => navigate(`/members/${m.id}`)}>
              <td className="max-w-[18rem] px-3 py-2.5">
                <Link to={`/members/${m.id}`} className="block truncate font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                  {m.displayName}
                </Link>
                <div className="truncate text-xs text-muted-foreground">{[m.etransferName, m.email].filter(Boolean).join(' · ') || 'No e-Transfer name or email'}</div>
              </td>
              <td className="px-3 py-2.5">
                <StatusBadge status={m.status} />
              </td>
              <td className="whitespace-nowrap px-3 py-2.5">
                {planLabel(m)}
                {!m.terms.planAmountCents.inherited && <span className="ml-1 text-xs text-primary">custom</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5">
                <DueCell m={m} />
              </td>
              <td className="px-3 py-2.5">
                <ServerChips servers={m.servers} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberCards({ items }: { items: MemberSummary[] }) {
  return (
    <ul className="space-y-2 md:hidden">
      {items.map((m) => (
        <li key={m.id}>
          <Link to={`/members/${m.id}`} className="block rounded-lg border bg-card p-3 hover:border-primary/50">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-medium">{m.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">{m.etransferName ?? m.email ?? '—'}</div>
              </div>
              <StatusBadge status={m.status} />
            </div>
            <div className="mt-2 flex items-end justify-between gap-2 text-sm">
              <DueCell m={m} />
              <div className="flex flex-col items-end gap-1">
                <span className="text-xs text-muted-foreground">{planLabel(m)}</span>
                <ServerChips servers={m.servers} />
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
