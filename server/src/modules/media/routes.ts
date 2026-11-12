import { Hono } from 'hono';
import { createServerSchema, linkLibrariesSchema, linkMemberSchema, updateServerSchema } from '@subscriberr/shared';
import { z } from 'zod';
import { AppError, notFound } from '../../core/errors.js';
import { actorOf, workspaceOf } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { jsonBody } from '../../http/validate.js';
import { writeAudit } from '../../core/audit.js';
import {
  createServer,
  deleteServer,
  getServerView,
  linkMember,
  listServerViews,
  type MediaDeps,
  serverLibraries,
  serverRow,
  serverUsers,
  setLinkLibraries,
  testServer,
  unlinkMember,
  updateServer,
} from './servers.js';
import { syncServer } from './sync.js';

const idParam = (raw: string | undefined, what: string) => {
  if (!raw || !/^\d{1,15}$/.test(raw)) throw notFound(`${what} not found`);
  return Number(raw);
};

/** /api/media — servers, users, libraries, links and enforcement (Spec §10). Workspace-scoped. */
export function mediaRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const md = (): MediaDeps => {
    if (!deps.media) throw new AppError(503, 'media_unavailable', 'Media servers are not available.');
    return { clock: deps.clock, secretBox: deps.secretBox, media: deps.media };
  };

  app.get('/servers', (c) => c.json({ items: listServerViews(workspaceOf(c)) }));
  app.post('/servers', jsonBody(createServerSchema), (c) => c.json(createServer(workspaceOf(c), md(), actorOf(c), c.req.valid('json')), 201));
  app.get('/servers/:id', (c) => c.json(getServerView(workspaceOf(c), idParam(c.req.param('id'), 'Server'))));
  app.patch('/servers/:id', jsonBody(updateServerSchema), (c) => c.json(updateServer(workspaceOf(c), md(), actorOf(c), idParam(c.req.param('id'), 'Server'), c.req.valid('json'))));
  app.delete('/servers/:id', (c) => {
    deleteServer(workspaceOf(c), md(), actorOf(c), idParam(c.req.param('id'), 'Server'));
    return c.json({ ok: true });
  });
  app.post('/servers/:id/test', async (c) => c.json(await testServer(workspaceOf(c), md(), idParam(c.req.param('id'), 'Server'))));
  app.get('/servers/:id/users', async (c) => c.json(await serverUsers(workspaceOf(c), md(), idParam(c.req.param('id'), 'Server'))));
  app.get('/servers/:id/libraries', async (c) => c.json({ items: await serverLibraries(workspaceOf(c), md(), idParam(c.req.param('id'), 'Server')) }));

  /** Turning enforcement on never changes anything by itself: the first sync is a reviewed dry run. */
  app.post('/servers/:id/enforcement', jsonBody(z.object({ enabled: z.boolean() }).strict()), (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'), 'Server');
    serverRow(ws, id);
    const enabled = c.req.valid('json').enabled;
    ws.sqlite.transaction(() => {
      ws.sqlite.prepare(`UPDATE media_servers SET enforcement_enabled = ?, enforcement_confirmed = CASE WHEN ? = 0 THEN 0 ELSE enforcement_confirmed END WHERE account_id = ? AND id = ?`).run(enabled ? 1 : 0, enabled ? 1 : 0, ws.accountId, id);
      writeAudit(ws, deps.clock, { actor: actorOf(c), action: enabled ? 'server.enforcement_on' : 'server.enforcement_off', entity: 'server', entityId: id });
    })();
    return c.json(getServerView(ws, id));
  });
  /** Dry run / drift view: what a sync would change, without changing anything. */
  app.get('/servers/:id/plan', async (c) => c.json(await syncServer(workspaceOf(c), { ...md(), log: deps.log }, idParam(c.req.param('id'), 'Server'), { dryRun: true })));
  /** "Sync now" / "Apply planned changes": applies (and confirms the first sync). */
  app.post('/servers/:id/sync', async (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'), 'Server');
    if (serverRow(ws, id).enforcement_enabled !== 1) throw new AppError(409, 'conflict', 'Turn enforcement on for this server first.');
    return c.json(await syncServer(ws, { ...md(), log: deps.log }, id, { dryRun: false, confirm: true, actor: actorOf(c) }));
  });

  app.post('/members/:memberId/links', jsonBody(linkMemberSchema), async (c) => {
    await linkMember(workspaceOf(c), md(), actorOf(c), idParam(c.req.param('memberId'), 'Member'), c.req.valid('json'));
    return c.json({ ok: true }, 201);
  });
  app.put('/members/:memberId/links/:serverId', jsonBody(linkLibrariesSchema), (c) => {
    setLinkLibraries(workspaceOf(c), deps.clock, actorOf(c), idParam(c.req.param('memberId'), 'Member'), idParam(c.req.param('serverId'), 'Server'), c.req.valid('json').libraryIds);
    return c.json({ ok: true });
  });
  app.delete('/members/:memberId/links/:serverId', (c) => {
    unlinkMember(workspaceOf(c), deps.clock, actorOf(c), idParam(c.req.param('memberId'), 'Member'), idParam(c.req.param('serverId'), 'Server'));
    return c.json({ ok: true });
  });
  return app;
}
