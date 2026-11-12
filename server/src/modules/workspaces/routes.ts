import { Hono } from 'hono';
import { updateWorkspaceSettingsSchema } from '@subscriberr/shared';
import { actorOf, workspaceOf } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { jsonBody } from '../../http/validate.js';
import { disconnectGoogle } from '../gmail/tokens.js';
import { completeOnboarding, getWorkspaceSettings, updateWorkspaceSettings } from './settings.js';

/** /api/workspace — settings of the signed-in account's own workspace. Every handler is scoped by `workspaceOf(c)`. */
export function workspaceRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/settings', (c) => c.json(getWorkspaceSettings(workspaceOf(c))));

  app.patch('/settings', jsonBody(updateWorkspaceSettingsSchema), (c) =>
    c.json(updateWorkspaceSettings(workspaceOf(c), deps.clock, actorOf(c), c.req.valid('json'))),
  );

  app.post('/onboarding/complete', (c) => c.json(completeOnboarding(workspaceOf(c), deps.clock, actorOf(c))));

  // "Disconnect Google account" (§5.3): revoke + clear credentials; sign-in stays valid, and
  // signing in with Google again reconnects Gmail.
  app.post('/google/disconnect', async (c) => {
    const result = await disconnectGoogle(workspaceOf(c), { clock: deps.clock, secretBox: deps.secretBox, google: deps.google, log: deps.log }, actorOf(c));
    return c.json(result);
  });

  return app;
}
