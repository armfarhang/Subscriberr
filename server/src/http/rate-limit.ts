import type { Context, MiddlewareHandler } from 'hono';
import type { Clock } from '../core/time.js';

// Fixed-window rate limiting per client IP (Spec §16: rate-limit auth endpoints). In-memory is
// enough: one process, ~20 members, and the limit only has to stop brute force and loops.

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  clock: Clock;
  key: (c: Context) => string | null;
  onLimited: (c: Context, retryAfterSeconds: number) => Response | Promise<Response>;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    const now = options.clock.now().getTime();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    const key = options.key(c) ?? 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      c.header('Retry-After', String(retryAfter));
      return options.onLimited(c, retryAfter);
    }
    await next();
  };
}
