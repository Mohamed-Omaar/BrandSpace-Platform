import { redact } from './redaction';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Correlation fields carried on every log line — docs/ARCHITECTURE.md §3.10. */
export interface LogContext {
  requestId?: string;
  traceId?: string;
  workspaceId?: string;
  actorId?: string;
  actorType?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(context: LogContext): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  context?: LogContext;
  /** Injected so tests can capture output instead of writing to stdout. */
  sink?: (line: string) => void;
}

/**
 * Structured JSON logger. Every field passes through the redaction layer before
 * it reaches the sink — a developer cannot log a secret by accident.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const context = options.context ?? {};
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));

  function emit(logLevel: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[logLevel] < LEVEL_ORDER[level]) return;
    const payload = {
      level: logLevel,
      // A log timestamp is wall-clock by definition and is never an input to
      // business logic, so it needs no injected clock.
      // eslint-disable-next-line no-restricted-syntax -- justified above
      time: new Date().toISOString(),
      msg: String(redact(msg)),
      ...(redact(context) as Record<string, unknown>),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    sink(JSON.stringify(payload));
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (childContext) =>
      createLogger({
        level,
        context: { ...context, ...childContext },
        ...(options.sink ? { sink: options.sink } : {}),
      }),
  };
}
