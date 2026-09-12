import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationIntegrationType, InteractionContextType, MessageFlags, PermissionFlagsBits, PermissionsBitField, type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from '../src/config';
import { data, execute } from '../src/commands/settings';
import { execute as help } from '../src/commands/help';
import { ServerSettings } from '../src/services/ServerSettings';
import { REWRITE_PLATFORMS } from '../src/services/SocialLinkService';

const directory = mkdtempSync(join(tmpdir(), 'linky-settings-command-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const SERVER = '111111111111111111';
let nextFile = 0;
const file = () => join(directory, `${nextFile++}.json`);
const config: Config = {
  discordToken: 'test', channelIds: [], serverIds: [], rewritePlatforms: ['instagram', 'tiktok', 'x'],
  translateTweets: true, settingsPath: 'unused',
};

function interaction(options: Record<string, string | boolean> = {}, guildId: string | null = SERVER,
  permissions: bigint = PermissionFlagsBits.ManageGuild) {
  const events: { name: string; payload: any }[] = [];
  const command = {
    guildId, channelId: 'channel', memberPermissions: new PermissionsBitField(permissions),
    options: { getBoolean: (name: string) => options[name] ?? null, getString: (name: string) => options[name] ?? null },
    reply: async (payload: unknown) => { events.push({ name: 'reply', payload }); },
    deferReply: async (payload: unknown) => { events.push({ name: 'defer', payload }); },
    editReply: async (payload: unknown) => { events.push({ name: 'edit', payload }); },
  };
  return { command: command as unknown as ChatInputCommandInteraction, events };
}

test('settings is restricted to server installs and Manage Server with optional choices', () => {
  const command = data.toJSON();
  assert.deepEqual(command.contexts, [InteractionContextType.Guild]);
  assert.deepEqual(command.integration_types, [ApplicationIntegrationType.GuildInstall]);
  assert.equal(command.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
  assert.deepEqual(command.options?.map(option => option.name), ['mode', 'instagram', 'tiktok', 'x', 'youtube', 'bluesky', 'reddit', 'twitch', 'translate_tweets', 'youtube_display']);
  assert.equal(command.options?.some(option => option.required), false);
});

for (const [name, guildId, permissions] of [
  ['DM', null, PermissionFlagsBits.ManageGuild],
  ['ordinary member', SERVER, PermissionFlagsBits.SendMessages],
] as const) {
  test(`settings denies a ${name} privately without reading options or saving`, async () => {
    const servers = new ServerSettings(file(), async () => assert.fail('Unauthorized write'));
    const { command, events } = interaction({ mode: 'reply' }, guildId, permissions);
    command.options.getString = () => assert.fail('Unauthorized option access');
    await execute(command, config, servers);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'reply');
    assert.equal(events[0].payload.flags, MessageFlags.Ephemeral);
    assert.deepEqual(events[0].payload.allowedMentions, { parse: [] });
    assert.deepEqual(servers.getPreferences(SERVER), {});
  });
}

test('settings with no options displays effective defaults without writing or opting in', async () => {
  const servers = new ServerSettings(file(), async () => assert.fail('Read-only command wrote settings'));
  const { command, events } = interaction();
  await execute(command, config, servers);
  assert.equal(events[0].name, 'defer');
  assert.equal(events[0].payload.flags, MessageFlags.Ephemeral);
  assert.match(events[1].payload.content, /Current server preferences/);
  assert.match(events[1].payload.content, /Disabled in this channel/);
  assert.match(events[1].payload.content, /Mode: Replace/);
  assert.match(events[1].payload.content, /Instagram: On/);
  assert.equal(servers.get(SERVER), undefined);
  assert.deepEqual(servers.getPreferences(SERVER), {});
});

test('settings saves per-server preferences without enabling an unconfigured or disabled server', async () => {
  const path = file();
  const servers = new ServerSettings(path);
  const { command, events } = interaction({ mode: 'reply', instagram: false, translate_tweets: false }, SERVER, PermissionFlagsBits.Administrator);
  await execute(command, config, servers);
  assert.equal(servers.get(SERVER), undefined);
  assert.equal(new ServerSettings(path).get(SERVER), undefined);
  assert.deepEqual(servers.getPreferences(SERVER), { mode: 'reply', platforms: { instagram: false }, translateTweets: false });
  assert.match(events[1].payload.content, /Enablement and channel scope are unchanged/);
  assert.match(events[1].payload.content, /Mode: Reply/);
  assert.match(events[1].payload.content, /Instagram: Off/);
  await servers.set(SERVER, false);
  await execute(interaction({ tiktok: false }).command, config, servers);
  assert.equal(new ServerSettings(path).get(SERVER), false);
  assert.deepEqual(new ServerSettings(path).getPreferences(SERVER).platforms, { instagram: false, tiktok: false });
});

test('settings reports operator-disabled features as off even if the server requests them', async () => {
  const servers = new ServerSettings(file());
  const { command, events } = interaction({ x: true, tiktok: true, translate_tweets: true });
  await execute(command, { ...config, rewritePlatforms: ['instagram'], translateTweets: false }, servers);
  const content = events[1].payload.content;
  assert.match(content, /X: Off \(disabled by the bot operator\)/);
  assert.match(content, /TikTok: Off \(disabled by the bot operator\)/);
  assert.match(content, /English tweet translation: Off \(disabled by the bot operator\)/);
  assert.equal(servers.getPreferences(SERVER).platforms?.x, true);
  assert.equal(servers.get(SERVER), undefined);
});

for (const platform of REWRITE_PLATFORMS) {
  test(`settings persists the ${platform} option without changing enablement`, async () => {
    const path = file();
    const servers = new ServerSettings(path);
    await execute(interaction({ [platform]: false }).command, config, servers);
    assert.equal(new ServerSettings(path).getPreferences(SERVER).platforms?.[platform], false);
    assert.equal(new ServerSettings(path).get(SERVER), undefined);
  });
}

test('effective translation is off when X link fixing is disabled', async () => {
  const servers = new ServerSettings(file());
  const { command, events } = interaction({ x: false, translate_tweets: true });
  await execute(command, config, servers);
  assert.match(events[1].payload.content, /English tweet translation: Off \(X link fixing is disabled\)/);
  assert.equal(servers.getPreferences(SERVER).translateTweets, true);
});

test('settings preserves operator-configured channel scope without creating a server override', async () => {
  const servers = new ServerSettings(file());
  const { command, events } = interaction({ mode: 'reply' });
  await execute(command, { ...config, channelIds: ['channel'] }, servers);
  assert.equal(servers.get(SERVER), undefined);
  assert.match(events[1].payload.content, /Enabled in this channel by the bot operator/);
});

test('settings acknowledges a change only after persistence completes', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const servers = new ServerSettings(file(), async () => { await gate; });
  const { command, events } = interaction({ mode: 'reply' });
  const pending = execute(command, config, servers);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.flags, MessageFlags.Ephemeral);
  assert.deepEqual(servers.getPreferences(SERVER), {});
  release();
  await pending;
  assert.match(events[1].payload.content, /Server preferences saved/);
  assert.deepEqual(events[1].payload.allowedMentions, { parse: [] });
});

test('settings reports failed persistence and retains previous preferences', async () => {
  let fail = false;
  const servers = new ServerSettings(file(), async () => { if (fail) throw new Error('Disk full'); });
  await servers.set(SERVER, false);
  await servers.update(SERVER, { mode: 'replace' });
  fail = true;
  const { command, events } = interaction({ mode: 'reply' });
  await assert.rejects(execute(command, config, servers), /Disk full/);
  assert.equal(events[0].payload.flags, MessageFlags.Ephemeral);
  assert.match(events[1].payload.content, /previous configuration is unchanged/);
  assert.equal(servers.get(SERVER), false);
  assert.deepEqual(servers.getPreferences(SERVER), { mode: 'replace' });
});

test('help describes reply mode and effective preferences without promising a preview', async () => {
  const servers = new ServerSettings(file());
  await servers.update(SERVER, { mode: 'reply', platforms: { instagram: false }, translateTweets: false });
  await servers.set(SERVER, true);
  const { command, events } = interaction();
  await help(command, config, servers);
  const content = events[0].payload.content;
  assert.match(content, /reply.*keeping your original message/);
  assert.match(content, /Supported platforms: TikTok, X/);
  assert.match(content, /English translation is currently disabled/);
  assert.match(content, /checks for a useful preview/);
  assert.doesNotMatch(content, /working preview/);
  assert.equal(events[0].payload.flags, MessageFlags.Ephemeral);
});

for (const display of ['preview', 'counts', 'counts-and-comment']) {
  test(`settings persists YouTube ${display} without enabling the server or overriding operator availability`, async () => {
    const path = file();
    const servers = new ServerSettings(path);
    const { command, events } = interaction({ youtube_display: display });
    await execute(command, config, servers);
    assert.equal(new ServerSettings(path).getPreferences(SERVER).youtubeDisplay, display);
    assert.equal(servers.get(SERVER), undefined);
    assert.match(events[1].payload.content, /YouTube is currently off/);
    assert.match(events[1].payload.content, /YouTube: Off \(disabled by the bot operator\)/);
  });
}

test('settings reports selected channel exclusion instead of server-wide enablement', async () => {
  const servers = new ServerSettings(file());
  await servers.set(SERVER, true);
  await servers.update(SERVER, { channelIds: [] });
  const { command, events } = interaction();
  await execute(command, config, servers);
  assert.match(events[1].payload.content, /Disabled in this channel by the selected channel restriction/);
  assert.equal(servers.get(SERVER), true);
});
