import type Database from 'better-sqlite3';
import type { Client } from 'discord.js';
import { logger } from '../logger';

/**
 * Elections move from open to closed (winner chosen) or failed (no quorum).
 * Ties are intentionally random. Leaving/unregistering revokes the current admin.
 */

export interface ElectionRow {
  id: number;
  guild_id: string;
  started_at: number;
  ends_at: number;
  status: 'open' | 'closed' | 'failed';
  result_admin_id: string | null;
}

export interface NominationRow {
  id: number;
  election_id: number;
  candidate_id: string;
  nominated_at: number;
}

export interface VoteRow {
  id: number;
  election_id: number;
  voter_id: string;
  candidate_id: string;
  voted_at: number;
}

export interface StartElectionResult {
  success: boolean;
  error?: string;
  election?: ElectionRow;
}

/** Start a one-hour election after checking player count, cooldown and active elections. */
export function startElection(
  db: Database.Database,
  guildId: string
): StartElectionResult {
  const txn = db.transaction((): StartElectionResult => {
    const playerCount = db
      .prepare<[string], { count: number }>(
        `SELECT COUNT(*) as count FROM players WHERE guild_id=? AND status='active'`
      )
      .get(guildId);

    if (!playerCount || playerCount.count < 2) {
      return { success: false, error: 'At least 2 registered players are required to start an election.' };
    }

    const openElection = db
      .prepare<[string], { id: number }>(
        `SELECT id FROM elections WHERE guild_id=? AND status='open'`
      )
      .get(guildId);

    if (openElection) {
      return { success: false, error: 'An election is already in progress.' };
    }

    const guild = db
      .prepare<[string], { last_vote_started_at: number | null; vote_cooldown_waived: number }>(
        `SELECT last_vote_started_at, vote_cooldown_waived FROM guilds WHERE guild_id=?`
      )
      .get(guildId);

    if (guild?.last_vote_started_at && !guild.vote_cooldown_waived) {
      const elapsed = Date.now() - guild.last_vote_started_at;
      const cooldown = 24 * 60 * 60 * 1000;
      if (elapsed < cooldown) {
        const remaining = Math.ceil((cooldown - elapsed) / 60000);
        return {
          success: false,
          error: `Elections are on cooldown. Try again in ${remaining} minutes.`,
        };
      }
    }

    const now = Date.now();
    const endsAt = now + 60 * 60 * 1000; // 1 hour

    db.prepare<[number, string]>(
      `UPDATE guilds SET last_vote_started_at=?, vote_cooldown_waived=0 WHERE guild_id=?`
    ).run(now, guildId);

    db.prepare<[string, number, number]>(
      `INSERT INTO elections (guild_id, started_at, ends_at) VALUES (?, ?, ?)`
    ).run(guildId, now, endsAt);

    const election = db
      .prepare<[string], ElectionRow>(
        `SELECT * FROM elections WHERE guild_id=? ORDER BY id DESC LIMIT 1`
      )
      .get(guildId);

    return { success: true, election: election ?? undefined };
  });

  return txn.immediate();
}

export interface NominateResult {
  success: boolean;
  error?: string;
  election?: ElectionRow;
}

export function nominateCandidate(
  db: Database.Database,
  guildId: string,
  candidateId: string
): NominateResult {
  const election = getOpenElection(db, guildId);
  if (!election) {
    return { success: false, error: 'No election is currently in progress.' };
  }
  if (Date.now() > election.ends_at) {
    return { success: false, error: 'The election window has closed.' };
  }

  try {
    db.prepare<[number, string]>(
      `INSERT INTO nominations (election_id, candidate_id) VALUES (?, ?)`
    ).run(election.id, candidateId);
    return { success: true, election };
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      return { success: false, error: 'You are already nominated.' };
    }
    throw err;
  }
}

export interface VoteResult {
  success: boolean;
  error?: string;
}

export function castVote(
  db: Database.Database,
  guildId: string,
  voterId: string,
  candidateId: string
): VoteResult {
  const election = getOpenElection(db, guildId);
  if (!election) {
    return { success: false, error: 'No election is currently in progress.' };
  }
  if (Date.now() > election.ends_at) {
    return { success: false, error: 'The election window has closed.' };
  }

  const nomination = db
    .prepare<[number, string], { id: number }>(
      `SELECT id FROM nominations WHERE election_id=? AND candidate_id=?`
    )
    .get(election.id, candidateId);

  if (!nomination) {
    return { success: false, error: 'That player is not nominated in this election.' };
  }

  try {
    db.prepare<[number, string, string]>(
      `INSERT INTO votes (election_id, voter_id, candidate_id) VALUES (?, ?, ?)`
    ).run(election.id, voterId, candidateId);
    return { success: true };
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      return { success: false, error: 'You have already voted in this election.' };
    }
    throw err;
  }
}

export interface ElectionStatus {
  election: ElectionRow | null;
  registeredCount: number;
  quorumThreshold: number;
  voteCount: number;
  nomineeCount: number;
  tallies: Array<{ candidateId: string; count: number }>;
}

export function getElectionStatus(db: Database.Database, guildId: string): ElectionStatus {
  const election = getOpenElection(db, guildId);

  const registeredCount = (db
    .prepare<[string], { count: number }>(
      `SELECT COUNT(*) as count FROM players WHERE guild_id=? AND status='active'`
    )
    .get(guildId)?.count) ?? 0;

  const quorumThreshold = Math.ceil(registeredCount / 2);

  if (!election) {
    return { election: null, registeredCount, quorumThreshold, voteCount: 0, nomineeCount: 0, tallies: [] };
  }

  const voteCount = (db
    .prepare<[number], { count: number }>(
      `SELECT COUNT(*) as count FROM votes WHERE election_id=?`
    )
    .get(election.id)?.count) ?? 0;

  const nomineeCount = (db
    .prepare<[number], { count: number }>(
      `SELECT COUNT(*) as count FROM nominations WHERE election_id=?`
    )
    .get(election.id)?.count) ?? 0;

  const tallies = db
    .prepare<[number], { candidate_id: string; count: number }>(
      `SELECT candidate_id, COUNT(*) as count FROM votes WHERE election_id=? GROUP BY candidate_id ORDER BY count DESC`
    )
    .all(election.id)
    .map((r) => ({ candidateId: r.candidate_id, count: r.count }));

  return { election, registeredCount, quorumThreshold, voteCount, nomineeCount, tallies };
}

export interface FinalizeResult {
  success: boolean;
  status: 'closed' | 'failed';
  winnerId?: string;
  reason?: string;
}

/** Finalize an election from its timer or when restoring timers after restart. */
export async function finalizeElection(
  db: Database.Database,
  client: Client,
  guildId: string,
  electionId: number
): Promise<FinalizeResult> {
  const txn = db.transaction((): FinalizeResult => {
    const election = db
      .prepare<[number], ElectionRow>(`SELECT * FROM elections WHERE id=?`)
      .get(electionId);

    if (!election || election.status !== 'open') {
      return { success: true, status: 'failed', reason: 'Election not found or already finalized.' };
    }

    const registeredCount = (db
      .prepare<[string], { count: number }>(
        `SELECT COUNT(*) as count FROM players WHERE guild_id=? AND status='active'`
      )
      .get(guildId)?.count) ?? 0;

    const voteCount = (db
      .prepare<[number], { count: number }>(
        `SELECT COUNT(*) as count FROM votes WHERE election_id=?`
      )
      .get(electionId)?.count) ?? 0;

    const quorum = Math.ceil(registeredCount / 2);

    if (voteCount < quorum) {
      db.prepare<[number]>(
        `UPDATE elections SET status='failed' WHERE id=?`
      ).run(electionId);
      return { success: true, status: 'failed', reason: `Quorum not met (${voteCount}/${quorum} votes).` };
    }

    const tallies = db
      .prepare<[number], { candidate_id: string; tally: number }>(
        `SELECT candidate_id, COUNT(*) as tally FROM votes WHERE election_id=? GROUP BY candidate_id ORDER BY tally DESC`
      )
      .all(electionId);

    if (tallies.length === 0) {
      db.prepare<[number]>(
        `UPDATE elections SET status='failed' WHERE id=?`
      ).run(electionId);
      return { success: true, status: 'failed', reason: 'No votes cast.' };
    }

    const maxTally = tallies[0]!.tally;
    const topCandidates = tallies.filter((t) => t.tally === maxTally);

    const winner = topCandidates[Math.floor(Math.random() * topCandidates.length)]!;

    db.prepare<[string, number]>(
      `UPDATE elections SET status='closed', result_admin_id=? WHERE id=?`
    ).run(winner.candidate_id, electionId);

    db.prepare<[string, string]>(
      `UPDATE guilds SET current_admin_id=? WHERE guild_id=?`
    ).run(winner.candidate_id, guildId);

    return { success: true, status: 'closed', winnerId: winner.candidate_id };
  });

  const result = txn.immediate();

  // Validate winner is still in guild (check after transaction)
  if (result.status === 'closed' && result.winnerId) {
    try {
      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        await guild.members.fetch(result.winnerId);
      }
    } catch {
      // An unverifiable winner invalidates the result.
      logger.warn({ guildId, winnerId: result.winnerId }, 'Election winner is no longer in guild; revoking');
      db.prepare<[string]>(
        `UPDATE guilds SET current_admin_id=NULL WHERE guild_id=?`
      ).run(guildId);
      db.prepare<[number]>(
        `UPDATE elections SET status='failed' WHERE id=?`
      ).run(electionId);
      return { success: true, status: 'failed', reason: 'Winner left the server before swearing in.' };
    }
  }

  return result;
}

export function getOpenElection(db: Database.Database, guildId: string): ElectionRow | null {
  return (
    db
      .prepare<[string], ElectionRow>(
        `SELECT * FROM elections WHERE guild_id=? AND status='open' ORDER BY id DESC LIMIT 1`
      )
      .get(guildId) ?? null
  );
}

/** Revoke an admin who left/unregistered and allow a replacement election immediately. */
export function revokeAdmin(
  db: Database.Database,
  guildId: string,
  userId: string
): void {
  const guild = db
    .prepare<[string], { current_admin_id: string | null }>(
      `SELECT current_admin_id FROM guilds WHERE guild_id=?`
    )
    .get(guildId);

  if (guild?.current_admin_id === userId) {
    db.prepare<[string]>(
      `UPDATE guilds SET current_admin_id=NULL, vote_cooldown_waived=1 WHERE guild_id=?`
    ).run(guildId);
    logger.info({ guildId, userId }, 'Admin revoked; vote cooldown waived');
  }
}

export function scheduleElectionFinalization(
  db: Database.Database,
  client: Client,
  guildId: string,
  election: ElectionRow
): ReturnType<typeof setTimeout> {
  const delay = Math.max(0, election.ends_at - Date.now());
  return setTimeout(async () => {
    const result = await finalizeElection(db, client, guildId, election.id);
    logger.info({ guildId, electionId: election.id, result }, 'Election finalized');
  }, delay);
}
