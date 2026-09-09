import type Database from 'better-sqlite3';
import { transfer } from './BalanceService';

export interface Player {
  guild_id: string;
  user_id: string;
  balance: number;
  status: 'active' | 'inactive' | 'banned';
  registered_at: number;
  last_active_at: number;
  last_daily_utc_date: string | null;
  prior_balance: number | null;
}

export interface GuildRow {
  guild_id: string;
  gambler_role_id: string | null;
  audit_channel_id: string | null;
  current_admin_id: string | null;
  last_vote_started_at: number | null;
  vote_cooldown_waived: number;
  created_at: number;
}

/** Create missing guild and bank rows without resetting existing data. */
export function ensureGuild(db: Database.Database, guildId: string): void {
  db.prepare<[string]>(
    `INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)`
  ).run(guildId);

  db.prepare<[string]>(
    `INSERT OR IGNORE INTO bank (guild_id, balance) VALUES (?, 0)`
  ).run(guildId);
}

export function getPlayer(
  db: Database.Database,
  guildId: string,
  userId: string
): Player | null {
  return (
    db
      .prepare<[string, string], Player>(
        `SELECT * FROM players WHERE guild_id = ? AND user_id = ?`
      )
      .get(guildId, userId) ?? null
  );
}

export function getGuild(db: Database.Database, guildId: string): GuildRow | null {
  return (
    db
      .prepare<[string], GuildRow>(`SELECT * FROM guilds WHERE guild_id = ?`)
      .get(guildId) ?? null
  );
}

export interface RegisterResult {
  success: boolean;
  error?: string;
  isReactivation: boolean;
  player?: Player;
}

/** New players receive $100; inactive players retain their existing balance. */
export function registerPlayer(
  db: Database.Database,
  guildId: string,
  userId: string
): RegisterResult {
  ensureGuild(db, guildId);

  const existing = getPlayer(db, guildId, userId);

  if (existing) {
    if (existing.status === 'active') {
      return { success: false, error: 'You are already registered.', isReactivation: false };
    }
    if (existing.status === 'banned') {
      return { success: false, error: 'You are banned from this server\'s economy.', isReactivation: false };
    }
    const now = Date.now();
    db.prepare<[number, string, string]>(
      `UPDATE players SET status='active', last_active_at=? WHERE guild_id=? AND user_id=?`
    ).run(now, guildId, userId);

    const updated = getPlayer(db, guildId, userId);
    return { success: true, isReactivation: true, player: updated ?? undefined };
  }

  const now = Date.now();
  db.prepare<[string, string, number, number]>(
    `INSERT INTO players (guild_id, user_id, balance, status, registered_at, last_active_at)
     VALUES (?, ?, 0, 'active', ?, ?)`
  ).run(guildId, userId, now, now);

  // Registration mints money without debiting the bank, as does the daily grant.
  transfer(db, {
    guildId,
    toWallet: { userId, amount: 10000 },
  });

  const player = getPlayer(db, guildId, userId);
  return { success: true, isReactivation: false, player: player ?? undefined };
}

export interface UnregisterResult {
  success: boolean;
  error?: string;
  finalBalance?: number;
}

/** Preserve the balance on unregister; unresolved bets prevent it. */
export function unregisterPlayer(
  db: Database.Database,
  guildId: string,
  userId: string
): UnregisterResult {
  const player = getPlayer(db, guildId, userId);
  if (!player || player.status !== 'active') {
    return { success: false, error: 'You must be a registered active player to unregister.' };
  }

  const activeBetCount = db
    .prepare<[string, string], { count: number }>(
      `SELECT COUNT(*) as count
       FROM bet_participants bp
       JOIN bets b ON b.bet_id = bp.bet_id AND b.guild_id = bp.guild_id
       WHERE bp.guild_id = ? AND bp.user_id = ?
         AND b.status IN ('open','locked','proposed','disputed')`
    )
    .get(guildId, userId);

  if (activeBetCount && activeBetCount.count > 0) {
    return {
      success: false,
      error: `Cannot unregister with ${activeBetCount.count} active bet(s). Settle or wait for them to resolve first.`,
    };
  }

  const now = Date.now();
  db.prepare<[number, string, string]>(
    `UPDATE players SET status='inactive', prior_balance=balance, last_active_at=?
     WHERE guild_id=? AND user_id=?`
  ).run(now, guildId, userId);

  return { success: true, finalBalance: player.balance };
}

/** Update activity after a command; no-op for an unregistered user. */
export function touchPlayer(
  db: Database.Database,
  guildId: string,
  userId: string
): void {
  db.prepare<[number, string, string]>(
    `UPDATE players SET last_active_at = ? WHERE guild_id = ? AND user_id = ?`
  ).run(Date.now(), guildId, userId);
}

export function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface DailyResult {
  success: boolean;
  error?: string;
  newBalance?: number;
}

/** Check and credit the daily $5 grant inside one immediate transaction. */
export function claimDaily(
  db: Database.Database,
  guildId: string,
  userId: string
): DailyResult {
  const today = todayUtcDate();

  const txn = db.transaction((): DailyResult => {
    const player = db
      .prepare<[string, string], Pick<Player, 'last_daily_utc_date' | 'balance' | 'status'>>(
        `SELECT last_daily_utc_date, balance, status FROM players WHERE guild_id=? AND user_id=?`
      )
      .get(guildId, userId);

    if (!player || player.status !== 'active') {
      return { success: false, error: 'You must be registered and active to claim daily.' };
    }

    if (player.last_daily_utc_date === today) {
      return { success: false, error: 'Daily already claimed today. Resets at UTC midnight.' };
    }

    db.prepare<[string, number, string, string]>(
      `UPDATE players SET last_daily_utc_date=?, last_active_at=?
       WHERE guild_id=? AND user_id=?`
    ).run(today, Date.now(), guildId, userId);

    // Daily grants mint money without debiting the bank.
    const xfer = transfer(db, {
      guildId,
      toWallet: { userId, amount: 500 },
    });

    if (!xfer.success) {
      return { success: false, error: 'Failed to credit daily bonus.' };
    }

    const updated = db
      .prepare<[string, string], { balance: number }>(
        `SELECT balance FROM players WHERE guild_id=? AND user_id=?`
      )
      .get(guildId, userId);

    return { success: true, newBalance: updated?.balance };
  });

  return txn.immediate();
}
