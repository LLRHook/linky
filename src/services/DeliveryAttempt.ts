import { ActionRowBuilder, type ButtonBuilder } from 'discord.js';
import type { DeliveryContext, DeliveryOutcome } from './DeliveryContext';
import type { DeliveryDiagnostics, DeliveryRequest } from './DeliveryDiagnostics';
import { deliveryDetailsButton } from './DeliveryDetails';
import { mapLinks, visibleLink } from './LinkTokens';
import { parseSocialUrl } from './SocialProviders';
import { parseYouTubeUrl } from './YouTube';
import { parseYouTubeCommunityUrl } from './YouTubeCommunity';
import { parseEromeUrl } from './EromeAlbum';

export function deliveryPlatform(content: string): DeliveryRequest['platform'] {
  const platforms = new Set<DeliveryRequest['platform']>();
  mapLinks(content, (url, position) => {
    if (visibleLink(content, position)) {
      const platform = parseSocialUrl(url)?.platform ?? (parseYouTubeUrl(url) || parseYouTubeCommunityUrl(url) ? 'youtube' : parseEromeUrl(url) ? 'erome' : undefined);
      if (platform) platforms.add(platform);
    }
    return url;
  });
  return platforms.size === 1 ? platforms.values().next().value! : 'mixed';
}

export async function bindDeliveryDetails(diagnostics: DeliveryDiagnostics | undefined, id: string | undefined,
  messageId: string): Promise<ActionRowBuilder<ButtonBuilder>[]> {
  if (!id || !diagnostics || !await diagnostics.bind(id, messageId).catch(() => false)) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(deliveryDetailsButton(id))];
}

/** Shared deadline and private diagnostic binding for automatic and explicit deliveries. */
export function createDeliveryAttempt(request: DeliveryRequest, diagnostics?: DeliveryDiagnostics,
  progress?: DeliveryContext['progress'], parentSignal?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  timer.unref?.();
  const trace = diagnostics?.begin(request);
  const context: DeliveryContext = { signal: parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal,
    deadlineAt: performance.now() + 120_000,
    fairnessKey: request.guildId ?? request.requesterId, trace, progress };
  trace?.setPath('native');
  let finished = false;
  return {
    context,
    finish(outcome: DeliveryOutcome): void {
      if (!finished) { finished = true; trace?.finish(outcome); }
    },
    async controls(messageId: string): Promise<ActionRowBuilder<ButtonBuilder>[]> {
      return bindDeliveryDetails(diagnostics, trace?.id, messageId);
    },
    close(): void {
      clearTimeout(timer);
      if (!finished) trace?.finish(controller.signal.aborted ? 'timeout' : 'cancelled');
      controller.abort();
    },
  };
}
