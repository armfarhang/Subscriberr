import type { Context } from 'hono';
import { Hono } from 'hono';
import { type AuthErrorCode, type AuthNoticeCode, devLoginRequestSchema } from '@subscriberr/shared';
import { forbidden, notFound } from '../../core/errors.js';
import { DEMO_OWNER_EMAIL } from '../../db/seed-demo.js';
import { clearSessionCookie, clientIp, setSessionCookie } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { jsonBody } from '../../http/validate.js';
import { toMe } from './accounts.js';
import { beginOAuth, consumeOAuth, safeReturnTo } from './oauth-state.js';
import { createSession, deleteSession } from './sessions.js';
import { completeSignIn } from './sign-in.js';
import { getWorkspaceSettings } from '../workspaces/settings.js';
import { forWorkspace } from '../../core/workspace-context.js';

/** /auth — Google sign-in (OAuth 2.0 authorization code + PKCE), the demo fake login, sign-out. */
export function authRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const signInDeps = { ctx: deps.ctx, clock: deps.clock, config: deps.config, secretBox: deps.secretBox };

  /** Back to the web app with an error/notice code the sign-in page understands. */
  const backToApp = (c: Context, returnTo: string, param?: { auth_error?: AuthErrorCode; auth_notice?: AuthNoticeCode }) => {
    const isAbsolute = /^https?:\/\//.test(returnTo);
    const url = new URL(returnTo, deps.config.baseUrl);
    for (const [k, v] of Object.entries(param ?? {})) if (v) url.searchParams.set(k, v);
    return c.redirect(isAbsolute ? url.toString() : url.pathname + url.search, 302);
  };

  const startSession = (c: Context<AppEnv>, accountId: number) => {
    const previous = c.get('sessionToken');
    if (previous) deleteSession(deps.ctx, previous); // never reuse a session id across sign-ins
    const token = createSession(deps.ctx, deps.clock, accountId, {
      userAgent: c.req.header('user-agent'),
      ip: clientIp(c, deps.config.trustProxyHops),
    });
    setSessionCookie(c, deps, token);
  };

  // Step 1: send the browser to Google. The redirect URI is always BASE_URL-based, never taken
  // from the request's Host / X-Forwarded-Host headers.
  app.get('/google/start', (c) => {
    const returnTo = safeReturnTo(c.req.query('return_to'), deps.config);
    if (!deps.google) return backToApp(c, returnTo, { auth_error: 'google_unavailable' });
    const { state, challenge } = beginOAuth(c, deps.secretBox, deps.clock, { secure: deps.config.secureCookies, returnTo });
    const loginHint = c.get('account')?.email;
    return c.redirect(deps.google.authorizationUrl({ state, codeChallenge: challenge, loginHint, selectAccount: c.req.query('switch') === '1' }), 302);
  });

  // Step 2: Google sends the browser back here with ?code&state (or ?error).
  app.get('/google/callback', async (c) => {
    const pending = consumeOAuth(c, deps.secretBox, deps.clock, { secure: deps.config.secureCookies, state: c.req.query('state') });
    if (!pending) return backToApp(c, '/', { auth_error: 'state_mismatch' });
    if (c.req.query('error')) return backToApp(c, pending.returnTo, { auth_error: 'access_denied' });
    const code = c.req.query('code');
    if (!code || !deps.google) return backToApp(c, pending.returnTo, { auth_error: 'exchange_failed' });

    let tokens;
    try {
      tokens = await deps.google.exchangeCode({ code, codeVerifier: pending.verifier });
    } catch (err) {
      deps.log.warn('google code exchange failed', { error: err instanceof Error ? err.message : String(err) });
      return backToApp(c, pending.returnTo, { auth_error: 'exchange_failed' });
    }

    const result = completeSignIn(signInDeps, { identity: tokens.identity, tokens: { refreshToken: tokens.refreshToken, scopes: tokens.scopes } });
    if (!result.ok) {
      deps.log.warn('sign-in refused', { reason: result.reason, email: tokens.identity.email });
      return backToApp(c, pending.returnTo, { auth_error: result.reason });
    }
    startSession(c, result.account.id);
    deps.log.info('signed in', { accountId: result.account.id, role: result.account.role, created: result.created, gmail: result.gmail });
    return backToApp(c, pending.returnTo, result.gmail === 'not_connected' ? { auth_notice: 'gmail_not_connected' } : undefined);
  });

  // Demo-only fake sign-in. Exists only when DEV_FAKE_LOGIN is on, which config.ts refuses unless
  // BASE_URL is localhost and NODE_ENV is not production. Same authorization rules as Google.
  app.post('/dev-login', jsonBody(devLoginRequestSchema), (c) => {
    if (!deps.config.devFakeLogin) throw notFound();
    const email = (c.req.valid('json').email ?? DEMO_OWNER_EMAIL).toLowerCase();
    const result = completeSignIn(signInDeps, { identity: { sub: `fake:${email}`, email, emailVerified: true, name: null }, tokens: null });
    if (!result.ok) throw forbidden(result.reason === 'not_authorized' ? 'This Google account is not authorized' : `Sign-in refused (${result.reason})`);
    startSession(c, result.account.id);
    const settings = getWorkspaceSettings(forWorkspace(deps.ctx, result.account.id));
    return c.json(toMe(result.account, settings.onboardingCompleted));
  });

  app.post('/logout', (c) => {
    const token = c.get('sessionToken');
    if (token) deleteSession(deps.ctx, token);
    clearSessionCookie(c, deps);
    return c.json({ ok: true });
  });

  return app;
}
