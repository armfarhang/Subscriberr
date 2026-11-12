import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Health, PublicConfig } from '@subscriberr/shared';
import { errorBody } from './core/errors.js';
import { nowIso } from './core/time.js';
import { currentSchemaVersion } from './db/migrate.js';
import { clientIp, csrfMiddleware, errorHandler, requireAuth, sessionMiddleware, workspaceOf } from './http/middleware.js';
import { rateLimit } from './http/rate-limit.js';
import type { AppDeps, AppEnv } from './http/types.js';
import { toMe } from './modules/auth/accounts.js';
import { allowlistRoutes } from './modules/auth/allowlist-routes.js';
import { FakeGoogleAuthProvider, fakeGoogleRoutes } from './modules/auth/fake-google.js';
import { authRoutes } from './modules/auth/routes.js';
import { memberRoutes } from './modules/members/routes.js';
import { systemRoutes } from './modules/system/routes.js';
import { workspaceRoutes } from './modules/workspaces/routes.js';
import { getWorkspaceSettings } from './modules/workspaces/settings.js';
import { APP_NAME, APP_VERSION } from './version.js';

/** Sign-in endpoints: 30 requests per client IP per 5 minutes (Spec §16). */
export const AUTH_RATE_LIMIT = { windowMs: 5 * 60_000, max: 30 };

/** Builds the Hono app: middleware → module routes → static web app. */
export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler(deps));

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
      // HSTS only makes sense on the public HTTPS URL (NPM terminates TLS).
      strictTransportSecurity: deps.config.secureCookies ? 'max-age=15552000' : false,
      // Never send our URLs to other sites. ('no-referrer' would also make browsers send
      // `Origin: null` on our own form posts, which the origin checks must then refuse.)
      referrerPolicy: 'same-origin',
    }),
  );

  // Unauthenticated liveness probe (Docker HEALTHCHECK).
  app.get('/healthz', (c) => {
    try {
      deps.ctx.sqlite.prepare('SELECT 1').get();
      const body: Health = { status: 'ok', version: APP_VERSION, schemaVersion: currentSchemaVersion(deps.ctx.sqlite), time: nowIso(deps.clock) };
      return c.json(body);
    } catch (err) {
      deps.log.error('healthcheck failed', { err });
      return c.json({ status: 'degraded', version: APP_VERSION, schemaVersion: 0, time: nowIso(deps.clock) } satisfies Health, 503);
    }
  });

  const authLimiter = rateLimit({
    ...AUTH_RATE_LIMIT,
    clock: deps.clock,
    key: (c) => clientIp(c, deps.config.trustProxyHops),
    // Browser navigations (the OAuth redirects) go back to the sign-in page; API calls get JSON.
    onLimited: (c) => (c.req.method === 'GET' ? c.redirect('/?auth_error=rate_limited', 302) : c.json(errorBody('rate_limited', 'Too many attempts. Try again in a few minutes.'), 429)),
  });
  app.use('/auth/*', authLimiter);

  app.use('/api/*', csrfMiddleware(deps), sessionMiddleware(deps));
  app.use('/auth/*', csrfMiddleware(deps), sessionMiddleware(deps));

  app.get('/api/public-config', (c) => {
    const body: PublicConfig = {
      appName: APP_NAME,
      version: APP_VERSION,
      devFakeLogin: deps.config.devFakeLogin,
      demoMode: deps.config.seedDemo,
      googleSignIn: deps.google !== null,
    };
    return c.json(body);
  });

  app.route('/auth', authRoutes(deps));

  // The fake Google consent page exists only while the fake provider is active (demo mode).
  if (deps.google instanceof FakeGoogleAuthProvider) {
    app.use('/dev/google/*', authLimiter);
    app.route('/dev/google', fakeGoogleRoutes(deps.google, { callbackUrl: deps.config.googleRedirectUri, allowedOrigin: new URL(deps.config.baseUrl).origin }));
  }

  // Everything else under /api needs a session.
  app.use('/api/*', async (c, next) => (c.req.path === '/api/public-config' ? next() : requireAuth(c, next)));
  app.get('/api/me', (c) => c.json(toMe(c.get('account')!, getWorkspaceSettings(workspaceOf(c)).onboardingCompleted)));
  app.route('/api/workspace', workspaceRoutes(deps));
  app.route('/api/members', memberRoutes(deps));
  app.route('/api/allowlist', allowlistRoutes(deps));
  app.route('/api/system', systemRoutes(deps));

  app.all('/api/*', (c) => c.json(errorBody('not_found', 'Not found'), 404));
  app.all('/auth/*', (c) => c.json(errorBody('not_found', 'Not found'), 404));

  // Built web app + SPA fallback.
  const webDir = deps.webDir;
  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    const indexHtml = readFileSync(path.join(webDir, 'index.html'), 'utf8');
    app.use('/assets/*', async (c, next) => {
      await next();
      if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable');
    });
    app.use('*', serveStatic({ root: webDir }));
    app.get('*', (c) => c.html(indexHtml));
  } else {
    app.get('/', (c) => c.text(`${APP_NAME} ${APP_VERSION} API is running. The web app has not been built (npm run build).`));
  }

  app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));
  return app;
}
