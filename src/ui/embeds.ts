import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type User,
} from 'discord.js';
import { formatCents } from '../services/BalanceService';

/**
 * Consolidated UI helpers — colors, embeds, buttons, and the leaderboard table.
 * Every user-facing response in the bot uses these helpers; no plain text.
 */

// ─── Colors ─────────────────────────────────────────────────────────────────────

export const COLORS = {
  /** Pending bets, notifications */
  GOLD: 0xffd700,
  /** Win / success */
  GREEN: 0x57f287,
  /** Loss / error */
  RED: 0xed4245,
  /** Cancelled / neither / inactive */
  GRAY: 0x95a5a6,
  /** Admin actions / elections */
  PURPLE: 0x9b59b6,
  /** Info / balance / stats */
  BLUE: 0x3498db,
} as const;

export type ColorKey = keyof typeof COLORS;

// ─── Generic embed builders ─────────────────────────────────────────────────────

export function errorEmbed(description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.RED)
    .setTitle('Error')
    .setDescription(description)
    .setTimestamp();
}

export function successEmbed(title: string, description?: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLORS.GREEN).setTitle(title).setTimestamp();
  if (description) embed.setDescription(description);
  return embed;
}

export function infoEmbed(title: string, description?: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLORS.BLUE).setTitle(title).setTimestamp();
  if (description) embed.setDescription(description);
  return embed;
}

// ─── Player-specific embeds ─────────────────────────────────────────────────────

export function balanceEmbed(user: User, balanceCents: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.BLUE)
    .setTitle(`${user.displayName}'s Balance`)
    .setThumbnail(user.displayAvatarURL())
    .addFields({ name: 'Wallet Balance', value: formatCents(balanceCents), inline: true })
    .setTimestamp();
}

export function registerEmbed(
  user: User,
  balanceCents: number,
  isReactivation: boolean
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.BLUE)
    .setTitle(isReactivation ? 'Welcome Back!' : 'Welcome to the Economy!')
    .setThumbnail(user.displayAvatarURL())
    .setDescription(
      isReactivation
        ? 'Your account has been reactivated. Your balance has been restored.'
        : 'You have been registered! You start with $100.00.'
    )
    .addFields(
      { name: 'Current Balance', value: formatCents(balanceCents), inline: true },
      { name: 'Status', value: 'Active', inline: true }
    )
    .setTimestamp();
}

export function dailyEmbed(user: User, newBalanceCents: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.GREEN)
    .setTitle('Daily Claimed!')
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'Reward', value: '+$5.00', inline: true },
      { name: 'New Balance', value: formatCents(newBalanceCents), inline: true }
    )
    .setFooter({ text: 'Resets at UTC midnight' })
    .setTimestamp();
}

export function unregisterEmbed(user: User, finalBalanceCents: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.GRAY)
    .setTitle('Unregistered')
    .setThumbnail(user.displayAvatarURL())
    .setDescription(
      'Your account has been deactivated. Re-register at any time to restore your balance.'
    )
    .addFields(
      { name: 'Final Balance (preserved)', value: formatCents(finalBalanceCents), inline: true }
    )
    .setTimestamp();
}

// ─── Help ─────────────────────────────────────────────────────────────

export function helpEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.BLUE)
    .setTitle('Wanna Bet Bot — Commands')
    .setDescription(
      'A per-server gambling economy with two-sided bet pools, escrow, and an elected admin.'
    )
    .addFields(
      {
        name: 'Economy',
        value: '`/register` `/unregister` `/balance` `/daily` `/bank` `/leaderboard` `/stats` `/history`',
      },
      {
        name: 'Betting',
        value:
          '`/wanna-bet` create a bet • `/accept` join a bet • `/decline` decline a direct invite • `/resolve` propose an outcome • `/bets active` list open bets',
      },
      {
        name: 'Elections',
        value: '`/vote-admin start` `/vote-admin nominate` `/vote-admin cast` `/vote-admin status`',
      },
      {
        name: 'Admin (elected admin only)',
        value:
          '`/admin grant` `/admin seize` `/admin resolve` `/admin cancel` `/admin ban` `/admin unban`',
      },
      {
        name: 'Server setup (Manage Guild permission)',
        value: '`/setup role` set the gambler role required for lobby bets',
      },
      {
        name: 'Quickstart',
        value:
          '1. `/register` to join and claim $100\n2. `/wanna-bet` to start your first bet\n3. Use `/help` anytime to see this list',
      }
    )
    .setFooter({ text: 'github.com/LLRHook/wanna-bet  •  MIT' })
    .setTimestamp();
}

// ─── Buttons ────────────────────────────────────────────────────────────────────

/**
 * Confirm / Dispute buttons for a bet resolution proposal.
 * The custom_id encodes the bet ID for routing inside the message component collector.
 */
export function resolutionButtons(betId: string): ActionRowBuilder<ButtonBuilder> {
  const confirmBtn = new ButtonBuilder()
    .setCustomId(`resolution:confirm:${betId}`)
    .setLabel('Confirm')
    .setStyle(ButtonStyle.Success)
    .setEmoji('✅');

  const disputeBtn = new ButtonBuilder()
    .setCustomId(`resolution:dispute:${betId}`)
    .setLabel('Dispute')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('❌');

  return new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn, disputeBtn);
}

/**
 * Previous / Next pagination buttons for paginated embeds (e.g. /history).
 */
export function paginationButtons(
  page: number,
  totalPages: number,
  prefix: string
): ActionRowBuilder<ButtonBuilder> {
  const prevBtn = new ButtonBuilder()
    .setCustomId(`${prefix}:prev:${page}`)
    .setLabel('◀ Previous')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page === 0);

  const nextBtn = new ButtonBuilder()
    .setCustomId(`${prefix}:next:${page}`)
    .setLabel('Next ▶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page >= totalPages - 1);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn);
}

// ─── Leaderboard table ──────────────────────────────────────────────────────────

export interface LeaderboardRow {
  rank: number;
  username: string;
  balanceCents: number;
  wins: number;
  losses: number;
}

const COL_RANK = 3;
const COL_PLAYER = 20;
const COL_BALANCE = 10;
const COL_WL = 8;

function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return str + ' '.repeat(width - str.length);
}

function padLeft(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return ' '.repeat(width - str.length) + str;
}

/**
 * Builds a box-drawing leaderboard table wrapped in a Discord code block.
 */
export function buildLeaderboardTable(rows: LeaderboardRow[]): string {
  const top    = `╔${'═'.repeat(COL_RANK + 2)}╦${'═'.repeat(COL_PLAYER + 2)}╦${'═'.repeat(COL_BALANCE + 2)}╦${'═'.repeat(COL_WL + 2)}╗`;
  const header = `║ ${pad('#', COL_RANK)} ║ ${pad('Player', COL_PLAYER)} ║ ${padLeft('Balance', COL_BALANCE)} ║ ${padLeft('W/L', COL_WL)} ║`;
  const divider= `╠${'═'.repeat(COL_RANK + 2)}╬${'═'.repeat(COL_PLAYER + 2)}╬${'═'.repeat(COL_BALANCE + 2)}╬${'═'.repeat(COL_WL + 2)}╣`;
  const bottom = `╚${'═'.repeat(COL_RANK + 2)}╩${'═'.repeat(COL_PLAYER + 2)}╩${'═'.repeat(COL_BALANCE + 2)}╩${'═'.repeat(COL_WL + 2)}╝`;

  const dataRows = rows.map((r) => {
    const rankStr = String(r.rank);
    const nameStr = r.username;
    const balStr = formatCents(r.balanceCents);
    const wlStr = `${r.wins}/${r.losses}`;
    return `║ ${pad(rankStr, COL_RANK)} ║ ${pad(nameStr, COL_PLAYER)} ║ ${padLeft(balStr, COL_BALANCE)} ║ ${padLeft(wlStr, COL_WL)} ║`;
  });

  const tableLines = [top, header, divider, ...dataRows, bottom];
  return '```\n' + tableLines.join('\n') + '\n```';
}
