import pino from 'pino';

/**
 * Structured logger using pino.
 * In development, uses pino-pretty for human-readable output.
 * In production, writes JSON to stdout (captured by Docker).
 */
export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  ...(process.env['NODE_ENV'] !== 'production'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});
