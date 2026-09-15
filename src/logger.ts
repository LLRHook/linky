import pino from 'pino';

const ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
  'EvalError', 'AggregateError', 'AbortError', 'TimeoutError', 'FetchError', 'HTTPError', 'DiscordAPIError']);
const SYSTEM_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'ENOSPC', 'EACCES', 'EPERM', 'ENOENT', 'EMFILE', 'ENFILE', 'ABORT_ERR', 'ERR_ABORTED',
  'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Discord errors retain uploaded buffers and message bodies; never pass those objects to JSON serialization. */
function safeError(error: unknown): Record<string, string | number> {
  const field = (key: string): unknown => {
    try { return typeof error === 'object' && error !== null ? Reflect.get(error, key) : undefined; }
    catch { return undefined; }
  };
  const name = field('name'), code = field('code'), status = field('status'), method = field('method');
  const type = typeof name === 'string' && /^DiscordAPIError\[\d+\]$/.test(name) ? 'DiscordAPIError' : name;
  const result: Record<string, string | number> = { type: typeof type === 'string' && ERROR_TYPES.has(type) ? type : 'Error' };
  if (typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 ||
    typeof code === 'string' && SYSTEM_CODES.has(code)) result.code = code;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) result.status = status;
  if (typeof method === 'string' && METHODS.has(method)) result.method = method;
  return result;
}

/**
 * Structured logger using pino.
 * In development, uses pino-pretty for human-readable output.
 * In production, writes JSON to stdout (captured by Docker).
 */
export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  serializers: { err: safeError },
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
