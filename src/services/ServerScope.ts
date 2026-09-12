import type { ServerPreferences } from './ServerSettings';

export interface ScopeInput {
  guildId: string;
  channelId: string;
  /** Supply only for a thread; categories do not implicitly match a channel preference. */
  threadParentId?: string | null;
  serverEnabled?: boolean;
  preferences?: ServerPreferences;
  operatorChannelIds?: readonly string[];
  operatorServerIds?: readonly string[];
}

export interface ScopeResult {
  enabled: boolean;
  reason: 'server-disabled' | 'not-enabled' | 'channel-excluded' | 'enabled';
  source: 'server' | 'operator-server' | 'operator-channel' | 'none';
}

/** Preserve legacy exact-channel enablement, then apply any explicit channel preference. */
export function evaluateScope(input: ScopeInput): ScopeResult {
  if (input.serverEnabled === false) return { enabled: false, reason: 'server-disabled', source: 'server' };
  const source = input.serverEnabled === true ? 'server'
    : input.operatorServerIds?.includes(input.guildId) ? 'operator-server'
      : input.operatorChannelIds?.includes(input.channelId) ? 'operator-channel' : 'none';
  if (source === 'none') return { enabled: false, reason: 'not-enabled', source };
  const channels = input.preferences?.channelIds;
  if (channels !== undefined && !channels.includes(input.channelId) &&
      !(input.threadParentId && channels.includes(input.threadParentId))) {
    return { enabled: false, reason: 'channel-excluded', source };
  }
  return { enabled: true, reason: 'enabled', source };
}

export function describeScope(scope: ScopeResult): string {
  if (scope.reason === 'server-disabled') return 'Disabled throughout this server.';
  if (scope.reason === 'channel-excluded') return 'Disabled in this channel by the selected channel restriction.';
  if (!scope.enabled) return 'Disabled in this channel; any operator-configured channels keep their existing scope.';
  return scope.source === 'operator-channel' ? 'Enabled in this channel by the bot operator; other channels follow the operator’s configuration.'
    : 'Enabled in this channel, subject to channel permissions.';
}
