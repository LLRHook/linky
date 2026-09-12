import { ButtonStyle, ComponentType, type APIActionRowComponent, type APIButtonComponentWithCustomId,
  type APIEmbed, type APIComponentInMessageActionRow, type APIMessageTopLevelComponent } from 'discord.js';
import { parseYouTubeUrl } from './YouTube';

export const YOUTUBE_CONTROL_PREFIX = 'linky:yt:';
type Row = APIActionRowComponent<APIComponentInMessageActionRow>;
type YouTubeRow = APIActionRowComponent<APIButtonComponentWithCustomId>;
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function parseYouTubeControl(customId: string): { action: 'stats' | 'comment'; videoId: string } | null {
  const match = /^linky:yt:(stats|comment):([\w-]{11})$/.exec(customId);
  return match ? { action: match[1] as 'stats' | 'comment', videoId: match[2] } : null;
}

/** Keep the native embed untouched; only small, readable controls carry the counts. */
export function controlsForYouTube(cards: APIEmbed[]): { controls: YouTubeRow[]; videoIds: string[] } | null {
  if (!cards.length || cards.length > 3) return null;
  const controls: YouTubeRow[] = [], videoIds: string[] = [];
  for (const [index, card] of cards.entries()) {
    const video = parseYouTubeUrl(card.url ?? '');
    if (!video || videoIds.includes(video.id)) return null;
    const counts = ['Views', 'Likes', 'Comments'].flatMap(name => {
      const raw = card.fields?.find(field => field.name === name)?.value.replace(/\*/g, '').replace(/,/g, '');
      return raw !== undefined && /^\d{1,20}$/.test(raw)
        ? [`${compact.format(BigInt(raw))} ${name.toLowerCase()}`] : [];
    });
    const buttons: APIButtonComponentWithCustomId[] = [];
    const button = (action: 'stats' | 'comment', label: string): APIButtonComponentWithCustomId => ({
      type: ComponentType.Button, style: ButtonStyle.Secondary,
      custom_id: `${YOUTUBE_CONTROL_PREFIX}${action}:${video.id}`, label,
    });
    if (counts.length) buttons.push(button('stats', `${cards.length > 1 ? `${index + 1} · ` : ''}${counts.join(' · ')}`));
    if (card.fields?.some(field => field.name === 'Top comment' && field.value.trim())) {
      buttons.push(button('comment', cards.length > 1 ? `Top comment ${index + 1}` : 'Top comment'));
    }
    if (!buttons.length || buttons.some(value => value.label!.length > 80)) return null;
    controls.push({ type: ComponentType.ActionRow, components: buttons });
    videoIds.push(video.id);
  }
  return { controls, videoIds };
}

export function removeYouTubeControls(existing: readonly APIMessageTopLevelComponent[]): APIMessageTopLevelComponent[] {
  return existing.flatMap<APIMessageTopLevelComponent>(row => {
    if (row.type !== ComponentType.ActionRow) return [row];
    const components = row.components.filter(component =>
      !('custom_id' in component && component.custom_id.startsWith(YOUTUBE_CONTROL_PREFIX)));
    return components.length ? [{ ...row, components }] : [];
  });
}

/** Reserve existing controls for their owner; YouTube uses at most three further rows. */
export function mergeYouTubeControls(existing: readonly APIMessageTopLevelComponent[], controls: Row[]): Row[] | null {
  const kept = removeYouTubeControls(existing);
  if (kept.some(row => row.type !== ComponentType.ActionRow) || kept.length + controls.length > 5) return null;
  return [...kept as Row[], ...controls];
}
