// Cloudflare Worker that relays Truth Social's public status API for Linky.
// Truth Social's bot protection rejects datacenter hosts such as the bot's server, but answers
// requests from Cloudflare's network. The relay serves one fixed, read-only, signed-out API path
// to callers holding RELAY_TOKEN; it is not a general proxy.

const STATUS = /^\/status\/(\d{1,20})$/;
const MAX_BYTES = 512 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; Linky/1.0; +https://linkybot.dev/)';

const reply = (status, body = '') => new Response(body, {
  status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/** Constant-time comparison of SHA-256 digests, so neither length nor content leaks through timing. */
async function same(given, expected) {
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') return reply(405);
    const token = typeof env.RELAY_TOKEN === 'string' ? env.RELAY_TOKEN : '';
    // Refuse to serve anyone until the operator has set a real secret.
    if (token.length < 32) return reply(503, 'relay token not configured');
    const auth = /^Bearer (\S{1,512})$/.exec(request.headers.get('authorization') ?? '');
    if (!auth || !await same(auth[1], token)) return reply(401);
    const url = new URL(request.url), match = STATUS.exec(url.pathname);
    if (!match || url.search) return reply(404);
    let upstream;
    try {
      upstream = await fetch(`https://truthsocial.com/api/v1/statuses/${match[1]}`, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT }, redirect: 'manual',
        cf: { cacheTtlByStatus: { '200': 60, '400-599': 0 } },
      });
    } catch { return reply(502, 'upstream unreachable'); }
    if (upstream.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(upstream.headers.get('content-type') ?? '')) {
      await upstream.body?.cancel();
      // 404 and 410 are the post's real state; anything else is the relay's failure.
      return reply([404, 410].includes(upstream.status) ? upstream.status : 502, `upstream ${upstream.status}`);
    }
    const body = await upstream.arrayBuffer();
    if (body.byteLength > MAX_BYTES) return reply(502, 'upstream too large');
    return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  },
};
