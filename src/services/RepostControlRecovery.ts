import { ButtonBuilder, ButtonStyle, ComponentType, MessageFlags, type APIButtonComponent,
  type APIMessageTopLevelComponent, type Message } from 'discord.js';
import type { RepostRecord, SourceMessage } from './RepostRegistry';
import type { DeliveryDiagnostics } from './DeliveryDiagnostics';
import { deliveryDetailsButton } from './DeliveryDetails';
import { repostControls } from './RepostPresentation';
import { mapLinks } from './LinkTokens';
import { parseProviderUrl } from './SocialProviders';

const managed = (id: string) => id === 'linky:remove' || id === 'linky:retry' || id.startsWith('linky:details:');
const buttons = (rows: readonly APIMessageTopLevelComponent[]) => rows.flatMap(row =>
  row.type === ComponentType.ActionRow ? row.components.filter(component => component.type === ComponentType.Button) : []);

/** Repair conventional automatic previews only. Ownership locking belongs to RepostRegistry.
 * Use completed diagnostics as the publication barrier: never expose Remove during source deletion,
 * invent a Details binding, or store post text/URLs in another durable journal.
 */
export async function restoreRepostControls(observed: Message, owner: RepostRecord,
  diagnostics: DeliveryDiagnostics, fetchSource: () => Promise<SourceMessage | null>): Promise<boolean> {
  const delivery = await diagnostics.boundAutomatic({ requesterId: owner.authorId, channelId: owner.channelId,
    guildId: owner.guildId, messageId: owner.replacementId });
  if (!delivery || !['confirmed', 'partial', 'permission', 'metadata-unconfirmed', 'unavailable', 'timeout', 'busy', 'unsupported']
    .includes(delivery.outcome!)) return false;
  const retry = owner.mode === 'reply' && ['metadata-unconfirmed', 'unavailable', 'timeout', 'busy'].includes(delivery.outcome!);
  const required = [new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId('linky:remove').setLabel('Remove').toJSON(),
    ...(retry ? [new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId('linky:retry').setLabel('Retry preview').toJSON()] : []),
    deliveryDetailsButton(delivery.id).toJSON()];
  const intact = (rows: readonly APIMessageTopLevelComponent[]) => {
    const current = buttons(rows), ids = current.flatMap(button => 'custom_id' in button ? [button.custom_id] : []);
    return current.some(button => 'url' in button && button.label?.startsWith('Original post')) &&
      required.every(button => 'custom_id' in button && ids.filter(id => id === button.custom_id).length === 1) &&
      ids.filter(managed).length === required.length;
  };
  const owned = (message: Message) => message.id === owner.replacementId && message.channelId === owner.channelId &&
    message.guildId === owner.guildId && message.author.id === observed.client.user.id &&
    !message.flags.has(MessageFlags.IsComponentsV2);
  if (observed.author && observed.author.id !== observed.client.user.id) return false;
  if (!observed.partial && (!owned(observed) || intact(observed.components.map(row => row.toJSON())))) return false;
  // A stale Gateway cache is not authority for a destructive components PATCH. Preserve current
  // unrelated controls from REST, including concurrent YouTube expiry or other finalized edits.
  const current = await observed.fetch(true);
  if (!owned(current) || intact(current.components.map(row => row.toJSON()))) return false;
  const rows = current.components.map(row => row.toJSON()).flatMap<APIMessageTopLevelComponent>(row => {
    if (row.type !== ComponentType.ActionRow) return [row];
    const components = row.components.filter(component => !(component.type === ComponentType.Button &&
      'custom_id' in component && managed(component.custom_id)));
    return components.length ? [{ ...row, components }] : [];
  });
  const append = (button: APIButtonComponent) => {
    const row = rows.find(row => row.type === ComponentType.ActionRow && row.components.length < 5 &&
      row.components.every(component => component.type === ComponentType.Button));
    if (row?.type === ComponentType.ActionRow) row.components.push(button);
    else if (rows.length < 5) rows.push({ type: ComponentType.ActionRow, components: [button] });
    else return false;
    return true;
  };
  if (!buttons(rows).some(button => 'url' in button && button.label?.startsWith('Original post'))) {
    // Native provider URLs in the bot's own content identify the original post even when every
    // row was lost. Do not copy unrelated custom actions from a stale Gateway snapshot.
    const content = mapLinks(current.content, url => parseProviderUrl(url)?.sourceUrl ?? url);
    let originals = repostControls(content, { remove: false });
    if (!originals.length && owner.mode === 'reply') {
      // Failure notices have no source URL in their text. Fetch the retained source using
      // the durable record, then check its complete identity before trusting its links.
      const source = await fetchSource().catch(() => null);
      if (!source || source.id !== owner.sourceId || source.channelId !== owner.channelId ||
        source.guildId !== owner.guildId || source.author?.id !== owner.authorId || typeof source.content !== 'string') return false;
      originals = repostControls(source.content, { remove: false });
    }
    if (!originals.length) return false;
    for (const row of originals) {
      for (const button of row.toJSON().components) if (!append(button)) return false;
    }
  }
  for (const button of required) if (!append(button)) return false;
  // Component edits must never replay message content, embeds, attachments or mention recipients.
  await current.edit({ components: rows, allowedMentions: { parse: [], users: [], roles: [], repliedUser: false } });
  return true;
}
