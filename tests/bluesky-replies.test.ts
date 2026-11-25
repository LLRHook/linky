import { createReplyLookup } from '../src/bot';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType, type ButtonInteraction, type ThreadChannel } from 'discord.js';
import { createBlueskyReplies, parseBlueskyReplies } from '../src/services/BlueskyReplies';
import { parseBlueskyThread } from '../src/services/BlueskyPost';
import { blueskyRepliesButton, ReplyThreads, replyThreadPayloads } from '../src/services/ReplyThreads';
import fixture from './fixtures/bluesky-replies.json';
const DID = fixture.thread.post.author.did, HANDLE = fixture.thread.post.author.handle;
const RKEY = fixture.thread.post.uri.split('/').at(-1)!;
const ID = `${HANDLE}/${RKEY}`;
const parse = (value: unknown = fixture) => parseBlueskyReplies(value, ID, 1000)!;

test('synthetic replies match a handle request with DID URI; embeds allowed and identity enforced', () => {
  const page = parse(); assert.ok(page.replies.length); assert.equal(page.source, 'Bluesky');
  assert.ok(parseBlueskyReplies(fixture, `${DID}/${RKEY}`, 0));
  assert.equal(parseBlueskyReplies(fixture, `${HANDLE}/wrong`, 0), null);
  assert.equal(parseBlueskyReplies(fixture, `other.example.test/${RKEY}`, 0), null);
  const value = structuredClone(fixture); value.thread.post.embed = { $type: 'app.bsky.embed.external#view' } as typeof value.thread.post.embed;
  assert.ok(parse(value));
});
test('filters hidden, labelled post/author, blocked, notFound and wrong parent once; sorts likes then newest', () => {
  const value = structuredClone(fixture), sample = structuredClone(value.thread.replies[0]);
  value.thread.replies = Array.from({ length: 10 }, (_, i) => {
    const reply = structuredClone(sample); reply.post.uri = `at://${reply.post.author.did}/app.bsky.feed.post/r${i}`;
    reply.post.record.reply.parent.uri = value.thread.post.uri;
    reply.post.labels = []; reply.post.author.labels = []; reply.post.likeCount = i === 0 ? 50 : 10;
    reply.post.record.createdAt = new Date(1000 + i * 1000).toISOString(); return reply;
  });
  value.thread.post.threadgate.record.hiddenReplies = [value.thread.replies[3].post.uri];
  value.thread.replies[4].post.labels = [{ val: 'spam' }] as typeof sample.post.labels;
  value.thread.replies[5].post.author.labels = [{ val: '!no-unauthenticated' }] as typeof sample.post.author.labels;
  value.thread.replies[6].post.record.reply.parent.uri = 'at://other/app.bsky.feed.post/other';
  value.thread.replies[7].$type = 'app.bsky.feed.defs#blockedPost';
  value.thread.replies[8].$type = 'app.bsky.feed.defs#notFoundPost';
  value.thread.replies[9].post.labels = [{ val: 'spam' }] as typeof sample.post.labels;
  value.thread.replies[9].post.author.labels = [{ val: 'spam' }] as typeof sample.post.author.labels;
  const page = parse(value); assert.equal(page.r, 10); assert.equal(page.m, 7);
  assert.deepEqual(page.replies.map(r => r.likes), [50, 10, 10]);
  assert.deepEqual(page.replies.map(r => r.timestamp), [1, 3, 2]);
  assert.equal(page.replies[0].url, `https://bsky.app/profile/${sample.post.author.did}/post/r0`);
  assert.equal(page.replies[0].profileUrl, `https://bsky.app/profile/${sample.post.author.did}`);
});
test('25 shown and literal header, greedy packing and X still capped at ten', () => {
  const page = parse(); page.N = 123; page.r = 40; page.m = 5;
  page.replies = Array.from({ length: 30 }, () => ({ ...page.replies[0], text: '@everyone **x** https://bad.test ' + 'x'.repeat(500) }));
  const payloads = replyThreadPayloads(page);
  assert.equal(payloads[0].components[0].components[0].content, 'Showing 25 of 123 replies from Bluesky, most liked first (Bluesky returned 40; Linky hid 5). Count as of <t:1:f>.');
  assert.equal(payloads.flatMap(p => p.components[0].components).length, 26);
  for (const p of payloads) { assert.equal(p.flags, 36868); assert.deepEqual(p.allowedMentions, { parse: [] }); assert.ok(p.components[0].components.map(t => t.content).join('').length <= 3800); }
  assert.doesNotMatch(JSON.stringify(payloads), /https:\/\/bad.test/);
  const x = replyThreadPayloads({ ...page, source: 'X', maxShown: undefined });
  assert.equal(x.flatMap(p => p.components[0].components).length, 11);
});
test('lookup exact request, five second timeout, no credentials/redirect, TTLs, byte cap and private oversize', async t => {
  let now = 0, calls = 0, large = false;
  const timeout = AbortSignal.timeout; const timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return timeout(ms); });
  const lookup = createBlueskyReplies(async (url, options) => {
    calls++; assert.equal(url, `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(`at://${HANDLE}/app.bsky.feed.post/${RKEY}`)}&depth=1&parentHeight=0`);
    assert.equal(options?.redirect, 'error'); assert.equal(options?.credentials, 'omit'); assert.equal(options?.headers, undefined);
    return new Response(large ? 'x'.repeat(1048577) : JSON.stringify(fixture));
  }, () => now);
  await Promise.all([lookup(ID), lookup(ID)]); assert.equal(calls, 1); assert.deepEqual(timeouts, [5000]);
  now = 299999; assert.ok(await lookup(ID)); assert.equal(calls, 1);
  now = 300000; large = true; await assert.rejects(lookup(ID), { message: 'This post has too many replies for Linky to load' }); assert.equal(calls, 2);
  now += 29999; await assert.rejects(lookup(ID)); assert.equal(calls, 2);
  now++; await assert.rejects(lookup(ID)); assert.equal(calls, 3);
  assert.equal(await lookup('https://evil.test/path'), null); assert.equal(calls, 3);
});
test('eight in flight and hundred entry cache bounded; redirects abstain', async () => {
  let calls = 0; const releases: (() => void)[] = [];
  const lookup = createBlueskyReplies(async () => { calls++; await new Promise<void>(r => releases.push(r)); return new Response('{}'); });
  const jobs = Array.from({ length: 8 }, (_, i) => lookup(`${DID}/r${i}`));
  const overflow = lookup(`${DID}/overflow`);
  const result = await Promise.race([overflow, new Promise<string>(resolve => setImmediate(() => resolve('pending')))]);
  releases.forEach(r => r()); await Promise.all([...jobs, overflow]);
  assert.equal(result, null); assert.equal(calls, 8);
  calls = 0; const cached = createBlueskyReplies(async () => { calls++; return new Response('{}'); });
  for (let i = 0; i < 101; i++) await cached(`${DID}/r${i}`);
  await cached(`${DID}/r0`); assert.equal(calls, 102);
  const redirected = createBlueskyReplies(async () => { const r = new Response(JSON.stringify(fixture)); Object.defineProperty(r, 'redirected', { value: true }); return r; });
  assert.equal(await redirected(ID), null);
});
test('button reuses lookup count, unknown/labelled absent; long handle thread name and off lookup gate', async () => {
  const raw = structuredClone(fixture); delete (raw.thread.post as { embed?: unknown }).embed;
  delete (raw.thread.post.record as { embed?: unknown }).embed;
  const post = parseBlueskyThread(raw, HANDLE, RKEY)!; assert.ok(post);
  assert.equal(post.replyCount, 116);
  post.replyCount = 12;
  const button = blueskyRepliesButton(post, ChannelType.GuildText, true)!;
  assert.equal((button.toJSON() as { label: string }).label, 'Replies (12)'); assert.equal((button.data as { custom_id: string }).custom_id, `linky:replies:bsky:${DID}/${RKEY}`);
  assert.equal(blueskyRepliesButton(post, ChannelType.GuildText, false), undefined);
  assert.equal(blueskyRepliesButton(undefined, ChannelType.GuildText, true), undefined);
  assert.equal(blueskyRepliesButton({ ...post, replyCount: undefined }, ChannelType.GuildText, true), undefined);
  assert.equal(blueskyRepliesButton(post, ChannelType.DM, true), undefined);
  raw.thread.post.labels = [{ val: 'spam' }] as typeof raw.thread.post.labels; assert.equal(parseBlueskyThread(raw, HANDLE, RKEY), null);
  const page = parse(); page.threadHandle = 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(58) + '.com';
  let enabled = false, calls = 0, creates = 0, actualName = ''; const sent: unknown[] = [], answers: string[] = [];
  const thread = { url: 'thread', send: async (p: unknown) => { sent.push(p); } };
  const message = { id: '100', guildId: 'guild', channelId: 'channel', author: { id: 'bot' }, channel: { type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) }, fetch: async () => message,
    startThread: async (options: { name: string }) => { creates++; actualName = options.name; return thread; } };
  const manager = new ReplyThreads({ botUserId: () => 'bot', enabled: () => enabled, tracked: () => true, lookup: async (id, platform) => { calls++; assert.equal(id, `${DID}/${RKEY}`); assert.equal(platform, 'bsky'); return page; }, fetchThread: async () => thread as unknown as ThreadChannel });
  const click = () => { const i = { customId: (button.data as { custom_id: string }).custom_id, message, guildId: 'guild', guild: { members: { me: {} } }, user: { id: 'user' }, deferred: false,
    reply: async (p: { content: string; flags: number }) => { assert.equal(p.flags, 64); answers.push(p.content); }, deferReply: async () => { i.deferred = true; }, editReply: async (p: { content: string }) => { answers.push(p.content); } }; return manager.handle(i as unknown as ButtonInteraction); };
  await click(); assert.equal(calls, 0); assert.equal(creates, 0); assert.equal(sent.length, 0);
  enabled = true; await Promise.all([click(), click()]); assert.equal(calls, 1); assert.equal(creates, 1); assert.equal(actualName, 'Replies to @' + page.threadHandle!.slice(0, 87) + '\u2026'); assert.equal(actualName.length, 100); assert.ok(sent.length, JSON.stringify(answers));
});

test('parser retains at most 25 replies after counting all entries', () => {
  const value = structuredClone(fixture);
  value.thread.replies = Array.from({ length: 40 }, () => structuredClone(fixture.thread.replies[0]));
  const page = parse(value); assert.equal(page.r, 40); assert.equal(page.m, 0); assert.equal(page.replies.length, 25);
});

test('malformed and labelled anchors abstain; failures cache for thirty seconds', async () => {
  for (const mutate of [
    (v: typeof fixture) => { v.thread.post.author.did = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'; },
    (v: typeof fixture) => { v.thread.$type = 'app.bsky.feed.defs#blockedPost'; },
    (v: typeof fixture) => { v.thread.post.labels = [{ val: 'spam' }] as typeof v.thread.post.labels; },
    (v: typeof fixture) => { v.thread.post.author.labels = [{ val: '!no-unauthenticated' }] as typeof v.thread.post.author.labels; },
  ]) { const v = structuredClone(fixture); mutate(v); assert.equal(parse(v), null); }
  let now = 0, calls = 0;
  const lookup = createBlueskyReplies(async () => { calls++; throw Error('offline'); }, () => now);
  assert.equal(await lookup(ID), null); now = 29999; assert.equal(await lookup(ID), null); assert.equal(calls, 1);
  now++; assert.equal(await lookup(ID), null); assert.equal(calls, 2);
});

test('a reply anchor honors both root top-level and embedded threadgate hidden replies', () => {
  const value = structuredClone(fixture);
  Object.assign(value.thread.post.record, { reply: { root: { uri: 'at://did:plc:ffffffffffffffffffffffff/app.bsky.feed.post/root' } } });
  Object.assign(value, { threadgate: { record: { hiddenReplies: [value.thread.replies[0].post.uri, value.thread.replies[1].post.uri] } } });
  value.thread.post.threadgate.record.hiddenReplies = [value.thread.replies[1].post.uri];
  const page = parse(value); assert.equal(page.r, 4); assert.equal(page.m, 2); assert.equal(page.replies.length, 2);
  assert.ok(page.replies.every(r => !r.url.endsWith('/reply0') && !r.url.endsWith('/reply1')));
});
test('response handle normalization matches post lookup and invalid anchor handle abstains', () => {
  const value = structuredClone(fixture); value.thread.post.author.handle = HANDLE.toUpperCase();
  assert.equal(parse(value).threadHandle, HANDLE);
  value.thread.post.author.handle = 'handle.invalid'; assert.equal(parse(value), null);
});
test('only actual media embed types get the media hint, without fetching embedded URLs', () => {
  for (const [type, hasMedia] of [['app.bsky.embed.images#view', true], ['app.bsky.embed.video#view', true],
    ['app.bsky.embed.gallery#view', true], ['app.bsky.embed.recordWithMedia#view', true],
    ['app.bsky.embed.external#view', false], ['app.bsky.embed.record#view', false], ['', false]] as const) {
    const value = structuredClone(fixture); value.thread.replies = [value.thread.replies[0]];
    if (type) Object.assign(value.thread.replies[0].post, { embed: { $type: type } });
    assert.equal(parse(value).replies[0].hasMedia, hasMedia);
  }
});

test('Bluesky control accepts exactly 100 characters and abstains without error at 101', () => {
  const value = structuredClone(fixture); delete (value.thread.post as { embed?: unknown }).embed;
  const post = parseBlueskyThread(value, HANDLE, RKEY)!;
  const at100 = { ...post, url: `https://bsky.app/profile/${HANDLE}/post/${'r'.repeat(48)}` };
  const button = blueskyRepliesButton(at100, ChannelType.GuildText, true)!;
  const json = button.toJSON() as { custom_id: string };
  assert.equal(json.custom_id.length, 100);
  assert.equal(json.custom_id, `linky:replies:bsky:did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/${'r'.repeat(48)}`);
  const at101 = { ...at100, url: at100.url + 'r' };
  assert.doesNotThrow(() => blueskyRepliesButton(at101, ChannelType.GuildText, true));
  assert.equal(blueskyRepliesButton(at101, ChannelType.GuildText, true), undefined);
});

test('controlled five-second signal reaches fetch and cancels a held bounded body; failure TTL applies', async t => {
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 5000); return timeout.signal; });
  const addListener = timeout.signal.addEventListener.bind(timeout.signal); let bodyListeners = 0;
  t.mock.method(timeout.signal, 'addEventListener', (type: string, listener: Parameters<AbortSignal['addEventListener']>[1], options?: AddEventListenerOptions | boolean) => {
    if (type === 'abort') bodyListeners++;
    return addListener(type, listener, options);
  });
  let body!: ReadableStreamDefaultController<Uint8Array>, cancelled = false, calls = 0, now = 0;
  let fetchSignal: AbortSignal | null | undefined;
  const lookup = createBlueskyReplies(async (_url, options) => {
    calls++; fetchSignal = options?.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      body = controller; controller.enqueue(new TextEncoder().encode(JSON.stringify(fixture)));
    }, cancel() { cancelled = true; } }));
  }, () => now);
  const pending = lookup(`${DID}/${RKEY}`);
  await new Promise<void>(resolve => setImmediate(resolve));
  timeout.abort();
  await new Promise<void>(resolve => setImmediate(resolve));
  // Let an incorrectly unbounded reader finish too, so the mutant fails without hanging the suite.
  if (!cancelled) body.close();
  const result = await pending;
  assert.equal(fetchSignal, timeout.signal);
  assert.equal(bodyListeners, 1, 'the controlled signal must reach the bounded body reader');
  assert.equal(cancelled, true); assert.equal(result, null);
  now = 29999; assert.equal(await lookup(`${DID}/${RKEY}`), null); assert.equal(calls, 1);
  now = 30000; assert.equal(await lookup(`${DID}/${RKEY}`), null); assert.equal(calls, 2);
});
test('DID request rejects a self-consistent anchor belonging to another DID', () => {
  const value = structuredClone(fixture), otherDid = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz';
  value.thread.post.author.did = otherDid;
  value.thread.post.uri = `at://${otherDid}/app.bsky.feed.post/${RKEY}`;
  for (const reply of value.thread.replies) {
    reply.post.record.reply.parent.uri = value.thread.post.uri; reply.post.record.reply.root.uri = value.thread.post.uri;
  }
  assert.equal(parseBlueskyReplies(value, `${otherDid}/${RKEY}`, 1000)!.replies.length, 4);
  assert.equal(parseBlueskyReplies(value, `${DID}/${RKEY}`, 1000), null);
});
test('bot reply lookup routes Bluesky and X in both directions, without calling the other adapter', async () => {
  const calls: string[] = [], x = { ...parse(), source: 'X' }, bluesky = parse();
  const lookup = createReplyLookup(async id => { calls.push(`x:${id}`); return x; }, async id => { calls.push(`bsky:${id}`); return bluesky; });
  assert.equal(await lookup('anchor', 'bsky'), bluesky); assert.deepEqual(calls, ['bsky:anchor']);
  calls.length = 0; assert.equal(await lookup('123', 'x'), x); assert.deepEqual(calls, ['x:123']);
  calls.length = 0; assert.equal(await lookup('456'), x); assert.deepEqual(calls, ['x:456']);
});
test('exactly 1048576 decoded bytes are accepted, and Content-Length oversize maps to private error', async () => {
  const json = JSON.stringify(fixture), body = json + ' '.repeat(1048576 - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(body), 1048576);
  const exact = createBlueskyReplies(async () => new Response(body));
  assert.equal((await exact(ID))!.replies.length, 4);
  let cancelled = false;
  const header = createBlueskyReplies(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '1048577' } }));
  await assert.rejects(header(ID), { message: 'This post has too many replies for Linky to load' });
  assert.equal(cancelled, true);
});
test('future author dates use earlier indexed time for tie ordering and displayed timestamp', () => {
  const value = structuredClone(fixture); value.thread.replies = [value.thread.replies[0], value.thread.replies[1]];
  for (const reply of value.thread.replies) reply.post.likeCount = 10;
  value.thread.replies[0].post.record.createdAt = '2099-01-01T00:00:00Z';
  Object.assign(value.thread.replies[0].post, { indexedAt: '2026-01-01T00:00:00Z' });
  value.thread.replies[1].post.record.createdAt = '2026-01-02T00:00:00Z';
  Object.assign(value.thread.replies[1].post, { indexedAt: '2026-01-03T00:00:00Z' });
  const page = parse(value);
  assert.deepEqual(page.replies.map(r => r.timestamp), [1767312000, 1767225600]);
  assert.ok(page.replies[0].url.endsWith('/reply1'));
  const shown = JSON.stringify(replyThreadPayloads(page));
  assert.ok(shown.includes('<t:1767225600:R>')); assert.ok(shown.includes('<t:1767312000:R>'));
  assert.ok(!shown.includes('4070908800'));
});
