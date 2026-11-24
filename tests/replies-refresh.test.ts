// Removing an intermediate regenerated reply preserves pending refresh and leaves one current reply.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepostRegistry } from '../src/services/RepostRegistry';

const BOT = '444444444444444444', GUILD = '111111111111111111', CHANNEL = '222222222222222222', AUTHOR = '555555555555555555';
const snow = (offset: bigint) => String((BigInt(Date.now() - 1_420_070_400_000) << 22n) + offset);

for (const variant of ['direct cleanup with preserved refresh', 'delete plus gateway event baseline'] as const) test(`source edited again while a regenerated reply is confirmed — ${variant}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'F2-refresh-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceId = snow(1n), a = snow(2n), b = snow(3n), c = snow(4n);
  const live = new Map<string, { id: string; channelId: string; guildId: string; author: { id: string }; content?: string; editedTimestamp?: number | null; delete(): Promise<unknown> }>();
  const make = (id: string, author = BOT) => ({ id, channelId: CHANNEL, guildId: GUILD, author: { id: author }, content: 'https://x.com/a/status/1', editedTimestamp: null,
    delete: async () => { live.delete(id); deletedIds.push(id); if (variant.startsWith('delete')) setImmediate(() => void registry.handleReplacementDelete({ id, channelId: CHANNEL, guildId: GUILD, author: { id: BOT } })); } });
  const deletedIds: string[] = [];
  live.set(sourceId, make(sourceId, AUTHOR)); live.set(a, make(a));
  let regenerations = 0;
  const registry = new RepostRegistry({ path: join(directory, 'reposts.json'), botUserId: BOT, canRetry: async () => true,
    fetchMessage: async (_c, id) => live.get(id) ?? null,
    regenerate: async source => {
      regenerations++;
      const id = regenerations === 1 ? b : c;
      live.set(id, make(id));
      assert.equal(await registry.remember({ guildId: GUILD, channelId: CHANNEL, sourceId: source.id, replacementId: id, authorId: AUTHOR, mode: 'reply' }), true);
      if (regenerations > 1) return undefined;
      // SocialLinkService.ts:627-631: the confirmation fetch sees another edit -> removeReplacement(); return 'retry'.
      const owned = registry.findByReplacement(id)!;
      if (variant.startsWith('direct')) assert.equal(await registry.queueRemoval(owned), true);
      else await live.get(id)!.delete();
      return 'retry';
    } });
  await registry.remember({ guildId: GUILD, channelId: CHANNEL, sourceId, replacementId: a, authorId: AUTHOR, mode: 'reply' });
  // First edit -> handleSourceUpdate -> schedule(refresh) -> process -> regenerate.
  const before = { ...live.get(sourceId)!, content: 'old text' }, after = { ...live.get(sourceId)!, content: 'new text', editedTimestamp: Date.now() };
  await registry.handleSourceUpdate(before, after, registry['options'].regenerate!);
  await new Promise(resolve => setTimeout(resolve, 20));
  await registry.sweep();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(regenerations, 2, 'the pending refresh must regenerate the edited source');
  assert.equal([b, c].filter(id => live.has(id)).length, 1);
});
