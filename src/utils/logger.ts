/**
 * Structured logger — lightweight wrapper around console with log levels.
 *
 * Outputs JSON in production, human-readable in development.
 * Log level is controlled by the LOG_LEVEL env var (default: info).
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

const currentLevel: LogLevel =
  (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info';

const isProd = process.env['NODE_ENV'] === 'production';

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function formatMessage(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>
): string {
  const ts = new Date().toISOString();

  if (isProd) {
    // JSON for log aggregators (Railway, Datadog, etc.)
    return JSON.stringify({ ts, level, message, ...meta });
  }

  // Pretty output for development
  const prefix: Record<LogLevel, string> = {
    debug: '\x1b[90m[DEBUG]\x1b[0m',
    info:  '\x1b[36m[INFO] \x1b[0m',
    warn:  '\x1b[33m[WARN] \x1b[0m',
    error: '\x1b[31m[ERROR]\x1b[0m',
  };

  const metaStr = meta && Object.keys(meta).length > 0
    ? ' ' + JSON.stringify(meta)
    : '';

  return `${ts} ${prefix[level]} ${message}${metaStr}`;
}

function log(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>
): void {
  if (!shouldLog(level)) return;

  const formatted = formatMessage(level, message, meta);

  if (level === 'error') {
    console.error(formatted);
  } else if (level === 'warn') {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) =>
    log('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) =>
    log('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) =>
    log('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) =>
    log('error', message, meta),
};
