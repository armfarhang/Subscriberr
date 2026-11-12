import { IMPORT_LIMITS, type ImportBatchListItem } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, FileUp, Upload } from 'lucide-react';
import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

const STATUS: Record<ImportBatchListItem['status'], { label: string; variant: BadgeProps['variant'] }> = {
  staged: { label: 'In progress', variant: 'warning' },
  committed: { label: 'Imported', variant: 'success' },
  undone: { label: 'Undone', variant: 'neutral' },
  abandoned: { label: 'Cancelled', variant: 'neutral' },
};

/** Import / export (Spec §12): export and template downloads, upload, recent imports. */
export function ImportExportPage() {
  const settings = useQuery({ queryKey: queryKeys.workspaceSettings, queryFn: api.workspaceSettings });
  const timeZone = settings.data?.timezone ?? 'UTC';
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight lg:hidden">Import / export</h2>
        <p className="text-sm text-muted-foreground">Move members in and out as CSV. Imports are reviewed side by side before anything changes, and can be undone for 24 hours.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ExportCard />
        <UploadCard />
      </div>
      <RecentImports timeZone={timeZone} />
    </div>
  );
}

function ExportCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Export</CardTitle>
        <CardDescription>A CSV that opens in Excel or Google Sheets. Edit it and import it back to update members in bulk.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button asChild>
          <a href={api.csvExportUrl({ status: 'all' })} download>
            <Download /> All members
          </a>
        </Button>
        <Button asChild variant="outline">
          <a href={api.csvExportUrl()} download>
            <Download /> Without archived
          </a>
        </Button>
        <Button asChild variant="ghost">
          <a href={api.csvTemplateUrl} download>
            <FileSpreadsheet /> Blank template
          </a>
        </Button>
        <p className="w-full text-xs text-muted-foreground">
          Empty plan cells mean “use the workspace default”. To export only some members, filter the Members list and use its Export button.
        </p>
      </CardContent>
    </Card>
  );
}

function UploadCard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const input = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const upload = useMutation({
    mutationFn: api.uploadImport,
    onSuccess: (batch) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.imports });
      queryClient.setQueryData(queryKeys.importBatch(batch.id), batch);
      navigate(`/import-export/${batch.id}`);
    },
  });
  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) upload.mutate(file);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import</CardTitle>
        <CardDescription>Upload a CSV. Nothing changes until you review every row and press Import.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pick(e.dataTransfer.files);
          }}
          disabled={upload.isPending}
          className={cn(
            'flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors',
            dragging ? 'border-primary bg-primary/10' : 'hover:border-primary/60 hover:bg-accent/40',
          )}
        >
          {upload.isPending ? <Upload className="h-6 w-6 animate-pulse text-primary" aria-hidden /> : <FileUp className="h-6 w-6 text-muted-foreground" aria-hidden />}
          <span className="font-medium">{upload.isPending ? 'Reading the file…' : 'Choose a CSV file or drop it here'}</span>
          <span className="text-xs text-muted-foreground">
            Up to {IMPORT_LIMITS.maxBytes / 1024 / 1024} MB and {IMPORT_LIMITS.maxRows.toLocaleString()} rows. Comma, semicolon or tab separated; UTF-8 or Windows encoding.
          </span>
        </button>
        <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv" className="sr-only" aria-label="CSV file" onChange={(e) => pick(e.target.files)} />
        {upload.isError && (
          <p role="alert" className="text-sm text-destructive">
            {upload.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RecentImports({ timeZone }: { timeZone: string }) {
  const list = useQuery({ queryKey: queryKeys.imports, queryFn: api.imports });
  if (!list.data || list.data.items.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent imports</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border">
          {list.data.items.map((b) => (
            <li key={b.id}>
              <Link to={`/import-export/${b.id}`} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm hover:bg-accent/40">
                <span className="min-w-0 flex-1 truncate font-medium">{b.fileName}</span>
                <span className="text-xs text-muted-foreground">
                  {b.rows} rows · {formatDateTime(b.committedAt ?? b.createdAt, timeZone)}
                </span>
                <Badge variant={STATUS[b.status].variant}>{b.status === 'staged' && b.stage === 'mapping' ? 'Mapping columns' : STATUS[b.status].label}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
