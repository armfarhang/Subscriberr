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

function serializeError(err: unknown): unknown {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return err;
}

export function createLogger(
  level: LogLevel = 'info',
  sink: LogSink = (line) => process.stdout.write(`${line}\n`),
  bindings: Record<string, unknown> = {},
): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const record: Record<string, unknown> = { time: new Date().toISOString(), level: lvl, msg, ...bindings };
    for (const [k, v] of Object.entries(fields ?? {})) record[k] = k === 'err' ? serializeError(v) : v;
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
