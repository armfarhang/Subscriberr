import { Hono } from 'hono';
import { addAllowedAccountSchema } from '@subscriberr/shared';
import { requireOwner } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { jsonBody } from '../../http/validate.js';
import { addAllowedAccount, listAllowedAccounts, removeAllowedAccount } from './allowlist.js';

/** /api/allowlist — the Owner manages which other Google accounts may sign in (Spec §5.5). */
export function allowlistRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireOwner);

  app.get('/', (c) => c.json({ items: listAllowedAccounts(deps.ctx, deps.config) }));

  app.post('/', jsonBody(addAllowedAccountSchema), (c) => {
    addAllowedAccount(deps.ctx, deps.clock, c.get('account')!, c.req.valid('json').email);
    return c.json({ items: listAllowedAccounts(deps.ctx, deps.config) }, 201);
  });

  app.delete('/:email', (c) => {
    const result = removeAllowedAccount(deps.ctx, deps.clock, deps.config, c.get('account')!, decodeURIComponent(c.req.param('email')));
    return c.json({ ...result, items: listAllowedAccounts(deps.ctx, deps.config) });
  });

  return app;
}
