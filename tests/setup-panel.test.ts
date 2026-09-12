import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ChannelType, Collection, MessageFlags, PermissionFlagsBits, PermissionsBitField,
  type ButtonInteraction, type ChannelSelectMenuInteraction, type StringSelectMenuInteraction } from 'discord.js';
import type { Config } from '../src/config';
import { ServerSettings } from '../src/services/ServerSettings';
import { buildSetupPanel, handleSetupComponent, isSetupComponent, SETUP_ACTIONS } from '../src/commands/setupPanel';

const directory = mkdtempSync(join(tmpdir(), 'linky-setup-panel-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const SERVER = '111111111111111111', CHANNEL = '222222222222222222';
let nextFile = 0;
const file = () => join(directory, `${nextFile++}.json`);
const config: Config = { discordToken: '', channelIds: [CHANNEL], serverIds: [], rewritePlatforms: ['instagram', 'x'],
  translateTweets: true, settingsPath: '' };

function component(customId: string, values: string[] = [], permission = PermissionFlagsBits.ManageGuild) {
  const events: { name: string; payload?: any }[] = [];
  const menu = customId === SETUP_ACTIONS.mode || customId === SETUP_ACTIONS.platforms;
  const channels = customId === SETUP_ACTIONS.channels;
  const input = {
    customId, values, guildId: SERVER as string | null, channelId: CHANNEL,
    memberPermissions: new PermissionsBitField(permission),
    channels: new Collection(values.map(id => [id, { id, type: ChannelType.GuildText, guildId: SERVER }])),
    isButton: () => !menu && !channels, isStringSelectMenu: () => menu, isChannelSelectMenu: () => channels,
    reply: async (payload: unknown) => { events.push({ name: 'reply', payload }); },
    deferUpdate: async () => { events.push({ name: 'defer' }); },
    editReply: async (payload: unknown) => { events.push({ name: 'edit', payload }); },
  };
  return { input, events, interaction: input as unknown as ButtonInteraction | ChannelSelectMenuInteraction | StringSelectMenuInteraction };
}

test('private panel renders mode, effective platforms, channel selection and explicit enable controls without writes', () => {
  const servers = new ServerSettings(file(), async () => assert.fail('Panel wrote settings'));
  const panel = buildSetupPanel({ guildId: SERVER, channelId: CHANNEL }, config, servers);
  const rows = panel.components.map(row => row.toJSON());
  assert.equal(rows.length, 4);
  assert.match(panel.content, /Enabled in this channel by the bot operator/);
  assert.match(panel.content, /without enabling Linky/);
  assert.match(panel.content, /accessible threads/);
  assert.deepEqual(panel.allowedMentions, { parse: [] });
  assert.equal(servers.get(SERVER), undefined);
  assert.deepEqual(servers.getPreferences(SERVER), {});
});

for (const action of Object.values(SETUP_ACTIONS)) {
  test(`${action} checks current Manage Server permission before handling a component`, async () => {
    const servers = new ServerSettings(file(), async () => assert.fail('Unauthorized write'));
    const f = component(action, [], PermissionFlagsBits.SendMessages);
    await handleSetupComponent(f.interaction, config, servers);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(f.events[0].payload.content, /Manage Server/);
    assert.equal(servers.get(SERVER), undefined);
  });
}

test('setup components reject DMs and ignore unrelated controls', async () => {
  const servers = new ServerSettings(file(), async () => assert.fail('Unexpected write'));
  const f = component(SETUP_ACTIONS.enable);
  f.input.guildId = null;
  await handleSetupComponent(f.interaction, config, servers);
  assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
  const other = component('other:enable');
  assert.equal(isSetupComponent(other.interaction), false);
  assert.equal(await handleSetupComponent(other.interaction, config, servers), false);
  assert.equal(other.events.length, 0);
});

test('mode and platform menus preserve operator enablement and capabilities', async () => {
  const path = file();
  const servers = new ServerSettings(path);
  const mode = component(SETUP_ACTIONS.mode, ['reply']);
  await handleSetupComponent(mode.interaction, config, servers);
  const platform = component(SETUP_ACTIONS.platforms, ['instagram', 'youtube']);
  await handleSetupComponent(platform.interaction, config, servers);
  assert.equal(servers.get(SERVER), undefined);
  assert.equal(new ServerSettings(path).getPreferences(SERVER).mode, 'reply');
  assert.deepEqual(servers.getPreferences(SERVER).platforms, { x: false, instagram: true, tiktok: false, youtube: true,
    bluesky: false, reddit: false, twitch: false });
  assert.match(platform.events[1].payload.content, /Platforms: Instagram\./);
  assert.match(platform.events[1].payload.content, /Enabled in this channel by the bot operator/);
});

test('channel selection, clearing and all-channels keep enablement unchanged', async () => {
  const path = file();
  const servers = new ServerSettings(path);
  await servers.set(SERVER, false);
  await servers.update(SERVER, { mode: 'reply', youtubeDisplay: 'counts' });
  await handleSetupComponent(component(SETUP_ACTIONS.channels, [CHANNEL]).interaction, config, servers);
  assert.deepEqual(servers.getPreferences(SERVER).channelIds, [CHANNEL]);
  await handleSetupComponent(component(SETUP_ACTIONS.channels, []).interaction, config, servers);
  assert.deepEqual(servers.getPreferences(SERVER).channelIds, []);
  await handleSetupComponent(component(SETUP_ACTIONS.allChannels).interaction, config, servers);
  assert.deepEqual(new ServerSettings(path).getPreferences(SERVER), { mode: 'reply', youtubeDisplay: 'counts' });
  assert.equal(new ServerSettings(path).get(SERVER), false);
});

test('enable and disable buttons retain a selected channel restriction', async () => {
  const path = file();
  const servers = new ServerSettings(path);
  await servers.update(SERVER, { channelIds: [CHANNEL] });
  await handleSetupComponent(component(SETUP_ACTIONS.enable).interaction, config, servers);
  assert.equal(new ServerSettings(path).get(SERVER), true);
  await handleSetupComponent(component(SETUP_ACTIONS.disable).interaction, config, servers);
  assert.equal(new ServerSettings(path).get(SERVER), false);
  assert.deepEqual(servers.getPreferences(SERVER).channelIds, [CHANNEL]);
});

test('invalid values and cross-server channels cannot change settings', async () => {
  const servers = new ServerSettings(file(), async () => assert.fail('Invalid selection wrote'));
  for (const f of [component(SETUP_ACTIONS.mode, ['other']), component(SETUP_ACTIONS.mode, ['replace', 'reply']),
    component(SETUP_ACTIONS.platforms, ['unknown']), component(SETUP_ACTIONS.platforms, ['x', 'x'])]) {
    await handleSetupComponent(f.interaction, config, servers);
    assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
  }
  const channel = component(SETUP_ACTIONS.channels, [CHANNEL]);
  channel.input.channels.get(CHANNEL)!.guildId = '333333333333333333';
  await handleSetupComponent(channel.interaction, config, servers);
  assert.match(channel.events[0].payload.content, /invalid/);
  assert.deepEqual(servers.getPreferences(SERVER), {});
});

test('panel acknowledges a successful update only after persistence', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const servers = new ServerSettings(file(), async () => { await gate; });
  const f = component(SETUP_ACTIONS.mode, ['reply']);
  const pending = handleSetupComponent(f.interaction, config, servers);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.events, [{ name: 'defer' }]);
  assert.deepEqual(servers.getPreferences(SERVER), {});
  release(); await pending;
  assert.match(f.events[1].payload.content, /Preferences saved/);
  assert.equal(servers.getPreferences(SERVER).mode, 'reply');
});

test('failed panel save shows the unchanged state and later writes remain usable', async () => {
  const path = file();
  let fail = false;
  const servers = new ServerSettings(path, async (target, content) => {
    if (fail) { fail = false; throw new Error('Disk full'); }
    await writeFile(target, content);
  });
  await servers.set(SERVER, false);
  fail = true;
  const f = component(SETUP_ACTIONS.enable);
  await assert.rejects(handleSetupComponent(f.interaction, config, servers), /Disk full/);
  assert.match(f.events[1].payload.content, /previous configuration is unchanged/);
  assert.match(f.events[1].payload.content, /Server disabled/);
  assert.equal(new ServerSettings(path).get(SERVER), false);
  await handleSetupComponent(component(SETUP_ACTIONS.mode, ['reply']).interaction, config, servers);
  assert.equal(new ServerSettings(path).getPreferences(SERVER).mode, 'reply');
});
