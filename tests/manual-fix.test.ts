import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationCommandType, ApplicationIntegrationType, InteractionContextType, MessageFlags,
  PermissionFlagsBits, PermissionsBitField, type ButtonInteraction, type ChatInputCommandInteraction,
  type APIEmbed, type Message, type MessageContextMenuCommandInteraction } from 'discord.js';
import type { Config } from '../src/config';
import { data, contextData, execute, manualLinks, removeManual } from '../src/commands/fix';
import { inspectPreviews, type ExpectedPreview, type PreviewResult } from '../src/services/PreviewRecovery';

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

function originalControls(fixture: ReturnType<typeof command>) {
  const controls = fixture.response.components.flatMap(row => row.toJSON().components);
  assert.equal(controls.at(-1).custom_id, 'linky:remove-manual');
  return controls.filter(control => control.url).map(control => control.url);
}

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

test('manual removal permits a current channel moderator but not an unrelated member', async () => {
  const moderator = button();
  moderator.input.user.id = OTHER;
  moderator.input.memberPermissions = new PermissionsBitField(PermissionFlagsBits.ManageMessages);
  await removeManual(moderator.interaction);
  assert.deepEqual(moderator.events.map(event => event.name), ['defer', 'delete']);
  const member = button();
  member.input.user.id = OTHER;
  member.input.memberPermissions = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
  await removeManual(member.interaction);
  assert.equal(member.events.length, 1);
  assert.equal(member.events[0].payload.flags, MessageFlags.Ephemeral);
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
