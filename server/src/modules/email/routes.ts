import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '@hono/zod-validator';
import { emailListQuerySchema, emailSettingsSchema, packCreateSchema, packFileWriteSchema, previewSchema, TEMPLATE_KINDS, TEMPLATE_LIMITS, themeValuesSchema } from '@subscriberr/shared';
import { z } from 'zod';
import { AppError, badRequest, notFound } from '../../core/errors.js';
import { actorOf, workspaceOf } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { jsonBody } from '../../http/validate.js';
import { drainWorkspace } from './drain.js';
import {
  DEFAULT_BUILTIN_DIR,
  deletePack,
  deletePackFile,
  duplicatePack,
  exportPack,
  importPack,
  listPacks,
  loadPack,
  packDetail,
  type PackEnv,
  readPackFile,
  saveThemeValues,
  setActivePack,
  themeValues,
  validatePack,
  writePackFile,
} from './packs.js';
import { cancelEmail, enqueue, getEmailSettings, getQueueItem, listQueue, PRIORITY, queueStatus, retryEmail, sampleVars, saveEmailSettings } from './queue.js';
import { renderEmail } from './render.js';

const queryError = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) => {
  if (!result.success) throw badRequest('Invalid query', result.error?.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
};
const idParam = (raw: string | undefined) => {
  if (!raw || !/^\d{1,15}$/.test(raw)) throw notFound('Email not found');
  return Number(raw);
};

export function packEnvOf(deps: AppDeps): PackEnv {
  return deps.packs ?? { builtinDir: DEFAULT_BUILTIN_DIR, workspacesDir: deps.backupEnv.workspacesDir };
}

/** /api/email — the queue, its status and the email settings (Spec §9.3, §9.5). */
export function emailRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.get('/settings', (c) => c.json(getEmailSettings(workspaceOf(c))));
  app.put('/settings', jsonBody(emailSettingsSchema), (c) => c.json(saveEmailSettings(workspaceOf(c), deps.clock, actorOf(c), c.req.valid('json'))));
  app.get('/status', (c) => c.json(queueStatus(workspaceOf(c), deps.clock)));
  app.get('/queue', zValidator('query', emailListQuerySchema, queryError), (c) => c.json(listQueue(workspaceOf(c), c.req.valid('query'))));
  app.get('/queue/:id', (c) => c.json(getQueueItem(workspaceOf(c), idParam(c.req.param('id')))));
  app.post('/queue/:id/retry', (c) => {
    retryEmail(workspaceOf(c), deps.clock, actorOf(c), idParam(c.req.param('id')));
    return c.json({ ok: true });
  });
  app.post('/queue/:id/cancel', (c) => {
    cancelEmail(workspaceOf(c), deps.clock, actorOf(c), idParam(c.req.param('id')));
    return c.json({ ok: true });
  });
  /** "Send now": run the drainer for this workspace without waiting for the next minute. */
  app.post('/drain', async (c) => {
    if (!deps.gmail) throw new AppError(503, 'gmail_unavailable', 'Sending is not available.');
    return c.json(await drainWorkspace(workspaceOf(c), { clock: deps.clock, log: deps.log, gmail: deps.gmail, throttleMs: deps.emailThrottleMs }));
  });
  return app;
}

/** /api/templates — template packs (Spec §9.1). Built-in packs are read-only. */
export function templateRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const env = () => packEnvOf(deps);

  app.get('/', (c) => c.json({ items: listPacks(env(), workspaceOf(c)) }));
  app.post('/', jsonBody(packCreateSchema), (c) => {
    const ws = workspaceOf(c);
    const body = c.req.valid('json');
    return c.json(packDetail(env(), ws, duplicatePack(env(), ws, body.fromPackId, body.name)), 201);
  });
  app.post(
    '/upload',
    bodyLimit({
      maxSize: TEMPLATE_LIMITS.packBytes + 64 * 1024,
      onError: () => {
        throw new AppError(413, 'too_large', 'The upload is larger than 2 MB');
      },
    }),
    async (c) => {
      const ws = workspaceOf(c);
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) throw badRequest('Attach the pack as "file" (.zip or .html)');
      if (!/\.(zip|html?)$/i.test(file.name)) throw badRequest('Upload a .zip template pack or a single .html layout');
      const id = await importPack(env(), ws, file.name, Buffer.from(await file.arrayBuffer()));
      return c.json(packDetail(env(), ws, id), 201);
    },
  );
  app.post('/preview', jsonBody(previewSchema), (c) => {
    const ws = workspaceOf(c);
    const body = c.req.valid('json');
    const pack = loadPack(env(), ws, body.packId);
    const files = new Map(pack.files);
    for (const [p, content] of Object.entries(body.files ?? {})) files.set(p, Buffer.from(content));
    const problems = validatePack(files);
    let subjects = pack.subjects;
    try {
      subjects = JSON.parse(files.get('pack.json')!.toString('utf8')).subjects ?? subjects;
    } catch {
      /* reported by validatePack */
    }
    const theme = { ...themeValues(ws, pack), ...(body.theme ?? {}) };
    try {
      const rendered = renderEmail({ files, subjects }, body.kind, sampleVars(ws), theme);
      // Inline images are shown in the preview as data: URLs.
      let html = rendered.html;
      for (const a of rendered.attachments) html = html.replaceAll(`cid:${a.cid}`, `data:${a.contentType};base64,${a.content.toString('base64')}`);
      return c.json({ subject: rendered.subject, html, text: rendered.text, problems });
    } catch (err) {
      return c.json({ subject: '', html: '', text: '', problems: [...problems, { file: `${body.kind}.html`, message: err instanceof Error ? err.message : String(err) }] });
    }
  });

  app.get('/:id', (c) => c.json(packDetail(env(), workspaceOf(c), c.req.param('id'))));
  app.delete('/:id', (c) => {
    deletePack(env(), workspaceOf(c), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/:id/activate', (c) => {
    setActivePack(env(), workspaceOf(c), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.put('/:id/theme', jsonBody(themeValuesSchema), (c) => {
    const ws = workspaceOf(c);
    saveThemeValues(env(), ws, c.req.param('id'), c.req.valid('json').values);
    return c.json(packDetail(env(), ws, c.req.param('id')));
  });
  app.get('/:id/file', zValidator('query', z.object({ path: z.string().min(1).max(200) }), queryError), (c) => {
    const content = readPackFile(env(), workspaceOf(c), c.req.param('id'), c.req.valid('query').path);
    return c.json({ content: content.toString('utf8') });
  });
  app.put('/:id/file', jsonBody(packFileWriteSchema), (c) => {
    const ws = workspaceOf(c);
    const body = c.req.valid('json');
    writePackFile(env(), ws, c.req.param('id'), body.path, Buffer.from(body.content));
    return c.json(packDetail(env(), ws, c.req.param('id')));
  });
  app.delete('/:id/file', zValidator('query', z.object({ path: z.string().min(1).max(200) }), queryError), (c) => {
    const ws = workspaceOf(c);
    deletePackFile(env(), ws, c.req.param('id'), c.req.valid('query').path);
    return c.json(packDetail(env(), ws, c.req.param('id')));
  });
  app.post('/:id/assets', bodyLimit({ maxSize: TEMPLATE_LIMITS.fileBytes + 16 * 1024, onError: () => { throw new AppError(413, 'too_large', 'Images must be 512 KB or smaller'); } }), async (c) => {
    const ws = workspaceOf(c);
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw badRequest('Attach the image as "file"');
    const name = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    if (!/\.(png|jpe?g|gif|svg)$/.test(name)) throw badRequest('Use a PNG, JPG, GIF or SVG image');
    writePackFile(env(), ws, c.req.param('id'), `assets/${name}`, Buffer.from(await file.arrayBuffer()));
    return c.json(packDetail(env(), ws, c.req.param('id')));
  });
  app.get('/:id/download', async (c) => {
    const id = c.req.param('id');
    const zip = await exportPack(env(), workspaceOf(c), id);
    return new Response(new Uint8Array(zip), { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${id}.zip"`, 'Cache-Control': 'no-store' } });
  });
  /** "Send test to me": the chosen kind with sample data, to the signed-in Google address. */
  app.post('/:id/test', jsonBody(z.object({ kind: z.enum(TEMPLATE_KINDS) }).strict()), (c) => {
    const ws = workspaceOf(c);
    const account = c.get('account')!;
    const pack = loadPack(env(), ws, c.req.param('id'));
    const rendered = renderEmail(pack, c.req.valid('json').kind, sampleVars(ws), themeValues(ws, pack));
    const id = enqueue(ws, deps.clock, {
      kind: 'test',
      memberId: null,
      to: account.email,
      rendered: { ...rendered, subject: `[Test] ${rendered.subject}` },
      priority: PRIORITY.transactional,
      dedupeKey: `test:${pack.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      templatePack: pack.id,
      templateVersion: pack.meta.version,
    });
    return c.json({ queued: id !== null, to: account.email });
  });
  return app;
}
