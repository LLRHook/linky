import { ButtonBuilder, ButtonStyle, ChannelType, ComponentType, MessageFlags, MessageType, PermissionFlagsBits,
  type ButtonInteraction, type Message, type ThreadChannel } from 'discord.js';
import { sanitizeReplyText } from './ReplyText';
import type { TweetTranslation } from './TweetTranslation';

export interface PublicReply {
  name: string; handle: string; profileUrl: string; url: string; text: string;
  likes: number; timestamp: number; hasMedia: boolean;
}
/** Counts describe the unfiltered provider page, even when only ten entries are retained. */
export interface ReplyPage {
  N: number; countTime: number; r: number; m: number; replies: PublicReply[]; orderLabel: string; source: string;
}
export interface ReplyCleanupTarget { guildId: string; channelId: string; threadId: string }
export const REPLY_FLAGS = MessageFlags.IsComponentsV2 | MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications;
// Reserved for Linky's copied reply pages; ordinary reposts and manual outputs never use it.
export const REPLY_PAGE_MARKER = 1795541460;
const CLEANUP_DONE_CODES = [10003, 10008, 50001, 50013, 50021, 50083, 160005];
const REMOVED = 'The replies thread for this post was removed';
const EMPTY = 'No replies Linky can show for this post';
const code = (error: unknown) => (error as { code?: number } | null)?.code;
export const repliesChannel = (type: ChannelType | undefined) => type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement;

/** Return a control only for a looked-up, single X post in an eligible server channel. */
export function xRepliesButton(tweet: TweetTranslation | undefined, type: ChannelType | undefined, enabled: boolean) {
  const statusId = tweet?.url?.match(/\/status\/(\d{1,20})$/)?.[1];
  return enabled && repliesChannel(type) && statusId && tweet?.author.handle && (tweet.replies ?? 0) > 0
    ? new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel(`Replies (${tweet.replies})`)
      .setCustomId(`linky:replies:x:${statusId}:${tweet.author.handle}`) : undefined;
}

/** Greedily pack displays, including the header in the first message's character budget. */
export function replyThreadPayloads(page: ReplyPage) {
  const replies = page.replies.slice(0, 10);
  const header = `Showing ${replies.length} of ${page.N} replies from ${page.source}, ${page.orderLabel} (${page.source} returned ${page.r}; Linky hid ${page.m}). Count as of <t:${Math.floor(page.countTime / 1000)}:f>.`;
  const groups: { type: ComponentType.TextDisplay; content: string }[][] = [];
  let components: { type: ComponentType.TextDisplay; content: string }[] = [{ type: ComponentType.TextDisplay, content: header }];
  let size = header.length, entries = 0;
  for (const reply of replies) {
    const content = `**${sanitizeReplyText(reply.name, 100, true)}** [@${reply.handle.replace(/@/g, '@\u200b')}](<${reply.profileUrl}>) · ${reply.likes} likes · <t:${reply.timestamp}:R>\n${sanitizeReplyText(reply.text, 500, true)}${reply.hasMedia ? '\n· has media' : ''}\n[Open reply](<${reply.url}>)`;
    if (size + content.length > 3800 || entries >= 10) { groups.push(components); components = []; size = 0; entries = 0; }
    components.push({ type: ComponentType.TextDisplay, content }); size += content.length; entries++;
  }
  groups.push(components);
  return groups.map(components => ({ flags: REPLY_FLAGS, components: [{ type: ComponentType.Container as const, id: REPLY_PAGE_MARKER, components }], allowedMentions: { parse: [] as never[] } }));
}

/** Own the per-message lock for creation and cleanup; Discord supplies durable thread identity. */
export class ReplyThreads {
  private flights = new Map<string, Promise<string>>();
  private removing = new Set<string>();
  private created = new Set<string>();
  private creationHistoryFull = false;
  private users = new Map<string, number>();
  private channels = new Map<string, number[]>();
  constructor(private readonly options: {
    botUserId: () => string;
    enabled: (guildId: string) => boolean;
    tracked: (message: Message) => boolean;
    lookup: (id: string) => Promise<ReplyPage | null>;
    fetchThread: (id: string) => Promise<ThreadChannel | null>;
    now?: () => number;
  }) {}

  /** A false Discord snapshot is safe only if this process never began creating the thread. */
  hasCreation(id: string): boolean { return this.creationHistoryFull || this.flights.has(id) || this.created.has(id); }
  needsCleanup(guildId: string, id: string, parent: { hasThread?: boolean } | null): boolean {
    return this.options.enabled(guildId) || !parent || Boolean(parent.hasThread) || this.hasCreation(id);
  }

  async handle(interaction: ButtonInteraction): Promise<boolean> {
    const match = /^linky:replies:x:(\d{1,20}):([A-Za-z0-9_]{1,15})$/.exec(interaction.customId);
    if (!match) return false;
    const message = interaction.message;
    const answer = async (content: string) => {
      const payload = { content, allowedMentions: { parse: [] as never[] } };
      if (interaction.deferred) await interaction.editReply(payload);
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    };
    if (!interaction.guildId || !this.options.enabled(interaction.guildId) || !repliesChannel(message.channel.type) ||
        message.author.id !== this.options.botUserId() || !this.options.tracked(message)) {
      await answer('Replies are unavailable for this post'); return true;
    }
    const member = interaction.guild?.members.me;
    const permissions = member && 'permissionsFor' in message.channel ? message.channel.permissionsFor(member) : null;
    const missing = ([['Create Public Threads', PermissionFlagsBits.CreatePublicThreads],
      ['Send Messages in Threads', PermissionFlagsBits.SendMessagesInThreads]] as const)
      .filter(([, bit]) => !permissions?.has(bit)).map(([name]) => name);
    if (missing.length) { await answer(`Missing permission: ${missing.join(', ')}`); return true; }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let flight = this.flights.get(message.id);
    if (!flight) {
      flight = this.open(message, match[1], match[2], interaction.user.id);
      this.flights.set(message.id, flight);
      void flight.finally(() => this.flights.delete(message.id)).catch(() => {});
    }
    try { await answer(await flight); }
    catch (error) {
      await answer([10003, 10008].includes(code(error) ?? 0) ? REMOVED : [160006, 160007].includes(code(error) ?? 0)
        ? "This server has reached Discord's active thread limit" : code(error) === 50013
          ? 'Discord denied permission to open the replies thread' : code(error) === 160005
            ? 'Discord cannot create a thread for this post' : 'Could not open replies. Try again later');
    }
    return true;
  }

  private async open(message: Message, id: string, handle: string, userId: string): Promise<string> {
    if (this.removing.has(message.id)) return REMOVED;
    const latest = await message.fetch();
    if (!this.options.tracked(latest)) return REMOVED;
    let thread: ThreadChannel | null = null;
    if (latest.hasThread) {
      thread = await this.options.fetchThread(message.id);
      if (!thread) return REMOVED;
      if (thread.archived || thread.locked || thread.ownerId !== this.options.botUserId() || thread.messageCount !== 0) return thread.url;
    }
    const now = (this.options.now ?? Date.now)();
    if (!thread) {
      for (const [key, until] of this.users) if (until <= now) this.users.delete(key);
      for (const [key, times] of this.channels) if (!times.some(time => time > now - 60_000)) this.channels.delete(key);
      const times = (this.channels.get(message.channelId) ?? []).filter(time => time > now - 60_000);
      if ((this.users.get(userId) ?? 0) > now || times.length >= 3 || this.users.size >= 10_000 || this.channels.size >= 10_000) return 'Try again in a minute';
      this.users.set(userId, now + 10_000); this.channels.set(message.channelId, [...times, now]);
    }
    const page = await this.options.lookup(id);
    if (!page?.replies.length) return EMPTY;
    if (this.removing.has(message.id) || !this.options.tracked(latest) || !this.options.enabled(latest.guildId!)) return REMOVED;
    if (!thread) {
      // Keep history across completed flights; cap memory by conservatively disabling skips once full.
      if (this.created.size < 10_000) this.created.add(message.id); else this.creationHistoryFull = true;
      try { thread = await latest.startThread({ name: `Replies to @${handle}`.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100), autoArchiveDuration: 1440 }); }
      catch (error) {
        if (![160004, 160005].includes(code(error) ?? 0)) throw error;
        thread = await this.options.fetchThread(message.id);
        if (!thread) return REMOVED;
        if (thread.archived || thread.locked || thread.ownerId !== this.options.botUserId() || thread.messageCount !== 0) return thread.url;
      }
    }
    for (const payload of replyThreadPayloads(page)) await thread.send(payload);
    return thread.url;
  }

  /** Delete only marked reply pages. Terminal Discord errors never block parent removal. */
  async cleanup(target: ReplyCleanupTarget): Promise<void> {
    const id = target.threadId;
    this.removing.add(id);
    const step = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
      try { return await run(); }
      catch (error) { if (!CLEANUP_DONE_CODES.includes(code(error) ?? 0)) throw error; return undefined; }
    };
    try {
      const flight = this.flights.get(id);
      await flight?.catch(() => {});
      const thread = await step(() => this.options.fetchThread(id));
      if (!thread || thread.guildId !== target.guildId || thread.parentId !== target.channelId || thread.ownerId !== this.options.botUserId()) return;
      if (thread.name === 'Replies removed' && thread.archived) return;
      if (thread.archived && !thread.locked) await step(() => thread.setArchived(false));
      let after = id;
      for (;;) {
        const messages = await step(() => thread.messages.fetch({ limit: 100, after }));
        if (!messages?.size) break;
        const own = [...messages.values()].filter(message => message.author.id === this.options.botUserId() &&
          [MessageType.Default, MessageType.Reply].includes(message.type) && message.components?.some(component => {
            const value = 'toJSON' in component ? component.toJSON() : component;
            return value.type === ComponentType.Container && value.id === REPLY_PAGE_MARKER;
          }));
        const recent = own.filter(message => message.createdTimestamp > (this.options.now ?? Date.now)() - 14 * 86400_000);
        if (recent.length >= 2 && thread.permissionsFor(this.options.botUserId())?.has(PermissionFlagsBits.ManageMessages)) {
          // A missing/forbidden/system message in the batch must not strand the other pages.
          try { await thread.bulkDelete(recent); }
          catch (error) {
            if (!CLEANUP_DONE_CODES.includes(code(error) ?? 0)) throw error;
            for (const message of recent) await step(() => message.delete());
          }
        } else for (const message of recent) await step(() => message.delete());
        for (const message of own.filter(message => !recent.includes(message))) await step(() => message.delete());
        if (messages.size < 100) break;
        // Discord returns newest first even with after; advance from the greatest snowflake.
        const next = [...messages.keys()].reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
        if (next === after) break;
        after = next;
      }
      await step(() => thread.setName('Replies removed'));
      await step(() => thread.setArchived(true));
    } finally { this.removing.delete(id); }
  }
}
