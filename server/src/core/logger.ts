// Minimal JSON-lines logger (stdout). No dependency; one line per event.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|api[-_]?key|credential/i;
// Bearer tokens, Google OAuth tokens and Plex/Jellyfin tokens that end up inside error messages or URLs.
const SECRET_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}|\b(ya29\.|1\/\/)[A-Za-z0-9._-]{10,}|((?:X-Plex-Token|X-Emby-Token|api_key|access_token|refresh_token|client_secret)["']?\s*[=:]\s*["']?)[^\s"'&,}]+/gi;

const scrub = (text: string): string => text.replace(SECRET_VALUE, (_m, bearer?: string, google?: string, named?: string) => `${bearer ?? google ?? named ?? ''}[redacted]`);

/**
 * Logs go to stdout (docker logs) and to the System page, so secrets must never reach them:
 * fields with secret-looking names are dropped and token-shaped substrings are masked.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: scrub(value.message), stack: value.stack ? scrub(value.stack) : undefined };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && typeof v !== 'boolean' && typeof v !== 'number' ? '[redacted]' : redact(v, depth + 1);
  return out;
}

export function createLogger(
  level: LogLevel = 'info',
  sink: LogSink = (line) => process.stdout.write(`${line}\n`),
  bindings: Record<string, unknown> = {},
): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const record: Record<string, unknown> = { time: new Date().toISOString(), level: lvl, msg: scrub(msg), ...bindings };
    for (const [k, v] of Object.entries((redact(fields ?? {}) as Record<string, unknown>) ?? {})) record[k] = v;
    sink(JSON.stringify(record));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (b) => createLogger(level, sink, { ...bindings, ...b }),
  };
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = createLogger('error', () => {});

/**
 * Keeps the last `size` log lines in memory for the System page ("recent errors", "log tail").
 * Lines are already structured JSON; nothing is written to disk.
 */
export interface LogBuffer {
  /** Wraps a sink so every line is also kept here. */
  tee(sink: LogSink): LogSink;
  lines(opts?: { minLevel?: LogLevel; limit?: number }): Array<{ time: string; level: LogLevel; msg: string; fields: Record<string, unknown> }>;
}

export function createLogBuffer(size = 500): LogBuffer {
  const ring: string[] = [];
  return {
    tee: (sink) => (line) => {
      ring.push(line);
      if (ring.length > size) ring.splice(0, ring.length - size);
      sink(line);
    },
    lines: ({ minLevel = 'debug', limit = 200 } = {}) => {
      const out: ReturnType<LogBuffer['lines']> = [];
      for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
        try {
          const { time, level, msg, ...fields } = JSON.parse(ring[i]!) as { time: string; level: LogLevel; msg: string } & Record<string, unknown>;
          if (ORDER[level] >= ORDER[minLevel]) out.push({ time, level, msg, fields });
        } catch {
          // not one of ours
        }
      }
      return out;
    },
  };
}

export const stdoutSink: LogSink = (line) => process.stdout.write(`${line}\n`);
