import assert from 'node:assert/strict';
import test from 'node:test';
import relay from '../workers/truth-social-relay/worker.mjs';

const token = 't'.repeat(48);
const env = { RELAY_TOKEN: token };
const call = (path, { auth = `Bearer ${token}`, method = 'GET', settings = env } = {}) =>
  relay.fetch(new Request(`https://relay.example.workers.dev${path}`, { method, headers: auth ? { authorization: auth } : {} }), settings);

async function withUpstream(respond, run) {
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init }); return respond(); };
  try { await run(requests); } finally { globalThis.fetch = original; }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

test('the relay returns one Truth Social status for an authorized caller and asks for nothing else', async () => {
  await withUpstream(() => json({ id: '117507817818004689' }), async requests => {
    const response = await call('/status/117507817818004689');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: '117507817818004689' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://truthsocial.com/api/v1/statuses/117507817818004689');
    assert.equal(requests[0].init.redirect, 'manual');
    // The caller's token never travels upstream.
    assert.equal(requests[0].init.headers.authorization, undefined);
  });
});

test('missing, wrong or unconfigured tokens, other methods and other paths are refused without an upstream request', async () => {
  await withUpstream(() => json({}), async requests => {
    assert.equal((await call('/status/1', { auth: null })).status, 401);
    assert.equal((await call('/status/1', { auth: `Bearer ${'x'.repeat(48)}` })).status, 401);
    assert.equal((await call('/status/1', { auth: token })).status, 401);
    assert.equal((await call('/status/1', { settings: {} })).status, 503);
    assert.equal((await call('/status/1', { settings: { RELAY_TOKEN: 'short' }, auth: 'Bearer short' })).status, 503);
    assert.equal((await call('/status/1', { method: 'POST' })).status, 405);
    for (const path of ['/status/abc', '/status/1/context', '/api/v1/statuses/1', '/status/1?x=1', '/status/123456789012345678901', '/']) {
      assert.equal((await call(path)).status, 404, path);
    }
    assert.equal(requests.length, 0);
  });
});

test('upstream blocks, redirects and non-JSON become relay failures; missing posts stay missing', async () => {
  for (const [upstream, expected] of [
    [() => new Response('<html>Just a moment...</html>', { status: 403, headers: { 'content-type': 'text/html' } }), 502],
    [() => new Response(null, { status: 302, headers: { location: 'https://truthsocial.com/login' } }), 502],
    [() => new Response('{}', { headers: { 'content-type': 'text/html' } }), 502],
    [() => json({ padding: 'x'.repeat(600 * 1024) }), 502],
    [() => json({ error: 'Record not found' }, 404), 404],
    [() => { throw new TypeError('network'); }, 502],
  ]) {
    await withUpstream(upstream, async () => assert.equal((await call('/status/1')).status, expected));
  }
});
