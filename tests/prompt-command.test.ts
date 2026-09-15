import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApplicationCommandOptionType, ApplicationIntegrationType, InteractionContextType, MessageFlags,
  PermissionFlagsBits, PermissionsBitField, type ButtonInteraction, type ChatInputCommandInteraction,
  type InteractionEditReplyOptions, type InteractionReplyOptions,
} from 'discord.js';
import { data, execute, handleStatus } from '../src/commands/prompt';
import { PromptError, type PromptJobView, type PromptService } from '../src/services/PromptService';

const id = '1491242185331576884', guildId = '1491242184391917590', userId = '307905648585080834';
const request = 'Add a compact preview option for YouTube.';

function fixture(overrides: Record<string, unknown> = {}) {
  const replies: InteractionReplyOptions[] = [];
  const edits: InteractionEditReplyOptions[] = [];
  const events: string[] = [];
  const interaction = {
    id, guildId, user: { id: userId }, customId: `prompt-status:${id}`,
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
    options: { getString: () => request },
    reply: async (payload: InteractionReplyOptions) => { replies.push(payload); events.push('reply'); },
    deferReply: async (payload: { flags: MessageFlags }) => {
      assert.equal(payload.flags, MessageFlags.Ephemeral); events.push('defer');
    },
    editReply: async (payload: InteractionEditReplyOptions) => { edits.push(payload); events.push('edit'); },
    ...overrides,
  };
  const submissions: Parameters<PromptService['submit']>[0][] = [];
  const checks: Parameters<PromptService['status']>[] = [];
  const job: PromptJobView = { id, state: 'queued', message: 'Your coding request is queued.' };
  const service: Pick<PromptService, 'available' | 'submit' | 'status'> = {
    available: candidate => candidate === guildId,
    submit: async input => { events.push('submit'); submissions.push(input); return job; },
    status: async (jobId, sourceGuildId) => { events.push('status'); checks.push([jobId, sourceGuildId]); return job; },
  };
  return { interaction, command: interaction as unknown as ChatInputCommandInteraction,
    button: interaction as unknown as ButtonInteraction, service, job, events, replies, edits, submissions, checks };
}

test('/prompt is an administrator-only guild command with bounded public request input', () => {
  const command = data.toJSON();
  assert.equal(command.name, 'prompt');
  assert.deepEqual(command.contexts, [InteractionContextType.Guild]);
  assert.deepEqual(command.integration_types, [ApplicationIntegrationType.GuildInstall]);
  assert.equal(command.default_member_permissions, String(PermissionFlagsBits.Administrator));
  const option = command.options?.[0];
  assert.ok(option);
  assert.equal(option.type, ApplicationCommandOptionType.String);
  if (option.type !== ApplicationCommandOptionType.String) assert.fail('Expected a string option');
  assert.equal(option.name, 'request');
  assert.equal(option.required, false);
  assert.equal(option.min_length, 10);
  assert.equal(option.max_length, 3000);
  assert.match(option.description, /public on GitHub/);
  assert.match(option.description, /Omit to check the latest request/);
});

for (const [description, overrides] of [
  ['direct messages', { guildId: null }],
  ['members without Administrator', { memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) }],
  ['missing member permissions', { memberPermissions: null }],
] as const) {
  test(`/prompt rejects ${description} before calling the service`, async () => {
    const f = fixture(overrides);
    f.service.available = () => assert.fail('Authorization must run before guild eligibility');
    await execute(f.command, f.service);
    assert.deepEqual(f.events, ['reply']);
    assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
    assert.deepEqual(f.replies[0].allowedMentions, { parse: [] });
    assert.match(f.replies[0].content!, /Administrator/);
    assert.equal(f.submissions.length, 0);
  });
}

for (const enabled of [true, false]) {
  test(`/prompt rejects an unavailable guild with ${enabled ? 'configured' : 'disabled'} coding service`, async () => {
    const f = fixture({ guildId: 'unapproved-guild' });
    await execute(f.command, enabled ? f.service : undefined);
    assert.deepEqual(f.events, ['reply']);
    assert.match(f.replies[0].content!, /not available in this server/);
    assert.equal(f.submissions.length, 0);
  });
}

test('/prompt acknowledges privately before submitting the exact caller and guild', async () => {
  const f = fixture({ options: { getString: () => `  ${request}  ` } });
  f.job.runUrl = 'https://github.com/LLRHook/linky/actions/runs/123';
  f.job.prUrl = 'https://github.com/LLRHook/linky/pull/42';
  await execute(f.command, f.service);
  assert.deepEqual(f.events, ['defer', 'submit', 'edit']);
  assert.deepEqual(f.submissions, [{ id, guildId, userId, request }]);
  assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
  assert.match(f.edits[0].content!, /shared Linky bot/);
  assert.match(f.edits[0].content!, /visible on public GitHub/);
  const json = JSON.stringify(f.edits[0].components);
  assert.match(json, new RegExp(`prompt-status:${id}`));
  assert.match(json, /https:\/\/github.com\/LLRHook\/linky\/actions\/runs\/123/);
  assert.match(json, /https:\/\/github.com\/LLRHook\/linky\/pull\/42/);
  assert.doesNotMatch(f.edits[0].content!, /compact preview/);
});

for (const invalid of ['', '          ', 'too short', 'x'.repeat(3001), 'Bad\u0000request input']) {
  test(`/prompt rejects invalid text (${invalid.length}) without creating a job`, async () => {
    const f = fixture({ options: { getString: () => invalid } });
    await execute(f.command, f.service);
    assert.deepEqual(f.events, ['defer', 'edit']);
    assert.match(f.edits[0].content!, /10–3,000 characters/);
    assert.equal(f.submissions.length, 0);
    assert.equal(f.checks.length, 0);
  });
}

test('/prompt without a request recovers the latest job in the current guild without submitting work', async () => {
  const f = fixture({ options: { getString: () => null } });
  f.job.state = 'running';
  await execute(f.command, f.service);
  assert.deepEqual(f.events, ['defer', 'status', 'edit']);
  assert.deepEqual(f.checks, [[undefined, guildId]]);
  assert.deepEqual(f.submissions, []);
  assert.match(f.edits[0].content!, /running/);
  assert.match(JSON.stringify(f.edits[0].components), new RegExp(`prompt-status:${id}`));
  assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
});

test('/prompt without a request still requires current Administrator permission', async () => {
  const f = fixture({ options: { getString: () => null }, memberPermissions: new PermissionsBitField() });
  await execute(f.command, f.service);
  assert.deepEqual(f.events, ['reply']);
  assert.deepEqual(f.checks, []);
  assert.deepEqual(f.submissions, []);
  assert.match(f.replies[0].content!, /Administrator permission/);
});

test('/prompt without a request shows a safe no-job response for the current guild', async () => {
  const f = fixture({ options: { getString: () => null } });
  f.service.status = async (jobId, sourceGuild) => {
    assert.equal(jobId, undefined);
    assert.equal(sourceGuild, guildId);
    throw new PromptError('No coding request found in this server.');
  };
  await execute(f.command, f.service);
  assert.deepEqual(f.events, ['defer', 'edit']);
  assert.deepEqual(f.submissions, []);
  assert.match(f.edits[0].content!, /No coding request found in this server/);
  assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
});

test('/prompt preserves valid multiline feature requirements', async () => {
  const value = 'Add a button.\n\tKeep replies private.';
  const f = fixture({ options: { getString: () => value } });
  await execute(f.command, f.service);
  assert.equal(f.submissions[0].request, value);
});

test('job messages cannot inject mentions, markdown or unrelated link buttons', async () => {
  const f = fixture();
  f.job.message = '**Unsafe** <@123> @everyone\nmessage';
  f.job.runUrl = 'https://github.com/LLRHook/linky/actions/runs/123?token=private';
  f.job.prUrl = 'https://example.com/fake';
  await execute(f.command, f.service);
  assert.match(f.edits[0].content!, /\\\*\\\*Unsafe\\\*\\\*/);
  assert.doesNotMatch(f.edits[0].content!, /@everyone|<@123>/);
  assert.doesNotMatch(JSON.stringify(f.edits[0]), /token=private|example.com/);
  assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
});

test('unknown service failures are hidden while safe PromptError messages are shown', async () => {
  for (const error of [new Error('Authorization: Bearer secret-token'), new PromptError('Daily coding limit reached.')]) {
    const f = fixture();
    f.service.submit = async () => { throw error; };
    await execute(f.command, f.service);
    assert.deepEqual(f.events, ['defer', 'edit']);
    assert.doesNotMatch(f.edits[0].content!, /secret-token|Bearer/);
    assert.match(f.edits[0].content!, error instanceof PromptError ? /Daily coding limit reached/ : /Run \/prompt without a request/);
    assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
  }
});

test('status buttons do not handle other components', async () => {
  const f = fixture({ customId: 'linky:retry' });
  assert.equal(await handleStatus(f.button, f.service), false);
  assert.deepEqual(f.events, []);
});

test('status checks recheck current Administrator permission', async () => {
  const f = fixture({ memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) });
  assert.equal(await handleStatus(f.button, f.service), true);
  assert.deepEqual(f.events, ['reply']);
  assert.deepEqual(f.checks, []);
});

test('status checks recheck guild eligibility', async () => {
  const f = fixture({ guildId: 'unapproved-guild' });
  assert.equal(await handleStatus(f.button, f.service), true);
  assert.deepEqual(f.events, ['reply']);
  assert.deepEqual(f.checks, []);
});

for (const badId of ['', '123', '../other-guild', `${id}:other-guild`]) {
  test(`status rejects a malformed request ID (${badId}) without querying jobs`, async () => {
    const f = fixture({ customId: `prompt-status:${badId}` });
    assert.equal(await handleStatus(f.button, f.service), true);
    assert.deepEqual(f.events, ['defer', 'edit']);
    assert.deepEqual(f.checks, []);
    assert.match(f.edits[0].content!, /ID is invalid/);
  });
}

test('status is scoped to the interacting guild and never resubmits work', async () => {
  const f = fixture();
  f.job.state = 'running';
  assert.equal(await handleStatus(f.button, f.service), true);
  assert.deepEqual(f.events, ['defer', 'status', 'edit']);
  assert.deepEqual(f.checks, [[id, guildId]]);
  assert.deepEqual(f.submissions, []);
  assert.match(f.edits[0].content!, /running/);
  assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
});

test('cross-guild job denials and status lookup failures stay private', async () => {
  for (const error of [new PromptError('Coding request not found in this server.'), new Error('GitHub token: private')]) {
    const f = fixture();
    f.service.status = async (jobId, sourceGuild) => {
      assert.equal(jobId, id); assert.equal(sourceGuild, guildId); throw error;
    };
    assert.equal(await handleStatus(f.button, f.service), true);
    assert.deepEqual(f.events, ['defer', 'edit']);
    assert.doesNotMatch(f.edits[0].content!, /GitHub token|private/);
    assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
  }
});
