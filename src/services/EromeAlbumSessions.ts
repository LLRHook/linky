import { randomUUID } from 'node:crypto';
import { ButtonStyle, ComponentType, MessageFlags, type APIActionRowComponent, type APIButtonComponent,
  type APIMessageTopLevelComponent, type ButtonInteraction, type Message } from 'discord.js';
import type { DeliveryContext } from './DeliveryContext';
import { createDeliveryProgress } from './DeliveryProgress';
import { parseEromeUrl } from './EromeAlbum';
import { messageHasEromeMedia, watchEromeMedia, type EromeMedia, type EromeMediaBinding,
  type EromeMediaPreparer } from './EromeMedia';

const PREFIX = 'linky:album:';
const MAX_ITEMS = 10;
const MAX_BYTES = 192 * 1024 * 1024;
const TTL_MS = 24 * 60 * 60_000;
const MAX_SESSIONS = 512;

export interface AlbumOwner {
  requesterId: string;
  channelId: string;
  guildId: string;
  messageId: string;
  sourceMessageId?: string;
  source: string;
  mode: 'automatic' | 'manual';
}

interface Session extends AlbumOwner {
  id: string;
  expiresAt: number;
  fingerprints: string[];
  truncated: boolean;
  loaded: { fingerprint: string; url: string; size: number }[];
  controller?: AbortController;
}

export interface AlbumRegistration extends AlbumOwner { media: EromeMedia }

/** Location-bound sessions contain only the current album, never a user-supplied action URL.
 * Sessions expire on restart; published media ownership remains in the durable media store. */
export class EromeAlbumSessions {
  private sessions = new Map<string, Session>();
  constructor(private options: {
    prepare: EromeMediaPreparer;
    bind: EromeMediaBinding;
    unbind: (assetId: string, messageId: string) => Promise<void>;
    cancelReservation: (reservation: string) => Promise<void>;
    allowed: (owner: AlbumOwner, interaction: ButtonInteraction) => Promise<boolean>;
    context?: (owner: AlbumOwner) => DeliveryContext;
    details?: (traceId: string | undefined, messageId: string) => Promise<APIMessageTopLevelComponent[]>;
    verify?: (message: Message, media: EromeMedia) => Promise<boolean>;
    clock?: () => number;
  }) {}

  register({ media, ...owner }: AlbumRegistration): APIActionRowComponent<APIButtonComponent> | undefined {
    this.prune();
    const fingerprints = media.itemFingerprints;
    if (!parseEromeUrl(owner.source) || !media.itemFingerprint || !fingerprints || fingerprints.length < 2 ||
        fingerprints.length > 100 || fingerprints.some(item => !/^[a-f0-9]{64}$/.test(item)) ||
        new Set(fingerprints).size !== fingerprints.length || !fingerprints.includes(media.itemFingerprint) ||
        !Number.isSafeInteger(media.size) || media.size <= 0 || media.size > MAX_BYTES) return;
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].find(session => !session.controller);
      if (!oldest) return;
      this.sessions.delete(oldest.id);
    }
    this.remove(owner.messageId);
    const session: Session = { ...owner, id: randomUUID(), fingerprints: [...fingerprints],
      truncated: Boolean(media.truncated),
      loaded: [{ fingerprint: media.itemFingerprint, url: media.url, size: media.size }],
      expiresAt: this.now() + TTL_MS };
    this.sessions.set(session.id, session);
    return this.control(session);
  }

  remove(messageId: string): void {
    for (const session of this.sessions.values()) if (session.messageId === messageId) {
      session.controller?.abort();
      this.sessions.delete(session.id);
    }
  }

  close(): void {
    for (const session of this.sessions.values()) session.controller?.abort();
    this.sessions.clear();
  }

  async handle(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith(PREFIX)) return false;
    this.prune();
    const session = this.sessions.get(interaction.customId.slice(PREFIX.length));
    const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] } });
    if (!session || interaction.message.author.id !== interaction.client.user.id ||
        interaction.message.id !== session.messageId || interaction.channelId !== session.channelId ||
        interaction.guildId !== session.guildId) {
      await reply('This album control has expired. Use Fix with Linky on the original album to start again.');
      return true;
    }
    if (interaction.user.id !== session.requesterId) {
      await reply('Only the person who requested this preview can load more of its album.');
      return true;
    }
    if (session.controller) {
      await reply('Another item is already being prepared for this album.');
      return true;
    }
    const fingerprint = session.fingerprints.find(item => !session.loaded.some(loaded => loaded.fingerprint === item));
    if (!fingerprint || !this.control(session)) {
      await reply('This preview has reached its album limit. The Original post button opens the complete album.');
      return true;
    }
    const controller = new AbortController();
    session.controller = controller;
    const timer = setTimeout(() => controller.abort(), 120_000);
    timer.unref?.();
    const progress = createDeliveryProgress(text => interaction.editReply({ content: text, allowedMentions: { parse: [] } }),
      { delayMs: 500 });
    const supplied = this.options.context?.(session);
    const context: DeliveryContext = { ...supplied, signal: supplied?.signal
      ? AbortSignal.any([supplied.signal, controller.signal]) : controller.signal,
      deadlineAt: Math.min(supplied?.deadlineAt ?? Infinity, performance.now() + 120_000),
      fairnessKey: session.guildId,
      progress: event => { progress.update(event); supplied?.progress?.(event); } };
    context.trace?.setPath('album');
    let media: EromeMedia | null = null, editAttempted = false, committed = false, bound = false, uncertain = false;
    let before: APIMessageTopLevelComponent[] | undefined;
    const valid = async () => {
      if (context.signal?.aborted || this.sessions.get(session.id) !== session) return false;
      const allowed = await this.options.allowed(session, interaction);
      return allowed && !context.signal?.aborted && this.sessions.get(session.id) === session;
    };
    const finish = async (content: string) => {
      await progress.stop();
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
    };
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!await valid()) {
        context.trace?.finish('disabled');
        await finish('This album is no longer available or allowed in this channel. The existing preview is unchanged.');
        return true;
      }
      progress.update({ stage: 'resolve', state: 'running' });
      media = await this.options.prepare(session.source, { context, selection: { fingerprint } });
      if (!media || media.itemFingerprint !== fingerprint || !Number.isSafeInteger(media.size) || media.size <= 0 ||
          session.loaded.reduce((sum, item) => sum + item.size, media.size) > MAX_BYTES || !await valid()) {
        context.trace?.finish(context.signal?.aborted ? 'timeout' : 'unavailable');
        await finish('The next item could not be prepared within this preview’s limits. Existing items are unchanged; use Original post for the complete album.');
        return true;
      }
      await progress.stop();
      const current = await interaction.message.fetch(true);
      before = current.components.map(component => component.toJSON());
      const galleries = before.filter(component => component.type === ComponentType.MediaGallery);
      if (galleries.length !== 1 || galleries[0].items.length !== session.loaded.length ||
          !session.loaded.every(item => messageHasEromeMedia(current, item.url)) || !await valid()) {
        context.trace?.finish('cancelled');
        await finish('The preview changed while this item was being prepared. Use Fix with Linky on the original album again.');
        return true;
      }
      const next: APIMessageTopLevelComponent[] = before.map(component => component.type === ComponentType.MediaGallery
        ? { ...component, items: [...component.items, { media: { url: media!.url }, description: 'Media from the linked album.' }] }
        : component);
      const watcher = this.options.verify ? undefined : watchEromeMedia(interaction.client, session.channelId, media);
      try {
        // The existing message ID is known. Reserve its durable reference before an edit can become ambiguous.
        const ownership = context.trace?.startStage('ownership', media.itemIndex);
        bound = await this.options.bind(media.id, session.messageId, media.reservation);
        ownership?.finish(bound ? 'ok' : 'failed');
        if (!bound || !await valid()) throw Error('Album ownership unavailable');
        const publish = context.trace?.startStage('publish', media.itemIndex);
        let updated: Message;
        // Edits are idempotent, but an ambiguous error is reconciled once before any cleanup.
        editAttempted = true;
        try { updated = await current.edit({ components: next, allowedMentions: { parse: [] } }); }
        catch (error) {
          uncertain = true;
          const observed = await current.fetch(true).catch(() => null);
          if (!observed || !messageHasEromeMedia(observed, media.url)) throw error;
          updated = observed;
          uncertain = false;
        }
        publish?.finish();
        if (!await valid()) throw Error('Album policy changed');
        const preview = context.trace?.startStage('preview', media.itemIndex);
        const verified = await (this.options.verify ? this.options.verify(updated, media) : watcher!.verify(updated));
        preview?.finish(verified ? 'ok' : 'unavailable');
        if (!verified || !await valid()) throw Error('Album preview unavailable');
        const loaded = [...session.loaded, { fingerprint, url: media.url, size: media.size }];
        const control = this.control({ ...session, loaded });
        const details = await this.options.details?.(context.trace?.id, session.messageId).catch(() => []) ?? [];
        const controls = next.map(component => component.type === ComponentType.TextDisplay
          ? { ...component, content: component.content.replace(/\n-# \d+ of \d+\+? items · Original media\. Album kept\.$/,
            `\n-# ${loaded.length} of ${session.fingerprints.length}${session.truncated ? '+' : ''} items · Original media. Album kept.`) }
          : component).filter(component => component.type !== ComponentType.ActionRow ||
          !component.components.some(button => 'custom_id' in button && (button.custom_id === `${PREFIX}${session.id}` ||
            details.length && button.custom_id.startsWith('linky:details:'))));
        if (!await valid()) throw Error('Album policy changed');
        try { await updated.edit({ components: [...controls, ...details, ...control ? [control] : []], allowedMentions: { parse: [] } }); }
        catch (error) { uncertain = true; throw error; }
        if (!await valid()) throw Error('Album policy changed');
        session.loaded = loaded;
        committed = true;
        context.trace?.finish('confirmed');
        await finish(`Added item ${session.loaded.length} of ${session.fingerprints.length}${session.truncated ? '+' : ''}. Discord confirmed its media preview.`);
      } finally { watcher?.close(); }
    } catch {
      context.trace?.finish(context.signal?.aborted ? 'timeout' : 'discord-failure');
      if (editAttempted && !committed && before && media) {
        try {
          await interaction.message.edit({ components: before, allowedMentions: { parse: [] } });
        } catch {
          uncertain = true;
        }
      }
      // A failed request can commit late. Keep its known message reference until removal releases it.
      if (uncertain) this.sessions.delete(session.id);
      await finish('Linky could not finish adding that item. Check the preview before retrying; the original album is still available.');
    } finally {
      clearTimeout(timer);
      await progress.stop();
      if (bound && !committed && !uncertain && media) await this.options.unbind(media.id, session.messageId).catch(() => {});
      if (media?.reservation) await this.options.cancelReservation(media.reservation).catch(() => {});
      session.controller = undefined;
    }
    return true;
  }

  private now(): number { return this.options.clock?.() ?? Date.now(); }
  private prune(): void {
    for (const session of this.sessions.values()) if (session.expiresAt <= this.now()) {
      session.controller?.abort();
      this.sessions.delete(session.id);
    }
  }
  private control(session: Session): APIActionRowComponent<APIButtonComponent> | undefined {
    if (session.loaded.length >= Math.min(MAX_ITEMS, session.fingerprints.length) ||
        session.loaded.reduce((sum, item) => sum + item.size, 0) >= MAX_BYTES) return;
    return { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Secondary,
      custom_id: `${PREFIX}${session.id}`, label: 'Load next item' }] };
  }
}
