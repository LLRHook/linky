import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEromeImageDownloader } from '../src/services/EromeImage';

const source = 'https://s63.erome.com/Album/photo.jpg', album = 'https://www.erome.com/a/Album';
const bytes = Buffer.from('verified elsewhere image bytes'), signal = new AbortController().signal;
const headers = { 'content-type': 'image/jpeg', 'content-length': String(bytes.length), etag: '"stable"' };
const dns = async () => ['93.184.216.34'];

test('image transport pins public DNS, validates HEAD and GET and preserves bytes', async () => {
  const downloader = createEromeImageDownloader({ dns, connect: async (options, abort) => {
    assert.equal(abort.aborted, false); assert.equal(options.hostname, 's63.erome.com');
    assert.equal(options.servername, 's63.erome.com'); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.path, '/Album/photo.jpg'); assert.equal(options.agent, false);
    const sent = options.headers as Record<string, string>;
    assert.equal(sent.Referer, album); assert.equal(sent['Accept-Encoding'], 'identity');
    assert.equal(sent['If-Match'], options.method === 'GET' ? '"stable"' : undefined);
    assert.equal(sent.Cookie, undefined);
    return new Response(options.method === 'HEAD' ? null : bytes, { headers });
  } });
  const head = await downloader.inspect(source, album, signal); assert.ok(head);
  assert.deepEqual(await downloader.download(source, album, head, signal), bytes);
});

test('image requests fail closed on private DNS and unsupported source paths', async () => {
  for (const answers of [['127.0.0.1'], ['93.184.216.34', '10.0.0.1'], [], ['169.254.169.254']]) {
    const downloader = createEromeImageDownloader({ dns: async () => answers,
      connect: async () => assert.fail('unsafe DNS reached transport') });
    assert.equal(await downloader.inspect(source, album, signal), null);
  }
  const downloader = createEromeImageDownloader({ dns: async () => assert.fail('invalid URL reached DNS') });
  for (const invalid of [source + '?x=1', source.replace('.jpg', '.svg'), source.replace('s63', 'v63')])
    assert.equal(await downloader.inspect(invalid, album, signal), null);
});

test('image metadata rejects weak validators, cookies, compression, partial responses and active formats', async () => {
  const changes: Record<string, string>[] = [{ etag: 'W/"stable"' }, { etag: '' }, { 'set-cookie': 'session=x' },
    { 'content-encoding': 'gzip' }, { 'content-range': 'bytes 0-3/10' }, { 'content-type': 'image/svg+xml' },
    { 'content-length': '8388609' }, { 'content-length': '-1' }];
  for (const change of changes) {
    const downloader = createEromeImageDownloader({ dns, connect: async () => new Response(null, { headers: { ...headers, ...change } }) });
    assert.equal(await downloader.inspect(source, album, signal), null, JSON.stringify(change));
  }
  const expected = { bytes: bytes.length, etag: '"stable"', mimeType: 'image/jpeg' as const };
  for (const response of [new Response(bytes, { headers: { ...headers, etag: '"changed"' } }),
    new Response('short', { headers }), new Response(null, { status: 412, headers })]) {
    const downloader = createEromeImageDownloader({ dns, connect: async () => response });
    assert.equal(await downloader.download(source, album, expected, signal), null);
  }
});
