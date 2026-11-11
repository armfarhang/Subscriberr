import { Hono } from 'hono';
import { devLoginRequestSchema } from '@subscriberr/shared';
import { forbidden, notFound } from '../../core/errors.js';
import { clearSessionCookie, clientIp, setSessionCookie } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { jsonBody } from '../../http/validate.js';
import { DEMO_OWNER_EMAIL } from '../../db/seed-demo.js';
import { countAccounts, createAccount, findAccountByEmail, toMe } from './accounts.js';
import { createSession, deleteSession } from './sessions.js';

/**
 * /auth routes. Milestone 1 ships only the FAKE sign-in used by demo mode; real Google OAuth
 * (PKCE, allowlist, encrypted refresh tokens) arrives in Milestone 2.
 */
export function authRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  // Fake Google sign-in. Only exists when DEV_FAKE_LOGIN is on, which config.ts refuses unless
  // BASE_URL is localhost and NODE_ENV is not production.
  app.post('/dev-login', jsonBody(devLoginRequestSchema), (c) => {
    if (!deps.config.devFakeLogin) throw notFound();
    const email = (c.req.valid('json').email ?? DEMO_OWNER_EMAIL).toLowerCase();

    let account = findAccountByEmail(deps.ctx, email);
    if (!account) {
      // Same rule as the real flow will use: the first account becomes the Owner; anyone
      // else must already exist (allowlist handling is Milestone 2).
      if (countAccounts(deps.ctx) > 0) throw forbidden('This Google account is not authorized');
      account = createAccount(deps.ctx, deps.clock, {
        googleSub: `fake:${email}`,
        email,
        role: 'owner',
        timezone: deps.config.timezone,
      });
    }
    const token = createSession(deps.ctx, deps.clock, account.id, {
      userAgent: c.req.header('user-agent'),
      ip: clientIp(c, deps.config.trustProxy),
    });
    setSessionCookie(c, deps, token);
    return c.json(toMe(account));
  });

  app.post('/logout', (c) => {
    const token = c.get('sessionToken');
    if (token) deleteSession(deps.ctx, token);
    clearSessionCookie(c, deps);
    return c.json({ ok: true });
  });

  return app;
}
