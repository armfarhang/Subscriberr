import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { addAliasSchema, createMemberSchema, memberListQuerySchema, memberStatusActionSchema, updateMemberSchema } from '@subscriberr/shared';
import { badRequest, notFound } from '../../core/errors.js';
import { actorOf, workspaceOf } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { jsonBody } from '../../http/validate.js';
import { addAlias, removeAlias } from './aliases.js';
import { changeMemberStatus, createMember, deleteMember, getMemberDetail, listMembers, updateMember } from './members.js';

/** Path ids are positive integers; anything else is simply "not found". */
function idParam(raw: string | undefined): number {
  const id = Number(raw);
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) throw notFound('Member not found');
  return id;
}

/** /api/members — every handler is scoped to the signed-in account's workspace via `workspaceOf(c)`. */
export function memberRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { clock } = deps;

  app.get(
    '/',
    zValidator('query', memberListQuerySchema, (result) => {
      if (!result.success) throw badRequest('Invalid query', result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }),
    (c) => c.json(listMembers(workspaceOf(c), clock, c.req.valid('query'))),
  );

  app.post('/', jsonBody(createMemberSchema), (c) => c.json(createMember(workspaceOf(c), clock, actorOf(c), c.req.valid('json')), 201));

  app.get('/:id', (c) => c.json(getMemberDetail(workspaceOf(c), clock, idParam(c.req.param('id')))));

  app.patch('/:id', jsonBody(updateMemberSchema), (c) => c.json(updateMember(workspaceOf(c), clock, actorOf(c), idParam(c.req.param('id')), c.req.valid('json'))));

  app.post('/:id/status', jsonBody(memberStatusActionSchema), (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'));
    const before = getMemberDetail(ws, clock, id).status;
    const after = changeMemberStatus(ws, clock, actorOf(c), id, c.req.valid('json').action);
    // Manual changes (pause / archive / reactivate) reach the same listeners as billing ones:
    // media access (archived → revoke, reactivated → grant) and the "access paused" email.
    if (after.status !== before) deps.billingEvents?.statusChanged?.(ws, { memberId: id, from: before, to: after.status });
    return c.json(after);
  });

  app.delete('/:id', (c) => {
    deleteMember(workspaceOf(c), clock, actorOf(c), idParam(c.req.param('id')));
    return c.json({ ok: true });
  });

  app.post('/:id/aliases', jsonBody(addAliasSchema), (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'));
    addAlias(ws, clock, actorOf(c), id, c.req.valid('json'));
    return c.json(getMemberDetail(ws, clock, id), 201);
  });

  app.delete('/:id/aliases/:aliasId', (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'));
    removeAlias(ws, clock, actorOf(c), id, idParam(c.req.param('aliasId')));
    return c.json(getMemberDetail(ws, clock, id));
  });

  return app;
}
