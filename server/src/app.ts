import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Health, PublicConfig } from '@subscriberr/shared';
import { errorBody } from './core/errors.js';
import { nowIso } from './core/time.js';
import { currentSchemaVersion } from './db/migrate.js';
import { csrfMiddleware, errorHandler, requireAuth, sessionMiddleware } from './http/middleware.js';
import type { AppDeps, AppEnv } from './http/types.js';
import { toMe } from './modules/auth/accounts.js';
import { authRoutes } from './modules/auth/routes.js';
import { systemRoutes } from './modules/system/routes.js';
import { APP_NAME, APP_VERSION } from './version.js';

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

  app.use('/api/*', csrfMiddleware(deps), sessionMiddleware(deps));
  app.use('/auth/*', csrfMiddleware(deps), sessionMiddleware(deps));

  app.get('/api/public-config', (c) => {
    const body: PublicConfig = { appName: APP_NAME, version: APP_VERSION, devFakeLogin: deps.config.devFakeLogin, demoMode: deps.config.seedDemo };
    return c.json(body);
  });

  app.route('/auth', authRoutes(deps));

  // Everything else under /api needs a session.
  app.use('/api/*', async (c, next) => (c.req.path === '/api/public-config' ? next() : requireAuth(c, next)));
  app.get('/api/me', (c) => c.json(toMe(c.get('account')!)));
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
