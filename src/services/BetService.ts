import type Database from 'better-sqlite3';
import { transfer, computeFee, dollarsToCents, formatCents } from './BalanceService';
import { logger } from '../logger';

/**
 * create → join (escrow) → propose → confirm/dispute → settle/cancel.
 * Payout math lives here; all balance changes use BalanceService.transfer().
 */

export interface BetRow {
  bet_id: string;
  guild_id: string;
  channel_id: string;
  creator_id: string;
  description: string;
  side_a_label: string;
  side_b_label: string;
  initiator_side: 'A' | 'B';
  direct_opponent_id: string | null;
  is_lobby: number;
  window_minutes: number;
  window_closes_at: number;
  status: 'open' | 'locked' | 'proposed' | 'disputed' | 'resolved' | 'cancelled';
  proposed_outcome: 'A' | 'B' | 'neither' | null;
  proposer_id: string | null;
  resolved_at: number | null;
  resolved_outcome: 'A' | 'B' | 'neither' | null;
  resolver_id: string | null;
  created_at: number;
}

export interface ParticipantRow {
  id: number;
  bet_id: string;
  guild_id: string;
  user_id: string;
  side: 'A' | 'B';
  stake: number;
  fee_paid: number;
  payout_received: number | null;
  joined_at: number;
}

export interface PoolTotals {
  poolA: number;
  poolB: number;
  participantCount: number;
}

/** Generates a 4-character uppercase alphanumeric bet ID */
function generateBetId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/** Gets a unique bet ID (retries on collision) */
function getUniqueBetId(db: Database.Database, guildId: string): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = generateBetId();
    const exists = db
      .prepare<[string, string], { bet_id: string }>(
        'SELECT bet_id FROM bets WHERE bet_id = ? AND guild_id = ?'
      )
      .get(id, guildId);
    if (!exists) return id;
  }
  throw new Error('Failed to generate unique bet ID after 10 attempts.');
}

export interface CreateBetParams {
  guildId: string;
  channelId: string;
  creatorId: string;
  description: string;
  sideALabel: string;
  sideBLabel: string;
  initiatorSide: 'A' | 'B';
  wagerDollars: number;
  opponentId?: string;
  isLobby?: boolean;
  windowMinutes?: number;
}

export interface CreateBetResult {
  success: boolean;
  error?: string;
  bet?: BetRow;
  fee?: number;
  netStake?: number;
}

export function createBet(db: Database.Database, params: CreateBetParams): CreateBetResult {
  const {
    guildId,
    channelId,
    creatorId,
    description,
    sideALabel,
    sideBLabel,
    initiatorSide,
    wagerDollars,
    opponentId,
    isLobby = false,
    windowMinutes = 10,
  } = params;

  const wagerCents = dollarsToCents(wagerDollars);
  const fee = computeFee(wagerCents);
  const netStake = wagerCents - fee;

  const txn = db.transaction((): CreateBetResult => {
    // Re-read player balance inside transaction
    const player = db
      .prepare<[string, string], { balance: number; status: string }>(
        'SELECT balance, status FROM players WHERE guild_id = ? AND user_id = ?'
      )
      .get(guildId, creatorId);

    if (!player || player.status !== 'active') {
      return { success: false, error: 'You must be registered and active to create a bet.' };
    }
    if (player.balance < wagerCents) {
      return {
        success: false,
        error: `Insufficient balance. You need ${formatCents(wagerCents)} but have ${formatCents(player.balance)}.`,
      };
    }

    const betId = getUniqueBetId(db, guildId);
    const now = Date.now();
    const windowClosesAt = now + windowMinutes * 60000;

    db.prepare<[string, string, string, string, string, string, string, string, string | null, number, number, number]>(
      `INSERT INTO bets (bet_id, guild_id, channel_id, creator_id, description,
                         side_a_label, side_b_label, initiator_side, direct_opponent_id,
                         is_lobby, window_minutes, window_closes_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      betId, guildId, channelId, creatorId, description,
      sideALabel, sideBLabel, initiatorSide, opponentId ?? null,
      isLobby ? 1 : 0, windowMinutes, windowClosesAt
    );

    // Transfer: creator wallet → bank (fee) + pool (stake)
    const xfer = transfer(db, {
      guildId,
      fromWallet: { userId: creatorId, amount: wagerCents },
      toBank: fee,
    });

    if (!xfer.success) {
      return { success: false, error: xfer.error };
    }

    db.prepare<[string, string, string, string, number, number]>(
      `INSERT INTO bet_participants (bet_id, guild_id, user_id, side, stake, fee_paid)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(betId, guildId, creatorId, initiatorSide, netStake, fee);

    const bet = getBet(db, guildId, betId);

    return { success: true, bet: bet ?? undefined, fee, netStake };
  });

  return txn.immediate();
}

export interface JoinBetParams {
  guildId: string;
  betId: string;
  userId: string;
  side: 'A' | 'B';
  wagerDollars: number;
}

export interface JoinBetResult {
  success: boolean;
  error?: string;
  fee?: number;
  netStake?: number;
  poolTotals?: PoolTotals;
}

/** Escrow the joiner's wager, rechecking eligibility inside BEGIN IMMEDIATE. */
export function joinBet(db: Database.Database, params: JoinBetParams): JoinBetResult {
  const { guildId, betId, userId, side, wagerDollars } = params;
  const wagerCents = dollarsToCents(wagerDollars);
  const fee = computeFee(wagerCents);
  const netStake = wagerCents - fee;

  const txn = db.transaction((): JoinBetResult => {
    const bet = getBet(db, guildId, betId);

    if (!bet) {
      return { success: false, error: 'Bet not found.' };
    }
    if (bet.status !== 'open') {
      return { success: false, error: `Bet is not open (status: ${bet.status}).` };
    }
    if (Date.now() > bet.window_closes_at) {
      return { success: false, error: 'The betting window has closed.' };
    }

    if (isParticipant(db, betId, guildId, userId)) {
      return { success: false, error: 'You are already a participant in this bet.' };
    }

    // Re-read balance inside transaction
    const player = db
      .prepare<[string, string], { balance: number; status: string }>(
        'SELECT balance, status FROM players WHERE guild_id = ? AND user_id = ?'
      )
      .get(guildId, userId);

    if (!player || player.status !== 'active') {
      return { success: false, error: 'You must be registered and active to join a bet.' };
    }
    if (player.balance < wagerCents) {
      return {
        success: false,
        error: `Insufficient balance. You need ${formatCents(wagerCents)} but have ${formatCents(player.balance)}.`,
      };
    }

    // Transfer: joiner wallet → bank (fee) + pool
    const xfer = transfer(db, {
      guildId,
      fromWallet: { userId, amount: wagerCents },
      toBank: fee,
    });

    if (!xfer.success) {
      return { success: false, error: xfer.error };
    }

    db.prepare<[string, string, string, string, number, number]>(
      `INSERT INTO bet_participants (bet_id, guild_id, user_id, side, stake, fee_paid)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(betId, guildId, userId, side, netStake, fee);

    const poolTotals = getPoolTotals(db, betId, guildId);
    return { success: true, fee, netStake, poolTotals };
  });

  return txn.immediate();
}

export function getPoolTotals(
  db: Database.Database,
  betId: string,
  guildId: string
): PoolTotals {
  const row = db
    .prepare<[string, string], PoolTotals>(
      `SELECT
         SUM(CASE WHEN side='A' THEN stake ELSE 0 END) as poolA,
         SUM(CASE WHEN side='B' THEN stake ELSE 0 END) as poolB,
         COUNT(*) as participantCount
       FROM bet_participants WHERE bet_id=? AND guild_id=?`
    )
    .get(betId, guildId);

  return {
    poolA: row?.poolA ?? 0,
    poolB: row?.poolB ?? 0,
    participantCount: row?.participantCount ?? 0,
  };
}

export interface DeclineBetResult {
  success: boolean;
  error?: string;
}

/** Declining a direct invite refunds both stake and fee: the bet never became bilateral. */
export function declineBet(
  db: Database.Database,
  guildId: string,
  betId: string,
  callerId: string
): DeclineBetResult {
  const txn = db.transaction((): DeclineBetResult => {
    const bet = getBet(db, guildId, betId);

    if (!bet) return { success: false, error: 'Bet not found.' };
    if (bet.status !== 'open') return { success: false, error: 'Bet is not open.' };
    if (bet.direct_opponent_id !== callerId) {
      return { success: false, error: 'You are not the invited opponent for this bet.' };
    }

    if (isParticipant(db, betId, guildId, callerId)) {
      return { success: false, error: 'You have already joined this bet. Use /resolve instead.' };
    }

    const participants = getParticipants(db, betId, guildId);

    db.prepare<[number, string, string]>(
      "UPDATE bets SET status='cancelled', resolved_at=? WHERE bet_id=? AND guild_id=?"
    ).run(Date.now(), betId, guildId);

    for (const p of participants) {
      const refund = p.stake + p.fee_paid;
      const xfer = transfer(db, {
        guildId,
        fromBank: p.fee_paid,
        toWallet: { userId: p.user_id, amount: refund },
      });
      if (!xfer.success) {
        logger.error({ betId, userId: p.user_id }, 'Failed to refund on decline');
      }
    }

    return { success: true };
  });

  return txn.immediate();
}

export interface CancelBetResult {
  success: boolean;
  error?: string;
  refunds?: Array<{ userId: string; amount: number }>;
}

/** Admin cancellation returns stakes but retains fees in the bank. */
export function adminCancelBet(
  db: Database.Database,
  guildId: string,
  betId: string
): CancelBetResult {
  const txn = db.transaction((): CancelBetResult => {
    const bet = getBet(db, guildId, betId);

    if (!bet) return { success: false, error: 'Bet not found.' };
    if (!['open', 'locked', 'proposed', 'disputed'].includes(bet.status)) {
      return { success: false, error: `Cannot cancel a bet with status '${bet.status}'.` };
    }

    const participants = getParticipants(db, betId, guildId);

    db.prepare<[number, string, string]>(
      "UPDATE bets SET status='cancelled', resolved_at=? WHERE bet_id=? AND guild_id=?"
    ).run(Date.now(), betId, guildId);

    const refunds: Array<{ userId: string; amount: number }> = [];

    for (const p of participants) {
      const xfer = transfer(db, {
        guildId,
        toWallet: { userId: p.user_id, amount: p.stake },
      });
      if (xfer.success) {
        refunds.push({ userId: p.user_id, amount: p.stake });
      } else {
        logger.error({ betId, userId: p.user_id }, 'Failed to refund stake on admin cancel');
      }
    }

    return { success: true, refunds };
  });

  return txn.immediate();
}

export interface SettleResult {
  success: boolean;
  error?: string;
  payouts?: Array<{ userId: string; payout: number }>;
}

/**
 * Winners recover their stake plus floor(stake / winner_pool * loser_pool).
 * The largest stake gets the rounding remainder. "Neither" returns stakes only.
 */
export function settleBet(
  db: Database.Database,
  guildId: string,
  betId: string,
  outcome: 'A' | 'B' | 'neither',
  resolverId: string
): SettleResult {
  const txn = db.transaction((): SettleResult => {
    // Atomic status check + update — prevents double-settle
    const updateResult = db
      .prepare<[string, string, number, string, string]>(
        `UPDATE bets SET status='resolved', resolved_outcome=?, resolver_id=?, resolved_at=?
         WHERE bet_id=? AND guild_id=? AND status IN ('proposed','open','locked','disputed')`
      )
      .run(outcome, resolverId, Date.now(), betId, guildId);

    if (updateResult.changes === 0) {
      return { success: false, error: 'Bet has already been resolved or cannot be settled.' };
    }

    const participants = getParticipants(db, betId, guildId);

    const payouts: Array<{ userId: string; payout: number }> = [];

    const recordPayout = db.prepare<[number, string, string, string]>(
      `UPDATE bet_participants SET payout_received=?
       WHERE bet_id=? AND guild_id=? AND user_id=?`
    );

    const pay = (participant: ParticipantRow, payout: number, error?: string): void => {
      const userId = participant.user_id;
      const result = transfer(db, { guildId, toWallet: { userId, amount: payout } });
      if (result.success) {
        payouts.push({ userId, payout });
        recordPayout.run(payout, betId, guildId, userId);
      } else if (error) {
        logger.error({ betId, userId }, error);
      }
    };

    const winners = participants.filter((p) => p.side === outcome);
    if (outcome === 'neither' || winners.length === 0) {
      // With no winning side, return stakes in participant order; retain fees.
      for (const participant of participants) {
        pay(participant, participant.stake, outcome === 'neither' ? 'Failed to return stake on neither' : undefined);
      }
      return { success: true, payouts };
    }

    const losers = participants.filter((p) => p.side !== outcome);
    const totalWinnerStake = winners.reduce((sum, p) => sum + p.stake, 0);
    const totalLoserPool = losers.reduce((sum, p) => sum + p.stake, 0);
    const sortedWinners = [...winners].sort((a, b) => b.stake - a.stake);
    let distributed = 0;
    const winnerPayouts = sortedWinners.map((participant) => {
      const share = totalWinnerStake > 0
        ? Math.floor((participant.stake / totalWinnerStake) * totalLoserPool)
        : 0;
      distributed += share;
      return { participant, share };
    });

    // Give rounding remainder to the largest stake; ties retain participant order.
    const remainder = totalLoserPool - distributed;
    if (winnerPayouts[0] && remainder > 0) winnerPayouts[0].share += remainder;
    for (const { participant, share } of winnerPayouts) {
      pay(participant, participant.stake + share, 'Failed payout on settlement');
    }
    // Explicit zero payouts let stats distinguish settled losses from pending bets.
    for (const loser of losers) {
      recordPayout.run(0, betId, guildId, loser.user_id);
    }

    return { success: true, payouts };
  });

  return txn.immediate();
}

export function getBet(
  db: Database.Database,
  guildId: string,
  betId: string
): BetRow | null {
  return (
    db
      .prepare<[string, string], BetRow>(
        'SELECT * FROM bets WHERE bet_id=? AND guild_id=?'
      )
      .get(betId, guildId) ?? null
  );
}

export function getParticipants(
  db: Database.Database,
  betId: string,
  guildId: string
): ParticipantRow[] {
  return db
    .prepare<[string, string], ParticipantRow>(
      'SELECT * FROM bet_participants WHERE bet_id=? AND guild_id=?'
    )
    .all(betId, guildId);
}

export function isParticipant(
  db: Database.Database,
  betId: string,
  guildId: string,
  userId: string
): boolean {
  const row = db
    .prepare<[string, string, string], { id: number }>(
      'SELECT id FROM bet_participants WHERE bet_id=? AND guild_id=? AND user_id=?'
    )
    .get(betId, guildId, userId);
  return row != null;
}

/** Open a resolution proposal with the proposer's confirmation already recorded. */
export function proposeResolution(
  db: Database.Database,
  guildId: string,
  betId: string,
  proposerId: string,
  outcome: 'A' | 'B' | 'neither'
): { success: boolean; error?: string } {
  const txn = db.transaction(() => {
    const bet = getBet(db, guildId, betId);

    if (!bet) return { success: false, error: 'Bet not found.' };
    if (!['open', 'locked'].includes(bet.status)) {
      return { success: false, error: `Bet cannot be proposed (status: ${bet.status}).` };
    }
    if (!isParticipant(db, betId, guildId, proposerId)) {
      return { success: false, error: 'You must be a participant to propose a resolution.' };
    }

    db.prepare<[string, string, string, string]>(
      `UPDATE bets SET status='proposed', proposed_outcome=?, proposer_id=?
       WHERE bet_id=? AND guild_id=?`
    ).run(outcome, proposerId, betId, guildId);

    // Auto-confirm for proposer
    db.prepare<[string, string, string]>(
      `INSERT OR REPLACE INTO resolution_responses (bet_id, guild_id, user_id, response)
       VALUES (?, ?, ?, 'confirm')`
    ).run(betId, guildId, proposerId);

    return { success: true };
  });

  return txn.immediate();
}

/** Record a response, then check for disputes or unanimous confirmation. */
export function recordResolutionResponse(
  db: Database.Database,
  guildId: string,
  betId: string,
  userId: string,
  response: 'confirm' | 'dispute'
): {
  success: boolean;
  error?: string;
  allConfirmed?: boolean;
  hasDispute?: boolean;
} {
  const txn = db.transaction(() => {
    db.prepare<[string, string, string, string]>(
      `INSERT OR REPLACE INTO resolution_responses (bet_id, guild_id, user_id, response)
       VALUES (?, ?, ?, ?)`
    ).run(betId, guildId, userId, response);

    const disputeCount = db
      .prepare<[string, string], { count: number }>(
        `SELECT COUNT(*) as count FROM resolution_responses
         WHERE bet_id=? AND guild_id=? AND response='dispute'`
      )
      .get(betId, guildId);

    if (disputeCount && disputeCount.count > 0) {
      db.prepare<[string, string]>(
        "UPDATE bets SET status='disputed' WHERE bet_id=? AND guild_id=?"
      ).run(betId, guildId);
      return { success: true, hasDispute: true, allConfirmed: false };
    }

    const participantCount = db
      .prepare<[string, string], { count: number }>(
        'SELECT COUNT(*) as count FROM bet_participants WHERE bet_id=? AND guild_id=?'
      )
      .get(betId, guildId);

    const confirmCount = db
      .prepare<[string, string], { count: number }>(
        `SELECT COUNT(*) as count FROM resolution_responses
         WHERE bet_id=? AND guild_id=? AND response='confirm'`
      )
      .get(betId, guildId);

    const allConfirmed =
      (participantCount?.count ?? 0) > 0 &&
      confirmCount?.count === participantCount?.count;

    return { success: true, allConfirmed, hasDispute: false };
  });

  return txn.immediate();
}
