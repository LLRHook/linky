import { ComponentType, type APIMessageTopLevelComponent } from 'discord.js';

/** A standalone prepared media file and its accompanying text, in one panel. */
export function uploadedMediaComponents(name: string | null, content: string,
  controls: APIMessageTopLevelComponent[] = []): APIMessageTopLevelComponent[] | null {
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}\.(?:mp4|jpg|png)$/.test(name) || content.length > 4000) return null;
  return [{ type: ComponentType.Container, components: [
    { type: ComponentType.TextDisplay, content },
    { type: ComponentType.MediaGallery, items: [{ media: { url: `attachment://${name}` } }] },
  ] }, ...controls];
}

/** Match an uploaded file inside a panel, never a bare gallery, arbitrary host or unrelated attachment. */
export function messageHasUploadedMedia(components: readonly { toJSON(): unknown }[], name: string | null,
  accept: (media: Record<string, unknown>) => boolean = () => true): boolean {
  if (!name) return false;
  const shown = (url: unknown) => {
    if (url === `attachment://${name}`) return true;
    try {
      const address = new URL(String(url));
      return address.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(address.hostname) && !address.port &&
        !address.username && !address.password &&
        /^\/attachments\/\d{17,20}\/\d{17,20}\/[^/]+$/.test(address.pathname) && address.pathname.endsWith(`/${name}`);
    } catch { return false; }
  };
  const galleries = (value: unknown, depth = 0): boolean => {
    const item = value as { type?: unknown; items?: { media?: Record<string, unknown> }[]; components?: unknown[] } | null;
    if (!item || typeof item !== 'object' || depth > 3) return false;
    if (item.type === ComponentType.MediaGallery) return Array.isArray(item.items) &&
      item.items.some(entry => entry?.media && shown(entry.media.url) && accept(entry.media));
    return Array.isArray(item.components) && item.components.some(child => galleries(child, depth + 1));
  };
  return components.some(component => {
    const value = component.toJSON() as { type?: unknown };
    return value?.type === ComponentType.Container && galleries(value);
  });
}
