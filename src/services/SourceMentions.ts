import type { Message } from 'discord.js';
import { visibleLink } from './LinkTokens';

/** Only the sender's explicit, Discord-resolved user tags can become notification recipients. */
export function sourceMentionUsers(message: Pick<Message, 'content' | 'mentions'>): string[] {
  const users = new Set<string>();
  for (const match of message.content.matchAll(/<@!?(\d{17,20})>/g)) {
    const prefix = message.content.slice(0, match.index);
    if ((prefix.match(/\\*$/)?.[0].length ?? 0) % 2 || !visibleLink(message.content, match.index) ||
      !message.mentions?.users.has(match[1])) continue;
    users.add(match[1]);
    if (users.size === 100) break;
  }
  return [...users];
}
