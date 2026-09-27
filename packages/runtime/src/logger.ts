import pino from 'pino';

export type Logger = pino.Logger;

export interface LoggerOptions {
  service: string;
  level?: string;
  /** Where JSON lines go; stdout by default. Tests pass a collecting stream. */
  destination?: pino.DestinationStream;
}

/**
 * Credential-bearing fields replaced with `[Redacted]` wherever a log line carries them,
 * including inside serialized errors (SDK and HTTP errors can hold their request or
 * response headers).
 */
export const REDACTED_LOG_PATHS: readonly string[] = [
  'password', '*.password',
  'passwordHash', '*.passwordHash',
  'token', '*.token',
  'authToken', '*.authToken',
  'apiKey', '*.apiKey',
  'secret', '*.secret',
  'authorization', '*.authorization',
  'headers.authorization', '*.headers.authorization', '*.*.headers.authorization',
  'headers.cookie', '*.headers.cookie', '*.*.headers.cookie',
  '*.headers["set-cookie"]', '*.headers["x-api-key"]', '*.*.headers["x-api-key"]',
];

/** JSON logs to stdout; the monitoring stack's log shipper reads them from the container. */
export function createLogger(options: LoggerOptions): Logger {
  const config: pino.LoggerOptions = {
    level: options.level || 'info',
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: [...REDACTED_LOG_PATHS],
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}

/** A logger that discards everything, for callers that don't inject one. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
