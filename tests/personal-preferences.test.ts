import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationIntegrationType, InteractionContextType, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { PersonalPreferences, PERSONAL_PREFERENCE_LIMIT } from '../src/services/PersonalPreferences';
import { data, execute } from '../src/commands/autofix';

const directory = mkdtempSync(join(tmpdir(), 'linky-personal-preferences-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const GUILD = '111111111111111111', OTHER = '222222222222222222', USER = '333333333333333333';
let next = 0;
const file = () => join(directory, `${next++}.json`);

function interaction(enabled: boolean | null = null, guildId: string | null = GUILD) {
  const events: { kind: string; payload: any }[] = [];
  const input = { guildId, user: { id: USER }, options: { getBoolean: () => enabled },
    reply: async (payload: unknown) => { events.push({ kind: 'reply', payload }); },
    deferReply: async (payload: unknown) => { events.push({ kind: 'defer', payload }); },
    editReply: async (payload: unknown) => { events.push({ kind: 'edit', payload }); },
  };
  return { input: input as unknown as ChatInputCommandInteraction, events };
}

test('personal preferences default on, persist only opted-out IDs, and undo deletes the record', async () => {
  const path = file(), store = new PersonalPreferences(path);
  assert.equal(store.isOptedOut(GUILD, USER), false);
  await store.setOptedOut(GUILD, USER, true);
  assert.equal(new PersonalPreferences(path).isOptedOut(GUILD, USER), true);
  assert.equal(store.isOptedOut(OTHER, USER), false);
  assert.equal(store.isOptedOut(GUILD, OTHER), false);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { [GUILD]: [USER] });
  await store.setOptedOut(GUILD, USER, false);
  assert.equal(new PersonalPreferences(path).isOptedOut(GUILD, USER), false);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
  assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);
});

test('concurrent personal writes and guild purge preserve choices in other servers', async () => {
  const path = file(), store = new PersonalPreferences(path);
  await Promise.all([store.setOptedOut(GUILD, USER, true), store.setOptedOut(GUILD, OTHER, true),
    store.setOptedOut(OTHER, USER, true), store.setOptedOut(GUILD, USER, false)]);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { [GUILD]: [OTHER], [OTHER]: [USER] });
  await store.removeGuild(GUILD);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { [OTHER]: [USER] });
  assert.equal(new PersonalPreferences(path).isOptedOut(GUILD, OTHER), false);
});

test('a failed personal write leaves durable state unchanged and later writes succeed', async () => {
  const path = file();
  let fail = false;
  const store = new PersonalPreferences(path, async (target, content) => {
    if (fail) { fail = false; throw new Error('Disk full'); }
    await writeFile(target, content);
  });
  await store.setOptedOut(GUILD, USER, true);
  const before = readFileSync(path, 'utf8');
  fail = true;
  await assert.rejects(store.setOptedOut(GUILD, USER, false), /Disk full/);
  assert.equal(store.isOptedOut(GUILD, USER), true);
  assert.equal(readFileSync(path, 'utf8'), before);
  await store.setOptedOut(GUILD, USER, false);
  assert.equal(new PersonalPreferences(path).isOptedOut(GUILD, USER), false);
});

test('invalid personal preference files and writes fail closed', async () => {
  for (const value of [[], null, { bad: [USER] }, { [GUILD]: [] }, { [GUILD]: [USER, USER] },
    { [GUILD]: ['bad'] }, { [GUILD]: true }, { [GUILD]: { user: USER } }]) {
    const path = file(); writeFileSync(path, JSON.stringify(value));
    assert.throws(() => new PersonalPreferences(path), /Invalid personal/);
  }
  const store = new PersonalPreferences(file(), async () => assert.fail('Invalid write'));
  await assert.rejects(store.setOptedOut('bad', USER, true));
  await assert.rejects(store.setOptedOut(GUILD, 'bad', true));
  await assert.rejects(store.setOptedOut(GUILD, USER, 'true' as unknown as boolean));
  await assert.rejects(store.removeGuild('bad'));
});

test('autofix is available to ordinary server members and shows a private read-only default', async () => {
  const command = data.toJSON();
  assert.deepEqual(command.contexts, [InteractionContextType.Guild]);
  assert.deepEqual(command.integration_types, [ApplicationIntegrationType.GuildInstall]);
  assert.equal(command.default_member_permissions, undefined);
  const store = new PersonalPreferences(file(), async () => assert.fail('Read-only command wrote'));
  const f = interaction(); await execute(f.input, store);
  assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
  assert.match(f.events[1].payload.content, /Automatic fixing is on/);
  assert.match(f.events[1].payload.content, /manual|\/fix/);
  assert.deepEqual(f.events[1].payload.allowedMentions, { parse: [] });
});

test('autofix acknowledges only durable changes and supports private undo', async () => {
  const path = file(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store = new PersonalPreferences(path, async (target, content) => { await gate; await writeFile(target, content); });
  const f = interaction(false), pending = execute(f.input, store);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.events.length, 1);
  assert.equal(store.isOptedOut(GUILD, USER), false);
  release(); await pending;
  assert.equal(new PersonalPreferences(path).isOptedOut(GUILD, USER), true);
  assert.match(f.events[1].payload.content, /Automatic fixing is off/);
  assert.match(f.events[1].payload.content, /only this server ID and your account ID/);
  await execute(interaction(true).input, store);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
});

test('autofix rejects DMs and reports persistence failures privately', async () => {
  const store = new PersonalPreferences(file(), async () => { throw new Error('Disk full'); });
  const dm = interaction(false, null); await execute(dm.input, store);
  assert.equal(dm.events.length, 1); assert.equal(dm.events[0].payload.flags, MessageFlags.Ephemeral);
  const f = interaction(false); await assert.rejects(execute(f.input, store), /Disk full/);
  assert.match(f.events[1].payload.content, /previous choice is unchanged/);
  assert.equal(store.isOptedOut(GUILD, USER), false);
});

test('oversized preference files fail closed and record capacity never silently discards opt-outs', async () => {
  const large = file(); writeFileSync(large, ' '.repeat(1024 * 1024 + 1));
  assert.throws(() => new PersonalPreferences(large), /Could not load personal/);
  const users = Array.from({ length: PERSONAL_PREFERENCE_LIMIT }, (_, index) => String(400000000000000000n + BigInt(index)));
  const path = file(); writeFileSync(path, JSON.stringify({ [GUILD]: users }));
  const store = new PersonalPreferences(path);
  const before = readFileSync(path, 'utf8');
  await assert.rejects(store.setOptedOut(GUILD, USER, true), /record limit/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(store.isOptedOut(GUILD, users[0]), true);
  await store.setOptedOut(GUILD, users[0], false);
  await store.setOptedOut(GUILD, USER, true);
  assert.equal(new PersonalPreferences(path).isOptedOut(GUILD, USER), true);
  writeFileSync(path, JSON.stringify({ [GUILD]: [...users, USER] }));
  assert.throws(() => new PersonalPreferences(path), /record limit/);
});

test('flush waits for queued preferences to persist', async () => {
  const path = file(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store = new PersonalPreferences(path, async (target, content) => { await gate; await writeFile(target, content); });
  const pending = store.setOptedOut(GUILD, USER, true);
  let flushed = false;
  const flush = store.flush().then(() => { flushed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(flushed, false);
  release(); await Promise.all([pending, flush]);
  assert.equal(new PersonalPreferences(path).isOptedOut(GUILD, USER), true);
});

test('ready-time retention removes guilds left while offline without changing retained opt-outs', async () => {
  const path = file(), store = new PersonalPreferences(path);
  await store.setOptedOut(GUILD, USER, true);
  await store.setOptedOut(OTHER, USER, true);
  const restarted = new PersonalPreferences(path);
  const retained = [GUILD];
  const cleanup = restarted.retainGuilds(retained);
  retained.length = 0;
  await cleanup;
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { [GUILD]: [USER] });
  assert.equal(new PersonalPreferences(path).isOptedOut(OTHER, USER), false);
  await assert.rejects(restarted.retainGuilds(['bad']));
  await restarted.retainGuilds([]);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
});

test('failed ready-time retention preserves choices and retries can remove them', async () => {
  const path = file(); writeFileSync(path, JSON.stringify({ [GUILD]: [USER], [OTHER]: [USER] }));
  let fail = true;
  const store = new PersonalPreferences(path, async (target, content) => {
    if (fail) { fail = false; throw new Error('Disk full'); }
    await writeFile(target, content);
  });
  await assert.rejects(store.retainGuilds([GUILD]), /Disk full/);
  assert.equal(store.isOptedOut(OTHER, USER), true);
  assert.equal(new PersonalPreferences(path).isOptedOut(OTHER, USER), true);
  await store.retainGuilds([GUILD]);
  assert.equal(new PersonalPreferences(path).isOptedOut(OTHER, USER), false);
});

test('unchanged personal choices and empty retention do not create storage', async () => {
  const store = new PersonalPreferences(file(), async () => assert.fail('No records changed'));
  await store.retainGuilds([GUILD]);
  await store.removeGuild(GUILD);
  await store.setOptedOut(GUILD, USER, false);
});
