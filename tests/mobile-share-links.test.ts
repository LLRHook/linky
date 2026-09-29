import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { RequestOptions } from 'node:https';
import { createMobileShareLinkNormalizer, type MobileShareLinkDependencies } from '../src/services/MobileShareLinks';

const share = 'https://www.instagram.com/share/reel/Share123';
const post = 'https://www.instagram.com/reel/Post123/';
const redditShare = 'https://www.reddit.com/r/aww/s/Share123';
const redditPost = 'https://www.reddit.com/r/aww/comments/abc123/title/';
const redirect = (location: string, status = 302): Response => new Response(null, { status, headers: { location } });
const fixture = (connect: NonNullable<MobileShareLinkDependencies['connect']>) => {
  const calls: RequestOptions[] = [];
  const normalizer = createMobileShareLinkNormalizer({
    resolve4: async () => ['1.1.1.1'],
    connect: async (options, signal) => { calls.push(options); return connect(options, signal); },
  });
  return { normalizer, calls };
};

test('Instagram bare, post and reel share forms resolve with exact source buttons, text and punctuation intact', async () => {
  for (const path of ['/share/Share123', '/share/p/Share123/', '/share/reel/Share123']) {
    const original = `https://m.instagram.com${path}?igsh=abcd#slide2`;
    const f = fixture(async options => {
      assert.equal(options.path, path + '?igsh=abcd');
      return redirect('https://instagram.com/p/Post123/?igsh=redirected');
    });
    const result = await f.normalizer(`See **${original}**.`, ['instagram']);
    const canonical = 'https://www.instagram.com/p/Post123/#slide2';
    assert.equal(result.content, `See **${canonical}**.`);
    assert.deepEqual([...result.originals], [[canonical, original]]);
    assert.equal(f.calls.length, 1);
  }
});

test('supported Reddit mobile share redirects and identity-bearing aliases normalize to supported posts', async () => {
  for (const share of [redditShare, 'https://m.reddit.com/u/alice/s/Share123', 'https://reddit.com/user/alice/s/Share123']) {
    const f = fixture(async () => redirect(redditPost + '?utm_source=share'));
    const result = await f.normalizer(share, ['reddit']);
    assert.equal(result.content, redditPost);
    assert.deepEqual([...result.originals], [[redditPost, share]]);
  }
  const f = fixture(async () => assert.fail('Identity-bearing aliases do not need DNS or HTTP'));
  const original = 'https://redd.it/AbC123?utm_source=share#thread';
  const result = await f.normalizer(`${original} https://m.reddit.com/r/aww/comments/abc123/title/?x=1`, ['reddit']);
  assert.equal(result.content, 'https://www.reddit.com/comments/AbC123#thread ' + redditPost);
  assert.equal(result.originals.get('https://www.reddit.com/comments/AbC123#thread'), original);
  assert.equal(f.calls.length, 0);
});

test('blocked Reddit app shares resolve through the fixed redirect service before normal rewriting', async () => {
  const original = redditShare + '?utm_source=ios#thread';
  const f = fixture(async options => options.hostname === 'www.reddit.com'
    ? new Response(null, { status: 403 })
    : redirect('https://rxddit.com/r/aww/comments/abc123/title/?utm_source=redirect'));
  const result = await f.normalizer(original, ['reddit']);
  assert.equal(result.content, redditPost + '#thread');
  assert.deepEqual([...result.originals], [[redditPost + '#thread', original]]);
  assert.deepEqual(f.calls.map(call => [call.hostname, call.path]), [
    ['www.reddit.com', '/r/aww/s/Share123?utm_source=ios'], ['rxddit.com', '/r/aww/s/Share123'],
  ]);
  const headers = new Headers(f.calls[1].headers as Record<string, string>);
  assert.match(headers.get('user-agent')!, /Linky/);
  assert.equal(headers.has('cookie'), false);
  assert.equal(headers.has('authorization'), false);
});

test('Reddit resolver accepts only validated canonical redirects and preserves failures', async () => {
  for (const location of [redditPost, '/r/aww/comments/abc123/title/',
    'https://rxddit.com/r/aww/comments/abc123/title/']) {
    const f = fixture(async options => options.hostname === 'www.reddit.com'
      ? new Response(null, { status: 403 }) : redirect(location));
    assert.equal((await f.normalizer(redditShare, ['reddit'])).content, redditPost);
  }
  for (const location of ['https://evil.test/comments/abc123', 'https://rxddit.com:443/comments/abc123',
    'https://user@rxddit.com/comments/abc123', 'https://www.rxddit.com/comments/abc123',
    'http://rxddit.com/comments/abc123', 'https://rxddit.com/foo/../comments/abc123',
    'https://rxddit.com/%2e%2e/comments/abc123', 'https://rxddit.com/r/aww/',
    'https://rxddit.com/login?next=' + redditPost, 'https://www.instagram.com/p/abc123/']) {
    const f = fixture(async options => options.hostname === 'www.reddit.com'
      ? new Response(null, { status: 403 }) : redirect(location));
    assert.equal((await f.normalizer(redditShare, ['reddit'])).content, redditShare, location);
    assert.equal(f.calls.length, 2);
  }
  for (const status of [200, 403, 404, 429, 502]) {
    const f = fixture(async options => new Response(null, { status: options.hostname === 'www.reddit.com' ? 403 : status }));
    const result = await f.normalizer(redditShare, ['reddit']);
    assert.equal(result.content, redditShare); assert.equal(result.originals.size, 0);
    assert.equal(f.calls.length, 2);
  }
});

test('Reddit fallback revalidates DNS and keeps the existing shared hop and time budgets', async () => {
  const requests: string[] = [], dns: string[] = [];
  const privateResolver = createMobileShareLinkNormalizer({
    resolve4: async host => { dns.push(host); return host === 'rxddit.com' ? ['127.0.0.1'] : ['1.1.1.1']; },
    connect: async options => { requests.push(String(options.hostname)); return new Response(null, { status: 403 }); },
  });
  assert.equal((await privateResolver(redditShare, ['reddit'])).content, redditShare);
  assert.deepEqual(dns, ['www.reddit.com', 'rxddit.com']);
  assert.deepEqual(requests, ['www.reddit.com']);
  const loop = fixture(async options => options.hostname === 'www.reddit.com'
    ? new Response(null, { status: 403 }) : redirect('/r/aww/s/Share' + loop.calls.length));
  assert.equal((await loop.normalizer(redditShare, ['reddit'])).content, redditShare);
  assert.equal(loop.calls.length, 4);
  const stalled = createMobileShareLinkNormalizer({ timeoutMs: 10, resolve4: async () => ['1.1.1.1'],
    connect: async options => options.hostname === 'www.reddit.com' ? new Response(null, { status: 403 })
      : new Promise<Response>(() => undefined),
  });
  assert.equal((await stalled(redditShare, ['reddit'])).content, redditShare);
});

test('fallback is restricted to blocked Reddit shares and never reads provider bodies', async () => {
  for (const status of [403, 429, 500, 502, 503]) {
    let cancelled = 0;
    const f = fixture(async options => new Response(new ReadableStream({
      pull() { assert.fail('Redirect resolution must not download HTML'); }, cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { status: options.hostname === 'www.reddit.com' ? status : 302,
      headers: { location: 'https://rxddit.com/comments/abc123', 'set-cookie': 'must-not-replay' } }));
    assert.equal((await f.normalizer(redditShare, ['reddit'])).content, 'https://www.reddit.com/comments/abc123');
    assert.equal(cancelled, 2);
  }
  for (const status of [200, 400, 401, 404, 410]) {
    const f = fixture(async () => new Response(null, { status }));
    assert.equal((await f.normalizer(redditShare, ['reddit'])).content, redditShare);
    assert.equal(f.calls.length, 1);
  }
  const instagram = fixture(async () => new Response(null, { status: 403 }));
  assert.equal((await instagram.normalizer(share, ['instagram', 'reddit'])).content, share);
  assert.equal(instagram.calls.length, 1);
});

test('public address is pinned independently on every requested redirect hop, preserving TLS hostname', async () => {
  let dns = 0, requests = 0;
  const normalizer = createMobileShareLinkNormalizer({
    resolve4: async host => { assert.equal(host, 'www.instagram.com'); return [++dns === 1 ? '1.1.1.1' : '8.8.8.8']; },
    connect: async (options, signal) => {
      requests++;
      assert.equal(signal.aborted, false);
      assert.equal(options.protocol, 'https:'); assert.equal(options.port, 443);
      assert.equal(options.hostname, 'www.instagram.com'); assert.equal(options.servername, options.hostname);
      assert.equal(options.family, 4); assert.equal(options.agent, false);
      assert.equal(options.rejectUnauthorized, true); assert.equal(options.maxHeaderSize, 8192);
      assert.equal(options.method, 'GET');
      const headers = new Headers(options.headers as Record<string, string>);
      assert.equal(headers.get('accept-encoding'), 'identity');
      for (const name of ['cookie', 'authorization', 'referer']) assert.equal(headers.has(name), false);
      const address = requests === 1 ? '1.1.1.1' : '8.8.8.8';
      options.lookup!(String(options.hostname), {}, (error, actual, family) => {
        assert.equal(error, null); assert.equal(actual, address); assert.equal(family, 4);
      });
      options.lookup!(String(options.hostname), { all: true }, (error, actual) => {
        assert.equal(error, null); assert.deepEqual(actual, [{ address, family: 4 }]);
      });
      return requests === 1 ? new Response(null, {
        status: 301, headers: { location: '/share/p/Next123', 'set-cookie': 'session=do-not-replay' },
      }) : redirect(post);
    },
  });
  assert.equal((await normalizer(share, ['instagram'])).content, post);
  assert.equal(dns, 2); assert.equal(requests, 2);
});

test('mixed, private, malformed and oversized DNS answer sets never open a connection', async () => {
  for (const addresses of [[], ['127.0.0.1'], ['1.1.1.1', '10.0.0.1'], ['169.254.169.254'],
    ['::ffff:127.0.0.1'], ['::1'], ['1.2.3.999'], Array(33).fill('1.1.1.1')]) {
    const normalizer = createMobileShareLinkNormalizer({
      resolve4: async () => addresses, connect: async () => assert.fail('Unsafe DNS must not connect'),
    });
    assert.equal((await normalizer(share, ['instagram'])).content, share);
  }
});

test('a public-to-private DNS rebind on the next share hop fails closed', async () => {
  let dns = 0, requests = 0;
  const normalizer = createMobileShareLinkNormalizer({
    resolve4: async () => ++dns === 1 ? ['1.1.1.1'] : ['1.1.1.1', '127.0.0.1'],
    connect: async () => { requests++; return redirect('/share/Next123'); },
  });
  assert.equal((await normalizer(share, ['instagram'])).content, share);
  assert.equal(dns, 2); assert.equal(requests, 1);
});

test('malformed source authorities and unsupported app schemes are rejected before DNS', async () => {
  const normalizer = createMobileShareLinkNormalizer({ resolve4: async () => assert.fail('Must reject before DNS') });
  for (const raw of [
    'http://www.instagram.com/share/Token', 'instagram://share/Token', 'reddit://r/aww/s/Token',
    'https://www.instagram.com:443/share/Token', 'https://www.instagram.com@evil.test/share/Token',
    'https://evil.test@www.instagram.com/share/Token', 'https://www.instagram.com./share/Token',
    'https://ｗｗｗ.instagram.com/share/Token', 'https://www.instagram.com/share/%2e%2e/share/Token',
    'https://www.instagram.com/foo/../share/Token', 'https://www.instagram.com\\@evil.test/share/Token',
    'https://evil.test/?next=' + share, 'https://www.instagram.com/share/p/Token/extra',
    'https://www.reddit.com/r/aww/s/Token/extra', 'https://reddit.app.link/Token',
    'https://redd.it/abc123/extra', 'https://v.redd.it/abc123', 'https://www.instagram.com/share/' + 'a'.repeat(65),
  ]) assert.equal((await normalizer(raw, ['instagram', 'reddit'])).content, raw, raw);
});

test('hostile redirects, login pages and other-platform destinations preserve the exact original', async () => {
  for (const destination of [
    'http://www.instagram.com/p/Post123/', 'https://evil.test/p/Post123/', '//evil.test/share/Token',
    'https://127.0.0.1/share/Token', 'https://www.instagram.com:443/p/Post123/',
    'https://www.instagram.com@evil.test/share/Token', 'https://evil.test@www.instagram.com/p/Post123/',
    'https://ｗｗｗ.instagram.com/p/Post123/', 'https://www.instagram.com./p/Post123/',
    'https://www.instagram.com/foo/../p/Post123/', '/foo/../p/Post123/', '/%2e%2e/p/Post123/',
    'https://www.instagram.com\\@evil.test/share/Token', '/accounts/login/?next=' + post,
    '/redirect?next=' + post, 'instagram://media?id=123', redditPost, '../p/Post123/',
    'https:///www.instagram.com/p/Post123/', '\\evil.test\\p\\Post123',
  ]) {
    const f = fixture(async () => redirect(destination));
    const result = await f.normalizer(share + '?igsh=original', ['instagram', 'reddit']);
    assert.equal(result.content, share + '?igsh=original', destination);
    assert.equal(result.originals.size, 0, destination);
    assert.equal(f.calls.length, 1, destination);
  }
});

test('share redirect loops, missing Location and the four-hop budget terminate without replacement', async () => {
  const loop = fixture(async () => redirect(share));
  assert.equal((await loop.normalizer(share, ['instagram'])).content, share);
  assert.equal(loop.calls.length, 1);
  const endless = fixture(async () => redirect('/share/Hop' + endless.calls.length));
  assert.equal((await endless.normalizer(share, ['instagram'])).content, share);
  assert.equal(endless.calls.length, 4);
  for (const response of [new Response(null, { status: 302 }), new Response(null, { status: 300 }),
    new Response(null, { status: 304 }), new Response(null, { status: 403 }), new Response(null, { status: 200 })]) {
    const f = fixture(async () => response);
    assert.equal((await f.normalizer(share, ['instagram'])).content, share);
  }
});

test('root-relative and scheme-relative same-platform redirects support standard redirect status codes', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const f = fixture(async () => redirect(status % 2 ? '/reel/Post123/' : '//www.instagram.com/reel/Post123/', status));
    assert.equal((await f.normalizer(share, ['instagram'])).content, post);
  }
});

test('response bodies are cancelled without reads on successful redirects and blocked/oversized pages', async () => {
  for (const status of [302, 200, 403, 500]) {
    let cancelled = false;
    const f = fixture(async () => new Response(new ReadableStream({
      pull() { assert.fail('No response body bytes may be requested'); }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status, headers: {
      location: post, 'content-length': '9999999999999', 'content-encoding': 'gzip', 'set-cookie': 'session=discard',
    } }));
    assert.equal((await f.normalizer(share, ['instagram'])).content, status === 302 ? post : share);
    assert.equal(cancelled, true);
  }
});

test('hidden links, disabled platforms and nolinky bypasses never perform a lookup', async () => {
  const normalizer = createMobileShareLinkNormalizer({ resolve4: async () => assert.fail('Hidden or disabled link lookup') });
  for (const content of [`<${share}>`, `\`${share}\``, `\`\`\`text\n${share}\n\`\`\``, `||${share}||`,
    `${share} !nolinky`, `!NOLINKY\n${share}`, `||${redditShare}||`]) {
    assert.equal((await normalizer(content, ['instagram', 'reddit'])).content, content);
  }
  for (const enabled of [[], ['x'], ['reddit']]) assert.equal((await normalizer(share, enabled)).content, share);
});

test('duplicate visible tokens share one lookup and hidden copies remain untouched', async () => {
  const f = fixture(async () => redirect(post));
  const result = await f.normalizer(`<${share}> [first](${share}) ||${share}|| ${share}`, ['instagram']);
  assert.equal(result.content, `<${share}> [first](${post}) ||${share}|| ${post}`);
  assert.equal(f.calls.length, 1); assert.equal(result.originals.size, 1);
});

test('one message resolves at most five distinct share tokens and preserves each remaining token', async () => {
  const urls = Array.from({ length: 8 }, (_, i) => share + i);
  const f = fixture(async options => redirect(post.replace('Post123', 'Post' + String(options.path).slice(-1))));
  const result = await f.normalizer(urls.join(' '), ['instagram']);
  assert.equal(f.calls.length, 5);
  assert.equal(result.content, urls.map((url, i) => i < 5 ? post.replace('Post123', 'Post' + i) : url).join(' '));
});

test('oversized originals can resolve but are excluded from link-button mappings', async () => {
  const f = fixture(async () => redirect(post));
  const original = share + '?igsh=' + 'a'.repeat(600);
  const result = await f.normalizer(original, ['instagram']);
  assert.equal(result.content, post); assert.equal(result.originals.size, 0);
});

test('stalled DNS and transport are bounded by one message deadline and late responses are cancelled', async () => {
  let requests = 0;
  const dns = createMobileShareLinkNormalizer({ timeoutMs: 10,
    resolve4: async () => new Promise<string[]>(() => undefined),
    connect: async () => { requests++; return redirect(post); },
  });
  assert.equal((await dns(share, ['instagram'])).content, share); assert.equal(requests, 0);
  let finish!: (response: Response) => void, cancelled = false;
  const transport = createMobileShareLinkNormalizer({ timeoutMs: 10, resolve4: async () => ['1.1.1.1'],
    connect: async () => new Promise<Response>(resolve => { finish = resolve; }),
  });
  assert.equal((await transport(share, ['instagram'])).content, share);
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await delay(0); assert.equal(cancelled, true);
});

test('caller abort restores original content, cancels active requests and cannot poison a later call', async () => {
  const controller = new AbortController();
  let requests = 0;
  const normalizer = createMobileShareLinkNormalizer({ resolve4: async () => ['1.1.1.1'],
    connect: async (_options, signal) => {
      requests++;
      if (requests === 2) {
        queueMicrotask(() => controller.abort());
        return new Promise<Response>(resolve => signal.addEventListener('abort', () => resolve(redirect(post)), { once: true }));
      }
      return redirect(post);
    },
  });
  const content = share + ' ' + share + 'Different';
  const result = await normalizer(content, ['instagram'], controller.signal);
  assert.equal(result.content, content); assert.equal(result.originals.size, 0);
  assert.equal((await normalizer(share, ['instagram'])).content, post);
  assert.equal(requests, 3);
});

test('global concurrency is bounded without queuing and one caller abort cannot affect another', async () => {
  const releases: (() => void)[] = [];
  const normalizer = createMobileShareLinkNormalizer({ timeoutMs: 2000, resolve4: async () => ['1.1.1.1'],
    connect: async () => new Promise<Response>(resolve => releases.push(() => resolve(redirect(post)))),
  });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const pending = controllers.map(controller => normalizer(share, ['instagram'], controller.signal));
  await delay(0); assert.equal(releases.length, 8);
  assert.equal((await normalizer(share, ['instagram'])).content, share);
  controllers[0].abort();
  for (const release of releases) release();
  const results = await Promise.all(pending);
  assert.equal(results[0].content, share);
  assert.ok(results.slice(1).every(result => result.content === post));
});
