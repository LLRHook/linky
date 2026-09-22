import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationCommandType, ApplicationIntegrationType, InteractionContextType, MessageFlags,
  PermissionFlagsBits, PermissionsBitField, type ButtonInteraction, type ChatInputCommandInteraction,
  type APIEmbed, type Message, type MessageContextMenuCommandInteraction } from 'discord.js';
import type { Config } from '../src/config';
import { data, contextData, execute, manualLinks, removeManual } from '../src/commands/fix';
import { inspectPreviews, type ExpectedPreview, type PreviewResult } from '../src/services/PreviewRecovery';
import type { DeliveryDiagnostics } from '../src/services/DeliveryDiagnostics';
import type { DeliveryOutcome } from '../src/services/DeliveryContext';
import { createMobileShareLinkNormalizer } from '../src/services/MobileShareLinks';
import type { ServerPreferences } from '../src/services/ServerSettings';
import type { InstagramTranslation } from '../src/services/InstagramTranslation';
import { parseYouTubeCommunityUrl, type YouTubeCommunityPost } from '../src/services/YouTubeCommunity';
import type { ArticlePreview } from '../src/services/ArticlePreview';

const BOT = '1491240385031311470', REQUESTER = '111111111111111111', OTHER = '222222222222222222';
const config: Config = { discordToken: '', channelIds: [], serverIds: [], rewritePlatforms: ['instagram', 'tiktok', 'x'],
  translateTweets: false, settingsPath: 'unused' };

function command(content = 'https://twitter.com/jack/status/20?s=46', context = false) {
  const events: { name: string; payload: any }[] = [];
  const state = {
    render: (body: string, _edit: number): APIEmbed[] => (body.match(/https:\/\/\S+/g) ?? []).map(url => ({
      url, title: 'A public post', description: 'The requested post.', video: { url: 'https://media.example/video.mp4' },
    })),
  };
  let edits = 0;
  const response = {
    id: '333333333333333333', content: '', components: [] as any[], embeds: [] as { toJSON(): APIEmbed }[],
    fetch: async () => response,
  };
  const input = {
    isChatInputCommand: () => !context, inGuild: () => true,
    guildId: 'guild', channelId: 'channel', user: { id: REQUESTER },
    channel: { isThread: () => false, messages: { fetch: () => assert.fail('Explicit fixing must not fetch chat history') } },
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.SendMessages),
    options: { getString: (name: string, required: boolean) => { assert.equal(name, 'link'); assert.equal(required, true); return content; } },
    targetMessage: { content, author: { id: OTHER }, delete: () => assert.fail('Manual fixing must preserve its source'),
      edit: () => assert.fail('Manual fixing must not edit its source') },
    reply: async (payload: unknown) => { events.push({ name: 'reply', payload }); },
    deferReply: async (payload: unknown) => { events.push({ name: 'defer', payload }); },
    editReply: async (payload: any) => {
      events.push({ name: 'edit', payload });
      if (typeof payload.content === 'string') response.content = payload.content;
      if (payload.components) response.components = payload.components;
      response.embeds = state.render(response.content, ++edits).map(embed => ({ toJSON: () => embed }));
      return response as unknown as Message;
    },
  };
  return { input, events, state, response, interaction: input as unknown as ChatInputCommandInteraction | MessageContextMenuCommandInteraction };
}

function previewChecks(fixture: ReturnType<typeof command>) {
  const checks: ExpectedPreview[][] = [], observations: { expected: ExpectedPreview[]; result: PreviewResult }[] = [];
  const dependencies: NonNullable<Parameters<typeof execute>[2]> = {
    verifyPreview: async (message, expected) => {
      assert.equal(message, fixture.response, 'each check inspects the same interaction response');
      checks.push(expected.map(item => ({ ...item })));
      return inspectPreviews(message.embeds.map(embed => embed.toJSON()), expected);
    },
    observePreview: (expected, result) => observations.push({ expected: [...expected], result }),
  };
  return { checks, observations, dependencies };
}

test('manual preview expiration stops provider retries and cannot record a late confirmation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const observed of [false, true]) {
    const f = command(), outcomes: DeliveryOutcome[] = [];
    const diagnostics = { begin: () => ({ id: 'attempt', setPath() {}, startStage: () => ({ finish() {} }),
      finish: (outcome: DeliveryOutcome) => outcomes.push(outcome) }), bind: async () => false } as unknown as DeliveryDiagnostics;
    let checks = 0;
    await execute(f.interaction, config, { diagnostics, verifyPreview: async (_message, expected) => {
      checks++;
      t.mock.timers.tick(120_000);
      return { ok: observed, missing: observed ? [] : [...expected], videoMetadata: observed };
    } });
    assert.equal(checks, 1);
    assert.ok(f.events.every(event => !String(event.payload?.content).includes('vxtwitter.com')));
    assert.match(f.response.content, /time limit/);
    assert.deepEqual(outcomes, ['timeout']);
  }
});

test('manual expiration during Details binding or final controls is recorded without deleting the preview', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const phase of ['binding', 'controls']) {
    const f = command(), outcomes: DeliveryOutcome[] = [];
    const expire = () => t.mock.timers.tick(120_000);
    const diagnostics = { begin: () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', setPath() {}, startStage: () => ({ finish() {} }),
      finish: (outcome: DeliveryOutcome) => outcomes.push(outcome) }),
    bind: async () => { if (phase === 'binding') expire(); return true; } } as unknown as DeliveryDiagnostics;
    const editReply = f.input.editReply;
    f.input.editReply = async payload => {
      const result = await editReply(payload);
      if (phase === 'controls' && payload.components && payload.content === undefined) expire();
      return result;
    };
    await execute(f.interaction, config, { diagnostics, ...previewChecks(f).dependencies });
    assert.deepEqual(outcomes, ['timeout'], phase);
    assert.ok(f.response.content.includes('https://fixupx.com/jack/status/20'));
    assert.ok(f.response.components.length);
  }
});

function originalControls(fixture: ReturnType<typeof command>) {
  const controls = fixture.response.components.flatMap(row => row.toJSON().components);
  assert.equal(controls.at(-1).custom_id, 'linky:remove-manual');
  return controls.filter(control => control.url).map(control => control.url);
}

test('manual preference changes during preview verification clear the stale preview before recovery', async () => {
  const f = command('https://instagram.com/reel/ABC/');
  let preferences: ServerPreferences = {};
  await execute(f.interaction, config, { serverPreferences: () => preferences, verifyPreview: async (_message, expected) => {
    preferences = { platforms: { instagram: false } };
    return { ok: false, missing: [...expected], videoMetadata: false };
  } });
  assert(!f.events.some(event => String(event.payload?.content).includes('oginstagram.com')));
  assert.match(f.response.content, /settings changed/i);
  const cleared = f.events.at(-1)!.payload;
  assert.deepEqual(cleared.embeds, []);
  assert.equal(cleared.flags, MessageFlags.SuppressEmbeds);
  assert.deepEqual(originalControls(f), ['https://www.instagram.com/reel/ABC/']);
});

function button() {
  const events: { name: string; payload?: any }[] = [];
  const input = {
    customId: 'linky:remove-manual', inGuild: () => true,
    user: { id: REQUESTER }, client: { user: { id: BOT } }, applicationId: BOT,
    memberPermissions: new PermissionsBitField(0n),
    message: { id: '333333333333333333', author: { id: BOT }, webhookId: BOT as string | null,
      interactionMetadata: { user: { id: REQUESTER } } as { user: { id: string } } | null },
    reply: async (payload: unknown) => { events.push({ name: 'reply', payload }); },
    deferUpdate: async () => { events.push({ name: 'defer' }); },
    deleteReply: async () => { events.push({ name: 'delete' }); },
  };
  return { input, events, interaction: input as unknown as ButtonInteraction };
}

test('manual commands support guild and user installs with explicit guild, bot-DM and private-channel contexts', () => {
  for (const definition of [data.toJSON(), contextData.toJSON()]) {
    assert.deepEqual(definition.integration_types, [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall]);
    assert.deepEqual(definition.contexts, [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel]);
    assert.equal(definition.default_member_permissions, undefined);
  }
  assert.equal(contextData.toJSON().type, ApplicationCommandType.Message);
  assert.equal(contextData.toJSON().name, 'Fix with Linky');
  assert.equal(data.toJSON().options?.[0].required, true);
});

test('manual parser uses supported explicit URLs, canonicalizes Twitter and deduplicates repeated shares', () => {
  assert.deepEqual(manualLinks('https://twitter.com/jack/status/20?s=46 https://x.com/jack/status/20?other=1', config),
    [{ source: 'https://x.com/jack/status/20', fixed: 'https://fixupx.com/jack/status/20' }]);
  assert.deepEqual(manualLinks('https://www.instagram.com/reel/ABC/?igsh=share', config),
    [{ source: 'https://www.instagram.com/reel/ABC/', fixed: 'https://www.instagram7.com/reel/ABC/' }]);
  assert.deepEqual(manualLinks('https://vm.tiktok.com/ABC/', config),
    [{ source: 'https://vm.tiktok.com/ABC/', fixed: 'https://tnktok.com/ABC/' }]);
});

test('manual parser skips hidden links, unsupported authorities and URLs nested inside other URLs', () => {
  const url = 'https://x.com/jack/status/20';
  for (const content of [`<${url}>`, `\`${url}\``, `\`\`\`\n${url}\n\`\`\``, `||${url}||`,
    `https://example.test/?next=${url}`, 'https://x.com.evil.test/jack/status/20',
    'https://attacker@x.com/jack/status/20', 'https://x.com:443/jack/status/20', 'http://x.com/jack/status/20']) {
    assert.deepEqual(manualLinks(content, config), [], content);
  }
  assert.equal(manualLinks(`||${url}|| https://x.com/jack/status/21`, config)[0]?.source, 'https://x.com/jack/status/21');
});

test('manual parser caps unique posts and respects disabled social providers while native YouTube needs no key', () => {
  assert.equal(manualLinks([20, 21, 22, 23].map(id => `https://x.com/jack/status/${id}`).join(' '), config).length, 3);
  assert.deepEqual(manualLinks('https://x.com/jack/status/20', { rewritePlatforms: [] }), []);
  assert.deepEqual(manualLinks('https://youtu.be/dQw4w9WgXcQ?t=1m20s', { rewritePlatforms: [] }),
    [{ source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=80', fixed: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=80' }]);
});

for (const context of [false, true]) {
  test(`${context ? 'message menu' : 'slash fix'} sends explicit links with original-post buttons and no mentions or source deletion`, async () => {
    const f = command(undefined, context);
    await execute(f.interaction, config);
    assert.deepEqual(f.events.map(event => event.name), ['defer', 'edit']);
    assert.deepEqual(f.events[0].payload, {});
    assert.equal(f.events[1].payload.content, 'https://fixupx.com/jack/status/20');
    assert.deepEqual(f.events[1].payload.allowedMentions, { parse: [] });
    const row = f.events[1].payload.components[0].toJSON();
    assert.equal(row.components[0].url, 'https://x.com/jack/status/20');
    assert.equal(row.components.at(-1).custom_id, 'linky:remove-manual');
  });
}

test('unsupported explicit requests fail privately without deferring a public response', async () => {
  const f = command('||https://x.com/jack/status/20||');
  await execute(f.interaction, config);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].name, 'reply');
  assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
  assert.deepEqual(f.events[0].payload.allowedMentions, { parse: [] });
});

test('manual fixing falls back to a private guild reply when the requester cannot send messages', async () => {
  const f = command();
  f.input.memberPermissions = new PermissionsBitField(0n);
  await execute(f.interaction, config);
  assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
});

test('manual fixing uses thread-send permission in threads', async () => {
  const denied = command();
  denied.input.channel.isThread = () => true;
  await execute(denied.interaction, config);
  assert.equal(denied.events[0].payload.flags, MessageFlags.Ephemeral);
  const permitted = command();
  permitted.input.channel.isThread = () => true;
  permitted.input.memberPermissions = new PermissionsBitField(PermissionFlagsBits.SendMessagesInThreads);
  await execute(permitted.interaction, config);
  assert.deepEqual(permitted.events[0].payload, {});
});

test('explicit personal-install fixing works outside a guild without depending on guild permission bits', async () => {
  const f = command();
  f.input.inGuild = () => false;
  f.input.memberPermissions = new PermissionsBitField(0n);
  await execute(f.interaction, config);
  assert.deepEqual(f.events[0].payload, {});
  assert.match(f.events[1].payload.content, /fixupx/);
});

test('manual response content and original-post buttons stay within Discord payload limits', async () => {
  const long = [20, 21, 22].map(id => `https://x.com/jack/status/${id}#${'a'.repeat(800)}`).join(' ');
  const f = command(long, true);
  await execute(f.interaction, config);
  const response = f.events.at(-1)!.payload;
  assert.ok(response.content.length <= 2000);
  for (const row of response.components ?? []) {
    for (const control of row.toJSON().components) if (control.url) assert.ok(control.url.length <= 512);
  }
});

test('manual X fallback verifies the alternate on the same response and preserves source and controls', async () => {
  const f = command(undefined, true);
  const original = f.input.targetMessage.content;
  const primary = 'https://fixupx.com/jack/status/20', alternate = 'https://vxtwitter.com/jack/status/20';
  f.state.render = (content, edit) => edit === 1 ? [] : [{ url: content, title: 'Jack', description: 'The requested post.' }];
  const preview = previewChecks(f);
  await execute(f.interaction, config, preview.dependencies);
  assert.deepEqual(f.events.map(event => event.name), ['defer', 'edit', 'edit']);
  assert.deepEqual(f.events.filter(event => event.name === 'edit').map(event => event.payload.content), [primary, alternate]);
  assert.deepEqual(preview.checks.map(items => items.map(item => item.providerId)), [['fixupx'], ['fixvx']]);
  assert.deepEqual(preview.observations.map(item => item.result.ok), [false, true]);
  assert.equal(f.response.content, alternate);
  assert.deepEqual(originalControls(f), ['https://x.com/jack/status/20']);
  assert.equal(f.input.targetMessage.content, original);
  for (const event of f.events.filter(event => event.name === 'edit')) assert.deepEqual(event.payload.allowedMentions, { parse: [] });
});

test('manual Instagram fallback recovers slash and context actions on the same response', async () => {
  const original = 'https://www.instagram.com/p/DdKVPMEhTXe/?igsh=tracking';
  const primary = 'https://www.instagram7.com/p/DdKVPMEhTXe/', alternate = 'https://oginstagram.com/p/DdKVPMEhTXe/';
  for (const context of [false, true]) {
    const f = command(original, context), preview = previewChecks(f);
    f.state.render = content => content === alternate
      ? [{ url: alternate, image: { url: 'https://media.example/requested-photo.jpg' } }] : [];
    await execute(f.interaction, config, preview.dependencies);
    assert.deepEqual(f.events.map(event => event.name), ['defer', 'edit', 'edit']);
    assert.deepEqual(f.events.filter(event => event.name === 'edit').map(event => event.payload.content), [primary, alternate]);
    assert.deepEqual(preview.observations.map(item => item.result.ok), [false, true]);
    assert.equal(f.response.content, alternate);
    assert.deepEqual(originalControls(f), ['https://www.instagram.com/p/DdKVPMEhTXe/']);
    assert.equal(f.input.targetMessage.content, original);
    for (const event of f.events.filter(event => event.name === 'edit')) assert.deepEqual(event.payload.allowedMentions, { parse: [] });
  }
});

test('manual Instagram recovery reports failure when both providers return a matching error card', async () => {
  const original = 'https://www.instagram.com/p/DdKVPMEhTXe/';
  const f = command(original, true), preview = previewChecks(f);
  f.state.render = content => [{ url: content.split('\n')[0], title: 'Error', description: 'Could not retrieve this post.' }];
  await execute(f.interaction, config, preview.dependencies);
  assert.deepEqual(preview.checks.map(items => items.map(item => item.providerId)), [['instagram7'], ['oginstagram']]);
  assert(preview.observations.every(item => !item.result.ok));
  assert.equal(f.events.filter(event => event.name === 'edit').length, 3);
  assert.match(f.response.content, /preview could not be confirmed/i);
  assert.deepEqual(originalControls(f), [original]);
  assert.equal(f.input.targetMessage.content, original);
});

test('missing, unrelated and matching error previews exhaust manual X recovery with an honest failure note', async () => {
  const badPreviews: APIEmbed[][] = [[],
    [{ url: 'https://fixupx.com/jack/status/999', title: 'Other post', description: 'Not the requested post.' }],
    [{ url: 'https://evil.test/jack/status/20', video: { url: 'https://media.example/video.mp4' } }],
    [{ url: 'https://x.com/jack/status/20', title: 'Error', description: 'Could not load the post.' }],
  ];
  for (const embeds of badPreviews) {
    const f = command(undefined, true), preview = previewChecks(f);
    f.state.render = () => embeds;
    const original = f.input.targetMessage.content;
    await execute(f.interaction, config, preview.dependencies);
    assert.equal(preview.checks.length, 2, 'each vetted X provider is checked once');
    assert(preview.observations.every(item => !item.result.ok));
    assert.equal(f.events.filter(event => event.name === 'edit').length, 3, 'initial response, alternate and final status only');
    assert.match(f.response.content, /^https:\/\/vxtwitter\.com\/jack\/status\/20\n-# /);
    assert.match(f.response.content, /preview could not be confirmed/i);
    assert.deepEqual(originalControls(f), ['https://x.com/jack/status/20']);
    assert.equal(f.input.targetMessage.content, original);
    assert(f.response.content.length <= 2000);
  }
});

test('manual recovery changes only the failed provider and excludes hidden or capped source links', async () => {
  const instagram = 'https://www.instagram7.com/reels/DdFKS1ABmK4/';
  const f = command('https://x.com/jack/status/20 https://instagram.com/reels/DdFKS1ABmK4/ ' +
    '||https://x.com/jack/status/999|| <https://youtu.be/dQw4w9WgXcQ>', true);
  f.state.render = (_content, edit) => [
    { url: instagram, video: { url: 'https://media.example/reel.mp4' } },
    ...(edit > 1 ? [{ url: 'https://vxtwitter.com/jack/status/20', title: 'Jack', description: 'A public post.' }] : []),
  ];
  const preview = previewChecks(f);
  await execute(f.interaction, config, preview.dependencies);
  assert.equal(preview.checks.length, 2);
  assert.deepEqual(preview.checks.map(items => items.map(item => item.providerId)), [['fixupx', 'instagram7'], ['fixvx', 'instagram7']]);
  assert.deepEqual(preview.observations[0].result.missing.map(item => item.providerId), ['fixupx']);
  assert.equal(f.response.content, `https://vxtwitter.com/jack/status/20\n${instagram}`);
  assert.deepEqual(originalControls(f), ['https://x.com/jack/status/20', 'https://www.instagram.com/reels/DdFKS1ABmK4/']);

  const capped = command([20, 21, 22, 23].map(id => `https://x.com/jack/status/${id}`).join(' '), true);
  const cappedPreview = previewChecks(capped);
  await execute(capped.interaction, config, cappedPreview.dependencies);
  assert.equal(cappedPreview.checks[0].length, 3);
  assert(!cappedPreview.checks[0].some(item => item.source.endsWith('/23')));
  assert.equal(originalControls(capped).length, 3);
});

test('manual YouTube uses native video metadata without requiring an API key or publishing statistics', async () => {
  const canonical = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=80';
  const f = command('https://youtu.be/dQw4w9WgXcQ?t=1m20s'), preview = previewChecks(f);
  f.state.render = () => [{ url: canonical, video: { url: 'https://www.youtube.com/embed/dQw4w9WgXcQ' } }];
  await execute(f.interaction, { ...config, rewritePlatforms: [], youtubeApiKey: undefined }, preview.dependencies);
  assert.equal(preview.checks.length, 1);
  assert.equal(preview.checks[0][0].providerId, 'youtube');
  assert.equal(preview.observations[0].result.ok, true);
  assert.equal(f.response.content, canonical);
  assert.deepEqual(originalControls(f), [canonical]);
  assert.equal(f.events.filter(event => event.name === 'edit').length, 1);
  assert(!f.events.some(event => event.payload?.embeds || event.payload?.files));
});

test('an Instagram reel thumbnail or a YouTube counts card cannot count as manual video recovery', async () => {
  for (const [source, embed] of [
    ['https://instagram.com/reel/ABC/', { url: 'https://www.instagram7.com/reel/ABC/', thumbnail: { url: 'https://media.example/photo.jpg' } }],
    ['https://youtu.be/dQw4w9WgXcQ', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'YouTube stats', fields: [{ name: 'Views', value: '42' }] }],
  ] as const) {
    const f = command(source), preview = previewChecks(f);
    f.state.render = () => [embed as APIEmbed];
    await execute(f.interaction, config, preview.dependencies);
    assert(preview.observations.every(item => !item.result.ok));
    assert.match(f.response.content, /preview could not be confirmed/i);
    assert.equal(originalControls(f).length, 1);
  }
});

test('manual removal allows the authenticated requester in a guild or private context', async () => {
  for (const guild of [true, false]) {
    const f = button();
    f.input.inGuild = () => guild;
    assert.equal(await removeManual(f.interaction), true);
    assert.deepEqual(f.events.map(event => event.name), ['defer', 'delete']);
  }
});

test('manual removal rejects everyone except the requester, including moderators and administrators', async () => {
  for (const permissions of [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, 0n]) {
    const f = button();
    f.input.user.id = OTHER;
    f.input.memberPermissions = new PermissionsBitField(permissions);
    await removeManual(f.interaction);
    assert.deepEqual(f.events.map(event => event.name), ['reply']);
    assert.match(f.events[0].payload.content, /Only the person who requested this preview can remove it/);
    assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
    assert.deepEqual(f.events[0].payload.allowedMentions, { parse: [] });
  }
});

test('manual removal rejects forged bot/webhook/ownership metadata and DM moderator claims', async () => {
  const cases = [
    (f: ReturnType<typeof button>) => { f.input.message.author.id = OTHER; },
    (f: ReturnType<typeof button>) => { f.input.message.webhookId = OTHER; },
    (f: ReturnType<typeof button>) => { f.input.message.webhookId = null; },
    (f: ReturnType<typeof button>) => { f.input.message.interactionMetadata = null; },
    (f: ReturnType<typeof button>) => { f.input.user.id = OTHER; },
    (f: ReturnType<typeof button>) => {
      f.input.user.id = OTHER; f.input.inGuild = () => false;
      f.input.memberPermissions = new PermissionsBitField(PermissionFlagsBits.ManageMessages);
    },
  ];
  for (const mutate of cases) {
    const f = button(); mutate(f);
    await removeManual(f.interaction);
    assert.deepEqual(f.events.map(event => event.name), ['reply']);
    assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
    assert.deepEqual(f.events[0].payload.allowedMentions, { parse: [] });
  }
});

test('unrelated controls are ignored without examining ownership or deleting a response', async () => {
  assert.equal(await removeManual({ customId: 'some-other-control' } as ButtonInteraction), false);
});

test('moderator permission does not authorize removing a forged non-Linky response', async () => {
  for (const invalid of ['author', 'webhook', 'metadata']) {
    const f = button();
    f.input.user.id = OTHER;
    f.input.memberPermissions = new PermissionsBitField(PermissionFlagsBits.ManageMessages);
    if (invalid === 'author') f.input.message.author.id = OTHER;
    else if (invalid === 'webhook') f.input.message.webhookId = OTHER;
    else f.input.message.interactionMetadata = null;
    await removeManual(f.interaction);
    assert.deepEqual(f.events.map(event => event.name), ['reply']);
    assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
  }
});

test('manual mobile shares acknowledge before network work and verify the resolved post', async () => {
  for (const context of [false, true]) for (const canSend of [false, true]) {
    const share = 'https://www.instagram.com/share/p/Mobile123?igsh=original';
    const source = 'https://www.instagram.com/p/ABC/', fixed = 'https://www.instagram7.com/p/ABC/';
    const f = command(share, context), preview = previewChecks(f);
    if (!canSend) f.input.memberPermissions = new PermissionsBitField(0n);
    const normalizeMobileLinks = createMobileShareLinkNormalizer({ resolve4: async () => ['1.1.1.1'], connect: async () => {
      assert.deepEqual(f.events.map(event => event.name), ['defer']);
      assert.deepEqual(f.events[0].payload, canSend ? {} : { flags: MessageFlags.Ephemeral });
      return new Response(null, { status: 302, headers: { location: source + '?igsh=resolved' } });
    } });
    f.state.render = () => [{ url: fixed, image: { url: 'https://cdn.example/photo.jpg' } }];
    await execute(f.interaction, config, { ...preview.dependencies, normalizeMobileLinks });
    assert.deepEqual(f.events.map(event => event.name), ['defer', 'edit']);
    assert.equal(f.response.content, fixed);
    assert.equal(preview.checks[0][0].source, source);
    assert.deepEqual(originalControls(f), [source]);
    assert.equal(f.input.targetMessage.content, share);
  }
});

test('invalid, hidden, bypassed and disabled mobile shares keep immediate private errors without resolver work', async () => {
  const share = 'https://www.instagram.com/share/p/Mobile123';
  for (const content of ['https://evil.test/share/Mobile123', `<${share}>`, `||${share}||`, `\`${share}\``, `${share} !nolinky`, share]) {
    const f = command(content);
    await execute(f.interaction, config, {
      serverPreferences: () => content === share ? { platforms: { instagram: false } } : {},
      normalizeMobileLinks: async () => assert.fail('An ineligible token cannot start normalization'),
    });
    assert.deepEqual(f.events.map(event => event.name), ['reply'], content);
    assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
  }
});

test('failed manual share normalization preserves the source and completes the acknowledged response', async () => {
  const content = 'https://www.instagram.com/share/Mobile123?igsh=original';
  for (const throws of [false, true]) {
    const f = command(content);
    await execute(f.interaction, config, { normalizeMobileLinks: async () => {
      if (throws) throw new Error('transport unavailable');
      return { content, originals: new Map() };
    } });
    assert.deepEqual(f.events.map(event => event.name), ['defer', 'edit']);
    assert.match(f.response.content, /No supported post link found/);
    assert.equal(f.input.targetMessage.content, content);
    assert.equal(f.response.components.length, 0);
  }
});

test('manual normalization receives effective platform settings and stops after a setting changes', async () => {
  const share = 'https://www.instagram.com/share/Mobile123';
  const f = command(share);
  let preferences: ServerPreferences = { platforms: { x: false } };
  await execute(f.interaction, config, { serverPreferences: () => preferences,
    normalizeMobileLinks: async (_content, platforms) => {
      assert.deepEqual(platforms, ['instagram', 'tiktok']);
      preferences = { platforms: { instagram: false } };
      return { content: 'https://www.instagram.com/p/ABC/', originals: new Map() };
    },
  });
  assert.deepEqual(f.events.map(event => event.name), ['defer', 'edit']);
  assert.match(f.response.content, /Link settings changed/);
  assert.equal(f.response.components.length, 0);
});

test('manual native YouTube still works without operator providers but honors a server platform disable', async () => {
  const f = command('https://youtu.be/dQw4w9WgXcQ');
  await execute(f.interaction, config, { serverPreferences: () => ({ platforms: { youtube: false } }) });
  assert.deepEqual(f.events.map(event => event.name), ['reply']);
  assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
});

test('manual Instagram presentation supports translated compact captions and media-first with translation off', async () => {
  const caption: InstagramTranslation = { sourceUrl: 'https://www.instagram.com/reel/ABC/', shortcode: 'ABC', username: 'author',
    text: 'A readable translated caption. '.repeat(30), languages: ['et'], mediaOnlyUrl: 'https://g.instagram7.com/p/ABC/', mediaTypes: ['GraphVideo'] };
  const sizes: number[] = [];
  for (const style of ['standard', 'compact', 'media-first'] as const) {
    const f = command(caption.sourceUrl), preview = previewChecks(f);
    let lookups = 0;
    f.state.render = () => [{ url: caption.mediaOnlyUrl, video: { url: 'https://cdn.example/video.mp4' } }];
    await execute(f.interaction, config, { ...preview.dependencies,
      serverPreferences: () => ({ instagramPresentation: style, translateInstagram: style !== 'media-first' }),
      translateInstagram: async () => { lookups++; return caption; },
    });
    assert.equal(lookups, style === 'media-first' ? 0 : 1);
    assert.equal(preview.checks[0][0].captionFree, true);
    assert.equal(preview.checks[0][0].requireVideo, true);
    assert.equal(f.response.content.includes('Translated from Estonian'), style !== 'media-first');
    assert.deepEqual(originalControls(f), [caption.sourceUrl]);
    sizes.push(f.response.content.length);
  }
  assert(sizes[1] < sizes[0]); assert(sizes[2] < sizes[1]);
});

test('manual media-first failures never claim a partial translated caption', async () => {
  const f = command('https://www.instagram.com/reel/ABC/'), preview = previewChecks(f);
  f.state.render = () => [];
  await execute(f.interaction, config, { ...preview.dependencies,
    serverPreferences: () => ({ instagramPresentation: 'media-first', translateInstagram: false }),
    translateInstagram: async () => assert.fail('Media-first has no caption lookup'),
  });
  assert(preview.checks.flat().every(item => item.captionFree && item.requireVideo));
  assert.match(f.response.content, /A useful preview could not be confirmed/);
  assert(!f.response.content.includes('Translated from'));
  assert(!f.response.content.includes('Instagram preview could not be verified'));
});

const COMMUNITY_URL = 'https://www.youtube.com/post/UgkxCommunityPublicPost123456789';
const communityPost = (url = COMMUNITY_URL, images: string[] = []): YouTubeCommunityPost => ({
  ...parseYouTubeCommunityUrl(url)!, author: { name: 'Creator', url: 'https://www.youtube.com/channel/UC' + 'a'.repeat(22) },
  text: 'Public community text.', images,
});
function communityCommand(content = COMMUNITY_URL, context = false) {
  const f = command(content, context), edit = f.input.editReply;
  let cards: APIEmbed[] = [];
  f.state.render = () => [];
  f.input.editReply = async payload => {
    if (payload.embeds) cards = payload.embeds.map((card: any) => 'toJSON' in card ? card.toJSON() : card);
    const result = await edit(payload);
    f.response.embeds.unshift(...cards.map(card => ({ toJSON: () => card })));
    return result;
  };
  return f;
}
const communityConfig: Config = { ...config, rewritePlatforms: [...config.rewritePlatforms, 'youtube'] };

test('manual community previews work without a video key, expose full images, and retain original and owner controls', async () => {
  for (const context of [false, true]) {
    const f = communityCommand(COMMUNITY_URL, context), paths: string[] = [], outcomes: DeliveryOutcome[] = [];
    const diagnostics = { begin: () => ({ id: 'community-manual', setPath: (path: string) => paths.push(path),
      startStage: () => ({ finish() {} }), finish: (outcome: DeliveryOutcome) => outcomes.push(outcome) }),
    bind: async () => false } as unknown as DeliveryDiagnostics;
    await execute(f.interaction, communityConfig, { diagnostics, serverPreferences: () => ({ youtubeDisplay: 'preview' }),
      lookupYouTubeCommunity: async (link, signal) => { assert(signal); return communityPost(typeof link === 'string' ? link : link.url,
        ['https://yt3.ggpht.com/first=s1080', 'https://yt3.ggpht.com/second=s500']); },
      verifyPreview: async () => assert.fail('community is not a video/native preview') });
    assert.equal(f.response.embeds.length, 2);
    assert.equal(f.response.embeds[0].toJSON().image?.url, 'https://yt3.ggpht.com/first=s1080');
    assert.deepEqual(originalControls(f), [COMMUNITY_URL]);
    assert.equal(paths.at(-1), 'explicit'); assert.deepEqual(outcomes, ['confirmed']);
  }
});

test('manual community galleries require all posts and keep every original control on lookup or budget failure', async () => {
  const sources = Array.from({ length: 5 }, (_, i) => COMMUNITY_URL + i);
  for (const kind of ['lookup', 'budget']) {
    const f = communityCommand(sources.join(' '));
    await execute(f.interaction, communityConfig, { lookupYouTubeCommunity: async link => kind === 'lookup' ? null
      : communityPost(typeof link === 'string' ? link : link.url, Array.from({ length: 3 }, (_, i) => `https://yt3.ggpht.com/image${i}=s1080`)) });
    assert.equal(f.response.embeds.length, 0);
    assert.deepEqual(originalControls(f), sources);
    assert.equal(f.response.components.length, 2);
    assert(f.response.components.every(row => row.toJSON().components.length <= 5));
    assert.match(f.response.content, /original is unchanged/i);
  }
  const six = communityCommand([...sources, COMMUNITY_URL + '5'].join(' '));
  await execute(six.interaction, communityConfig, { lookupYouTubeCommunity: async () => assert.fail('six sources looked up') });
  assert.match(six.events[0].payload.content, /at most five/);
});

test('manual unavailable or changed source cannot publish a verified community card', async () => {
  for (const kind of ['missing', 'edited', 'preferences']) {
    const f = communityCommand(COMMUNITY_URL, true);
    let preferences: ServerPreferences = {};
    Object.assign(f.input.targetMessage, { fetch: async () => {
      if (kind === 'missing') throw Error('Unknown Message');
      if (kind === 'preferences') preferences = { platforms: { youtube: false } };
      return { ...f.input.targetMessage, ...(kind === 'edited' ? { content: COMMUNITY_URL + ' edited' } : {}) };
    } });
    await execute(f.interaction, communityConfig, { lookupYouTubeCommunity: async () => communityPost(), serverPreferences: () => preferences });
    assert.equal(f.response.embeds.length, 0); assert.deepEqual(originalControls(f), [COMMUNITY_URL]);
    assert.match(f.response.content, /original is unchanged/i);
  }
});

test('manual mixed guidance recognizes mobile and other delivery shapes before any public lookup', async () => {
  for (const other of ['https://youtu.be/dQw4w9WgXcQ', 'https://www.instagram.com/share/ABCDefghi/',
    'https://www.reddit.com/r/example/s/ABCDefghij', 'https://www.erome.com/a/Synthetic01']) {
    const f = communityCommand(`${COMMUNITY_URL} ${other}`);
    await execute(f.interaction, { ...communityConfig, rewritePlatforms: [...communityConfig.rewritePlatforms, 'reddit', 'erome'] }, {
      serverPreferences: () => ({ eromeChannels: 'all' }),
      lookupYouTubeCommunity: async () => assert.fail('mixed lookup'), prepareErome: async () => assert.fail('mixed media'),
      normalizeMobileLinks: async () => assert.fail('mixed normalization') });
    assert.equal(f.events.length, 1); assert.match(f.events[0].payload.content, /separate messages/);
    assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
  }
});

test('manual settings changes during Details binding or controls clear stale previews without discarding owner controls', async () => {
  for (const phase of ['binding', 'controls']) {
    const f = command('https://instagram.com/p/ABC/'); let preferences: ServerPreferences = {};
    const diagnostics = { begin: () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', setPath() {}, startStage: () => ({ finish() {} }), finish() {} }),
      bind: async () => { if (phase === 'binding') preferences = { platforms: { instagram: false } }; return true; } } as unknown as DeliveryDiagnostics;
    const edit = f.input.editReply;
    f.input.editReply = async payload => {
      const result = await edit(payload);
      if (phase === 'controls' && payload.content === undefined && payload.components) preferences = { platforms: { instagram: false } };
      return result;
    };
    await execute(f.interaction, config, { diagnostics, serverPreferences: () => preferences, ...previewChecks(f).dependencies });
    assert.match(f.response.content, /settings changed/);
    assert.deepEqual(originalControls(f), ['https://www.instagram.com/p/ABC/']);
    assert.equal(f.events.at(-1)!.payload.flags, MessageFlags.SuppressEmbeds);
  }
});

test('manual context source edits during Details or final controls remove a previously verified community card', async () => {
  for (const phase of ['binding', 'controls']) {
    const f = communityCommand(COMMUNITY_URL, true), outcomes: DeliveryOutcome[] = [];
    const change = () => { f.input.targetMessage.content = COMMUNITY_URL + ' edited'; };
    const diagnostics = { begin: () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', setPath() {}, startStage: () => ({ finish() {} }),
      finish: (outcome: DeliveryOutcome) => outcomes.push(outcome) }),
      bind: async () => { if (phase === 'binding') change(); return true; } } as unknown as DeliveryDiagnostics;
    const edit = f.input.editReply;
    f.input.editReply = async payload => { const result = await edit(payload);
      if (phase === 'controls' && payload.content === undefined && payload.components) change(); return result; };
    await execute(f.interaction, communityConfig, { diagnostics, lookupYouTubeCommunity: async () => communityPost() });
    assert.equal(f.response.embeds.length, 0); assert.match(f.response.content, /source changed/);
    assert.deepEqual(originalControls(f), [COMMUNITY_URL]); assert.deepEqual(outcomes, ['unavailable']);
  }
});

test('five community-only manual posts still render while unrelated and hidden links do not create a conflict', async () => {
  const urls = Array.from({ length: 5 }, (_, i) => COMMUNITY_URL + i);
  const f = communityCommand(urls.join(' ') + ' https://example.test/page <https://x.com/jack/status/20>');
  await execute(f.interaction, communityConfig, { lookupYouTubeCommunity: async link => communityPost(typeof link === 'string' ? link : link.url) });
  assert.equal(f.response.embeds.length, 5); assert.deepEqual(originalControls(f), urls);
  assert.equal(f.response.components.length, 2); assert.doesNotMatch(f.response.content, /separate messages/);
});

test('manual mixed community guidance is private and skips every lookup without a retry offer', async () => {
  for (const context of [false, true]) {
    const f = communityCommand(`${COMMUNITY_URL} https://x.com/jack/status/20`, context), outcomes: DeliveryOutcome[] = [];
    const diagnostics = { begin: () => ({ id: 'mixed-guidance', setPath() {}, startStage: () => ({ finish() {} }),
      finish: (outcome: DeliveryOutcome) => outcomes.push(outcome) }), bind: async () => false } as unknown as DeliveryDiagnostics;
    await execute(f.interaction, communityConfig, { diagnostics,
      lookupYouTubeCommunity: async () => assert.fail('mixed lookup'),
      verifyPreview: async () => assert.fail('mixed verify'), normalizeMobileLinks: async () => assert.fail('mixed normalize') });
    assert.equal(f.events.length, 1); assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(f.events[0].payload.content, /separate messages/);
    assert.doesNotMatch(f.events[0].payload.content, /retry/i);
    assert.deepEqual(outcomes, ['unsupported']); assert.equal(f.response.embeds.length, 0);
  }
});

const ARTICLE_URL = 'https://publisher.example.com/news/public-article';
const articlePost = (source = ARTICLE_URL): ArticlePreview => ({ source, url: source,
  title: 'A public article', publisher: 'Example Publisher', description: 'A short publisher-provided excerpt.',
  image: 'https://publisher.example.com/images/article.jpg', publishedAt: '2026-09-22T12:00:00Z' });
const articleConfig: Config = { ...config, rewritePlatforms: [...config.rewritePlatforms, 'articles'] };

test('manual article parser respects platform settings, hidden links, bypasses and the source URL limit', () => {
  assert.deepEqual(manualLinks(ARTICLE_URL, articleConfig), [{ source: ARTICLE_URL, fixed: `<${ARTICLE_URL}>` }]);
  assert.deepEqual(manualLinks(`${ARTICLE_URL} ${ARTICLE_URL}#read`, articleConfig), [{ source: ARTICLE_URL, fixed: `<${ARTICLE_URL}>` }]);
  for (const content of [`<${ARTICLE_URL}>`, `||${ARTICLE_URL}||`, `\`${ARTICLE_URL}\``, `${ARTICLE_URL} !nolinky`, ARTICLE_URL + 'x'.repeat(500)]) {
    assert.deepEqual(manualLinks(content, articleConfig), [], content);
  }
  assert.deepEqual(manualLinks(ARTICLE_URL, config), []);
  for (const unsafe of ['https://127.0.0.1/article', 'https://intranet.local/article', 'https://erome.com/a/Example',
    'https://youtube.com/account', 'https://instagram.com/someone']) {
    assert.deepEqual(manualLinks(unsafe, { ...articleConfig, rewritePlatforms: ['articles'] }), [], unsafe);
  }
});

test('manual article previews use authored cards without native waits and retain requester controls', async () => {
  for (const context of [false, true]) {
    const f = communityCommand(ARTICLE_URL, context), paths: string[] = [], outcomes: DeliveryOutcome[] = [];
    const diagnostics = { begin: () => ({ id: 'article-manual', setPath: (path: string) => paths.push(path),
      startStage: () => ({ finish() {} }), finish: (outcome: DeliveryOutcome) => outcomes.push(outcome) }),
      bind: async () => false } as unknown as DeliveryDiagnostics;
    await execute(f.interaction, articleConfig, { diagnostics,
      lookupArticle: async (source, signal) => { assert(signal); assert.equal(source, ARTICLE_URL); return articlePost(source); },
      verifyPreview: async () => assert.fail('Authored articles must not wait for native unfurls') });
    assert.equal(f.response.content, `<${ARTICLE_URL}>`);
    assert.equal(f.response.embeds.length, 1);
    const card = f.response.embeds[0].toJSON();
    assert.equal(card.title, 'A public article');
    assert.equal(card.author?.name, 'Publisher: Example Publisher');
    assert.match(card.footer?.text ?? '', /Article metadata/);
    assert.deepEqual(originalControls(f), [ARTICLE_URL]);
    assert.equal(paths.at(-1), 'explicit'); assert.deepEqual(outcomes, ['confirmed']);
    assert.equal(f.input.targetMessage.content, ARTICLE_URL);
    assert(f.events.filter(event => event.name === 'edit').every(event => event.payload.allowedMentions.parse.length === 0));
  }
});

test('manual article preparation is all-or-nothing and caps requests before lookup', async () => {
  const sources = Array.from({ length: 3 }, (_, index) => ARTICLE_URL + index);
  for (const kind of ['unavailable', 'partial', 'throw', 'missing-lookup'] as const) {
    const f = communityCommand(sources.join(' '), true);
    const lookupArticle = kind === 'missing-lookup' ? undefined : async (source: string) => {
      if (kind === 'throw') throw Error('provider unavailable');
      return kind === 'partial' && source === sources[0] ? articlePost(source) : null;
    };
    await execute(f.interaction, articleConfig, { lookupArticle });
    assert.equal(f.response.embeds.length, 0); assert.match(f.response.content, /original is unchanged/i);
    assert.deepEqual(originalControls(f), sources); assert.equal(f.input.targetMessage.content, sources.join(' '));
  }
  const four = communityCommand([...sources, ARTICLE_URL + '3'].join(' '));
  await execute(four.interaction, articleConfig, { lookupArticle: async () => assert.fail('four articles looked up') });
  assert.deepEqual(four.events.map(event => event.name), ['reply']);
  assert.equal(four.events[0].payload.flags, MessageFlags.Ephemeral);
  assert.match(four.events[0].payload.content, /at most three articles/);
});

test('manual articles with social, disabled platform, insecure or local links are rejected privately before fetches', async () => {
  for (const other of ['https://x.com/jack/status/20', COMMUNITY_URL, 'https://erome.com/a/Example',
    'http://publisher.example.com/old', 'https://127.0.0.1/private']) {
    const f = communityCommand(`${ARTICLE_URL} ${other}`);
    await execute(f.interaction, articleConfig, {
      lookupArticle: async () => assert.fail('mixed article lookup'), lookupYouTubeCommunity: async () => assert.fail('mixed community lookup'),
      normalizeMobileLinks: async () => assert.fail('mixed mobile normalization') });
    assert.deepEqual(f.events.map(event => event.name), ['reply']);
    assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(f.events[0].payload.content, /separately/);
  }
  const disabled = communityCommand(ARTICLE_URL);
  await execute(disabled.interaction, articleConfig, { serverPreferences: () => ({ platforms: { articles: false } }),
    lookupArticle: async () => assert.fail('disabled article lookup') });
  assert.deepEqual(disabled.events.map(event => event.name), ['reply']);
});

test('three manual articles allow hidden social links and require an exact echoed card for every article', async () => {
  const sources = Array.from({ length: 3 }, (_, index) => ARTICLE_URL + index);
  const f = communityCommand(sources.join(' ') + ' <https://x.com/jack/status/20> ||https://youtube.com/watch?v=dQw4w9WgXcQ||');
  await execute(f.interaction, articleConfig, { lookupArticle: async source => articlePost(source) });
  assert.equal(f.response.embeds.length, 3); assert.deepEqual(originalControls(f), sources);
  assert.doesNotMatch(f.response.content, /could not/);
  const mismatch = communityCommand(ARTICLE_URL), edit = mismatch.input.editReply;
  mismatch.input.editReply = async payload => {
    const result = await edit(payload);
    if (payload.embeds?.length) mismatch.response.embeds = [{ toJSON: () => ({ ...payload.embeds[0], title: 'Wrong article' }) }];
    return result;
  };
  await execute(mismatch.interaction, articleConfig, { lookupArticle: async source => articlePost(source) });
  assert.match(mismatch.response.content, /preview could not be confirmed/);
  assert.equal(mismatch.response.embeds.length, 0, 'An unverified article card must be removed');
  assert.deepEqual(originalControls(mismatch), [ARTICLE_URL]);
});

test('manual article source edits, deletions, shutdown and preference changes prevent publication', async () => {
  for (const kind of ['edited', 'deleted', 'cancelled', 'preferences'] as const) {
    const f = communityCommand(ARTICLE_URL, true), controller = new AbortController();
    let preferences: ServerPreferences = {};
    Object.assign(f.input.targetMessage, { fetch: async () => {
      if (kind === 'deleted') throw Error('Unknown Message');
      return f.input.targetMessage;
    } });
    await execute(f.interaction, articleConfig, { signal: controller.signal, serverPreferences: () => preferences,
      lookupArticle: async source => {
        if (kind === 'edited') f.input.targetMessage.content += ' edited';
        if (kind === 'cancelled') controller.abort();
        if (kind === 'preferences') preferences = { platforms: { articles: false } };
        return articlePost(source);
      } });
    assert.equal(f.response.embeds.length, 0, kind);
    assert.match(f.response.content, /original (?:post )?is unchanged/i, kind);
    assert.deepEqual(originalControls(f), [ARTICLE_URL]);
  }
});

test('manual article source and settings changes during publication, Details binding and final controls remove stale cards', async () => {
  for (const kind of ['source', 'preferences', 'cancelled'] as const) for (const phase of ['publish', 'binding', 'controls']) {
    const f = communityCommand(ARTICLE_URL, true), controller = new AbortController();
    let preferences: ServerPreferences = {};
    const change = () => {
      if (kind === 'source') f.input.targetMessage.content += ' edited';
      if (kind === 'preferences') preferences = { platforms: { articles: false } };
      if (kind === 'cancelled') controller.abort();
    };
    const diagnostics = { begin: () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', setPath() {},
      startStage: () => ({ finish() {} }), finish() {} }),
      bind: async () => { if (phase === 'binding') change(); return true; } } as unknown as DeliveryDiagnostics;
    const edit = f.input.editReply;
    f.input.editReply = async payload => {
      const result = await edit(payload);
      if (phase === 'publish' && payload.embeds?.length || phase === 'controls' && payload.content === undefined && payload.components) change();
      return result;
    };
    await execute(f.interaction, articleConfig, { diagnostics, signal: controller.signal, serverPreferences: () => preferences,
      lookupArticle: async source => articlePost(source) });
    assert.equal(f.response.embeds.length, 0, `${kind}/${phase}`);
    assert.match(f.response.content, /(?:settings changed|source changed)/i, `${kind}/${phase}`);
    assert.deepEqual(originalControls(f), [ARTICLE_URL]);
  }
});


test('manual tracking aliases publish one verified article card while preserving every original control', async () => {
  const sources = [ARTICLE_URL + '?utm_source=first', ARTICLE_URL + '?utm_source=second'];
  for (const context of [false, true]) {
    const f = communityCommand(sources.join(' '), context), observed: PreviewResult[] = [];
    await execute(f.interaction, articleConfig, {
      lookupArticle: async source => ({ ...articlePost(source), url: ARTICLE_URL }),
      observePreview: (expected, result) => { assert.equal(expected.length, 2); observed.push(result); },
    });
    assert.equal(f.response.embeds.length, 1);
    assert.equal(f.response.embeds[0].toJSON().url, ARTICLE_URL);
    assert.deepEqual(originalControls(f), sources);
    assert.deepEqual(observed.map(result => result.ok), [true]);
    assert.doesNotMatch(f.response.content, /could not/);
  }
});

test('manual articles with conflicting canonical metadata publish no cards and retain both source controls', async () => {
  const sources = [ARTICLE_URL + '?utm_source=first', ARTICLE_URL + '?utm_source=second'];
  const f = communityCommand(sources.join(' '), true);
  await execute(f.interaction, articleConfig, {
    lookupArticle: async source => ({ ...articlePost(source), url: ARTICLE_URL,
      ...(source === sources[1] ? { title: 'Conflicting article' } : {}) }),
    observePreview: () => assert.fail('Conflicting cards must never reach verification'),
  });
  assert.equal(f.response.embeds.length, 0);
  assert.match(f.response.content, /article preview could not be verified/);
  assert.deepEqual(originalControls(f), sources);
  assert.equal(f.input.targetMessage.content, sources.join(' '));
});
