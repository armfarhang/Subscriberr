import { csvFieldLabel, csvHeaderKey, type ImportBatchView, type MappingPreset } from '@subscriberr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Save, X } from 'lucide-react';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

/** Fields that identify a person: they never get a default for every row. */
const NO_DEFAULT = new Set(['id', 'display_name', 'email', 'etransfer_name', 'payment_memo_code', 'aliases']);

const DEFAULT_HINTS: Record<string, string> = {
  plan_amount: '15.00',
  plan_period_days: '30',
  currency: 'CAD',
  tolerance: '0.00',
  grace_days: '3',
  paid_through: '2026-12-01',
  credit: '0.00',
  status: 'paused / archived',
  reminders_enabled: 'true / false',
  emails_enabled: 'true / false',
  notes: 'Imported from the old sheet',
};

/** Step 2 (Spec §12.2): map columns, defaults for missing fields, presets. */
export function MappingStep({ batch }: { batch: ImportBatchView }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [columns, setColumns] = React.useState<Array<string | null>>(batch.columns);
  const [defaults, setDefaults] = React.useState<Record<string, string>>(batch.defaults);
  const [presetName, setPresetName] = React.useState('');
  const presets = useQuery({ queryKey: queryKeys.mappingPresets, queryFn: api.mappingPresets });

  const save = useMutation({
    mutationFn: () => api.setImportMapping(batch.id, { columns, defaults, stage: true }),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.importBatch(batch.id), next);
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.importBatch(batch.id), 'rows'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.imports });
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.abandonImport(batch.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.imports });
      navigate('/import-export', { replace: true });
    },
  });
  const savePreset = useMutation({
    mutationFn: (items: MappingPreset[]) => api.saveMappingPresets(items),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.mappingPresets, data);
      setPresetName('');
    },
  });

  const mapped = new Set(columns.filter((c): c is string => c !== null));
  const unmapped = batch.availableFields.filter((f) => !mapped.has(f) && !NO_DEFAULT.has(f) && !f.startsWith('server:'));
  const identifies = ['id', 'display_name', 'email', 'etransfer_name'].some((f) => mapped.has(f));

  const applyPreset = (name: string) => {
    const preset = presets.data?.items.find((p) => p.name === name);
    if (!preset) return;
    const next = batch.headers.map((h) => {
      const f = preset.columns[csvHeaderKey(h)];
      return f && batch.availableFields.includes(f) ? f : null;
    });
    // Keep each field once.
    const seen = new Set<string>();
    setColumns(next.map((f) => (f && !seen.has(f) ? (seen.add(f), f) : null)));
    setDefaults(preset.defaults);
  };
  const storePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const preset: MappingPreset = { name, columns: Object.fromEntries(batch.headers.map((h, i) => [csvHeaderKey(h), columns[i] ?? null])), defaults };
    savePreset.mutate([...(presets.data?.items ?? []).filter((p) => p.name !== name), preset].slice(-20));
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Match the columns</CardTitle>
          <CardDescription>
            {batch.fileName}: {batch.headers.length} columns, {batch.encoding}, {batch.delimiter}-separated. Columns were matched by name; check them and set “Ignore” for anything you do not want to import.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {presets.data && presets.data.items.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Saved mapping:</span>
              <Select aria-label="Apply a saved mapping" className="w-auto" defaultValue="" onChange={(e) => applyPreset(e.target.value)}>
                <option value="" disabled>
                  Choose…
                </option>
                {presets.data.items.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Column in the file</th>
                  <th scope="col" className="px-3 py-2 font-medium">Example values</th>
                  <th scope="col" className="px-3 py-2 font-medium">Import as</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {batch.headers.map((h, i) => (
                  <tr key={`${h}-${i}`}>
                    <td className="px-3 py-2 font-medium">{h}</td>
                    <td className="max-w-[18rem] px-3 py-2 text-xs text-muted-foreground">
                      <span className="line-clamp-2">
                        {batch.sample
                          .map((r) => r[i] ?? '')
                          .filter((v) => v.trim() !== '')
                          .slice(0, 3)
                          .join(' · ') || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        aria-label={`Import column ${h} as`}
                        className="min-w-[11rem]"
                        value={columns[i] ?? ''}
                        onChange={(e) => setColumns((cols) => cols.map((c, j) => (j === i ? e.target.value || null : c)))}
                      >
                        <option value="">Ignore</option>
                        {batch.availableFields.map((f) => (
                          <option key={f} value={f} disabled={mapped.has(f) && columns[i] !== f}>
                            {csvFieldLabel(f)} ({f})
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!identifies && (
            <p role="alert" className="text-sm text-destructive">
              Map at least one column that identifies the member: display name, email, e-Transfer name or member id.
            </p>
          )}
        </CardContent>
      </Card>

      {unmapped.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Values for columns the file does not have</CardTitle>
            <CardDescription>Optional. A value here is used for every row. Leave empty to keep existing values (and workspace defaults for new members).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {unmapped.map((f) => (
              <label key={f} className="space-y-1 text-sm">
                <span className="font-medium">{csvFieldLabel(f)}</span>
                <Input placeholder={DEFAULT_HINTS[f] ?? ''} value={defaults[f] ?? ''} onChange={(e) => setDefaults((d) => ({ ...d, [f]: e.target.value }))} />
              </label>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending || !identifies}>
          {save.isPending ? 'Matching rows…' : 'Continue to review'} <ArrowRight />
        </Button>
        <Button variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
          <X /> Cancel import
        </Button>
        <span className="ml-auto flex items-center gap-2">
          <Input aria-label="Name for this mapping" placeholder="Save mapping as…" className="w-44" value={presetName} onChange={(e) => setPresetName(e.target.value)} />
          <Button variant="outline" onClick={storePreset} disabled={!presetName.trim() || savePreset.isPending}>
            <Save /> Save
          </Button>
        </span>
      </div>
      {(save.isError || cancel.isError || savePreset.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {(save.error ?? cancel.error ?? savePreset.error)?.message}
        </p>
      )}
      {savePreset.isSuccess && <p className="text-sm text-success">Mapping saved.</p>}
    </div>
  );
}
