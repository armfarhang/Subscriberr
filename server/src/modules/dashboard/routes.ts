import { Hono } from 'hono';
import { workspaceOf } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { getDashboard } from './dashboard.js';

/** /api/dashboard — the landing page in one call (workspace-scoped). */
export function dashboardRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.get('/', (c) => c.json(getDashboard(workspaceOf(c), deps.clock)));
  return app;
}
