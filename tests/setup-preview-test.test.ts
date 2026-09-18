import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection, ComponentType, MessageFlags, PermissionFlagsBits, PermissionsBitField,
  type ButtonInteraction } from 'discord.js';
import type { Config } from '../src/config';
import { createSetupPreviewTest } from '../src/services/SetupPreviewTest';
import { ServerSettings } from '../src/services/ServerSettings';
import { removeManual } from '../src/commands/fix';
import type { PreviewWatcher } from '../src/services/PreviewWatcher';

const directory = mkdtempSync(join(tmpdir(), 'linky-setup-preview-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const GUILD = '111111111111111111', CHANNEL = '222222222222222222';
const USER = '333333333333333333', BOT = '444444444444444444';
let next = 0;
const configuration: Config = { discordToken: '', channelIds: [CHANNEL], serverIds: [],
  rewritePlatforms: ['x', 'youtube'], translateTweets: false, settingsPath: '' };

function fixture(config: Config = configuration) {
  const servers = new ServerSettings(join(directory, `${next++}.json`));
  const calls: string[] = [], sends: any[] = [];
  const actor = { id: USER, permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild), communicationDisabledUntilTimestamp: 0 };
  const bot = { id: BOT };
  const actorPermissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
  const botPermissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages]);
  const channel = { id: CHANNEL, guildId: GUILD, parentId: null as string | null,
    isThread: () => false, isSendable: () => true,
    permissionsFor: (member: { id: string }) => member === actor ? actorPermissions : botPermissions,
  };
  const guild = { id: GUILD,
    members: { fetch: async ({ user, force }: { user: string; force: boolean }) => {
      assert.equal(force, true); calls.push(user === USER ? 'actor' : 'bot'); return user === USER ? actor : bot;
    } },
    channels: { fetch: async (id: string, { force }: { force: boolean }) => {
      assert.equal(id, CHANNEL); assert.equal(force, true); calls.push('channel'); return channel;
    } },
  };
  const message = { id: '555555555555555555', channelId: CHANNEL, author: { id: BOT },
    webhookId: BOT, interactionMetadata: { user: { id: USER } } };
  const input = { guildId: GUILD, channelId: CHANNEL, user: { id: USER }, customId: 'linky:setup:test',
    client: { user: { id: BOT }, guilds: { fetch: async (id: string) => { assert.equal(id, GUILD); calls.push('guild'); return guild; } } },
    followUp: async (payload: unknown) => { calls.push('send'); sends.push(payload); return message; },
  };
  let ok = true, clock = 0;
  const armPreview: PreviewWatcher['arm'] = (channelId, expected) => {
    assert.equal(channelId, CHANNEL); assert.equal(expected.length, 1); calls.push('arm');
    return { close: () => { calls.push('close'); }, verify: async observed => {
      assert.equal(observed, message); calls.push('verify');
      return { ok, missing: ok ? [] : [...expected], videoMetadata: expected[0].platform === 'youtube' };
    } };
  };
  const run = createSetupPreviewTest(config, servers, { armPreview, now: () => clock });
  return { servers, calls, sends, actor, bot, actorPermissions, botPermissions, channel, guild, input, message, armPreview, run,
    interaction: input as unknown as ButtonInteraction, setOk: (value: boolean) => { ok = value; }, tick: (ms: number) => { clock += ms; } };
}

test('explicit setup test fetches current access, arms before sending and keeps a quiet attributed sample', async () => {
  const f = fixture();
  const result = await f.run(f.interaction);
  assert.match(result, /Discord supplied a matching preview/);
  assert.match(result, /does not test Replace removal or confirm playback/);
  assert.deepEqual(f.calls, ['guild', 'actor', 'bot', 'channel', 'arm', 'send', 'verify', 'close']);
  assert.equal(f.sends.length, 1);
  const payload = f.sends[0];
  assert.match(payload.content, /Linky setup test/);
  assert.match(payload.content, new RegExp(`requested by <@${USER}>`));
  assert.match(payload.content, /https:\/\/fixupx.com\/jack\/status\/20/);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(payload.flags, MessageFlags.SuppressNotifications);
  assert.equal(Boolean(payload.flags & MessageFlags.Ephemeral), false);
  const buttons = payload.components[0].toJSON().components;
  assert.equal(buttons[0].url, 'https://x.com/jack/status/20');
  assert.equal(buttons[1].custom_id, 'linky:remove-manual');
  assert.deepEqual(f.servers.getPreferences(GUILD), {});
  assert.equal(f.servers.get(GUILD), undefined);
});

test('YouTube-only setup uses the fixed NASA native video without statistics or a provider fetch', async () => {
  const f = fixture({ ...configuration, rewritePlatforms: ['youtube'] });
  const result = await f.run(f.interaction);
  assert.match(result, /NASA\/JPL Earth Minute video/);
  assert.match(f.sends[0].content, /https:\/\/www.youtube.com\/watch\?v=ecBgUrGlKps/);
  assert.equal(f.sends.length, 1);
});

for (const denial of ['manage', 'view', 'send', 'timeout', 'bot-view', 'bot-send', 'embed', 'history', 'manage-messages', 'not-sendable'] as const) {
  test(`setup sample denies ${denial} using freshly fetched permissions`, async () => {
    const f = fixture();
    if (denial === 'manage') f.actor.permissions.remove(PermissionFlagsBits.ManageGuild);
    if (denial === 'view') f.actorPermissions.remove(PermissionFlagsBits.ViewChannel);
    if (denial === 'send') f.actorPermissions.remove(PermissionFlagsBits.SendMessages);
    if (denial === 'timeout') f.actor.communicationDisabledUntilTimestamp = Date.now() + 30_000;
    if (denial === 'bot-view') f.botPermissions.remove(PermissionFlagsBits.ViewChannel);
    if (denial === 'bot-send') f.botPermissions.remove(PermissionFlagsBits.SendMessages);
    if (denial === 'embed') f.botPermissions.remove(PermissionFlagsBits.EmbedLinks);
    if (denial === 'history') f.botPermissions.remove(PermissionFlagsBits.ReadMessageHistory);
    if (denial === 'manage-messages') f.botPermissions.remove(PermissionFlagsBits.ManageMessages);
    if (denial === 'not-sendable') f.channel.isSendable = () => false;
    assert.match(await f.run(f.interaction), /No sample was posted/);
    assert.equal(f.sends.length, 0);
    assert.equal(f.calls.includes('arm'), false);
  });
}

test('setup test denies excluded and disabled channels and platforms without changing settings', async () => {
  for (const state of ['disabled', 'excluded', 'platforms', 'unsupported'] as const) {
    const f = fixture(state === 'unsupported' ? { ...configuration, rewritePlatforms: ['instagram'] } : configuration);
    if (state === 'disabled') await f.servers.set(GUILD, false);
    if (state === 'excluded') await f.servers.update(GUILD, { channelIds: [] });
    if (state === 'platforms') await f.servers.update(GUILD, { platforms: { x: false, youtube: false } });
    assert.match(await f.run(f.interaction), state === 'unsupported' ? /No safe sample/ : /No sample was posted/);
    assert.equal(f.sends.length, 0);
  }
});

test('setup sample uses thread permissions and includes accessible selected parent scope', async () => {
  const parent = '666666666666666666';
  const f = fixture({ ...configuration, channelIds: [], serverIds: [GUILD] });
  f.channel.isThread = () => true; f.channel.parentId = parent;
  await f.servers.update(GUILD, { mode: 'reply', channelIds: [parent] });
  f.actorPermissions.remove(PermissionFlagsBits.SendMessages).add(PermissionFlagsBits.SendMessagesInThreads);
  f.botPermissions.remove([PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages]).add(PermissionFlagsBits.SendMessagesInThreads);
  assert.match(await f.run(f.interaction), /matching preview/);
  assert.equal(f.sends.length, 1);
});

test('setup sample rechecks scope and platform after fresh authorization awaits', async () => {
  for (const change of ['scope', 'platform'] as const) {
    const f = fixture();
    const fetch = f.guild.channels.fetch;
    f.guild.channels.fetch = async (...args) => {
      if (change === 'scope') await f.servers.set(GUILD, false);
      else await f.servers.update(GUILD, { platforms: { x: false, youtube: false } });
      return fetch(...args);
    };
    assert.match(await f.run(f.interaction), /No sample was posted/);
    assert.equal(f.sends.length, 0);
  }
});

test('per-channel inflight guard and cooldown prevent duplicate samples and expire after 30 seconds', async () => {
  const f = fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const send = f.input.followUp;
  f.input.followUp = async payload => { await gate; return send(payload); };
  const pending = f.run(f.interaction);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.match(await f.run(f.interaction), /running or just finished/);
  release(); await pending;
  assert.match(await f.run(f.interaction), /Wait 30 seconds/);
  f.tick(30_000);
  await f.run(f.interaction);
  assert.equal(f.sends.length, 2);
});

test('provider failure retains one sample and Original post without claiming success', async () => {
  const f = fixture(); f.setOk(false);
  assert.match(await f.run(f.interaction), /usable preview could not be verified/);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].components[0].toJSON().components[0].url, 'https://x.com/jack/status/20');
  assert.equal(f.calls.at(-1), 'close');
});

test('sample send failures close the watcher and retain cooldown because the send may be ambiguous', async () => {
  const f = fixture(); f.input.followUp = async () => { throw new Error('network'); };
  assert.match(await f.run(f.interaction), /send could not be confirmed/);
  assert.equal(f.calls.at(-1), 'close');
  assert.match(await f.run(f.interaction), /Wait 30 seconds/);
});

test('cancelled samples do not publish and leave no retained inflight entry', async () => {
  const f = fixture(), controller = new AbortController();
  const callback = createSetupPreviewTest(configuration, f.servers, { armPreview: (...args) => {
    controller.abort(); return f.armPreview(...args);
  }, signal: controller.signal });
  assert.match(await callback(f.interaction), /No sample was posted/);
  assert.equal(f.sends.length, 0);
  assert.equal(f.calls.at(-1), 'close');
});

test('sample Remove relies on Discord requester metadata and cannot be used by another member', async () => {
  const f = fixture(); await f.run(f.interaction);
  let deleted = 0; const replies: any[] = [];
  const removal = { customId: 'linky:remove-manual', message: f.message, applicationId: BOT, client: f.input.client,
    user: { id: '777777777777777777' }, reply: async (payload: unknown) => { replies.push(payload); },
    deferUpdate: async () => {}, deleteReply: async () => { deleted++; } };
  await removeManual(removal as unknown as ButtonInteraction);
  assert.equal(deleted, 0); assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  removal.user.id = USER;
  await removeManual(removal as unknown as ButtonInteraction);
  assert.equal(deleted, 1);
  const rows = f.sends[0].components.map((row: { toJSON(): unknown }) => row.toJSON());
  assert.equal(rows[0].type, ComponentType.ActionRow);
});

test('test state is bounded across distinct channels without evicting active cooldowns', async () => {
  const f = fixture();
  const channels = new Collection<string, typeof f.channel>();
  f.guild.channels.fetch = async id => channels.get(id)!;
  const callback = createSetupPreviewTest({ ...configuration, channelIds: [], serverIds: [GUILD] }, f.servers,
    { armPreview: () => ({ close: () => {}, verify: async () => ({ ok: true, missing: [], videoMetadata: false }) }), now: () => 0 });
  for (let index = 0; index < 64; index++) {
    const id = String(200000000000000000n + BigInt(index));
    channels.set(id, { ...f.channel, id }); f.input.channelId = id;
    assert.match(await callback(f.interaction), /matching preview/);
  }
  f.input.channelId = '299999999999999999';
  assert.match(await callback(f.interaction), /busy/);
  assert.equal(f.sends.length, 64);
});
