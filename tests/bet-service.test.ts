import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { transfer } from '../src/services/BalanceService';
import { ensureGuild, getPlayer, registerPlayer } from '../src/services/PlayerService';
import {
  adminCancelBet, createBet, declineBet, getBet, getParticipants, getPoolTotals,
  isParticipant, joinBet, proposeResolution, settleBet,
} from '../src/services/BetService';

const schema = readFileSync(path.resolve('migrations/001_initial.sql'), 'utf8');
const guildId = 'guild';

function fixture() {
  const db = new Database(':memory:');
  db.exec(schema);
  for (const guild of [guildId, 'other']) {
    ensureGuild(db, guild);
    for (const user of ['a', 'b', 'c', 'd']) registerPlayer(db, guild, user);
  }
  return db;
}

function create(db: Database.Database, extra: Partial<Parameters<typeof createBet>[1]> = {}) {
  return createBet(db, {
    guildId, channelId: 'channel', creatorId: 'a', description: 'Question?',
    sideALabel: 'Yes', sideBLabel: 'No', initiatorSide: 'A', wagerDollars: 10,
    ...extra,
  });
}

function bank(db: Database.Database) {
  return db.prepare('SELECT balance FROM bank WHERE guild_id=?').get(guildId);
}

test('creating and joining escrow wagers, preserve metadata and isolate guilds', (t) => {
  const db = fixture(); t.after(() => db.close());
  const result = create(db, { opponentId: 'b', windowMinutes: 20 });
  assert.equal(result.success, true);
  assert.equal(result.fee, 100);
  assert.equal(result.netStake, 900);
  const bet = result.bet!;
  assert.match(bet.bet_id, /^[A-Z0-9]{4}$/);
  assert.equal(bet.direct_opponent_id, 'b');
  assert.equal(bet.window_minutes, 20);
  assert.equal(bet.status, 'open');
  assert.equal(getPlayer(db, guildId, 'a')!.balance, 9000);
  assert.deepEqual(bank(db), { balance: 100 });
  assert.deepEqual(getPoolTotals(db, bet.bet_id, guildId), { poolA: 900, poolB: 0, participantCount: 1 });
  assert.equal(getBet(db, 'other', bet.bet_id), null);
  assert.deepEqual(getParticipants(db, bet.bet_id, 'other'), []);
  assert.equal(isParticipant(db, bet.bet_id, 'other', 'a'), false);
  assert.deepEqual(joinBet(db, { guildId, betId: bet.bet_id, userId: 'b', side: 'B', wagerDollars: 20 }), {
    success: true, fee: 100, netStake: 1900,
    poolTotals: { poolA: 900, poolB: 1900, participantCount: 2 },
  });
  assert.equal(getPlayer(db, guildId, 'b')!.balance, 8000);
  assert.equal(getPlayer(db, 'other', 'b')!.balance, 10000);
  assert.deepEqual(bank(db), { balance: 200 });
  assert.deepEqual(getParticipants(db, bet.bet_id, guildId).map(p => p.user_id), ['a', 'b']);
});

for (const [change, expected] of [
  [{ creatorId: 'missing' }, 'You must be registered and active to create a bet.'],
  [{ wagerDollars: 101 }, 'Insufficient balance. You need $101.00 but have $100.00.'],
] as const) {
  test(`create validation: ${expected}`, (t) => {
    const db = fixture(); t.after(() => db.close());
    assert.deepEqual(create(db, change), { success: false, error: expected });
    assert.deepEqual(db.prepare('SELECT count(*) AS n FROM bets').get(), { n: 0 });
    assert.equal(getPlayer(db, guildId, 'a')!.balance, 10000);
    assert.deepEqual(bank(db), { balance: 0 });
  });
}

for (const [scenario, expected] of [
  ['missing', 'Bet not found.'],
  ['duplicate', 'You are already a participant in this bet.'],
  ['inactive', 'You must be registered and active to join a bet.'],
  ['poor', 'Insufficient balance. You need $101.00 but have $100.00.'],
  ['closed', 'Bet is not open (status: locked).'],
  ['expired', 'The betting window has closed.'],
] as const) {
  test(`join validation: ${scenario}`, (t) => {
    const db = fixture(); t.after(() => db.close());
    const betId = create(db).bet!.bet_id;
    if (scenario === 'inactive') db.prepare("UPDATE players SET status='inactive' WHERE user_id='b'").run();
    if (scenario === 'closed') db.prepare("UPDATE bets SET status='locked'").run();
    if (scenario === 'expired') db.prepare('UPDATE bets SET window_closes_at=0').run();
    assert.deepEqual(joinBet(db, {
      guildId, betId: scenario === 'missing' ? 'NONE' : betId,
      userId: scenario === 'duplicate' ? 'a' : 'b', side: 'B', wagerDollars: scenario === 'poor' ? 101 : 10,
    }), { success: false, error: expected });
    assert.equal(getParticipants(db, betId, guildId).length, 1);
    assert.equal(getPlayer(db, guildId, 'b')!.balance, 10000);
    assert.deepEqual(bank(db), { balance: 100 });
  });
}

test('declining refunds the creator fee and stake; cancelling retains fees', (t) => {
  const db = fixture(); t.after(() => db.close());
  const declined = create(db, { opponentId: 'b' }).bet!.bet_id;
  assert.deepEqual(declineBet(db, guildId, declined, 'c'), { success: false, error: 'You are not the invited opponent for this bet.' });
  assert.deepEqual(declineBet(db, guildId, declined, 'b'), { success: true });
  assert.equal(getPlayer(db, guildId, 'a')!.balance, 10000);
  assert.deepEqual(bank(db), { balance: 0 });
  assert.equal(getBet(db, guildId, declined)!.status, 'cancelled');
  const cancelled = create(db).bet!.bet_id;
  joinBet(db, { guildId, betId: cancelled, userId: 'b', side: 'B', wagerDollars: 20 });
  assert.deepEqual(adminCancelBet(db, guildId, cancelled), {
    success: true, refunds: [{ userId: 'a', amount: 900 }, { userId: 'b', amount: 1900 }],
  });
  assert.equal(getPlayer(db, guildId, 'a')!.balance, 9900);
  assert.equal(getPlayer(db, guildId, 'b')!.balance, 9900);
  assert.deepEqual(bank(db), { balance: 200 });
  assert.deepEqual(adminCancelBet(db, guildId, cancelled), { success: false, error: "Cannot cancel a bet with status 'cancelled'." });
});

test('decline and resolution retain distinct validation and proposer confirmation', (t) => {
  const db = fixture(); t.after(() => db.close());
  assert.deepEqual(declineBet(db, guildId, 'NONE', 'b'), { success: false, error: 'Bet not found.' });
  assert.deepEqual(adminCancelBet(db, guildId, 'NONE'), { success: false, error: 'Bet not found.' });
  assert.deepEqual(proposeResolution(db, guildId, 'NONE', 'a', 'A'), { success: false, error: 'Bet not found.' });
  const betId = create(db, { opponentId: 'b' }).bet!.bet_id;
  assert.deepEqual(proposeResolution(db, guildId, betId, 'c', 'A'), { success: false, error: 'You must be a participant to propose a resolution.' });
  joinBet(db, { guildId, betId, userId: 'b', side: 'B', wagerDollars: 10 });
  assert.deepEqual(declineBet(db, guildId, betId, 'b'), { success: false, error: 'You have already joined this bet. Use /resolve instead.' });
  assert.deepEqual(proposeResolution(db, guildId, betId, 'a', 'neither'), { success: true });
  assert.equal(getBet(db, guildId, betId)!.proposed_outcome, 'neither');
  assert.deepEqual(db.prepare('SELECT user_id, response FROM resolution_responses').all(), [{ user_id: 'a', response: 'confirm' }]);
  assert.deepEqual(proposeResolution(db, guildId, betId, 'a', 'A'), { success: false, error: 'Bet cannot be proposed (status: proposed).' });
  assert.deepEqual(declineBet(db, guildId, betId, 'b'), { success: false, error: 'Bet is not open.' });
});

const settlements: Array<{ label: string; sides: Array<'A' | 'B'>; stakes: number[]; outcome: 'A' | 'B' | 'neither'; payouts: Array<[string, number]> }> = [
  { label: 'A wins', sides: ['A', 'B'], stakes: [900, 1900], outcome: 'A', payouts: [['a', 2800]] },
  { label: 'B wins', sides: ['A', 'B'], stakes: [900, 1900], outcome: 'B', payouts: [['b', 2800]] },
  { label: 'neither', sides: ['A', 'B'], stakes: [900, 1900], outcome: 'neither', payouts: [['a', 900], ['b', 1900]] },
  { label: 'no winning side', sides: ['A', 'A'], stakes: [900, 1900], outcome: 'B', payouts: [['a', 900], ['b', 1900]] },
  { label: 'unequal stakes and remainder', sides: ['A', 'A', 'B'], stakes: [200, 300, 101], outcome: 'A', payouts: [['b', 361], ['a', 240]] },
  { label: 'tied stakes retain participant order', sides: ['A', 'A', 'B'], stakes: [100, 100, 101], outcome: 'A', payouts: [['a', 151], ['b', 150]] },
  { label: 'zero winner stakes', sides: ['A', 'A', 'B'], stakes: [0, 0, 101], outcome: 'A', payouts: [['a', 101], ['b', 0]] },
];

for (const scenario of settlements) {
  test(`settlement: ${scenario.label}`, (t) => {
    const db = fixture(); t.after(() => db.close());
    const betId = create(db).bet!.bet_id;
    db.prepare('DELETE FROM bet_participants').run();
    scenario.stakes.forEach((stake, i) => db.prepare(
      'INSERT INTO bet_participants(bet_id,guild_id,user_id,side,stake,fee_paid) VALUES(?,?,?,?,?,100)'
    ).run(betId, guildId, 'abcd'[i], scenario.sides[i], stake));
    const balances = ['a', 'b', 'c', 'd'].map(user => getPlayer(db, guildId, user)!.balance);
    const expected = scenario.payouts.map(([userId, payout]) => ({ userId, payout }));
    assert.deepEqual(settleBet(db, guildId, betId, scenario.outcome, 'resolver'), { success: true, payouts: expected });
    for (const [i, user] of [...'abcd'].entries()) {
      assert.equal(getPlayer(db, guildId, user)!.balance, balances[i] + (expected.find(p => p.userId === user)?.payout ?? 0));
    }
    for (const participant of getParticipants(db, betId, guildId)) {
      assert.equal(participant.payout_received, expected.find(p => p.userId === participant.user_id)?.payout ?? 0);
    }
    assert.deepEqual(bank(db), { balance: 100 });
    const bet = getBet(db, guildId, betId)!;
    assert.equal(bet.status, 'resolved');
    assert.equal(bet.resolved_outcome, scenario.outcome);
    assert.equal(bet.resolver_id, 'resolver');
    assert.deepEqual(settleBet(db, guildId, betId, scenario.outcome, 'resolver'), {
      success: false, error: 'Bet has already been resolved or cannot be settled.',
    });
  });
}

test('settlement rolls back status and payouts on a database failure', (t) => {
  const db = fixture(); t.after(() => db.close());
  const betId = create(db).bet!.bet_id;
  db.exec("CREATE TRIGGER fail_payout BEFORE UPDATE OF payout_received ON bet_participants BEGIN SELECT RAISE(ABORT, 'payout failed'); END;");
  assert.throws(() => settleBet(db, guildId, betId, 'A', 'resolver'), /payout failed/);
  assert.equal(getBet(db, guildId, betId)!.status, 'open');
  assert.equal(getPlayer(db, guildId, 'a')!.balance, 9000);
  assert.equal(getParticipants(db, betId, guildId)[0].payout_received, null);
  assert.deepEqual(transfer(db, { guildId, toWallet: { userId: 'b', amount: 1 } }).success, true);
});
