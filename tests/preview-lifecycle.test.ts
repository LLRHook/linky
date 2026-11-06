import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComponentType, MessageFlags, type APIMessage } from 'discord.js';
import { discordLifecycle, BOT, CHANNEL, GUILD, MEMBER, OWNER } from './support/discord-lifecycle';

const actions = (message: APIMessage) => (message.components ?? []).flatMap(row =>
  row.type === ComponentType.ActionRow ? row.components : []);
function controls(message: APIMessage) {
  const buttons = actions(message);
  assert(buttons.some(button => 'url' in button && button.label === 'Original post'));
  assert.equal(buttons.filter(button => 'custom_id' in button && button.custom_id === 'linky:remove').length, 1);
  const details = buttons.filter(button => 'custom_id' in button && button.custom_id.startsWith('linky:details:'));
  assert.equal(details.length, 1, 'a finished delivery needs one bound Details action');
  return 'custom_id' in details[0] ? details[0].custom_id : '';
}
const sources = [
  'https://www.tiktok.com/@synthetic/video/1234567890123456789',
  'https://bsky.app/profile/synthetic.example/post/3synthetic',
  'https://www.reddit.com/r/synthetic/comments/abc123/fixture/',
];

for (const mode of ['replace', 'reply'] as const) for (const source of sources) {
  test(`SDK ${mode} restores delayed Original-only controls for ${new URL(source).hostname}`, async t => {
    const f = await discordLifecycle(t, mode);
    const sourceId = await f.post(source);
    const output = [...f.state.values()].find(message => message.author.id === BOT)!; assert(output);
    const detailsId = controls(output);
    assert.equal(f.state.has(sourceId), mode === 'reply');
    const cached = f.channel.messages.cache.get(output.id)!;
    assert(!actions({ ...output, components: cached.components.map(row => row.toJSON()) }).some(button =>
      'custom_id' in button && button.custom_id === 'linky:remove'), 'SDK edit response must not silently patch its original cache handle');
    // Replay the observed delayed server regression, not merely a stale local cache.
    f.update(output.id, { components: f.initialControls.get(output.id) }); await f.drain();
    assert.equal(controls(f.state.get(output.id)!), detailsId);
    const detailReply = await f.click(output.id, detailsId, MEMBER);
    assert.equal(detailReply[0].flags, MessageFlags.Ephemeral);
    assert.match(detailReply.at(-1)?.content ?? '', /preview was delivered/i);
    const denied = await f.click(output.id, 'linky:remove', MEMBER);
    assert.match(denied.at(-1)?.content ?? '', /Only the original author/);
    assert(f.state.has(output.id));
    await f.restart();
    f.update(output.id, { components: f.initialControls.get(output.id) }); await f.drain();
    assert.equal(controls(f.state.get(output.id)!), detailsId, 'recovery must load durable ownership and Details binding');
    const removed = await f.click(output.id, 'linky:remove', OWNER);
    assert.match(removed.at(-1)?.content ?? '', /Removed/); assert(!f.state.has(output.id));
    assert.equal(f.state.has(sourceId), mode === 'reply');
  });
}

for (const observation of ['gateway', 'rest'] as const) test(`SDK ${observation} error-card failure and member Retry preserve the source, recovery actions and owner after reload`, async t => {
  const f = await discordLifecycle(t);
  f.observation(observation);
  f.render(content => { const url = /https:\/\/[^\s<>]+/.exec(content)?.[0]; return url ? [{ url,
    title: 'vxTwitter / fixvx', description: '**Failed to scan your link!** This post is unavailable.',
    thumbnail: { url: 'https://media.example/logo.png' } }] : []; });
  const sourceUrl = 'https://x.com/synthetic/status/123';
  const sourceId = await f.post(sourceUrl);
  assert(f.state.has(sourceId), 'a branded provider error must never authorize source deletion');
  let notice = [...f.state.values()].find(message => message.author.id === BOT)!; assert(notice);
  const detailId = controls(notice);
  assert(actions(notice).some(button => 'custom_id' in button && button.custom_id === 'linky:retry'));
  f.update(notice.id, { components: f.initialControls.get(notice.id) }); await f.drain();
  assert.equal(controls(f.state.get(notice.id)!), detailId);
  assert(actions(f.state.get(notice.id)!).some(button => 'custom_id' in button && button.custom_id === 'linky:retry'));
  f.update(notice.id, { components: [] }); await f.drain();
  assert.equal(controls(f.state.get(notice.id)!), detailId, 'a failure notice has no URL in its text; use its bound source');
  assert(actions(f.state.get(notice.id)!).some(button => 'url' in button && button.url === sourceUrl));
  await f.restart();
  f.update(notice.id, { components: [] }); await f.drain();
  assert.equal(controls(f.state.get(notice.id)!), detailId, 'the bound source must restore Original post after restart too');
  f.observation('gateway');
  f.render(content => { const url = /https:\/\/[^\s<>]+/.exec(content)?.[0]; return url ? [{ url,
    title: 'Synthetic author', description: 'Failed to scan your link! Here is the quoted error and our fix.' }] : []; });
  const retried = await f.click(notice.id, 'linky:retry', MEMBER);
  assert.match(retried.at(-1)?.content ?? '', /Retry finished/); assert(f.state.has(sourceId));
  assert(!f.state.has(notice.id));
  notice = [...f.state.values()].find(message => message.author.id === BOT)!; assert(notice);
  const successDetails = controls(notice);
  assert(!actions(notice).some(button => 'custom_id' in button && button.custom_id === 'linky:retry'));
  f.update(notice.id, { components: f.initialControls.get(notice.id) }); await f.drain();
  assert.equal(controls(f.state.get(notice.id)!), successDetails);
  const denied = await f.click(notice.id, 'linky:remove', MEMBER);
  assert.match(denied.at(-1)?.content ?? '', /Only the original author/);
  const removed = await f.click(notice.id, 'linky:remove');
  assert.match(removed.at(-1)?.content ?? '', /Removed/); assert(f.state.has(sourceId));
});

test('SDK failure-notice recovery refuses source links from a different author after restart', async t => {
  const f = await discordLifecycle(t);
  f.render(() => []);
  const sourceId = await f.post('https://x.com/synthetic/status/123');
  const notice = [...f.state.values()].find(message => message.author.id === BOT)!; assert(notice);
  controls(notice);
  await f.restart();
  const source = f.state.get(sourceId)!;
  source.author.id = MEMBER;
  source.content = 'https://x.com/other_author/status/999';
  const before = f.requests.filter(request => request.method === 'PATCH').length;
  f.update(notice.id, { components: [] }); await f.drain();
  assert.equal(f.requests.filter(request => request.method === 'PATCH').length, before,
    'untrusted source data must not authorize component restoration');
  assert.deepEqual(actions(f.state.get(notice.id)!), []);
});

test('SDK automatic Replace keeps the source when a later error revokes an early useful Gateway card', async t => {
  const f = await discordLifecycle(t);
  f.frames(content => { const url = /https:\/\/[^\s<>]+/.exec(content)?.[0]; return url ? [
    [{ url, title: 'Synthetic author', description: 'Transient useful content' }],
    [{ url, title: 'vxTwitter / fixvx', description: 'Failed to scan your link! Unavailable.' }],
  ] : [[]]; });
  const source = await f.post('https://x.com/synthetic/status/123');
  assert(f.state.has(source));
  const notice = [...f.state.values()].find(message => message.author.id === BOT)!; assert(notice);
  controls(notice);
  assert(actions(notice).some(button => 'custom_id' in button && button.custom_id === 'linky:retry'));
});

test('SDK recovery restores fully missing rows, preserves unrelated controls and edits only components', async t => {
  const f = await discordLifecycle(t, 'reply');
  await f.post(sources[2]);
  const output = [...f.state.values()].find(message => message.author.id === BOT)!; assert(output);
  const originalDetails = controls(output), content = output.content, embeds = structuredClone(output.embeds);
  f.update(output.id, { components: [{ type: ComponentType.ActionRow, components: [
    { type: ComponentType.Button, style: 2, custom_id: 'synthetic:unrelated', label: 'Unrelated' },
  ] }] });
  const start = f.requests.length;
  await f.drain();
  const repaired = f.state.get(output.id)!;
  assert.equal(controls(repaired), originalDetails);
  assert(actions(repaired).some(button => 'custom_id' in button && button.custom_id === 'synthetic:unrelated'));
  assert.equal(repaired.content, content); assert.deepEqual(repaired.embeds, embeds);
  const patches = f.requests.slice(start).filter(request => request.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(Object.keys(patches[0].body!).sort(), ['allowed_mentions', 'components', 'enforce_nonce', 'tts']);
  assert.deepEqual(patches[0].body!.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
  // A stale Gateway cache must not overwrite newer, complete server-side controls.
  const patchCount = f.requests.filter(request => request.method === 'PATCH').length;
  const packet = { t: 'MESSAGE_UPDATE', d: { id: output.id, channel_id: CHANNEL, guild_id: GUILD, components: [] } };
  const root = require('node:path').join(require('node:path').dirname(require.resolve('discord.js')), 'client/websocket/handlers/MESSAGE_UPDATE.js');
  require(root)(f.client, packet);
  await f.drain();
  assert.equal(f.requests.filter(request => request.method === 'PATCH').length, patchCount);
  assert.equal(controls(f.state.get(output.id)!), originalDetails);
});
