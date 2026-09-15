import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { request as httpsRequest, RequestOptions } from 'node:https';
import { isPublicIpv4, requestErome, type RegionalHttpDependencies, type RegionalOriginOptions } from '../src/services/RegionalHttp';

const source = 'https://v63.erome.com/7242/Album123/video_720p.mp4';
const album = 'https://www.erome.com/a/Album123';
const head = (): RegionalOriginOptions => ({ method: 'HEAD', album, signal: new AbortController().signal });
const get = (): RegionalOriginOptions => ({ ...head(), method: 'GET', range: { start: 4, end: 7, length: 4 }, etag: '"version"' });

test('public IPv4 policy rejects private, shared, loopback, reserved, documentation and multicast space', () => {
  for (const ip of ['0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    '255.255.255.255', '127.1', '0x7f000001', '::1', '::ffff:127.0.0.1', '1.2.3.999']) assert.equal(isPublicIpv4(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1']) assert.equal(isPublicIpv4(ip), true, ip);
});

test('transport pins the resolved address while retaining hostname TLS and exact conditional range headers', async () => {
  let resolutions = 0;
  const dependencies: RegionalHttpDependencies = {
    resolve4: async hostname => { resolutions++; assert.equal(hostname, 'v63.erome.com'); return ['1.1.1.1']; },
    connect: async (options, signal) => {
      assert.equal(options.hostname, 'v63.erome.com');
      assert.equal(options.servername, 'v63.erome.com');
      assert.equal(options.agent, false);
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.family, 4);
      assert.equal(options.port, 443);
      assert.equal(options.maxHeaderSize, 8192);
      assert.equal(options.path, '/7242/Album123/video_720p.mp4');
      assert.equal(signal.aborted, false);
      const headers = new Headers(options.headers as Record<string, string>);
      assert.equal(headers.get('range'), 'bytes=4-7');
      assert.equal(headers.get('if-match'), '"version"');
      assert.equal(headers.get('accept-encoding'), 'identity');
      assert.equal(headers.get('referer'), album);
      assert.equal(headers.has('cookie'), false);
      assert.equal(headers.has('authorization'), false);
      assert.ok(options.lookup);
      options.lookup!('v63.erome.com', {}, (error, address, family) => {
        assert.equal(error, null); assert.equal(address, '1.1.1.1'); assert.equal(family, 4);
      });
      options.lookup!('v63.erome.com', { all: true }, (error, addresses) => {
        assert.equal(error, null); assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }]);
      });
      return new Response('test', { status: 206 });
    },
  };
  const response = await requestErome(source, get(), dependencies);
  assert.equal(await response.text(), 'test');
  assert.equal(resolutions, 1);
});

test('all DNS answers must be public before connecting', async () => {
  let connects = 0;
  for (const addresses of [[], ['1.1.1.1', '127.0.0.1'], ['10.0.0.1'], Array(33).fill('1.1.1.1')]) {
    await assert.rejects(requestErome(source, head(), {
      resolve4: async () => addresses,
      connect: async () => { connects++; return new Response(); },
    }), /regional_dns/);
  }
  assert.equal(connects, 0);
});

test('noncanonical sources and malformed ranges fail before DNS', async () => {
  let resolutions = 0;
  const dependencies: RegionalHttpDependencies = { resolve4: async () => { resolutions++; return ['1.1.1.1']; } };
  for (const url of [source + '?x=1', source + '#x', source.replace('https:', 'http:'),
    source.replace('v63.erome.com', '127.0.0.1'), source.replace('v63.erome.com', 'v63.erome.com:443'),
    source.replace('v63.erome.com', 'v63.erome.com@evil.example'), source.replace('/7242/', '/%2e%2e/')]) {
    await assert.rejects(requestErome(url, head(), dependencies), /regional_source/);
  }
  for (const options of [
    { ...get(), range: undefined }, { ...get(), etag: 'W/"weak"' },
    { ...get(), range: { start: 0, end: 4, length: 4 } },
    { ...get(), range: { start: 0, end: 4 * 1024 * 1024, length: 4 * 1024 * 1024 + 1 } },
    { ...head(), etag: '"extra"' },
  ]) await assert.rejects(requestErome(source, options, dependencies), /regional_source/);
  assert.equal(resolutions, 0);
});

test('redirects, response cookies and compressed bytes are rejected and cancelled', async () => {
  const examples: { status: number; headers: Record<string, string> }[] = [
    { status: 302, headers: { location: 'https://evil.example' } },
    { status: 200, headers: { 'set-cookie': 'session=private' } },
    { status: 200, headers: { 'content-encoding': 'gzip' } },
  ];
  for (const example of examples) {
    let cancelled = false;
    await assert.rejects(requestErome(source, head(), {
      resolve4: async () => ['1.1.1.1'],
      connect: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), example),
    }), /regional_source_headers/);
    assert.equal(cancelled, true);
  }
});

test('HEAD sends no range/condition and returns headers without consuming media', async () => {
  const response = await requestErome(source, head(), {
    resolve4: async () => ['1.1.1.1'],
    connect: async options => {
      assert.equal(options.method, 'HEAD');
      const headers = new Headers(options.headers as Record<string, string>);
      assert.equal(headers.has('range'), false);
      assert.equal(headers.has('if-match'), false);
      return new Response(null, { headers: { 'content-length': '25026293', etag: '"version"' } });
    },
  });
  assert.equal(response.body, null);
  assert.equal(response.headers.get('content-length'), '25026293');
});

test('abort bounds stalled DNS and cancels a response arriving after transport deadline', async () => {
  const dnsAbort = new AbortController();
  let connections = 0;
  const dns = requestErome(source, { ...head(), signal: dnsAbort.signal }, {
    resolve4: async () => new Promise<string[]>(() => undefined),
    connect: async () => { connections++; return new Response(); },
  });
  dnsAbort.abort();
  await assert.rejects(dns, /regional_aborted/);
  assert.equal(connections, 0);
  const connectionAbort = new AbortController();
  let finish!: (response: Response) => void;
  let cancelled = false;
  const connection = requestErome(source, { ...head(), signal: connectionAbort.signal }, {
    resolve4: async () => ['1.1.1.1'],
    connect: async () => new Promise<Response>(resolve => { finish = resolve; }),
  });
  await delay(0);
  connectionAbort.abort();
  await assert.rejects(connection, /regional_aborted/);
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await delay(0);
  assert.equal(cancelled, true);
});

test('native HTTPS adapter forwards abort and cancellation and safely rejects invalid statuses', async () => {
  for (const status of [206, 999]) {
    const incoming = new Readable({ read() { this.push(Buffer.from('test')); } }) as IncomingMessage;
    incoming.statusCode = status;
    incoming.rawHeaders = ['Content-Type', 'video/mp4'];
    let requestSignal: AbortSignal | undefined;
    const send = ((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      requestSignal = options.signal;
      const outgoing = new EventEmitter() as ClientRequest;
      outgoing.end = (() => { queueMicrotask(() => callback(incoming)); return outgoing; }) as ClientRequest['end'];
      outgoing.destroy = (() => outgoing) as ClientRequest['destroy'];
      return outgoing;
    }) as typeof httpsRequest;
    const options = get();
    const response = requestErome(source, options, { resolve4: async () => ['1.1.1.1'], request: send });
    if (status === 999) await assert.rejects(response, /regional_transport/);
    else await (await response).body!.cancel();
    assert.equal(requestSignal, options.signal);
    assert.equal(incoming.destroyed, true);
  }
});
