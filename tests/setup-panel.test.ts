import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ChannelType, Collection, ComponentType, MessageFlags, PermissionFlagsBits, PermissionsBitField,
  type APIMessageTopLevelComponent,
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

function panelView(panel: { components: readonly { toJSON(): APIMessageTopLevelComponent }[] }) {
  const components = panel.components.map(component => component.toJSON());
  assert.equal(components.length, 1, 'one container holds the setup panel');
  const container = components[0];
  assert(container.type === ComponentType.Container);
  assert(container.components.every(component => component.type === ComponentType.TextDisplay ||
    component.type === ComponentType.ActionRow || component.type === ComponentType.Separator));
  return { container,
    text: container.components.filter(component => component.type === ComponentType.TextDisplay).map(component => component.content).join('\n'),
    rows: container.components.filter(component => component.type === ComponentType.ActionRow),
  };
}

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
  const { rows, text } = panelView(panel);
  assert.equal(rows.length, 4);
  assert.match(text, /Active in this channel/);
  assert.match(text, /Access is limited to the bot’s configured channels/);
  assert.match(text, /Selections save automatically\. They never enable the server\./);
  assert.deepEqual(panel.allowedMentions, { parse: [] });
  assert.equal(servers.get(SERVER), undefined);
  assert.deepEqual(servers.getPreferences(SERVER), {});
});

test('V2 migration explicitly clears legacy content and embeds while preserving setup controls', () => {
  const panel = buildSetupPanel({ guildId: SERVER, channelId: CHANNEL }, config, new ServerSettings(file()));
  assert.equal(panel.content, null);
  assert.deepEqual(panel.embeds, []);
  assert.equal(panel.flags, MessageFlags.IsComponentsV2);
  const { rows, container, text } = panelView(panel);
  assert.equal(rows.length, 4);
  const controls = rows.flatMap(row => row.components);
  assert.deepEqual(controls.map(control => 'custom_id' in control ? control.custom_id : '').sort(), Object.values(SETUP_ACTIONS).sort());
  assert.deepEqual(rows.map(row => row.components.length), [1, 1, 1, 3]);
  assert(1 + container.components.length + controls.length <= 40, 'nested controls remain within the V2 component limit');
  assert(text.length <= 4000);
  for (const control of controls) {
    assert('custom_id' in control && control.custom_id.length > 0 && control.custom_id.length <= 100);
    if (control.type === ComponentType.Button) assert('label' in control && control.label && control.label.length <= 80);
    if (control.type === ComponentType.StringSelect) assert(control.options.length <= 25);
  }
  const mode = controls.find(control => 'custom_id' in control && control.custom_id === SETUP_ACTIONS.mode);
  assert(mode?.type === ComponentType.StringSelect);
  assert.deepEqual(mode.options.map(option => [option.value, option.default]), [['replace', true], ['reply', false]]);
});

test('panel status distinguishes current-channel activity from enablement and exclusions', async () => {
  const cases = [
    { name: 'enabled', enabled: true, channels: undefined, channelId: CHANNEL, operator: false, expected: 'Active in this channel' },
    { name: 'disabled', enabled: false, channels: undefined, channelId: CHANNEL, operator: true, expected: 'Server disabled' },
    { name: 'excluded', enabled: true, channels: [] as string[], channelId: CHANNEL, operator: true, expected: 'Not active in this channel' },
    { name: 'operator', enabled: undefined, channels: undefined, channelId: CHANNEL, operator: true, expected: 'Active in this channel' },
    { name: 'inactive', enabled: undefined, channels: undefined, channelId: '333333333333333333', operator: true, expected: 'Not enabled in this channel' },
  ];
  for (const entry of cases) {
    const servers = new ServerSettings(file());
    if (entry.enabled !== undefined) await servers.set(SERVER, entry.enabled);
    if (entry.channels !== undefined) await servers.update(SERVER, { channelIds: entry.channels });
    const panel = buildSetupPanel({ guildId: SERVER, channelId: entry.channelId },
      { ...config, channelIds: entry.operator ? [CHANNEL] : [] }, servers);
    const view = panelView(panel);
    assert(view.text.split('\n').includes(`**${entry.expected}**`), entry.name);
    const buttons = view.rows[3].components;
    assert.equal(buttons.find(button => 'custom_id' in button && button.custom_id === SETUP_ACTIONS.enable)?.disabled, entry.enabled === true);
    assert.equal(buttons.find(button => 'custom_id' in button && button.custom_id === SETUP_ACTIONS.disable)?.disabled, entry.enabled === false);
    assert.equal(servers.get(SERVER), entry.enabled, `${entry.name}: rendering cannot change enablement`);
  }
});

test('channel menu retains all 25 saved selections and scope controls stay within Discord limits', async () => {
  const channels = Array.from({ length: 25 }, (_, index) => String(222222222222222222n + BigInt(index)));
  const servers = new ServerSettings(file());
  await servers.update(SERVER, { channelIds: channels });
  const { rows, text } = panelView(buildSetupPanel({ guildId: SERVER, channelId: CHANNEL }, config, servers));
  const menu = rows[2].components[0];
  assert(menu.type === ComponentType.ChannelSelect);
  assert.equal(menu.min_values, 0); assert.equal(menu.max_values, 25);
  assert.deepEqual(menu.default_values?.map(value => value.id), channels);
  assert(menu.placeholder && menu.placeholder.length <= 150);
  assert(text.length <= 4000);
  assert.equal(servers.get(SERVER), undefined);
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
  const view = panelView(platform.events[1].payload);
  assert.match(view.text, /Active in this channel/);
  const platforms = view.rows[1].components[0];
  assert(platforms.type === ComponentType.StringSelect);
  assert.deepEqual(platforms.options.filter(option => option.default).map(option => option.value), ['instagram']);
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
  const enable = component(SETUP_ACTIONS.enable);
  await handleSetupComponent(enable.interaction, config, servers);
  assert.equal(new ServerSettings(path).get(SERVER), true);
  assert.match(panelView(enable.events[1].payload).text, /Server enabled\. Channel selection kept\./);
  const disable = component(SETUP_ACTIONS.disable);
  await handleSetupComponent(disable.interaction, config, servers);
  assert.equal(new ServerSettings(path).get(SERVER), false);
  assert.match(panelView(disable.events[1].payload).text, /Server disabled\. Your choices are saved\./);
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
  assert.match(panelView(f.events[1].payload).text, /Saved\./);
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
  assert.match(panelView(f.events[1].payload).text, /previous configuration is unchanged/);
  assert.match(panelView(f.events[1].payload).text, /Server disabled/);
  assert.equal(new ServerSettings(path).get(SERVER), false);
  await handleSetupComponent(component(SETUP_ACTIONS.mode, ['reply']).interaction, config, servers);
  assert.equal(new ServerSettings(path).getPreferences(SERVER).mode, 'reply');
});
