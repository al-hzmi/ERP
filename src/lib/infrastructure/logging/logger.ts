/**
 * Structured logging.
 *
 * Two rules govern everything here:
 *   1. Logs are JSON in production, so they are queryable rather than greppable.
 *   2. Nothing sensitive is ever written. Passwords, tokens, national IDs, IBANs
 *      and salaries are redacted by key name before serialisation — an incident
 *      is not the moment to discover that a debug line was logging a payload.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = Record<string, unknown>;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Any key matching these is replaced with `[REDACTED]`, at any nesting depth. */
const SENSITIVE_KEY_PATTERN =
  /password|passwordhash|token|secret|authorization|cookie|iban|nationalid|salary|apikey|privatekey|creditcard|cvv/i;

const MAX_DEPTH = 6;

function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      // Stack traces stay server-side only, and never reach a response body.
      stack: process.env.NODE_ENV === 'production' ? undefined : value.stack,
    };
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redact(nested, depth + 1);
    }
    return result;
  }
  return value;
}

class Logger {
  private readonly minimumLevel: LogLevel;

  constructor() {
    const configured = process.env['LOG_LEVEL'];
    this.minimumLevel = isLogLevel(configured)
      ? configured
      : process.env.NODE_ENV === 'production'
        ? 'info'
        : 'debug';
  }

  debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minimumLevel]) return;

    const entry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(context !== undefined ? { context: redact(context) } : {}),
    };

    const line =
      process.env.NODE_ENV === 'production'
        ? JSON.stringify(entry)
        : `[${level.toUpperCase()}] ${message}${
            context !== undefined ? ` ${JSON.stringify(redact(context))}` : ''
          }`;

    // eslint-disable-next-line no-console
    if (level === 'error') console.error(line);
    // eslint-disable-next-line no-console
    else if (level === 'warn') console.warn(line);
    // eslint-disable-next-line no-console
    else console.log(line);
  }
}

function isLogLevel(value: string | undefined): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

export const logger = new Logger();
