import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageFlags } from 'discord.js';
import { RepostRegistry, REPOST_RETENTION_MS, REMOVE_REPOST_CUSTOM_ID, type RepostInteraction, type RepostMessage, type RepostRecord } from '../src/services/RepostRegistry';

const NOW = Date.UTC(2026, 8, 12);
const snowflake = (offset: number, sequence = 0) => String((BigInt(NOW + offset - 1_420_070_400_000) << 22n) + BigInt(sequence));
const BOT = snowflake(-10_000, 1), AUTHOR = snowflake(-10_000, 2), MOD = snowflake(-10_000, 3);
const GUILD = snowflake(-10_000, 4), CHANNEL = snowflake(-10_000, 5);
type Options = ConstructorParameters<typeof RepostRegistry>[0];

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'linky-reposts-'));
  const path = join(directory, 'reposts.json');
  const messages = new Map<string, RepostMessage>(), deleted: string[] = [], fetched: string[] = [];
  const errors: Error[] = [], permissionChecks: string[] = [], managers: RepostRegistry[] = [];
  let time = NOW, allowed = false, failure: unknown, relatedFailure = false;
  const related: string[] = [];
  const message = (id: string, authorId: string, content = 'Test message'): RepostMessage => {
    const value: RepostMessage = { id, guildId: GUILD, channelId: CHANNEL, author: { id: authorId }, content,
      flags: { bitfield: 0 }, editedTimestamp: null,
      delete: async () => { if (failure) throw failure; deleted.push(id); messages.delete(id); },
    };
    messages.set(id, value);
    return value;
  };
  const source = message(snowflake(-1_000), AUTHOR, 'Source text is never stored');
  const replacement = message(snowflake(0), BOT, 'Replacement text is never stored');
  const record: RepostRecord = { guildId: GUILD, channelId: CHANNEL, sourceId: source.id,
    replacementId: replacement.id, authorId: AUTHOR, mode: 'reply' };
  const manager = (overrides: Partial<Options> = {}) => {
    const instance = new RepostRegistry({ path, botUserId: BOT, now: () => time,
      fetchMessage: async (channel, id) => { assert.equal(channel, CHANNEL); fetched.push(id); return messages.get(id) ?? null; },
      canManageMessages: async (entry, id) => { assert.equal(entry.channelId, CHANNEL); permissionChecks.push(id); return allowed; },
      removeRelated: async entry => { related.push(entry.replacementId); if (relatedFailure) throw new Error('card cleanup failed'); },
      onError: error => errors.push(error), ...overrides,
    });
    managers.push(instance);
    return instance;
  };
  const interaction = (userId = AUTHOR) => {
    const responses: { content?: string; flags?: number }[] = [];
    const value: RepostInteraction = { customId: REMOVE_REPOST_CUSTOM_ID, guildId: GUILD, channelId: CHANNEL,
      user: { id: userId }, message: { id: replacement.id, author: { id: BOT } }, deferred: false,
      deferReply: async options => { assert.equal(options.flags, MessageFlags.Ephemeral); value.deferred = true; },
      reply: async options => { responses.push(options as { content?: string; flags?: number }); value.replied = true; },
      editReply: async options => { assert.equal(value.deferred || value.replied, true); responses.push(options as { content?: string }); },
    };
    return { value, responses };
  };
  t.after(async () => { managers.forEach(m => m.stop()); await rm(directory, { recursive: true, force: true }); });
  return { path, source, replacement, record, messages, fetched, deleted, related, errors, permissionChecks, message, manager, interaction,
    advance: (ms: number) => { time += ms; }, allowModerator: (value: boolean) => { allowed = value; },
    failDelete: (value?: unknown) => { failure = value; }, failRelated: (value: boolean) => { relatedFailure = value; },
    saved: async () => JSON.parse(await readFile(path, 'utf8')),
  };
}

test('ownership survives restart with only allowed metadata and isolated read values', async t => {
  const f = await fixture(t), registry = f.manager();
  assert.equal(await registry.remember(f.record), true);
  assert.equal(await registry.remember({ ...f.record }), true);
  const restored = f.manager();
  assert.deepEqual(restored.findBySource(f.source.id), f.record);
  restored.findByReplacement(f.replacement.id)!.authorId = MOD;
  assert.equal(restored.findByReplacement(f.replacement.id)!.authorId, AUTHOR);
  const serialized = await readFile(f.path, 'utf8');
  assert(!serialized.includes('text is never stored'));
  assert.deepEqual(Object.keys((await f.saved()).records[0]).sort(), ['authorId', 'channelId', 'guildId', 'mode', 'replacementId', 'sourceId']);
  assert.equal(await registry.remember({ ...f.record, content: 'not allowed' } as RepostRecord), false);
});

test('unauthorized, forged and cross-channel buttons never fetch or delete a target', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  const unauthorized = f.interaction(MOD);
  assert.equal(await registry.handleRemove(unauthorized.value), true);
  assert.match(unauthorized.responses[0].content!, /original author/);
  assert.deepEqual(f.permissionChecks, [MOD]);
  for (const change of [
    (i: RepostInteraction) => { i.channelId = snowflake(-10_000, 6); },
    (i: RepostInteraction) => { i.guildId = snowflake(-10_000, 7); },
    (i: RepostInteraction) => { i.message.id = f.source.id; },
    (i: RepostInteraction) => { i.message.author.id = AUTHOR; },
  ]) {
    const forged = f.interaction(); change(forged.value);
    await registry.handleRemove(forged.value);
    assert.equal(forged.responses[0].flags, MessageFlags.Ephemeral);
  }
  assert.deepEqual(f.fetched, []);
  assert.deepEqual(f.deleted, []);
  const other = f.interaction(); other.value.customId = `linky:remove:${f.source.id}`;
  assert.equal(await registry.handleRemove(other.value), false);
  assert.deepEqual(other.responses, []);
});

test('author removal persists intent before deleting related data and bot output, preserving the source', async t => {
  const f = await fixture(t);
  const registry = f.manager({ removeRelated: async record => {
    assert((await f.saved()).remove.includes(record.replacementId));
    assert(f.messages.has(record.replacementId));
  } });
  await registry.remember(f.record);
  const request = f.interaction();
  assert.equal(await registry.handleRemove(request.value), true);
  assert.deepEqual(f.permissionChecks, []);
  assert.deepEqual(f.deleted, [f.replacement.id]);
  assert(f.messages.has(f.source.id));
  assert.deepEqual((await f.saved()).records, []);
  assert.match(request.responses[0].content!, /Removed/);
});

test('moderator permissions are checked fresh on every action and fetched ownership cannot be forged', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  f.allowModerator(true);
  assert.deepEqual(await registry.authorize(f.interaction(MOD).value), f.record);
  f.allowModerator(false);
  assert.equal(await registry.authorize(f.interaction(MOD).value), null);
  assert.deepEqual(f.permissionChecks, [MOD, MOD]);
  f.replacement.author.id = AUTHOR;
  assert.equal(await registry.authorize(f.interaction().value), null);
  assert.deepEqual(f.deleted, []);
});

test('authorized failures remain durable and retry related cleanup after restart', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  f.failRelated(true);
  await registry.handleRemove(f.interaction().value);
  assert.deepEqual(f.deleted, []);
  assert.deepEqual((await f.saved()).remove, [f.replacement.id]);
  f.failRelated(false); f.failDelete({ code: 50013 });
  await f.manager().sweep();
  assert.deepEqual((await f.saved()).remove, [f.replacement.id]);
  f.failDelete(); await f.manager().sweep();
  assert.deepEqual(f.deleted, [f.replacement.id]);
  assert.deepEqual((await f.saved()).records, []);
});

test('a failed intent write prevents deletion and later writes recover', async t => {
  const f = await fixture(t);
  let denied = false;
  const registry = f.manager({ write: async (path, value) => { if (denied) throw new Error('disk denied'); await writeFile(path, value); } });
  await registry.remember(f.record); denied = true;
  await registry.handleRemove(f.interaction().value);
  assert.deepEqual(f.deleted, []);
  assert.deepEqual((await f.saved()).remove, []);
  denied = false; await registry.handleRemove(f.interaction().value);
  assert.deepEqual(f.deleted, [f.replacement.id]);
});

test('source deletion removes only a linked reply; replace-mode self deletion is ignored', async t => {
  for (const mode of ['reply', 'replace'] as const) {
    const f = await fixture(t), registry = f.manager();
    await registry.remember({ ...f.record, mode });
    await registry.handleSourceDelete({ ...f.source, channelId: snowflake(-10_000, 8) });
    assert.deepEqual(f.deleted, []);
    await registry.handleSourceDelete(f.source);
    assert.deepEqual(f.deleted, mode === 'reply' ? [f.replacement.id] : []);
    assert(f.messages.has(f.source.id));
  }
});

test('authorized retry persists cleanup and refresh before removing related cards and regenerating', async t => {
  const f = await fixture(t);
  const registry = f.manager({ removeRelated: async record => {
    const saved = await f.saved();
    assert(saved.remove.includes(record.replacementId));
    assert(saved.refresh.includes(record.replacementId));
    assert(f.messages.has(record.replacementId));
  } });
  await registry.remember(f.record);
  const request = f.interaction(); request.value.customId = 'linky:retry';
  const authorized = await registry.authorize(request.value);
  assert(authorized);
  assert.equal(await registry.retry(authorized, async source => {
    assert.equal(source.id, f.source.id);
    assert.deepEqual(f.deleted, [f.replacement.id]);
    assert.deepEqual((await f.saved()).refresh, [f.replacement.id]);
    const next = f.message(snowflake(1_000), BOT);
    assert(await registry.remember({ ...f.record, replacementId: next.id }));
  }), true);
  assert(f.messages.has(f.source.id));
  assert.equal(registry.findBySource(f.source.id)?.replacementId, snowflake(1_000));
});

test('failed retry cleanup and regeneration survive restart without deleting the source', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  f.failRelated(true);
  assert.equal(await registry.retry(f.record, async () => { assert.fail('Cleanup failed'); }), false);
  assert.deepEqual(f.deleted, []);
  assert.deepEqual((await f.saved()).refresh, [f.replacement.id]);
  f.failRelated(false);
  await f.manager({ regenerate: async () => { throw new Error('Transient delivery failure'); } }).sweep();
  assert.deepEqual(f.deleted, [f.replacement.id]);
  assert.deepEqual((await f.saved()).refresh, [f.replacement.id]);
  let regenerated = false;
  await f.manager({ regenerate: async () => { regenerated = true; } }).sweep();
  assert(regenerated);
  assert.deepEqual((await f.saved()).records, []);
  assert(f.messages.has(f.source.id));
});

test('retry rejects stale ownership and replace records without fetching or deleting messages', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  for (const record of [
    { ...f.record, authorId: MOD }, { ...f.record, channelId: snowflake(-10_000, 8) },
    { ...f.record, mode: 'replace' as const }, { ...f.record, replacementId: f.source.id },
  ]) assert.equal(await registry.retry(record, async () => { assert.fail('Ownership did not match'); }), false);
  await registry.forget(f.replacement.id);
  assert.equal(await registry.retry(f.record, async () => { assert.fail('Ownership was removed'); }), false);
  assert.deepEqual(f.fetched, []);
  assert.deepEqual(f.deleted, []);
});

test('retry preserves the notice for a missing, inaccessible or mismatched source', async t => {
  for (const source of ['missing', 'inaccessible', 'wrong-author'] as const) {
    const f = await fixture(t), registry = f.manager({ fetchMessage: async (_channel, id) => {
      if (id !== f.source.id) return f.messages.get(id) ?? null;
      if (source === 'inaccessible') throw { code: 50001 };
      return source === 'missing' ? null : { ...f.source, author: { id: MOD } };
    } });
    await registry.remember(f.record);
    assert.equal(await registry.retry(f.record, async () => { assert.fail('No usable source'); }), false);
    assert.deepEqual(f.deleted, []);
    assert.deepEqual(f.related, []);
    assert.deepEqual((await f.saved()).remove, []);
    assert(registry.findByReplacement(f.replacement.id));
  }
});

test('concurrent retries serialize by source and cannot replace a newer repost twice', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  let regenerated = 0;
  const regenerate = async () => {
    regenerated++;
    const next = f.message(snowflake(1_000), BOT);
    assert(await registry.remember({ ...f.record, replacementId: next.id }));
  };
  assert.deepEqual(await Promise.all([registry.retry(f.record, regenerate), registry.retry(f.record, regenerate)]), [true, false]);
  assert.equal(regenerated, 1);
  assert.deepEqual(f.deleted, [f.replacement.id]);
  assert.equal(registry.findBySource(f.source.id)?.replacementId, snowflake(1_000));
});

test('an already-deleted target is forgotten but inaccessible or different output is retained', async t => {
  for (const error of [null, { code: 10008 }, { code: 10003 }, { status: 404 }, { code: 50001 }]) {
    const f = await fixture(t), registry = f.manager({ fetchMessage: async () => { if (error) throw error; return null; } });
    await registry.remember(f.record);
    await registry.handleSourceDelete(f.source);
    assert.equal(registry.findByReplacement(f.replacement.id) !== undefined, error?.code === 50001);
    assert.deepEqual(f.deleted, []);
    assert.equal(f.related.length, error?.code === 50001 ? 0 : 1, 'related cards are cleaned even when the base is gone');
  }
  const f = await fixture(t), registry = f.manager({ fetchMessage: async () => f.source });
  await registry.remember(f.record); await registry.handleSourceDelete(f.source);
  assert(registry.findByReplacement(f.replacement.id));
  assert.deepEqual(f.related, []);
});

test('a MessageDelete event from stale-reply cleanup cannot erase pending regeneration', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  const before = { ...f.source }; f.source.content = 'Edited';
  f.replacement.delete = async () => {
    f.messages.delete(f.replacement.id);
    await registry.forget(f.replacement.id);
  };
  let regenerated = false;
  await registry.handleSourceUpdate(before, f.source, async () => { regenerated = true; });
  assert(regenerated);
  assert.deepEqual((await f.saved()).records, []);
});

test('direct replacement deletion cleans related cards durably without deleting the source', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember({ ...f.record, mode: 'replace' });
  f.messages.delete(f.replacement.id);
  f.failRelated(true);
  await registry.handleReplacementDelete({ id: f.replacement.id, channelId: CHANNEL, guildId: GUILD, partial: true });
  assert.deepEqual((await f.saved()).remove, [f.replacement.id]);
  assert.deepEqual((await f.saved()).refresh, []);
  f.failRelated(false);
  await f.manager().sweep();
  assert.equal(f.related.length, 2);
  assert.deepEqual((await f.saved()).records, []);
  assert.deepEqual(f.deleted, []);
  assert(f.messages.has(f.source.id));
});

test('replacement deletion events reject unknown, cross-channel and non-bot message identities', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  for (const message of [
    f.source, { ...f.replacement, channelId: snowflake(-10_000, 8) },
    { ...f.replacement, guildId: snowflake(-10_000, 9) }, { ...f.replacement, author: { id: AUTHOR } },
  ]) await registry.handleReplacementDelete(message);
  assert.deepEqual(f.fetched, []);
  assert.deepEqual(f.related, []);
  assert.deepEqual(f.deleted, []);
  assert.deepEqual((await f.saved()).records, [f.record]);
});

test('a queued self-deletion event preserves a failed refresh and safely retries it', async t => {
  const f = await fixture(t);
  let regenerated = 0, deletionEvent: Promise<void> | undefined;
  const registry = f.manager({ regenerate: async () => { regenerated++; } });
  await registry.remember(f.record);
  f.replacement.delete = async () => {
    f.messages.delete(f.replacement.id);
    // Discord dispatches gateway events independently of the REST deletion response.
    deletionEvent = registry.handleReplacementDelete(f.replacement);
  };
  const before = { ...f.source }; f.source.content = 'Edited';
  await registry.handleSourceUpdate(before, f.source, async () => { throw new Error('Transient delivery failure'); });
  await deletionEvent;
  assert.equal(regenerated, 1);
  assert.deepEqual((await f.saved()).records, []);
  assert(f.messages.has(f.source.id));
});

test('source edits remove stale replies then regenerate once from a fresh source without deadlocking remember', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  const before = { ...f.source };
  f.source.content = 'Edited source'; f.source.editedTimestamp = NOW + 1_000;
  let regenerated = 0;
  await registry.handleSourceUpdate(before, f.source, async latest => {
    regenerated++;
    assert.equal(latest.content, 'Edited source');
    assert.deepEqual(f.deleted, [f.replacement.id]);
    const next = f.message(snowflake(2_000), BOT);
    assert.equal(await registry.remember({ ...f.record, replacementId: next.id }), true);
  });
  assert.equal(regenerated, 1);
  assert.equal(registry.findBySource(f.source.id)?.replacementId, snowflake(2_000));
  await registry.handleSourceUpdate(before, f.source, async () => { assert.fail('Queued stale update was already copied'); });
  assert(f.messages.has(f.source.id));
});

test('replacement ownership remains recoverable when regeneration fails after saving its new reply', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  const before = { ...f.source }; f.source.content = 'Edited';
  const newId = snowflake(1_000);
  await registry.handleSourceUpdate(before, f.source, async () => {
    f.message(newId, BOT);
    assert(await registry.remember({ ...f.record, replacementId: newId }));
    assert.deepEqual((await f.saved()).refresh, [newId]);
    assert.deepEqual((await f.saved()).remove, [newId]);
    throw new Error('Delivery interrupted after ownership write');
  });
  assert.equal(registry.findBySource(f.source.id)?.replacementId, newId);
  let regenerated = false;
  await f.manager({ regenerate: async () => {
    assert(!f.messages.has(newId), 'unfinished output is cleaned before retry');
    regenerated = true;
  } }).sweep();
  assert(regenerated);
  assert.deepEqual((await f.saved()).records, []);
  assert(f.messages.has(f.source.id));
});

test('embed-only updates, link-warning flags and unchanged text never duplicate replies', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  const after = { ...f.source, editedTimestamp: NOW + 1_000, flags: { bitfield: MessageFlags.ShouldShowLinkNotDiscordWarning } };
  await registry.handleSourceUpdate(f.source, after, async () => { assert.fail('Only embed metadata changed'); });
  assert.deepEqual(f.deleted, []);
});

test('attachment and suppression changes regenerate while a partial old message uses edit time', async t => {
  for (const kind of ['attachment', 'flags', 'partial'] as const) {
    const f = await fixture(t), registry = f.manager();
    await registry.remember(f.record);
    const before = { ...f.source };
    if (kind === 'attachment') f.source.attachments = { values: () => [{ id: snowflake(3_000), name: 'image.png' }].values() };
    if (kind === 'flags') f.source.flags = { bitfield: MessageFlags.SuppressEmbeds };
    if (kind === 'partial') { before.partial = true; before.content = null; f.source.editedTimestamp = NOW + 1_000; }
    let regenerated = false;
    await registry.handleSourceUpdate(before, f.source, async () => { regenerated = true; });
    assert(regenerated);
    assert.deepEqual((await f.saved()).records, []);
  }
});

test('failed refresh survives restart and a deleted source is never regenerated', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  const before = { ...f.source }; f.source.content = 'Edited';
  await registry.handleSourceUpdate(before, f.source, async () => { throw new Error('handler failed'); });
  assert.deepEqual((await f.saved()).refresh, [f.replacement.id]);
  assert.deepEqual((await f.saved()).remove, []);
  f.messages.delete(f.source.id);
  await f.manager({ regenerate: async () => assert.fail('Source was deleted') }).sweep();
  assert.deepEqual((await f.saved()).records, []);
});

test('restart reconciliation removes orphan replies and refreshes sources edited while offline', async t => {
  for (const edited of [false, true]) {
    const f = await fixture(t);
    await f.manager().remember(f.record);
    if (edited) { f.source.content = 'Edited offline'; f.source.editedTimestamp = NOW + 1_000; }
    else f.messages.delete(f.source.id);
    let regenerated = false;
    const restored = f.manager({ regenerate: async source => { regenerated = true; assert.equal(source.content, 'Edited offline'); } });
    restored.start(); await restored.sweep();
    assert.equal(regenerated, edited);
    assert.deepEqual(f.deleted, [f.replacement.id]);
  }
});

test('concurrent writes retain records and conflicting ownership cannot replace an active post', async t => {
  const f = await fixture(t), registry = f.manager();
  const records = Array.from({ length: 5 }, (_, i) => ({ ...f.record, sourceId: snowflake(-1_000, i), replacementId: snowflake(0, i) }));
  assert.deepEqual(await Promise.all(records.map(r => registry.remember(r))), [true, true, true, true, true]);
  assert.equal((await f.saved()).records.length, 5);
  assert.equal(await registry.remember({ ...records[0], authorId: MOD }), false);
  assert.equal(await registry.remember({ ...records[0], replacementId: snowflake(0, 9) }), false);
});

test('retention prunes only ordinary ownership and never discards a pending removal', async t => {
  const f = await fixture(t), registry = f.manager();
  await registry.remember(f.record);
  f.failDelete({ code: 50013 });
  await registry.handleRemove(f.interaction().value);
  f.advance(REPOST_RETENTION_MS + 1);
  await registry.sweep();
  assert(registry.findByReplacement(f.replacement.id));
  assert.deepEqual((await f.saved()).remove, [f.replacement.id]);
  f.failDelete(); await registry.sweep();
  assert.equal(registry.findByReplacement(f.replacement.id), undefined);
});

test('capacity rejects new ownership and corrupt journals fail closed', async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 10_000 }, (_, i) => ({ ...f.record, sourceId: snowflake(-1_000, i), replacementId: snowflake(0, i) }));
  await writeFile(f.path, JSON.stringify({ records, remove: [], refresh: [] }));
  assert.equal(await f.manager().remember({ ...f.record, sourceId: snowflake(-1_000, 10_001), replacementId: snowflake(0, 10_001) }), false);
  for (const journal of [[], { records: [f.record], remove: [f.source.id], refresh: [] },
    { records: [{ ...f.record, token: 'must not be saved' }], remove: [], refresh: [] },
    { records: [f.record, f.record], remove: [], refresh: [] }]) {
    await writeFile(f.path, JSON.stringify(journal));
    assert.throws(() => f.manager(), /Invalid repost ownership/);
  }
});

test('a long failing cleanup backlog cannot starve later pending removals', async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 110 }, (_, i) => ({ ...f.record, sourceId: snowflake(-1_000, i), replacementId: snowflake(0, i) }));
  await writeFile(f.path, JSON.stringify({ records, remove: records.map(r => r.replacementId), refresh: [] }));
  const denied = new Set(records.slice(0, 100).map(r => r.replacementId));
  const registry = f.manager({ fetchMessage: async (_channel, id) => { if (denied.has(id)) throw { code: 50013 }; return null; } });
  await registry.sweep();
  assert.equal((await f.saved()).records.length, 110);
  await registry.sweep();
  assert.equal((await f.saved()).records.length, 100);
  assert((await f.saved()).records.every((record: RepostRecord) => denied.has(record.replacementId)));
});
