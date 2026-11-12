import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { paymentListQuerySchema, rescanSchema, resolvePaymentSchema, ruleFieldsSchema, ruleTestSchema } from '@subscriberr/shared';
import { z } from 'zod';
import { AppError, badRequest, notFound } from '../../core/errors.js';
import { actorOf, workspaceOf } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { jsonBody } from '../../http/validate.js';
import { GmailUnavailableError } from '../gmail/factory.js';
import { createRule, deleteRule, listRules, updateRule } from '../members/directory.js';
import { getScanState, type IngestDeps, scanMailbox } from './ingest.js';
import { rerunReviewQueue, resolvePayment, testRules } from './review-queue.js';
import { getPayment, listPayments } from './store.js';

function idParam(raw: string | undefined, what: string): number {
  if (!raw || !/^\d{1,15}$/.test(raw) || Number(raw) <= 0) throw notFound(`${what} not found`);
  return Number(raw);
}

const queryError = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) => {
  if (!result.success) throw badRequest('Invalid query', result.error?.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
};

/** /api/payments — payments, Review Queue, matching rules and mailbox scans. Workspace-scoped. */
export function paymentRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const ingest = (): IngestDeps => {
    if (!deps.gmail) throw new AppError(503, 'gmail_unavailable', 'Mailbox scanning is not available.');
    return { clock: deps.clock, log: deps.log, gmail: deps.gmail, onStored: deps.onPaymentStored };
  };
  const review = { clock: deps.clock, onStored: deps.onPaymentStored };
  const runScan = async (fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GmailUnavailableError) throw new AppError(503, 'gmail_unavailable', err.message);
      throw err;
    }
  };

  app.get('/', zValidator('query', paymentListQuerySchema, queryError), (c) => c.json(listPayments(workspaceOf(c), c.req.valid('query'))));

  app.get('/scan', (c) => c.json(getScanState(workspaceOf(c))));
  app.post('/scan', async (c) => c.json(await runScan(() => scanMailbox(workspaceOf(c), ingest()))));
  app.post('/rescan', jsonBody(rescanSchema), async (c) => {
    const body = c.req.valid('json');
    return c.json(await runScan(() => scanMailbox(workspaceOf(c), ingest(), { rescan: { since: new Date(`${body.since}T00:00:00Z`) }, dryRun: body.dryRun })));
  });
  app.post('/review/rerun', (c) => c.json(rerunReviewQueue(workspaceOf(c), review, actorOf(c))));

  app.get('/rules', zValidator('query', z.object({ memberId: z.coerce.number().int().positive().optional() }), queryError), (c) =>
    c.json({ items: listRules(workspaceOf(c), c.req.valid('query').memberId) }),
  );
  app.post('/rules', jsonBody(ruleFieldsSchema), (c) => c.json(createRule(workspaceOf(c), deps.clock, actorOf(c), c.req.valid('json')), 201));
  app.post('/rules/test', jsonBody(ruleTestSchema), (c) => c.json(testRules(workspaceOf(c), c.req.valid('json'))));
  app.put('/rules/:id', jsonBody(ruleFieldsSchema), (c) => c.json(updateRule(workspaceOf(c), deps.clock, actorOf(c), idParam(c.req.param('id'), 'Rule'), c.req.valid('json'))));
  app.delete('/rules/:id', (c) => {
    deleteRule(workspaceOf(c), deps.clock, actorOf(c), idParam(c.req.param('id'), 'Rule'));
    return c.json({ ok: true });
  });

  app.get('/:id', (c) => c.json(getPayment(workspaceOf(c), idParam(c.req.param('id'), 'Payment'))));
  app.post('/:id/resolve', jsonBody(resolvePaymentSchema), (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'), 'Payment');
    resolvePayment(ws, review, actorOf(c), id, c.req.valid('json'));
    return c.json(getPayment(ws, id));
  });

  return app;
}
