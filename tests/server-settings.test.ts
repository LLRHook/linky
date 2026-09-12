import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationIntegrationType, ComponentType, InteractionContextType, MessageFlags, PermissionFlagsBits, PermissionsBitField,
  type APIMessageTopLevelComponent, type ChatInputCommandInteraction } from 'discord.js';
import { ServerSettings, type ServerPreferences } from '../src/services/ServerSettings';
import { data, execute } from '../src/commands/setup';

const directory = mkdtempSync(join(tmpdir(), 'linky-server-settings-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const FIRST = '111111111111111111';
const SECOND = '222222222222222222';
let nextFile = 0;
const file = () => join(directory, `${nextFile++}.json`);

function setupView(payload: { components: { toJSON(): APIMessageTopLevelComponent }[] }) {
  assert.equal(payload.components.length, 1);
  const container = payload.components[0].toJSON();
  assert(container.type === ComponentType.Container);
  return {
    text: container.components.filter(component => component.type === ComponentType.TextDisplay).map(component => component.content).join('\n'),
    rows: container.components.filter(component => component.type === ComponentType.ActionRow),
  };
}

function interaction(enabled: boolean | null, guildId: string | null = FIRST,
  permissions: bigint = PermissionFlagsBits.ManageGuild) {
  const events: { name: string; payload: any }[] = [];
  const command = {
    guildId, channelId: SECOND, memberPermissions: new PermissionsBitField(permissions),
    options: { getBoolean: (name: string, required: boolean) => {
      assert.equal(name, 'enabled'); assert.equal(required, undefined); return enabled;
    } },
    reply: async (payload: unknown) => { events.push({ name: 'reply', payload }); },
    deferReply: async (payload: unknown) => { events.push({ name: 'defer', payload }); },
    editReply: async (payload: unknown) => { events.push({ name: 'edit', payload }); },
  };
  return { command: command as unknown as ChatInputCommandInteraction, events };
}

test('a missing settings file starts empty and saved enable/disable choices survive restart', async () => {
  const path = file();
  const servers = new ServerSettings(path);
  assert.equal(servers.get(FIRST), undefined);
  await servers.set(FIRST, true);
  assert.equal(new ServerSettings(path).get(FIRST), true);
  await servers.set(FIRST, false);
  assert.equal(new ServerSettings(path).get(FIRST), false);
  assert.equal(new ServerSettings(path).get(SECOND), undefined);
});

test('malformed settings stop startup instead of silently losing server choices', () => {
  for (const content of ['{', 'null', '[]', 'true', '{"bad-id":true}', `{"${FIRST}":"true"}`]) {
    const path = file();
    writeFileSync(path, content);
    assert.throws(() => new ServerSettings(path), /server settings/);
  }
});

test('concurrent changes retain both servers and apply later changes in order', async () => {
  const path = file();
  const servers = new ServerSettings(path);
  await Promise.all([servers.set(FIRST, true), servers.set(SECOND, true), servers.set(FIRST, false)]);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { [FIRST]: false, [SECOND]: true });
  assert.equal(new ServerSettings(path).get(SECOND), true);
  assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);
});

test('a failed save preserves disk and active state and does not block later writes', async () => {
  const path = file();
  let fail = false;
  const servers = new ServerSettings(path, async (target, content) => {
    if (fail) throw new Error('Disk full');
    await writeFile(target, content);
  });
  await servers.set(FIRST, true);
  fail = true;
  await assert.rejects(servers.set(FIRST, false), /Disk full/);
  assert.equal(servers.get(FIRST), true);
  assert.equal(new ServerSettings(path).get(FIRST), true);
  fail = false;
  await servers.set(SECOND, true);
  assert.equal(new ServerSettings(path).get(SECOND), true);
});

test('setup is registered only for guild installs and requires Manage Server', () => {
  const command = data.toJSON();
  assert.deepEqual(command.contexts, [InteractionContextType.Guild]);
  assert.deepEqual(command.integration_types, [ApplicationIntegrationType.GuildInstall]);
  assert.equal(command.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
  assert.equal(command.options?.[0].required ?? false, false);
});

for (const [name, guildId, permission] of [
  ['DM', null, PermissionFlagsBits.ManageGuild],
  ['ordinary member', FIRST, PermissionFlagsBits.SendMessages],
] as const) {
  test(`setup denies a ${name} privately without saving`, async () => {
    const servers = new ServerSettings(file(), async () => assert.fail('Unauthorized write'));
    const { command, events } = interaction(true, guildId, permission);
    await execute(command, servers);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'reply');
    assert.equal(events[0].payload.flags, MessageFlags.Ephemeral);
    assert.deepEqual(events[0].payload.allowedMentions, { parse: [] });
    assert.equal(servers.get(FIRST), undefined);
  });
}

test('setup defers privately and acknowledges only after the setting is saved', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const path = file();
  const servers = new ServerSettings(path, async (target, content) => { await gate; await writeFile(target, content); });
  const { command, events } = interaction(true, FIRST, PermissionFlagsBits.Administrator);
  const pending = execute(command, servers);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'defer');
  assert.equal(events[0].payload.flags, MessageFlags.Ephemeral);
  assert.equal(servers.get(FIRST), undefined);
  release();
  await pending;
  assert.equal(new ServerSettings(path).get(FIRST), true);
  assert.match(setupView(events[1].payload).text, /Server enabled/);
  assert.match(setupView(events[1].payload).text, /Active in this channel/);
  assert.equal(events[1].payload.flags, MessageFlags.IsComponentsV2);
  assert.equal(events[1].payload.content, null);
  assert.deepEqual(events[1].payload.embeds, []);
  assert.deepEqual(events[1].payload.allowedMentions, { parse: [] });
  await execute(interaction(false).command, servers);
  assert.equal(new ServerSettings(path).get(FIRST), false);
});

test('setup reports a save failure privately while preserving the previous state', async () => {
  const path = file();
  writeFileSync(path, JSON.stringify({ [FIRST]: true }));
  const servers = new ServerSettings(path, async () => { throw new Error('Disk full'); });
  const { command, events } = interaction(false);
  await assert.rejects(execute(command, servers), /Disk full/);
  assert.equal(events[0].payload.flags, MessageFlags.Ephemeral);
  assert.match(events[1].payload.content, /previous configuration is unchanged/);
  assert.equal(servers.get(FIRST), true);
  assert.equal(new ServerSettings(path).get(FIRST), true);
});

test('legacy enablement and preference-only records survive migration without opting in a server', async () => {
  const path = file();
  writeFileSync(path, JSON.stringify({ [FIRST]: true, [SECOND]: false }));
  const servers = new ServerSettings(path);
  assert.deepEqual(servers.getPreferences(FIRST), {});
  await servers.update(FIRST, { mode: 'reply', platforms: { instagram: false }, translateTweets: false });
  await servers.update('333333333333333333', { mode: 'reply' });
  await servers.set(FIRST, false);
  const restarted = new ServerSettings(path);
  assert.equal(restarted.get(FIRST), false);
  assert.equal(restarted.get(SECOND), false);
  assert.equal(restarted.get('333333333333333333'), undefined);
  assert.deepEqual(restarted.getPreferences(FIRST), { mode: 'reply', platforms: { instagram: false }, translateTweets: false });
  assert.deepEqual(restarted.getPreferences('333333333333333333'), { mode: 'reply' });
});

test('queued setup and preferences merge fields and platform toggles without losing choices', async () => {
  const path = file();
  const servers = new ServerSettings(path);
  await Promise.all([
    servers.update(FIRST, { mode: 'reply', platforms: { instagram: false } }),
    servers.set(FIRST, true),
    servers.update(FIRST, { platforms: { tiktok: false }, translateTweets: false }),
    servers.update(SECOND, { mode: 'reply' }),
    servers.update(FIRST, { platforms: { instagram: true } }),
    servers.set(FIRST, false),
  ]);
  const restarted = new ServerSettings(path);
  assert.equal(restarted.get(FIRST), false);
  assert.equal(restarted.get(SECOND), undefined);
  assert.deepEqual(restarted.getPreferences(FIRST), {
    mode: 'reply', platforms: { instagram: true, tiktok: false }, translateTweets: false,
  });
  assert.deepEqual(restarted.getPreferences(SECOND), { mode: 'reply' });
});

test('queued preference input and returned preferences cannot mutate stored choices', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const path = file();
  const servers = new ServerSettings(path, async (target, content) => { await gate; await writeFile(target, content); });
  const patch: ServerPreferences = { mode: 'reply', platforms: { instagram: false } };
  const pending = servers.update(FIRST, patch);
  patch.mode = 'replace';
  patch.platforms!.instagram = true;
  assert.deepEqual(servers.getPreferences(FIRST), {});
  release();
  await pending;
  const preferences = servers.getPreferences(FIRST);
  preferences.mode = 'replace';
  preferences.platforms!.instagram = true;
  assert.deepEqual(servers.getPreferences(FIRST), { mode: 'reply', platforms: { instagram: false } });
  assert.deepEqual(new ServerSettings(path).getPreferences(FIRST), servers.getPreferences(FIRST));
});

test('invalid persisted preference fields stop startup', () => {
  for (const record of [null, [], 1, { enabled: 1 }, { mode: 'other' }, { mode: null },
    { translateTweets: 'true' }, { platforms: [] }, { platforms: null }, { platforms: { instagram: 'false' } },
    { platforms: { unknown: false } }, { unknown: true }, { preferences: { mode: 'reply' } }]) {
    const path = file();
    writeFileSync(path, JSON.stringify({ [FIRST]: record }));
    assert.throws(() => new ServerSettings(path), /Invalid server settings/);
  }
});

test('invalid updates cannot write, change enablement, or block a later valid update', async () => {
  let writes = 0;
  const servers = new ServerSettings(file(), async () => { writes++; });
  for (const patch of [null, [], true, { enabled: true }, { mode: 'other' }, { mode: undefined },
    { translateTweets: 'true' }, { platforms: [] }, { platforms: { x: undefined } },
    { platforms: { unknown: true } }, { unknown: true }]) {
    await assert.rejects(servers.update(FIRST, patch as ServerPreferences));
  }
  await assert.rejects(servers.update('bad-id', { mode: 'reply' }));
  await assert.rejects(servers.update(111111111111111111 as unknown as string, { mode: 'reply' }));
  await assert.rejects(servers.set(FIRST, 'true' as unknown as boolean));
  assert.equal(writes, 0);
  assert.equal(servers.get(FIRST), undefined);
  await servers.update(FIRST, { mode: 'reply' });
  assert.equal(writes, 1);
});

test('a failed preference save leaves memory and disk intact and later queued writes still work', async () => {
  const path = file();
  let fail = false;
  const servers = new ServerSettings(path, async (target, content) => {
    if (fail) { fail = false; throw new Error('Disk full'); }
    await writeFile(target, content);
  });
  await servers.set(FIRST, true);
  await servers.update(FIRST, { mode: 'replace', platforms: { instagram: true } });
  const before = readFileSync(path, 'utf8');
  fail = true;
  await assert.rejects(servers.update(FIRST, { mode: 'reply', platforms: { instagram: false } }), /Disk full/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(servers.get(FIRST), true);
  assert.deepEqual(servers.getPreferences(FIRST), { mode: 'replace', platforms: { instagram: true } });
  await servers.update(FIRST, { platforms: { tiktok: false } });
  assert.deepEqual(new ServerSettings(path).getPreferences(FIRST), {
    mode: 'replace', platforms: { instagram: true, tiktok: false },
  });
});

test('setup without an option opens a private panel without changing legacy enablement', async () => {
  const path = file();
  writeFileSync(path, JSON.stringify({ [FIRST]: true, [SECOND]: false }));
  const servers = new ServerSettings(path, async () => assert.fail('Panel must not write'));
  const { command, events } = interaction(null);
  await execute(command, servers);
  assert.equal(events[0].payload.flags, MessageFlags.Ephemeral);
  assert.equal(setupView(events[1].payload).rows.length, 4);
  assert.match(setupView(events[1].payload).text, /Active in this channel/);
  assert.equal(events[1].payload.flags, MessageFlags.IsComponentsV2);
  assert.equal(events[1].payload.content, null);
  assert.deepEqual(events[1].payload.embeds, []);
  assert.equal(servers.get(FIRST), true);
  assert.equal(servers.get(SECOND), false);
  assert.deepEqual(servers.getPreferences(FIRST), {});
});

test('channel and YouTube display choices merge with legacy settings and survive restart', async () => {
  const path = file();
  writeFileSync(path, JSON.stringify({ [FIRST]: true, [SECOND]: false }));
  const servers = new ServerSettings(path);
  const channels = [SECOND];
  await Promise.all([
    servers.update(FIRST, { channelIds: channels, youtubeDisplay: 'counts' }),
    servers.update(FIRST, { mode: 'reply' }),
    servers.set(FIRST, false),
  ]);
  channels.push(FIRST);
  servers.getPreferences(FIRST).channelIds!.push(FIRST);
  const restarted = new ServerSettings(path);
  assert.equal(restarted.get(FIRST), false);
  assert.equal(restarted.get(SECOND), false);
  assert.deepEqual(restarted.getPreferences(FIRST), { channelIds: [SECOND], youtubeDisplay: 'counts', mode: 'reply' });
  await restarted.update(FIRST, { channelIds: [] });
  assert.deepEqual(new ServerSettings(path).getPreferences(FIRST).channelIds, []);
});

test('resetting channel scope preserves enablement and all other preferences within the write queue', async () => {
  const path = file();
  const servers = new ServerSettings(path);
  await servers.update(FIRST, { channelIds: [SECOND], mode: 'reply' });
  await Promise.all([servers.resetChannelScope(FIRST), servers.update(FIRST, { youtubeDisplay: 'preview' })]);
  assert.equal(servers.get(FIRST), undefined);
  assert.deepEqual(new ServerSettings(path).getPreferences(FIRST), { mode: 'reply', youtubeDisplay: 'preview' });
  await assert.rejects(servers.resetChannelScope('invalid'));
});

test('invalid channel/display fields cannot persist or mutate memory', async () => {
  const servers = new ServerSettings(file(), async () => assert.fail('Invalid write'));
  const invalid = [{ channelIds: null }, { channelIds: 'all' }, { channelIds: ['bad'] },
    { channelIds: [FIRST, FIRST] }, { channelIds: new Array(1) },
    { channelIds: Array.from({ length: 26 }, (_, index) => String(100000000000000000n + BigInt(index))) },
    { youtubeDisplay: 'all' }, { youtubeDisplay: null }, { youtubeDisplay: undefined }];
  for (const patch of invalid) await assert.rejects(servers.update(FIRST, patch as ServerPreferences));
  for (const record of invalid.filter(value => !Object.hasOwn(value, 'youtubeDisplay') || value.youtubeDisplay !== undefined)) {
    const path = file();
    writeFileSync(path, JSON.stringify({ [FIRST]: record }));
    assert.throws(() => new ServerSettings(path), /Invalid server settings/);
  }
  assert.deepEqual(servers.getPreferences(FIRST), {});
});

test('failed channel reset retains the old restriction and later queued writes work', async () => {
  const path = file();
  let fail = false;
  const servers = new ServerSettings(path, async (target, content) => {
    if (fail) { fail = false; throw new Error('Disk full'); }
    await writeFile(target, content);
  });
  await servers.update(FIRST, { channelIds: [SECOND] });
  fail = true;
  await assert.rejects(servers.resetChannelScope(FIRST), /Disk full/);
  await servers.update(FIRST, { youtubeDisplay: 'counts' });
  assert.deepEqual(new ServerSettings(path).getPreferences(FIRST), { channelIds: [SECOND], youtubeDisplay: 'counts' });
  assert.equal(servers.get(FIRST), undefined);
});
