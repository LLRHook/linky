import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { ComponentType, type ChatInputCommandInteraction, type AutocompleteInteraction } from 'discord.js';

let db: Database.Database;

// Commands currently import the running bot and singleton database. Replace those
// entry points before loading commands; all SQL below runs in an isolated database.
function stubModule(modulePath: string, exports: unknown): void {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeModule;
}
stubModule('../src/index', { client: {} });
stubModule('../src/db/connection', { getDb: () => db });
stubModule('../src/logger', { logger: { error() {}, info() {}, warn() {} } });

const admin: typeof import('../src/commands/admin/admin') = require('../src/commands/admin/admin');
const history: typeof import('../src/commands/economy/history') = require('../src/commands/economy/history');
const migration = fs.readFileSync(path.join(__dirname, '../migrations/001_initial.sql'), 'utf8');
const GUILD = 'test-guild';
const ADMIN = 'test-admin';
const TARGET = 'test-player';
const AVATAR = 'https://example.com/avatar.png';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(migration);
  db.prepare('INSERT INTO guilds (guild_id, current_admin_id) VALUES (?, ?)').run(GUILD, ADMIN);
  player(ADMIN, 'active');
});
afterEach(() => db.close());

function player(userId: string, status: string, guildId = GUILD): void {
  db.prepare(`INSERT INTO players (guild_id, user_id, balance, status, registered_at, last_active_at)
    VALUES (?, ?, 12345, ?, 10, 20)`).run(guildId, userId, status);
}

function embedJson(payload: { embeds: Array<{ toJSON(): unknown }> }): Record<string, any> {
  const embed = payload.embeds[0].toJSON() as Record<string, any>;
  assert.ok(Number.isFinite(Date.parse(embed.timestamp)));
  const { timestamp: _timestamp, ...rest } = embed;
  return JSON.parse(JSON.stringify(rest));
}

function adminInteraction(sub: string, onReply?: () => void) {
  const replies: Record<string, any>[] = [];
  const interaction = {
    guildId: GUILD, user: { id: ADMIN },
    options: { getSubcommand: () => sub, getUser: () => ({ id: TARGET }) },
    editReply: async (payload: { embeds: Array<{ toJSON(): unknown }> }) => {
      onReply?.();
      replies.push(embedJson(payload));
    },
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies };
}

for (const sub of ['ban', 'unban'] as const) {
  for (const initialStatus of ['active', 'inactive', 'banned', 'missing']) {
    test(`admin ${sub} preserves the ${initialStatus} player outcome and audit ordering`, async () => {
      if (initialStatus !== 'missing') player(TARGET, initialStatus);
      const success = sub === 'ban' ? ['active', 'inactive'].includes(initialStatus) : initialStatus === 'banned';
      const finalStatus = success ? (sub === 'ban' ? 'banned' : 'active') : initialStatus;
      const f = adminInteraction(sub, () => {
        const target = db.prepare('SELECT status FROM players WHERE user_id=?').get(TARGET) as { status: string } | undefined;
        assert.equal(target?.status ?? 'missing', finalStatus);
        assert.deepEqual(db.prepare('SELECT last_active_at FROM players WHERE user_id=?').get(ADMIN), { last_active_at: 20 });
        assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get(), { count: 0 });
      });
      await admin.execute(f.interaction);
      assert.equal(f.replies.length, 1);
      if (success) {
        assert.deepEqual(f.replies[0], {
          color: sub === 'ban' ? 0xed4245 : 0x57f287,
          title: sub === 'ban' ? 'Player Banned' : 'Player Unbanned',
          fields: [{ name: 'Player', value: `<@${TARGET}>`, inline: true }],
        });
        assert.deepEqual(db.prepare('SELECT guild_id, actor_id, action_type, payload_json FROM audit_log').all(), [{
          guild_id: GUILD, actor_id: ADMIN, action_type: sub === 'ban' ? 'ADMIN_BAN' : 'ADMIN_UNBAN',
          payload_json: JSON.stringify({ targetId: TARGET }),
        }]);
        const activity = db.prepare('SELECT last_active_at FROM players WHERE user_id=?').get(ADMIN) as { last_active_at: number };
        assert.ok(activity.last_active_at > 20);
      } else {
        const error = sub === 'unban' ? 'is not banned.' : initialStatus === 'missing' ? 'is not registered.' : 'is already banned.';
        assert.deepEqual(f.replies[0], { color: 0xed4245, title: 'Error', description: `<@${TARGET}> ${error}` });
        assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get(), { count: 0 });
      }
      assert.deepEqual(db.prepare('SELECT DISTINCT balance FROM players').all(), [{ balance: 12345 }]);
    });
  }

  test(`admin ${sub} rejects a non-admin without changing the player`, async () => {
    player(TARGET, 'banned');
    const f = adminInteraction(sub);
    Object.assign(f.interaction, { user: { id: 'outsider' } });
    await admin.execute(f.interaction);
    assert.deepEqual(f.replies, [{ color: 0xed4245, title: 'Error', description: 'You must be the elected admin to use admin commands.' }]);
    assert.deepEqual(db.prepare('SELECT status FROM players WHERE user_id=?').get(TARGET), { status: 'banned' });
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get(), { count: 0 });
  });

  test(`admin ${sub} does not touch activity or audit if the successful reply fails`, async () => {
    player(TARGET, sub === 'ban' ? 'active' : 'banned');
    const f = adminInteraction(sub, () => { throw new Error('Discord unavailable'); });
    await assert.rejects(admin.execute(f.interaction), /Discord unavailable/);
    assert.deepEqual(db.prepare('SELECT status FROM players WHERE user_id=?').get(TARGET), { status: sub === 'ban' ? 'banned' : 'active' });
    assert.deepEqual(db.prepare('SELECT last_active_at FROM players WHERE user_id=?').get(ADMIN), { last_active_at: 20 });
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get(), { count: 0 });
  });
}

function bet(id: string, status = 'open', guildId = GUILD, description = `Description ${id}`, createdAt = 100): void {
  db.prepare(`INSERT INTO bets (bet_id, guild_id, channel_id, creator_id, description, side_a_label, side_b_label,
    initiator_side, window_closes_at, status, created_at) VALUES (?, ?, 'channel', ?, ?, 'Yes', 'No', 'A', 9999999999999, ?, ?)`)
    .run(id, guildId, ADMIN, description, status, createdAt);
}

async function autocomplete(sub: string | null, focused = '') {
  let result: unknown;
  await admin.autocomplete({
    guildId: GUILD,
    options: { getSubcommand: () => sub, getFocused: () => focused },
    respond: async (options: unknown) => { result = options; },
  } as unknown as AutocompleteInteraction);
  return result;
}

for (const sub of ['resolve', 'cancel']) {
  test(`admin ${sub} autocomplete includes exactly active statuses in this guild`, async () => {
    db.prepare('INSERT INTO guilds (guild_id) VALUES (?)').run('other-guild');
    for (const status of ['open', 'locked', 'proposed', 'disputed', 'resolved', 'cancelled']) bet(status.toUpperCase(), status);
    bet('OTHER', 'open', 'other-guild');
    const orderedIds = sub === 'resolve' ? ['OPEN', 'LOCKED', 'PROPOSED', 'DISPUTED'] : ['DISPUTED', 'LOCKED', 'OPEN', 'PROPOSED'];
    assert.deepEqual(await autocomplete(sub), orderedIds.map(id => ({ name: `#${id} — Description ${id}`, value: id })));
  });

  test(`admin ${sub} autocomplete uppercases prefixes and truncates descriptions to 80 characters`, async () => {
    bet('ABCD', 'open', GUILD, 'x'.repeat(90));
    bet('OTHER');
    assert.deepEqual(await autocomplete(sub, 'ab'), [{ name: `#ABCD — ${'x'.repeat(80)}`, value: 'ABCD' }]);
    assert.deepEqual(await autocomplete(sub, ' ab'), []);
  });

  test(`admin ${sub} autocomplete limits SQL results before applying the prefix`, async () => {
    for (let index = 0; index < 25; index++) bet(`A${String(index).padStart(2, '0')}`);
    bet('Z99');
    assert.equal((await autocomplete(sub) as unknown[]).length, 25);
    assert.deepEqual(await autocomplete(sub, 'z'), []);
  });
}

test('unrelated admin subcommands respond with no autocomplete choices', async () => {
  assert.deepEqual(await autocomplete('ban'), []);
  assert.deepEqual(await autocomplete(null), []);
});

function historyInteraction() {
  const replies: Record<string, any>[] = [];
  const updates: Record<string, any>[] = [];
  const edits: unknown[] = [];
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  let collectorOptions: Record<string, any> | undefined;
  const serialize = (payload: { embeds?: Array<{ toJSON(): unknown }>; components?: Array<{ toJSON(): unknown }> }) => ({
    ...(payload.embeds ? { embed: embedJson({ embeds: payload.embeds }) } : {}),
    components: payload.components?.map(component => component.toJSON()),
  });
  const message = {
    createMessageComponentCollector: (options: Record<string, any>) => {
      collectorOptions = options;
      return { on: (event: string, handler: (...args: any[]) => Promise<void>) => handlers.set(event, handler) };
    },
    edit: async (payload: unknown) => { edits.push(payload); },
  };
  const interaction = {
    guildId: GUILD, user: { id: ADMIN },
    options: { getUser: () => ({ id: TARGET, displayName: 'Sample Player', displayAvatarURL: () => AVATAR }) },
    editReply: async (payload: Parameters<typeof serialize>[0]) => { replies.push(serialize(payload)); return message; },
  };
  return {
    interaction: interaction as unknown as ChatInputCommandInteraction, replies, updates, edits, handlers,
    get collectorOptions() { return collectorOptions; },
    click: async (customId: string) => handlers.get('collect')!({ customId, update: async (payload: Parameters<typeof serialize>[0]) => { updates.push(serialize(payload)); } }),
  };
}

test('history rejects missing targets and preserves the empty-history reply without a collector', async () => {
  const missing = historyInteraction();
  await history.execute(missing.interaction);
  assert.deepEqual(missing.replies[0].embed, { color: 0xed4245, title: 'Error', description: `<@${TARGET}> is not registered in this guild's economy.` });
  assert.equal(missing.collectorOptions, undefined);

  player(TARGET, 'inactive');
  const empty = historyInteraction();
  await history.execute(empty.interaction);
  assert.deepEqual(empty.replies[0], { embed: {
    color: 0x3498db, title: "Sample Player's Bet History", thumbnail: { url: AVATAR }, footer: { text: 'Page 1 of 1' }, description: 'No bets found.',
  }, components: [] });
  assert.equal(empty.collectorOptions, undefined);
});

test('history initial and paginated replies preserve fields, ordering, buttons, limits and timeout cleanup', async () => {
  player(TARGET, 'banned');
  const cases = [
    { id: 'PEND', status: 'open', outcome: null, side: 'A', result: 'Pending' },
    { id: 'CANC', status: 'cancelled', outcome: null, side: 'B', result: 'Cancelled' },
    { id: 'PUSH', status: 'resolved', outcome: 'neither', side: 'A', result: 'Neither | P/L: $-1.00' },
    { id: 'WINS', status: 'resolved', outcome: 'A', side: 'A', result: 'WIN | P/L: approx. +$4.00' },
    { id: 'LOSS', status: 'resolved', outcome: 'B', side: 'A', result: 'LOSS | P/L: -$5.00' },
    { id: 'LAST', status: 'locked', outcome: null, side: 'A', result: 'Pending' },
  ];
  for (const [index, entry] of cases.entries()) {
    bet(entry.id, entry.status, GUILD, 'd'.repeat(70), 1000 - index);
    db.prepare('UPDATE bets SET resolved_outcome=?, resolved_at=? WHERE bet_id=?').run(entry.outcome, entry.outcome ? 100000 : null, entry.id);
    db.prepare('INSERT INTO bet_participants (bet_id, guild_id, user_id, side, stake, fee_paid) VALUES (?, ?, ?, ?, 400, 100)')
      .run(entry.id, GUILD, TARGET, entry.side);
  }
  const f = historyInteraction();
  await history.execute(f.interaction);
  assert.equal(f.replies.length, 1);
  assert.equal(f.collectorOptions?.componentType, ComponentType.Button);
  assert.equal(f.collectorOptions?.time, 300000);
  assert.equal(f.collectorOptions?.filter({ user: { id: ADMIN } }), true);
  assert.equal(f.collectorOptions?.filter({ user: { id: TARGET } }), false);
  assert.deepEqual(f.replies[0].embed.fields, cases.slice(0, 5).map(entry => ({
    name: `#${entry.id} — ${'d'.repeat(60)}`,
    value: `**Side:** ${entry.side} (${entry.side === 'A' ? 'Yes' : 'No'})\n**Wager:** $5.00 | **Fee:** $1.00\n**Result:** ${entry.result}` + (entry.outcome ? '\n**Resolved:** <t:100:R>' : ''),
    inline: false,
  })));
  const buttons = (payload: Record<string, any>) => payload.components[0].components.map((button: Record<string, any>) => ({ id: button.custom_id, disabled: button.disabled, label: button.label }));
  assert.deepEqual(buttons(f.replies[0]), [
    { id: `history:${TARGET}:prev:0`, disabled: true, label: '◀ Previous' },
    { id: `history:${TARGET}:next:0`, disabled: false, label: 'Next ▶' },
  ]);
  await f.click(`history:${TARGET}:next:0`);
  assert.equal(f.updates[0].embed.footer.text, 'Page 2 of 2');
  assert.equal(f.updates[0].embed.fields.length, 1);
  assert.equal(f.updates[0].embed.fields[0].name, `#LAST — ${'d'.repeat(60)}`);
  assert.deepEqual(buttons(f.updates[0]), [
    { id: `history:${TARGET}:prev:1`, disabled: false, label: '◀ Previous' },
    { id: `history:${TARGET}:next:1`, disabled: true, label: 'Next ▶' },
  ]);
  await f.click(`history:${TARGET}:next:99`);
  assert.deepEqual(f.updates[1], f.updates[0]);
  await f.click(`history:${TARGET}:prev:0`);
  assert.deepEqual(f.updates[2], f.replies[0]);
  await f.handlers.get('end')!();
  assert.deepEqual(f.edits, [{ components: [] }]);
});
