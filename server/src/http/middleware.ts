import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { getConnInfo } from '@hono/node-server/conninfo';
import { AppError, errorBody, forbidden, unauthorized } from '../core/errors.js';
import { resolveSession, SESSION_COOKIE, SESSION_TTL_MS } from '../modules/auth/sessions.js';
import type { AppDeps, AppEnv } from './types.js';

/** Client IP: the first X-Forwarded-For hop when TRUST_PROXY is on (behind NPM), else the socket. */
export function clientIp(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null; // app.request() in tests has no socket
  }
}

export function setSessionCookie(c: Context, deps: AppDeps, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: deps.config.secureCookies,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context, deps: AppDeps): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: deps.config.secureCookies });
}

/** Loads the signed-in account (if any) into the request context. */
export function sessionMiddleware(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE) ?? null;
    const account = token ? resolveSession(deps.ctx, deps.clock, token) : null;
    c.set('sessionToken', account ? token : null);
    c.set('account', account);
    await next();
  };
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('account')) throw unauthorized();
  await next();
};

export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  const account = c.get('account');
  if (!account) throw unauthorized();
  if (account.role !== 'owner') throw forbidden('Only the owner can do this');
  await next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'subscriberr';

/**
 * CSRF protection for state-changing requests (Spec §5.1): the SameSite=Lax cookie, plus a
 * custom header that a cross-site form or simple request cannot send, plus an Origin check.
 */
export function csrfMiddleware(deps: AppDeps): MiddlewareHandler<AppEnv> {
  const allowedOrigin = new URL(deps.config.baseUrl).origin;
  const isLocalDev = (origin: string) => !deps.config.isProduction && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (c.req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) throw forbidden('Missing CSRF header');
    const origin = c.req.header('origin');
    if (origin && origin !== allowedOrigin && !isLocalDev(origin)) throw forbidden('Cross-origin request refused');
    await next();
  };
}

export function errorHandler(deps: AppDeps): ErrorHandler<AppEnv> {
  return (err, c) => {
    if (err instanceof AppError) return c.json(errorBody(err.code, err.message, err.details), err.status);
    if (err instanceof HTTPException) {
      return c.json(errorBody(err.status === 400 ? 'bad_request' : 'http_error', err.message || 'Request failed'), err.status);
    }
    deps.log.error('unhandled error', { path: c.req.path, method: c.req.method, err });
    return c.json(errorBody('internal_error', 'Something went wrong'), 500);
  };
}
