import { Hono } from 'hono';
import { balanceAdjustSchema, balanceSetSchema, manualPaymentSchema, markDepositedSchema, voidPaymentSchema } from '@subscriberr/shared';
import { notFound } from '../../core/errors.js';
import { actorOf, workspaceOf } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { jsonBody } from '../../http/validate.js';
import { getMemberDetail } from '../members/members.js';
import { getPayment } from '../payments/store.js';
import { type BillingDeps, listLedger, markDeposited, recordManualAdjust, recordManualPayment, recordManualSet, voidPayment } from './ledger.js';

function idParam(raw: string | undefined, what: string): number {
  if (!raw || !/^\d{1,15}$/.test(raw) || Number(raw) <= 0) throw notFound(`${what} not found`);
  return Number(raw);
}

/** /api/billing — manual payments, voids, deposits and balance corrections (Spec §8). Workspace-scoped. */
export function billingRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const billing: BillingDeps = { clock: deps.clock, events: deps.billingEvents };

  app.post('/payments', jsonBody(manualPaymentSchema), (c) => {
    const ws = workspaceOf(c);
    const id = recordManualPayment(ws, billing, actorOf(c), c.req.valid('json'));
    return c.json(getPayment(ws, id), 201);
  });
  app.post('/payments/:id/void', jsonBody(voidPaymentSchema), (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'), 'Payment');
    voidPayment(ws, billing, actorOf(c), id, c.req.valid('json').reason);
    return c.json(getPayment(ws, id));
  });
  app.post('/payments/:id/deposited', jsonBody(markDepositedSchema), (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'), 'Payment');
    markDeposited(ws, billing, actorOf(c), id, c.req.valid('json'));
    return c.json(getPayment(ws, id));
  });

  app.get('/members/:id/ledger', (c) => c.json({ items: listLedger(workspaceOf(c), idParam(c.req.param('id'), 'Member')) }));
  app.post('/members/:id/adjust', jsonBody(balanceAdjustSchema), (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'), 'Member');
    const body = c.req.valid('json');
    recordManualAdjust(ws, billing, actorOf(c), id, { days: body.days, creditCents: body.creditCents, note: body.note });
    return c.json(getMemberDetail(ws, deps.clock, id));
  });
  app.post('/members/:id/set', jsonBody(balanceSetSchema), (c) => {
    const ws = workspaceOf(c);
    const id = idParam(c.req.param('id'), 'Member');
    recordManualSet(ws, billing, actorOf(c), id, c.req.valid('json'));
    return c.json(getMemberDetail(ws, deps.clock, id));
  });

  return app;
}
