import {
  csvFieldLabel,
  type ImportBatchView,
  type ImportCell,
  IMPORT_ROW_FILTERS,
  type ImportRowFilter,
  type ImportRowPatch,
  type ImportRowView,
  type ImportSummary,
} from '@subscriberr/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, ChevronLeft, ChevronRight, RotateCcw, Search, ShieldCheck, XCircle } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;

const FILTER_LABEL: Record<ImportRowFilter, string> = { all: 'All rows', errors: 'Errors', changes: 'Changes', new: 'New', unmatched: 'Unmatched', skipped: 'Skipped' };

const MATCH_LABEL: Record<ImportRowView['match']['type'], string> = {
  id: 'member id',
  email: 'email',
  etransfer_name: 'e-Transfer name',
  display_name: 'display name',
  manual: 'chosen by you',
  none: '',
  ambiguous: '',
};

function useInvalidate(batchId: number) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.importBatch(batchId) });
  };
}

/** Steps 4–5 (Spec §12.2): side-by-side review, corrections, summary and commit. */
export function ReviewStep({ batch }: { batch: ImportBatchView }) {
  const [filter, setFilter] = React.useState<ImportRowFilter>('all');
  const [page, setPage] = React.useState(1);
  const query = { filter, page, pageSize: PAGE_SIZE };
  const rows = useQuery({ queryKey: queryKeys.importRows(batch.id, query), queryFn: () => api.importRows(batch.id, query), placeholderData: keepPreviousData });
  const invalidate = useInvalidate(batch.id);
  const queryClient = useQueryClient();

  const bulk = useMutation({
    mutationFn: (op: 'accept_valid' | 'skip_errors' | 'use_csv_all') =>
      api.bulkImport(batch.id, op === 'use_csv_all' ? { op, rowIds: rows.data?.items.map((r) => r.id) } : { op }),
    onSuccess: invalidate,
  });
  const back = useMutation({
    mutationFn: () => api.setImportMapping(batch.id, { columns: batch.columns, defaults: batch.defaults, stage: false }),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.importBatch(batch.id), next),
  });

  const summary = rows.data?.summary ?? batch.summary;
  const pages = rows.data ? Math.max(1, Math.ceil(rows.data.total / rows.data.pageSize)) : 1;
  React.useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);

  return (
    <div className="space-y-4">
      {summary && <SummaryBar summary={summary} />}

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Show rows" className="flex flex-wrap gap-1.5">
          {IMPORT_ROW_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
                setPage(1);
              }}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                filter === f ? 'border-primary bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {FILTER_LABEL[f]}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate('accept_valid')} title="Include every skipped row that has no errors">
            Accept all valid rows
          </Button>
          <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate('skip_errors')}>
            Skip rows with errors
          </Button>
          <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate('use_csv_all')} title="For the rows shown on this page, use the CSV value for every changed field">
            Use CSV values on this page
          </Button>
        </div>
      </div>

      {rows.isPending && <div className="h-64 animate-pulse rounded-lg bg-muted" />}
      {rows.isError && <p className="text-sm text-destructive">Could not load the rows: {rows.error.message}</p>}
      {rows.data && rows.data.items.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No rows in this view.</p>}
      <div className="space-y-3">
        {rows.data?.items.map((r) => (
          <RowCard key={r.id} batchId={batch.id} row={r} />
        ))}
      </div>

      {rows.data && pages > 1 && (
        <div className="flex items-center justify-end gap-1 text-sm text-muted-foreground">
          <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft />
          </Button>
          <span className="px-2 tabular-nums">
            Page {page} of {pages} · {rows.data.total} rows
          </span>
          <Button variant="outline" size="icon" aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            <ChevronRight />
          </Button>
        </div>
      )}

      {summary && <CommitPanel batch={batch} summary={summary} />}

      <Button variant="ghost" onClick={() => back.mutate()} disabled={back.isPending}>
        <ArrowLeft /> Back to column matching
      </Button>
      {(bulk.isError || back.isError) && <p className="text-sm text-destructive">{(bulk.error ?? back.error)?.message}</p>}
    </div>
  );
}

function SummaryBar({ summary: s }: { summary: ImportSummary }) {
  const chip = (label: string, n: number, cls = '') => (
    <span className={cn('rounded-md border px-2.5 py-1 text-sm', cls)}>
      <span className="font-semibold tabular-nums">{n}</span> {label}
    </span>
  );
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap gap-2">
          {chip('new', s.create, 'border-success/40 text-success')}
          {chip('to update', s.update, 'border-warning/40 text-warning')}
          {chip('unchanged', s.unchanged)}
          {chip('skipped', s.skip)}
          {chip('with errors', s.errorRows, s.errorRows > 0 ? 'border-destructive/50 text-destructive' : '')}
          {chip('with warnings', s.warningRows)}
        </div>
        {s.safetyWarnings.length > 0 && (
          <ul className="space-y-1 text-sm">
            {s.safetyWarnings.map((w) => (
              <li key={w} className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                {w}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const STATE_CLASS: Record<ImportCell['state'], string> = {
  new: 'border-l-success',
  changed: 'border-l-warning',
  unchanged: 'border-l-transparent',
};

function RowCard({ batchId, row }: { batchId: number; row: ImportRowView }) {
  const invalidate = useInvalidate(batchId);
  const [picking, setPicking] = React.useState(false);
  const patch = useMutation({ mutationFn: (p: ImportRowPatch) => api.patchImportRow(batchId, row.id, p), onSuccess: invalidate });
  const matched = row.match.memberId !== null;
  const updating = row.action === 'update';
  // Row-level messages that are not already shown next to a cell.
  const cellMessages = new Set(row.cells.flatMap((c) => [c.error, c.warning].filter(Boolean).map((m) => `${csvFieldLabel(c.field)}: ${m}`)));
  const rowErrors = row.errors.filter((m) => !cellMessages.has(m));
  const rowWarnings = row.warnings.filter((m) => !cellMessages.has(m));

  return (
    <Card className={cn(row.action === 'skip' && 'opacity-70', row.errors.length > 0 && row.action !== 'skip' && 'border-destructive/50')}>
      <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0 pb-3">
        <CardTitle className="mr-1">Row {row.rowNumber}</CardTitle>
        <Select aria-label={`Action for row ${row.rowNumber}`} className="h-8 w-auto" value={row.action} disabled={patch.isPending} onChange={(e) => patch.mutate({ action: e.target.value as ImportRowView['action'] })}>
          <option value="create">Create new</option>
          <option value="update" disabled={!matched}>
            Update existing
          </option>
          <option value="skip">Skip</option>
        </Select>
        <span className="text-sm text-muted-foreground">
          {row.match.type === 'ambiguous' ? (
            <span className="text-warning">Several members match:</span>
          ) : matched ? (
            <>
              matches{' '}
              <Link to={`/members/${row.match.memberId}`} target="_blank" className="font-medium text-foreground underline underline-offset-2">
                {row.match.displayName}
              </Link>{' '}
              by {MATCH_LABEL[row.match.type]}
              {row.match.confidence && <Badge variant={row.match.confidence === 'medium' ? 'warning' : 'neutral'} className="ml-1.5">{row.match.confidence}</Badge>}
            </>
          ) : (
            'no matching member'
          )}
        </span>
        {row.match.candidates.map((c) => (
          <Button key={c.id} size="sm" variant="outline" className="h-7" disabled={patch.isPending} onClick={() => patch.mutate({ matchMemberId: c.id })}>
            {c.displayName}
          </Button>
        ))}
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" className="h-7" onClick={() => setPicking((p) => !p)}>
            <Search /> Change match
          </Button>
          {row.edited && (
            <Button size="sm" variant="ghost" className="h-7" disabled={patch.isPending} onClick={() => patch.mutate({ reset: true })}>
              <RotateCcw /> Reset row
            </Button>
          )}
        </span>
        {picking && (
          <MemberPicker
            onPick={(id) => {
              setPicking(false);
              patch.mutate({ matchMemberId: id });
            }}
          />
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="hidden grid-cols-[9rem_minmax(0,1.5fr)_minmax(0,1fr)_8.5rem] gap-3 px-2 text-xs uppercase tracking-wide text-muted-foreground md:grid">
          <span>Field</span>
          <span>CSV (editable)</span>
          <span>{updating ? 'Current member' : 'Database'}</span>
          <span>{updating ? 'Use' : ''}</span>
        </div>
        {row.cells.map((cell) => (
          <CellRow key={cell.field} cell={cell} updating={updating} disabled={patch.isPending} onPatch={(p) => patch.mutate(p)} />
        ))}
        {(rowErrors.length > 0 || rowWarnings.length > 0) && (
          <ul className="space-y-1 pt-1 text-sm">
            {rowErrors.map((m) => (
              <li key={m} className="flex gap-2 text-destructive">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {m}
              </li>
            ))}
            {rowWarnings.map((m) => (
              <li key={m} className="flex gap-2 text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {m}
              </li>
            ))}
          </ul>
        )}
        {patch.isError && <p className="text-sm text-destructive">{patch.error.message}</p>}
      </CardContent>
    </Card>
  );
}

function CellRow({ cell, updating, disabled, onPatch }: { cell: ImportCell; updating: boolean; disabled: boolean; onPatch: (p: ImportRowPatch) => void }) {
  const [text, setText] = React.useState(cell.csv);
  React.useEffect(() => setText(cell.csv), [cell.csv]);
  const commit = () => {
    if (text !== cell.csv) onPatch({ values: { [cell.field]: text } });
  };
  const label = csvFieldLabel(cell.field);
  const id = React.useId();
  const toggle = updating && cell.state === 'changed' && cell.field !== 'id';
  return (
    <div className={cn('grid gap-1.5 rounded-md border-l-4 bg-muted/20 px-2 py-1.5 md:grid-cols-[9rem_minmax(0,1.5fr)_minmax(0,1fr)_8.5rem] md:items-start md:gap-3', STATE_CLASS[cell.state])}>
      <label htmlFor={id} className="pt-1.5 text-sm font-medium">
        {label}
        {cell.edited && <span className="ml-1 text-xs font-normal text-primary">edited</span>}
      </label>
      <div className="space-y-1">
        <Input
          id={id}
          className={cn('h-8', cell.use === 'db' && toggle && 'line-through opacity-60')}
          value={text}
          disabled={disabled || cell.field === 'id'}
          aria-invalid={Boolean(cell.error)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
        {cell.error && <p className="text-xs text-destructive">{cell.error}</p>}
        {cell.warning && <p className="text-xs text-warning">{cell.warning}</p>}
      </div>
      <div className="min-h-8 break-words pt-1.5 text-sm text-muted-foreground">
        <span className="md:hidden">Now: </span>
        {updating ? (cell.db ?? <em>{cell.field.startsWith('plan_') || cell.field === 'tolerance' || cell.field === 'grace_days' ? 'workspace default' : 'empty'}</em>) : <em>new member</em>}
        {cell.state === 'unchanged' && updating && cell.field !== 'id' && <Check className="ml-1 inline h-3.5 w-3.5 text-success" aria-label="unchanged" />}
      </div>
      <div>
        {toggle && (
          <div role="group" aria-label={`Value to keep for ${label}`} className="inline-flex overflow-hidden rounded-md border text-xs">
            {(['csv', 'db'] as const).map((u) => (
              <button
                key={u}
                type="button"
                disabled={disabled}
                aria-pressed={cell.use === u}
                onClick={() => onPatch({ use: { [cell.field]: u } })}
                className={cn('px-2 py-1', cell.use === u ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}
              >
                {u === 'csv' ? 'Use CSV' : 'Keep'}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MemberPicker({ onPick }: { onPick: (id: number | null) => void }) {
  const [q, setQ] = React.useState('');
  const results = useQuery({ queryKey: queryKeys.memberList({ q, status: 'all', pageSize: 8 }), queryFn: () => api.members({ q, status: 'all', pageSize: 8 }), enabled: q.trim().length > 0 });
  return (
    <div className="w-full space-y-2 rounded-md border bg-card p-2">
      <Input autoFocus placeholder="Search members by name or email…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search members" />
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" onClick={() => onPick(null)}>
          It is a new member
        </Button>
        {results.data?.items.map((m) => (
          <Button key={m.id} size="sm" variant="secondary" onClick={() => onPick(m.id)}>
            {m.displayName}
            {m.email && <span className="text-muted-foreground">· {m.email}</span>}
          </Button>
        ))}
      </div>
    </div>
  );
}

function CommitPanel({ batch, summary }: { batch: ImportBatchView; summary: ImportSummary }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);
  const commit = useMutation({
    mutationFn: () => api.commitImport(batch.id),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.importBatch(batch.id), next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.members });
      void queryClient.invalidateQueries({ queryKey: queryKeys.imports });
    },
  });
  const nothing = summary.create + summary.update === 0;
  const blocked = summary.errorRows > 0;
  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle>Import</CardTitle>
        <CardDescription>
          {blocked
            ? `${summary.errorRows} row(s) still have errors. Fix them in the grid or skip them.`
            : nothing
              ? 'Every row is skipped or unchanged: there is nothing to import.'
              : `Creates ${summary.create} and updates ${summary.update} member(s). A safety backup is taken first; no emails are sent and no media-server access changes.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        {confirming ? (
          <>
            <Button onClick={() => commit.mutate()} disabled={commit.isPending}>
              <ShieldCheck /> {commit.isPending ? 'Backing up and importing…' : 'Yes, import now'}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={commit.isPending}>
              Cancel
            </Button>
          </>
        ) : (
          <Button onClick={() => setConfirming(true)} disabled={blocked || nothing}>
            Import {summary.create + summary.update} member(s)
          </Button>
        )}
        {commit.isError && (
          <p role="alert" className="w-full text-sm text-destructive">
            {commit.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
