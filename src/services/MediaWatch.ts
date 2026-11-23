import { Events, type Client, type Message } from 'discord.js';

/** The raw message fields a media check reads, from a Gateway packet or a fetched message. */
export type MediaMessage = { id?: unknown; channel_id?: unknown; author?: { id?: unknown }; components?: unknown };

/**
 * Discord fills an external gallery item's proxy address, type and size only after fetching it.
 * Subscribe before publishing, using the bot's existing connection; only the returned message ID can pass.
 * `refetch` reads the published message again when no matching update arrived in time.
 */
export function watchMessageMedia(client: Client, channelId: string, matches: (value: MediaMessage) => boolean,
  { timeoutMs = 6000 }: { timeoutMs?: number } = {}) {
  const ready = new Set<string>();
  let closed = false;
  let target: string | undefined, resolve: ((value: boolean) => void) | undefined;
  const listener = (packet: { t?: string; d?: MediaMessage }) => {
    const value = packet.d;
    if (!['MESSAGE_CREATE', 'MESSAGE_UPDATE'].includes(packet.t ?? '') || !value ||
      value.channel_id !== channelId || typeof value.id !== 'string' ||
      value.author?.id && value.author.id !== client.user?.id || !matches(value)) return;
    ready.add(value.id);
    if (ready.size > 16) ready.delete(ready.values().next().value!);
    if (target === value.id) resolve?.(true);
  };
  client.on(Events.Raw, listener);
  const identity = (message: Message) => message.channelId === channelId && message.author.id === client.user?.id;
  const inspect = (message: Message) => !closed && message.id === target && identity(message) &&
    matches({ components: message.components.map(component => component.toJSON()) });
  return {
    async verify(message: Message, refetch: () => Promise<Message> = () => message.fetch(true)): Promise<boolean> {
      if (closed || !identity(message)) return false;
      target = message.id;
      if (ready.has(target) || inspect(message)) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const observed = await new Promise<boolean>(done => {
          resolve = done; timer = setTimeout(() => done(false), timeoutMs);
          if (ready.has(message.id)) done(true);
        });
        if (closed) return false;
        if (observed) return true;
        try { return inspect(await refetch()); } catch { return false; }
      } finally { clearTimeout(timer); resolve = undefined; }
    },
    close() { closed = true; client.off(Events.Raw, listener); resolve?.(false); resolve = undefined; ready.clear(); },
  };
}

/** Gallery items anywhere in a message's top-level components or one container deep. */
export function galleryItems(components: unknown): { media?: Record<string, unknown> }[] {
  if (!Array.isArray(components)) return [];
  return components.flatMap((component: { type?: unknown; items?: unknown; components?: unknown } | null) => {
    if (!component || typeof component !== 'object') return [];
    if (component.type === 12) return Array.isArray(component.items) ? component.items : [];
    return component.type === 17 && Array.isArray(component.components)
      ? (component.components as { type?: unknown; items?: unknown }[])
        .flatMap(child => child?.type === 12 && Array.isArray(child.items) ? child.items : [])
      : [];
  });
}
