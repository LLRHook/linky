import type Database from 'better-sqlite3';

/**
 * Only this service may UPDATE players.balance or bank.balance.
 * Amounts are integer cents; transfers use BEGIN IMMEDIATE to prevent balance races.
 */

export interface TransferParams {
  guildId: string;
  /** Debit this amount from a player's wallet (cents). */
  fromWallet?: { userId: string; amount: number };
  /** Credit this amount to a player's wallet (cents). */
  toWallet?: { userId: string; amount: number };
  /** Debit from the bank (cents). Bank balance must be >= amount. */
  fromBank?: number;
  /** Credit to the bank (cents). */
  toBank?: number;
  /** Optional bet ID for audit context (not used in DB mutation). */
  betId?: string;
}

export interface TransferResult {
  success: boolean;
  error?: string;
  /** New balance of the fromWallet player after transfer (cents). */
  fromWalletBalance?: number;
  /** New balance of the toWallet player after transfer (cents). */
  toWalletBalance?: number;
  /** New bank balance after transfer (cents). */
  bankBalance?: number;
}

/**
 * Debit/credit any combination of wallets and bank atomically.
 * Insufficient funds return { success: false, error } before any mutation.
 */
export function transfer(db: Database.Database, params: TransferParams): TransferResult {
  const { guildId, fromWallet, toWallet, fromBank, toBank } = params;

  const txn = db.transaction((): TransferResult => {
    if (fromWallet) {
      const row = db
        .prepare<[string, string], { balance: number }>(
          'SELECT balance FROM players WHERE guild_id = ? AND user_id = ?'
        )
        .get(guildId, fromWallet.userId);

      if (!row) {
        return { success: false, error: `Player ${fromWallet.userId} not found.` };
      }
      if (row.balance < fromWallet.amount) {
        return {
          success: false,
          error: `Insufficient balance. Have ${row.balance} cents, need ${fromWallet.amount} cents.`,
        };
      }
    }

    if (fromBank !== undefined && fromBank > 0) {
      const bankRow = db
        .prepare<[string], { balance: number }>('SELECT balance FROM bank WHERE guild_id = ?')
        .get(guildId);

      if (!bankRow) {
        return { success: false, error: `Bank not initialized for guild ${guildId}.` };
      }
      if (bankRow.balance < fromBank) {
        return {
          success: false,
          error: `Insufficient bank balance. Have ${bankRow.balance} cents, need ${fromBank} cents.`,
        };
      }
    }

    let fromWalletBalance: number | undefined;
    let toWalletBalance: number | undefined;
    let bankBalance: number | undefined;

    if (fromWallet) {
      db.prepare<[number, string, string]>(
        'UPDATE players SET balance = balance - ? WHERE guild_id = ? AND user_id = ?'
      ).run(fromWallet.amount, guildId, fromWallet.userId);

      const updated = db
        .prepare<[string, string], { balance: number }>(
          'SELECT balance FROM players WHERE guild_id = ? AND user_id = ?'
        )
        .get(guildId, fromWallet.userId);
      fromWalletBalance = updated?.balance;
    }

    if (toWallet) {
      db.prepare<[number, string, string]>(
        'UPDATE players SET balance = balance + ? WHERE guild_id = ? AND user_id = ?'
      ).run(toWallet.amount, guildId, toWallet.userId);

      const updated = db
        .prepare<[string, string], { balance: number }>(
          'SELECT balance FROM players WHERE guild_id = ? AND user_id = ?'
        )
        .get(guildId, toWallet.userId);
      toWalletBalance = updated?.balance;
    }

    const netBankDelta = (toBank ?? 0) - (fromBank ?? 0);
    if (netBankDelta !== 0) {
      db.prepare<[number, string]>(
        'UPDATE bank SET balance = balance + ? WHERE guild_id = ?'
      ).run(netBankDelta, guildId);

      const bankRow = db
        .prepare<[string], { balance: number }>('SELECT balance FROM bank WHERE guild_id = ?')
        .get(guildId);
      bankBalance = bankRow?.balance;
    }

    return {
      success: true,
      fromWalletBalance,
      toWalletBalance,
      bankBalance,
    };
  });

  return txn.immediate();
}

/** Fee in cents: 1% of the wager, with a $1 minimum. */
export function computeFee(wagerCents: number): number {
  return Math.max(100, Math.floor(wagerCents * 0.01));
}

/** Round user-provided dollars to integer cents. */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
