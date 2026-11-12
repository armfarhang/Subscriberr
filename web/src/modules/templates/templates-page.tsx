import { html as htmlLang } from '@codemirror/lang-html';
import { json as jsonLang } from '@codemirror/lang-json';
import { type PackDetail, type PackProblem, TEMPLATE_KINDS, type TemplateKind } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CodeMirror from '@uiw/react-codemirror';
import { Check, Copy, Download, Monitor, Moon, Smartphone, Sun, Trash2, Upload } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { api, ApiRequestError } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<TemplateKind, string> = { thanks: 'Thank-you', deficit: 'Deficit', reminder: 'Reminder', expired: 'Access paused', announcement: 'Announcement' };

/** Templates (Spec §9.1): pick, duplicate, edit, preview, theme, upload/download, test. */
export function TemplatesPage() {
  const queryClient = useQueryClient();
  const packs = useQuery({ queryKey: queryKeys.packs, queryFn: api.packs });
  const [selected, setSelected] = React.useState<string | null>(null);
  const current = selected ?? packs.data?.items.find((p) => p.active)?.id ?? null;
  const upload = useMutation({
    mutationFn: api.uploadPack,
    onSuccess: (p) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.packs });
      setSelected(p.id);
    },
  });
  const input = React.useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">Template packs decide how every email looks. Built-in packs can’t be changed: duplicate one to customise it.</p>
        <Button variant="outline" onClick={() => input.current?.click()} disabled={upload.isPending}>
          <Upload /> Upload pack
        </Button>
        <input ref={input} type="file" accept=".zip,.html,.htm" className="sr-only" aria-label="Template pack file" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
      </div>
      {upload.isError && <Problems error={upload.error} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {packs.data?.items.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setSelected(p.id)}
            className={cn('rounded-lg border bg-card p-3 text-left text-sm transition-colors hover:border-primary/60', current === p.id && 'border-primary ring-1 ring-primary')}
          >
            <div className="flex flex-wrap items-center gap-1.5 font-medium">
              {p.name}
              {p.active && <Badge variant="success">In use</Badge>}
              <Badge variant="neutral">{p.builtin ? 'Built-in' : 'Custom'}</Badge>
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.description || `Version ${p.version}`}</p>
          </button>
        ))}
      </div>
      {current && <PackEditor key={current} packId={current} onSelect={setSelected} />}
    </div>
  );
}

function Problems({ error, problems }: { error?: unknown; problems?: PackProblem[] }) {
  const list = problems ?? (error instanceof ApiRequestError && Array.isArray(error.details) ? (error.details as PackProblem[]) : null);
  if (!list) return error ? <p className="text-sm text-destructive">{(error as Error).message}</p> : null;
  if (list.length === 0) return null;
  return (
    <ul role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      {list.map((p, i) => (
        <li key={i}>
          {p.file && <span className="font-mono">{p.file}: </span>}
          {p.message}
        </li>
      ))}
    </ul>
  );
}

function PackEditor({ packId, onSelect }: { packId: string; onSelect: (id: string | null) => void }) {
  const queryClient = useQueryClient();
  const pack = useQuery({ queryKey: queryKeys.pack(packId), queryFn: () => api.pack(packId) });
  const [kind, setKind] = React.useState<TemplateKind>('thanks');
  const [theme, setTheme] = React.useState<Record<string, string> | null>(null);
  const [edits, setEdits] = React.useState<Record<string, string>>({});
  const [copyName, setCopyName] = React.useState('');
  const refresh = (next?: PackDetail) => {
    if (next) queryClient.setQueryData(queryKeys.pack(packId), next);
    void queryClient.invalidateQueries({ queryKey: queryKeys.packs });
  };
  React.useEffect(() => {
    if (pack.data && !theme) setTheme(pack.data.themeValues);
  }, [pack.data, theme]);

  const activate = useMutation({ mutationFn: () => api.activatePack(packId), onSuccess: () => refresh() });
  const duplicate = useMutation({
    mutationFn: () => api.duplicatePack(packId, copyName.trim() || `${pack.data?.name ?? 'Pack'} copy`),
    onSuccess: (p) => {
      refresh();
      onSelect(p.id);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deletePack(packId),
    onSuccess: () => {
      refresh();
      onSelect(null);
    },
  });
  const saveTheme = useMutation({ mutationFn: () => api.savePackTheme(packId, theme ?? {}), onSuccess: refresh });
  const test = useMutation({ mutationFn: () => api.testPack(packId, kind) });

  if (!pack.data || !theme) return <div className="h-64 animate-pulse rounded-lg bg-muted" />;
  const p = pack.data;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row flex-wrap items-start gap-3 space-y-0">
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle>{p.name}</CardTitle>
            <CardDescription>{p.description}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {!p.active && (
              <Button size="sm" onClick={() => activate.mutate()} disabled={activate.isPending}>
                <Check /> Use for all emails
              </Button>
            )}
            <Button size="sm" variant="outline" asChild>
              <a href={`/api/templates/${p.id}/download`} download>
                <Download /> Download .zip
              </a>
            </Button>
            {!p.builtin && (
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
                <Trash2 /> Delete
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Input className="w-56" placeholder={`${p.name} copy`} value={copyName} onChange={(e) => setCopyName(e.target.value)} aria-label="Name for the copy" />
          <Button size="sm" variant="outline" onClick={() => duplicate.mutate()} disabled={duplicate.isPending}>
            <Copy /> Duplicate {p.builtin ? 'to customise' : ''}
          </Button>
          {(duplicate.isError || remove.isError || activate.isError) && <Problems error={duplicate.error ?? remove.error ?? activate.error} />}
        </CardContent>
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="min-w-0 space-y-6">
          {Object.keys(p.theme).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Theme</CardTitle>
                <CardDescription>Colours and texts, no code needed. The preview updates as you type.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  {Object.entries(p.theme).map(([key, def]) => (
                    <label key={key} className={cn('space-y-1 text-sm', def.type === 'text' && 'sm:col-span-2')}>
                      <span className="font-medium">{def.label}</span>
                      <span className="flex items-center gap-2">
                        {def.type === 'color' && (
                          <input type="color" aria-label={`${def.label} colour`} className="h-9 w-10 cursor-pointer rounded border bg-transparent" value={theme[key] ?? def.default} onChange={(e) => setTheme({ ...theme, [key]: e.target.value })} />
                        )}
                        <Input value={theme[key] ?? ''} onChange={(e) => setTheme({ ...theme, [key]: e.target.value })} />
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => saveTheme.mutate()} disabled={saveTheme.isPending}>
                    Save theme
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setTheme(Object.fromEntries(Object.entries(p.theme).map(([k, v]) => [k, v.default])))}>
                    Reset to defaults
                  </Button>
                  {saveTheme.isSuccess && <span className="text-sm text-success">Saved</span>}
                </div>
                {saveTheme.isError && <Problems error={saveTheme.error} />}
              </CardContent>
            </Card>
          )}
          <FilesCard pack={p} edits={edits} setEdits={setEdits} onSaved={refresh} />
        </div>
        <PreviewCard packId={p.id} kind={kind} setKind={setKind} theme={theme} edits={edits} onTest={() => test.mutate()} testResult={test.data ? `Test queued to ${test.data.to}. It is sent within a minute (Emails page).` : test.isError ? test.error.message : null} />
      </div>
    </div>
  );
}

function FilesCard({ pack: p, edits, setEdits, onSaved }: { pack: PackDetail; edits: Record<string, string>; setEdits: (e: Record<string, string>) => void; onSaved: (next?: PackDetail) => void }) {
  const textFiles = p.files.filter((f) => f.text);
  const [file, setFile] = React.useState(textFiles.find((f) => f.path === 'layout.html')?.path ?? textFiles[0]?.path ?? '');
  const content = useQuery({ queryKey: ['packs', p.id, 'file', file], queryFn: () => api.packFile(p.id, file), enabled: Boolean(file) });
  const save = useMutation({
    mutationFn: () => api.savePackFile(p.id, file, edits[file] ?? content.data?.content ?? ''),
    onSuccess: (next) => {
      const rest = { ...edits };
      delete rest[file];
      setEdits(rest);
      onSaved(next);
    },
  });
  const asset = useMutation({ mutationFn: (f: File) => api.uploadPackAsset(p.id, f), onSuccess: onSaved });
  const resolved = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  const value = edits[file] ?? content.data?.content ?? '';
  const dirty = edits[file] !== undefined && edits[file] !== content.data?.content;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Files</CardTitle>
        <CardDescription>
          {p.builtin ? 'Built-in packs are read-only: edits here only change the preview. Duplicate the pack to save them.' : 'HTML with Handlebars variables. Saving checks variables and safety rules.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {textFiles.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => setFile(f.path)}
              className={cn('rounded-md border px-2 py-1 font-mono text-xs', file === f.path ? 'border-primary bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent', edits[f.path] !== undefined && 'italic')}
            >
              {f.path}
              {edits[f.path] !== undefined && ' •'}
            </button>
          ))}
        </div>
        {file && (
          <div className="overflow-hidden rounded-md border text-sm">
            <CodeMirror
              value={value}
              height="22rem"
              theme={resolved === 'dark' ? 'dark' : 'light'}
              extensions={[file.endsWith('.json') ? jsonLang() : htmlLang()]}
              onChange={(v) => setEdits({ ...edits, [file]: v })}
              aria-label={`Editor for ${file}`}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {!p.builtin && (
            <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              Save {file}
            </Button>
          )}
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const rest = { ...edits };
                delete rest[file];
                setEdits(rest);
              }}
            >
              Discard changes
            </Button>
          )}
          {!p.builtin && (
            <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
              <Upload className="h-4 w-4" aria-hidden /> Add image (logo…)
              <input type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml" className="sr-only" onChange={(e) => e.target.files?.[0] && asset.mutate(e.target.files[0])} />
            </label>
          )}
        </div>
        {!p.builtin && p.files.some((f) => f.path.startsWith('assets/')) && (
          <p className="text-xs text-muted-foreground">
            Images: {p.files.filter((f) => f.path.startsWith('assets/')).map((f) => f.path).join(', ')}. Use them as <code>&lt;img src="assets/logo.png"&gt;</code>; they are sent inline.
          </p>
        )}
        {save.isError && <Problems error={save.error} />}
        {asset.isError && <Problems error={asset.error} />}
      </CardContent>
    </Card>
  );
}

function PreviewCard({
  packId,
  kind,
  setKind,
  theme,
  edits,
  onTest,
  testResult,
}: {
  packId: string;
  kind: TemplateKind;
  setKind: (k: TemplateKind) => void;
  theme: Record<string, string>;
  edits: Record<string, string>;
  onTest: () => void;
  testResult: string | null;
}) {
  const [device, setDevice] = React.useState<'desktop' | 'mobile'>('desktop');
  const [scheme, setScheme] = React.useState<'light' | 'dark'>('light');
  const [asText, setAsText] = React.useState(false);
  // Debounced so typing in the editor does not send a request per keystroke.
  const [debounced, setDebounced] = React.useState({ theme, edits });
  React.useEffect(() => {
    const t = window.setTimeout(() => setDebounced({ theme, edits }), 300);
    return () => window.clearTimeout(t);
  }, [theme, edits]);
  const preview = useQuery({
    queryKey: ['packs', packId, 'preview', kind, debounced],
    queryFn: () => api.previewPack({ packId, kind, theme: debounced.theme, files: Object.keys(debounced.edits).length > 0 ? debounced.edits : undefined }),
    placeholderData: (prev) => prev,
  });
  // Dark preview: the email's own dark-mode rules are switched on (an iframe follows the OS setting otherwise).
  const html = preview.data ? (scheme === 'dark' ? preview.data.html.replace(/@media\s*\(prefers-color-scheme:\s*dark\)/g, '@media all') : preview.data.html.replace(/@media\s*\(prefers-color-scheme:\s*dark\)/g, '@media not all')) : '';
  return (
    <Card className="xl:sticky xl:top-16 xl:self-start">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="mr-auto">Preview</CardTitle>
          <Select aria-label="Email kind" className="h-8 w-auto" value={kind} onChange={(e) => setKind(e.target.value as TemplateKind)}>
            {TEMPLATE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
          <div className="inline-flex overflow-hidden rounded-md border" role="group" aria-label="Device">
            <Button size="icon" variant={device === 'desktop' ? 'secondary' : 'ghost'} className="h-8 w-8 rounded-none" aria-label="Desktop" aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}>
              <Monitor />
            </Button>
            <Button size="icon" variant={device === 'mobile' ? 'secondary' : 'ghost'} className="h-8 w-8 rounded-none" aria-label="Mobile" aria-pressed={device === 'mobile'} onClick={() => setDevice('mobile')}>
              <Smartphone />
            </Button>
          </div>
          <div className="inline-flex overflow-hidden rounded-md border" role="group" aria-label="Colour scheme">
            <Button size="icon" variant={scheme === 'light' ? 'secondary' : 'ghost'} className="h-8 w-8 rounded-none" aria-label="Light" aria-pressed={scheme === 'light'} onClick={() => setScheme('light')}>
              <Sun />
            </Button>
            <Button size="icon" variant={scheme === 'dark' ? 'secondary' : 'ghost'} className="h-8 w-8 rounded-none" aria-label="Dark" aria-pressed={scheme === 'dark'} onClick={() => setScheme('dark')}>
              <Moon />
            </Button>
          </div>
        </div>
        {preview.data && (
          <div className="text-sm">
            <span className="text-muted-foreground">Subject: </span>
            {preview.data.subject || <em>empty</em>}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {preview.data && <Problems problems={preview.data.problems} />}
        {asText ? (
          <pre className="max-h-[34rem] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{preview.data?.text}</pre>
        ) : (
          <div className={cn('mx-auto overflow-hidden rounded-md border bg-white transition-all', device === 'mobile' ? 'w-[375px] max-w-full' : 'w-full')}>
            <iframe title="Email preview" sandbox="" srcDoc={html} className="h-[34rem] w-full" />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setAsText((t) => !t)}>
            {asText ? 'Show HTML' : 'View as plain text'}
          </Button>
          <Button size="sm" variant="outline" onClick={onTest}>
            Send test to me
          </Button>
          {testResult && <span className="text-xs text-muted-foreground">{testResult}</span>}
        </div>
        <p className="text-xs text-muted-foreground">
          Variables: {'{{member.display_name}}'}, {'{{amount_received}}'}, {'{{paid_through}}'}, {'{{due_date}}'}, {'{{shortfall}}'}, {'{{credit}}'}, {'{{etransfer_email}}'}, {'{{payment_memo_code}}'}, {'{{theme.*}}'} … The
          preview uses sample data.
        </p>
      </CardContent>
    </Card>
  );
}
