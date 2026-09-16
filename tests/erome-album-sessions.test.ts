import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ButtonStyle, ComponentType, MessageFlags, type APIMessageTopLevelComponent, type ButtonInteraction, type Message } from 'discord.js';
import { EromeAlbumSessions, type AlbumOwner } from '../src/services/EromeAlbumSessions';
import { eromeMediaComponents, type EromeMedia } from '../src/services/EromeMedia';

const botId = '100000000000000001';
const otherMemberId = '100000000000000009';
const owner: AlbumOwner = { requesterId: '100000000000000002', channelId: '100000000000000003',
  guildId: '100000000000000004', messageId: '100000000000000005', sourceMessageId: '100000000000000006',
  source: 'https://www.erome.com/a/SyntheticAlbum', mode: 'automatic' };
const fingerprints = Array.from({ length: 12 }, (_, index) => (index + 1).toString(16).repeat(64));
function mediaAt(index: number, count = 3): EromeMedia {
  const id = (index + 1).toString(16).repeat(32);
  return { id, url: `https://media.example/media/${id}.mp4`, sha256: fingerprints[index], size: 1_000,
    metadata: { width: 1280, height: 720, duration: 12, fps: 30 }, kind: 'video', videoCount: count,
    itemIndex: index, itemFingerprint: fingerprints[index], itemFingerprints: fingerprints.slice(0, count), itemCount: count,
    reservation: `reservation-${index}` };
}
type Options = ConstructorParameters<typeof EromeAlbumSessions>[0];
type Reply = { content?: string; flags?: number; allowedMentions?: unknown };
function harness(t: { after: (fn: () => void) => void }, overrides: Partial<Options> = {}, initial = mediaAt(0)) {
  const events: string[] = [];
  const prepared: Parameters<Options['prepare']>[] = [];
  const bound = new Set<string>();
  const cancelled: string[] = [];
  let edits = 0, fetches = 0;
  let editHook: ((components: APIMessageTopLevelComponent[], index: number) => Promise<void>) | undefined;
  let fetchHook: ((index: number) => Promise<void>) | undefined;
  let components: APIMessageTopLevelComponent[] = [];
  const message = { id: owner.messageId, channelId: owner.channelId, author: { id: botId },
    get components() { return components.map(value => ({ toJSON: () => structuredClone(value) })); },
    fetch: async () => { events.push('fetch'); fetches++; await fetchHook?.(fetches); return message; },
    edit: async (value: { components: APIMessageTopLevelComponent[]; allowedMentions?: unknown }) => {
      events.push('edit'); edits++;
      await editHook?.(value.components, edits);
      components = structuredClone(value.components);
      return message;
    },
  } as unknown as Message;
  const options: Options = {
    prepare: async (...args) => { events.push('prepare'); prepared.push(args); return mediaAt(1); },
    bind: async (asset, messageId) => { events.push('bind'); assert.equal(messageId, owner.messageId); bound.add(asset); return true; },
    unbind: async asset => { events.push('unbind'); bound.delete(asset); },
    cancelReservation: async reservation => { events.push('cancel'); cancelled.push(reservation); },
    allowed: async () => true,
    verify: async () => { events.push('verify'); return true; },
    ...overrides,
  };
  const sessions = new EromeAlbumSessions(options);
  t.after(() => sessions.close());
  const albumControl = sessions.register({ ...owner, media: initial });
  assert.ok(albumControl);
  const button = albumControl.components[0];
  assert.ok('custom_id' in button);
  const customId = button.custom_id;
  const controls: APIMessageTopLevelComponent[] = [{ type: ComponentType.ActionRow, components: [
    { type: ComponentType.Button, style: ButtonStyle.Link, label: 'Original post', url: owner.source },
    { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Remove', custom_id: 'linky:remove' },
  ] }];
  components = eromeMediaComponents(initial, 'Original album caption.', [...controls, albumControl]);
  const initialComponents = structuredClone(components);
  function click(changes: Record<string, unknown> = {}) {
    const replies: Reply[] = [];
    const interaction = { customId, user: { id: owner.requesterId },
      channelId: owner.channelId, guildId: owner.guildId, message, client: { user: { id: botId } },
      reply: async (value: Reply) => { replies.push(value); },
      deferReply: async (value: Reply) => { replies.push(value); },
      editReply: async (value: Reply) => { replies.push(value); }, ...changes } as unknown as ButtonInteraction;
    return { interaction, replies };
  }
  return { sessions, options, click, events, prepared, bound, cancelled, message, initialComponents,
    components: () => components,
    setComponents: (value: APIMessageTopLevelComponent[]) => { components = value; },
    onEdit: (hook: typeof editHook) => { editHook = hook; }, onFetch: (hook: typeof fetchHook) => { fetchHook = hook; } };
}

function gallery(components: APIMessageTopLevelComponent[]) {
  const item = components.find(component => component.type === ComponentType.MediaGallery);
  assert.ok(item && item.type === ComponentType.MediaGallery);
  return item;
}
function customIds(components: APIMessageTopLevelComponent[]): string[] {
  return components.flatMap(component => component.type === ComponentType.ActionRow
    ? component.components.flatMap(button => 'custom_id' in button ? [button.custom_id] : []) : []);
}

test('album actions require the exact bot output, channel, guild and message', async t => {
  const f = harness(t);
  const changedMessage = (changes: Record<string, unknown>) => ({ ...f.message, ...changes });
  for (const changes of [
    { message: changedMessage({ author: { id: '100000000000000009' } }) },
    { message: changedMessage({ id: '100000000000000009' }) }, { channelId: '100000000000000009' },
    { guildId: '100000000000000009' }, { guildId: null },
  ]) {
    const click = f.click(changes);
    assert.equal(await f.sessions.handle(click.interaction), true);
    assert.equal(click.replies.length, 1);
    assert.equal(click.replies[0].flags, MessageFlags.Ephemeral);
  }
  assert.equal(f.prepared.length, 0);
  assert.deepEqual(f.events, []);
  assert.equal(await f.sessions.handle(f.click({ customId: 'linky:remove' }).interaction), false);
});

test('other members can append with private progress while ownership and Remove remain unchanged', async t => {
  const contexts: { ownerId: string; actorId: string }[] = [], policyChecks: { ownerId: string; actorId: string }[] = [];
  const f = harness(t, {
    context: (session, actorId) => { contexts.push({ ownerId: session.requesterId, actorId }); return {}; },
    allowed: async (session, interaction) => {
      policyChecks.push({ ownerId: session.requesterId, actorId: interaction.user.id }); return true;
    },
  });
  const click = f.click({ user: { id: otherMemberId } });
  assert.equal(await f.sessions.handle(click.interaction), true);
  assert.equal(click.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(click.replies.at(-1)?.content ?? '', /Added item 2/);
  assert.deepEqual(contexts, [{ ownerId: owner.requesterId, actorId: otherMemberId }]);
  assert.ok(policyChecks.length > 1);
  assert.ok(policyChecks.every(check => check.ownerId === owner.requesterId && check.actorId === otherMemberId));
  assert.deepEqual(f.components().find(component => component.type === ComponentType.ActionRow),
    f.initialComponents.find(component => component.type === ComponentType.ActionRow));
  assert.equal(gallery(f.components()).items.length, 2);
  assert.equal(await f.sessions.handle(f.click({ customId: 'linky:remove', user: { id: otherMemberId } }).interaction), false,
    'Remove still belongs to its separate owner-authorized handler');
});

test('a denied shared album click cannot prepare media or alter the public gallery', async t => {
  const f = harness(t, { allowed: async (session, interaction) => {
    assert.equal(session.requesterId, owner.requesterId); assert.equal(interaction.user.id, otherMemberId); return false;
  } });
  const click = f.click({ user: { id: otherMemberId } });
  await f.sessions.handle(click.interaction);
  assert.equal(click.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(f.prepared.length, 0); assert.deepEqual(f.components(), f.initialComponents);
});

test('expiry and restart invalidate album actions without touching the published gallery', async t => {
  let now = 100;
  const f = harness(t, { clock: () => now });
  now += 24 * 60 * 60_000;
  const expired = f.click();
  await f.sessions.handle(expired.interaction);
  assert.match(expired.replies[0].content!, /expired/);
  const restarted = new EromeAlbumSessions(f.options);
  t.after(() => restarted.close());
  const afterRestart = f.click();
  await restarted.handle(afterRestart.interaction);
  assert.match(afterRestart.replies[0].content!, /expired/);
  assert.deepEqual(f.components(), f.initialComponents);
  assert.deepEqual(f.events, []);
});

test('append binds before editing and preserves every prior item and existing control', async t => {
  const f = harness(t);
  const click = f.click();
  assert.equal(await f.sessions.handle(click.interaction), true);
  assert.equal(click.replies[0].flags, MessageFlags.Ephemeral);
  assert.ok(f.events.indexOf('bind') < f.events.indexOf('edit'));
  assert.equal(f.prepared[0][0], owner.source);
  assert.deepEqual(f.prepared[0][1]?.selection, { fingerprint: fingerprints[1] });
  assert.equal(f.prepared[0][1]?.context?.fairnessKey, owner.guildId);
  assert.deepEqual(gallery(f.components()).items.map(item => item.media.url), [mediaAt(0).url, mediaAt(1).url]);
  assert.deepEqual(gallery(f.components()).items[0], gallery(f.initialComponents).items[0]);
  assert.deepEqual(f.components().find(component => component.type === ComponentType.ActionRow),
    f.initialComponents.find(component => component.type === ComponentType.ActionRow));
  assert.ok(customIds(f.components()).includes('linky:remove'));
  assert.equal(f.bound.has(mediaAt(1).id), true);
  assert.deepEqual(f.cancelled, ['reservation-1']);
  const caption = f.components().find(component => component.type === ComponentType.TextDisplay);
  assert.ok(caption && caption.type === ComponentType.TextDisplay);
  assert.equal(caption.content, 'Original album caption.\n-# 2 of 3 items · Original media. Full album: Original post.');
});

test('concurrent clicks from different members prepare one item and privately tell the second member to wait', async t => {
  let entered!: () => void, release!: (media: EromeMedia) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const f = harness(t, { prepare: async () => { calls++; entered(); return new Promise(resolve => { release = resolve; }); } });
  const first = f.sessions.handle(f.click({ user: { id: otherMemberId } }).interaction);
  await started;
  const second = f.click();
  await f.sessions.handle(second.interaction);
  assert.match(second.replies[0].content!, /already being prepared/);
  assert.equal(second.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(calls, 1);
  release(mediaAt(1));
  await first;
  assert.equal(gallery(f.components()).items.length, 2);
});

test('removal or policy revocation during an awaited allowed check cancels before preparation', async t => {
  for (const reason of ['remove', 'policy'] as const) {
    let entered!: () => void, release!: (value: boolean) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = harness(t, { allowed: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
    const click = f.click();
    const pending = f.sessions.handle(click.interaction);
    await started;
    if (reason === 'remove') f.sessions.remove(owner.messageId);
    release(reason !== 'policy');
    await pending;
    assert.equal(f.prepared.length, 0);
    assert.deepEqual(f.components(), f.initialComponents);
    assert.match(click.replies.at(-1)?.content ?? '', /no longer available/);
  }
});

test('fingerprint changes and byte budgets reject prepared items before any gallery edit', async t => {
  for (const patch of [{ itemFingerprint: fingerprints[2] }, { size: 192 * 1024 * 1024 }, { size: 0 }, { size: Number.NaN }]) {
    const f = harness(t, { prepare: async () => ({ ...mediaAt(1), ...patch }) });
    const click = f.click();
    await f.sessions.handle(click.interaction);
    assert.ok(!f.events.includes('edit'));
    assert.ok(!f.events.includes('bind'));
    assert.deepEqual(f.components(), f.initialComponents);
    assert.deepEqual(f.cancelled, ['reservation-1']);
    assert.match(click.replies.at(-1)?.content ?? '', /could not be prepared/);
  }
});

test('a changed gallery is not overwritten after preparation', async t => {
  const f = harness(t);
  const changed = structuredClone(f.initialComponents);
  gallery(changed).items[0].media.url = 'https://media.example/media/replacement.mp4';
  f.setComponents(changed);
  const click = f.click();
  await f.sessions.handle(click.interaction);
  assert.ok(!f.events.includes('edit'));
  assert.ok(!f.events.includes('bind'));
  assert.deepEqual(f.components(), changed);
  assert.match(click.replies.at(-1)?.content ?? '', /preview changed/);
});

test('failed ownership binding prevents append; failed metadata rolls back and unbinds only the new asset', async t => {
  const denied = harness(t, { bind: async () => false });
  await denied.sessions.handle(denied.click().interaction);
  assert.ok(!denied.events.includes('edit'));
  assert.deepEqual(denied.components(), denied.initialComponents);
  const failed = harness(t, { verify: async () => false });
  await failed.sessions.handle(failed.click().interaction);
  assert.deepEqual(failed.components(), failed.initialComponents);
  assert.ok(failed.events.includes('unbind'));
  assert.equal(failed.bound.size, 0);
  assert.deepEqual(failed.cancelled, ['reservation-1']);
});

test('an ambiguous append reconciles once and keeps a bound asset when neither edit nor fetch is conclusive', async t => {
  const f = harness(t);
  f.onEdit(async (_components, index) => { if (index === 1) throw Error('Connection lost after PATCH'); });
  f.onFetch(async index => { if (index === 2) throw Error('Discord unavailable'); });
  await f.sessions.handle(f.click().interaction);
  assert.equal(f.events.filter(event => event === 'fetch').length, 2);
  assert.equal(f.bound.has(mediaAt(1).id), true, 'A late successful edit may still reference the new asset');
  assert.ok(!f.events.includes('unbind'));
  const again = f.click();
  await f.sessions.handle(again.interaction);
  assert.match(again.replies[0].content!, /expired/);
});

test('an edit accepted by Discord despite a transport error is verified and not submitted twice', async t => {
  const f = harness(t);
  f.onEdit(async (components, index) => {
    if (index === 1) { f.setComponents(structuredClone(components)); throw Error('Lost REST response'); }
  });
  const click = f.click();
  await f.sessions.handle(click.interaction);
  assert.equal(gallery(f.components()).items.length, 2);
  assert.equal(f.events.filter(event => event === 'edit').length, 2, 'One append and one final control update');
  assert.equal(f.bound.has(mediaAt(1).id), true);
  assert.ok(!f.events.includes('unbind'));
  assert.match(click.replies.at(-1)?.content ?? '', /Added item/);
});

test('policy revocation after binding releases the unused reference without publishing', async t => {
  let allowedCalls = 0;
  const f = harness(t, { allowed: async () => ++allowedCalls < 4 });
  await f.sessions.handle(f.click().interaction);
  assert.ok(f.events.includes('bind'));
  assert.ok(f.events.includes('unbind'));
  assert.ok(!f.events.includes('edit'));
  assert.equal(f.bound.size, 0);
});

test('revocation or expiration during the final album edit rolls back before committing the new item', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const reason of ['policy', 'remove', 'deadline'] as const) {
    let allowed = true;
    const f = harness(t, { allowed: async () => allowed });
    f.onEdit(async (_components, index) => {
      if (index !== 2) return;
      if (reason === 'policy') allowed = false;
      else if (reason === 'remove') f.sessions.remove(owner.messageId);
      else t.mock.timers.tick(120_000);
    });
    const click = f.click();
    await f.sessions.handle(click.interaction);
    assert.deepEqual(f.components(), f.initialComponents, reason);
    assert.equal(f.bound.size, 0, reason);
    assert.ok(f.events.includes('unbind'), reason);
    assert.ok(click.replies.every(reply => !reply.content?.startsWith('Added item')), reason);
  }
});

test('the gallery stops after ten items and never prepares an eleventh', async t => {
  let index = 1;
  const f = harness(t, { prepare: async () => mediaAt(index++, 12) }, mediaAt(0, 12));
  for (let count = 0; count < 9; count++) await f.sessions.handle(f.click().interaction);
  assert.equal(gallery(f.components()).items.length, 10);
  assert.equal(customIds(f.components()).some(id => id.startsWith('linky:album:')), false);
  const exhausted = f.click();
  await f.sessions.handle(exhausted.interaction);
  assert.match(exhausted.replies[0].content!, /album limit/);
  assert.equal(index, 10);
});

test('an image can join a video gallery while preserving the original video', async t => {
  const image: EromeMedia = { ...mediaAt(1), kind: 'image', mimeType: 'image/jpeg',
    url: mediaAt(1).url.replace('.mp4', '.jpg'), metadata: { width: 1080, height: 1920 } };
  const f = harness(t, { prepare: async () => image });
  await f.sessions.handle(f.click().interaction);
  assert.deepEqual(gallery(f.components()).items.map(item => item.media.url), [mediaAt(0).url, image.url]);
  assert.equal(f.bound.has(image.id), true);
});

test('new Details replaces only the old diagnostic row after its binding callback succeeds', async t => {
  const oldId = 'linky:details:old', newId = 'linky:details:new';
  const row = (id: string): APIMessageTopLevelComponent => ({ type: ComponentType.ActionRow, components: [
    { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: id, label: 'Details' },
  ] });
  for (const fail of [false, true]) {
    const bindings: string[] = [];
    const f = harness(t, { details: async (_traceId, messageId) => {
      bindings.push(messageId);
      if (fail) throw Error('Diagnostics disk unavailable');
      return [row(newId)];
    } });
    f.setComponents([...f.components(), row(oldId)]);
    await f.sessions.handle(f.click().interaction);
    assert.deepEqual(bindings, [owner.messageId]);
    const ids = customIds(f.components());
    assert.equal(ids.includes(oldId), fail);
    assert.equal(ids.includes(newId), !fail);
    assert.ok(ids.includes('linky:remove'));
    assert.equal(gallery(f.components()).items.length, 2, 'Diagnostic failure cannot undo a valid album item');
  }
});

test('removing the source during preparation cancels the item and releases its reservation', async t => {
  let entered!: () => void, release!: (media: EromeMedia) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = harness(t, { prepare: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const pending = f.sessions.handle(f.click().interaction);
  await started;
  f.sessions.remove(owner.messageId);
  release(mediaAt(1));
  await pending;
  assert.ok(!f.events.includes('bind'));
  assert.ok(!f.events.includes('edit'));
  assert.deepEqual(f.cancelled, ['reservation-1']);
  assert.deepEqual(f.components(), f.initialComponents);
});

test('uncertain final controls or a failed rollback retain the potentially displayed asset', async t => {
  for (const stage of ['controls', 'rollback'] as const) {
    const f = harness(t, stage === 'rollback' ? { verify: async () => false } : {});
    f.onEdit(async (_components, index) => {
      if (index === 2) throw Error(stage === 'controls' ? 'Controls response lost' : 'Rollback unavailable');
    });
    await f.sessions.handle(f.click().interaction);
    assert.equal(f.bound.has(mediaAt(1).id), true, stage);
    assert.ok(!f.events.includes('unbind'), stage);
    const stale = f.click();
    await f.sessions.handle(stale.interaction);
    assert.match(stale.replies[0].content!, /expired/);
  }
});
