import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '@hono/zod-validator';
import {
  IMPORT_LIMITS,
  importBulkSchema,
  importMappingSchema,
  importRowPatchSchema,
  importRowsQuerySchema,
  localDate,
  mappingPresetSchema,
  memberListQuerySchema,
} from '@subscriberr/shared';
import { z } from 'zod';
import { AppError, badRequest, notFound } from '../../core/errors.js';
import { actorOf, workspaceOf } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { jsonBody } from '../../http/validate.js';
import { ServerUserDirectory } from '../media/links.js';
import { getWorkspaceSettings, readJsonSetting, writeJsonSetting } from '../workspaces/settings.js';
import { exportMembersCsv, templateCsv } from './export.js';
import { abandonImport, bulkUpdate, commitImport, createImport, getBatchView, getRowsPage, type ImportDeps, patchRow, setMapping, undoImport } from './imports.js';
import { listBatches } from './staging.js';

function idParam(raw: string | undefined, what = 'Import'): number {
  if (!raw || !/^\d{1,15}$/.test(raw) || Number(raw) <= 0) throw notFound(`${what} not found`);
  return Number(raw);
}

const queryError = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) => {
  if (!result.success) throw badRequest('Invalid query', result.error?.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
};

const PRESETS_KEY = 'import_mapping_presets';
const presetsSchema = z.array(mappingPresetSchema).max(20);

function csvResponse(body: string, fileName: string) {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** /api/csv — export, template, mapping presets and the import wizard (Spec §12). Workspace-scoped. */
export function csvRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const directory = new ServerUserDirectory(deps.media, deps.clock);
  const importDeps: ImportDeps = { clock: deps.clock, log: deps.log, directory, backupEnv: deps.backupEnv };
  const stamp = (c: Parameters<typeof workspaceOf>[0]) => localDate(deps.clock.now(), getWorkspaceSettings(workspaceOf(c)).timezone);

  app.get('/export', zValidator('query', memberListQuerySchema, queryError), (c) => {
    const { csv } = exportMembersCsv(workspaceOf(c), c.req.valid('query'));
    return csvResponse(csv, `subscriberr-members-${stamp(c)}.csv`);
  });

  app.get('/template', (c) => csvResponse(templateCsv(workspaceOf(c)), 'subscriberr-members-template.csv'));

  app.get('/presets', (c) => c.json({ items: presetsSchema.catch([]).parse(readJsonSetting(workspaceOf(c), PRESETS_KEY) ?? []) }));
  app.put('/presets', jsonBody(z.object({ items: presetsSchema }).strict()), (c) => {
    const ws = workspaceOf(c);
    writeJsonSetting(ws, PRESETS_KEY, c.req.valid('json').items);
    return c.json({ items: c.req.valid('json').items });
  });

  app.get('/imports', (c) => c.json({ items: listBatches(workspaceOf(c)) }));

  app.post(
    '/imports',
    bodyLimit({
      maxSize: IMPORT_LIMITS.maxBytes + 64 * 1024,
      onError: () => {
        throw new AppError(413, 'too_large', `The file is larger than ${IMPORT_LIMITS.maxBytes / 1024 / 1024} MB.`);
      },
    }),
    async (c) => {
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) throw badRequest('Attach the CSV file as "file".');
      const id = createImport(workspaceOf(c), deps, actorOf(c), file.name, new Uint8Array(await file.arrayBuffer()));
      return c.json(await getBatchView(workspaceOf(c), importDeps, id), 201);
    },
  );

  app.get('/imports/:id', async (c) => c.json(await getBatchView(workspaceOf(c), importDeps, idParam(c.req.param('id')))));

  app.delete('/imports/:id', (c) => {
    abandonImport(workspaceOf(c), deps.clock, actorOf(c), idParam(c.req.param('id')));
    return c.json({ ok: true });
  });

  app.put('/imports/:id/mapping', jsonBody(importMappingSchema), async (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'));
    await setMapping(ws, importDeps, id, c.req.valid('json'));
    return c.json(await getBatchView(ws, importDeps, id));
  });

  app.get('/imports/:id/rows', zValidator('query', importRowsQuerySchema, queryError), async (c) =>
    c.json(await getRowsPage(workspaceOf(c), importDeps, idParam(c.req.param('id')), c.req.valid('query'))),
  );

  app.patch('/imports/:id/rows/:rowId', jsonBody(importRowPatchSchema), async (c) =>
    c.json(await patchRow(workspaceOf(c), importDeps, idParam(c.req.param('id')), idParam(c.req.param('rowId'), 'Row'), c.req.valid('json'))),
  );

  app.post('/imports/:id/bulk', jsonBody(importBulkSchema), async (c) => c.json({ summary: await bulkUpdate(workspaceOf(c), importDeps, idParam(c.req.param('id')), c.req.valid('json')) }));

  app.post('/imports/:id/commit', async (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'));
    await commitImport(ws, importDeps, actorOf(c), id);
    return c.json(await getBatchView(ws, importDeps, id));
  });

  app.post('/imports/:id/undo', async (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'));
    undoImport(ws, importDeps, actorOf(c), id);
    return c.json(await getBatchView(ws, importDeps, id));
  });

  return app;
}
