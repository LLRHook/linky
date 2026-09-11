import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationIntegrationType, InteractionContextType, MessageFlags, PermissionFlagsBits, PermissionsBitField, type ChatInputCommandInteraction } from 'discord.js';
import { ServerSettings } from '../src/services/ServerSettings';
import { data, execute } from '../src/commands/setup';

const directory = mkdtempSync(join(tmpdir(), 'linky-server-settings-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const FIRST = '111111111111111111';
const SECOND = '222222222222222222';
let nextFile = 0;
const file = () => join(directory, `${nextFile++}.json`);

function interaction(enabled: boolean, guildId: string | null = FIRST,
  permissions: bigint = PermissionFlagsBits.ManageGuild) {
  const events: { name: string; payload: any }[] = [];
  const command = {
    guildId, memberPermissions: new PermissionsBitField(permissions),
    options: { getBoolean: (name: string, required: boolean) => {
      assert.equal(name, 'enabled'); assert.equal(required, true); return enabled;
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
  assert.equal(command.options?.[0].required, true);
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
  assert.match(events[1].payload.content, /enabled throughout this server/);
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
