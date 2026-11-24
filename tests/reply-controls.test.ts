import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { publishManualMediaBlock } from '../src/commands/fixMedia';

for (const throws of [false, true]) test(`block re-verification ${throws ? 'throws' : 'fails'} before Replies can be published`, async () => {
  const payloads: unknown[] = []; let checks = 0;
  const message = { id: '333333333333333333' };
  const row = (id: string) => new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Control').setCustomId(id));
  await publishManualMediaBlock({ interaction: { editReply: async (payload: unknown) => { payloads.push(payload); return message; } } as never,
    attempt: { context: {}, controls: async () => [], finish: () => {} } as never,
    block: [{ type: ComponentType.TextDisplay, content: 'post' }], files: [], buttonRows: () => [row('linky:remove-manual')],
    confirmedButtonRows: () => [row('linky:replies:x:20:foo')], preferencesCurrent: () => true, sourceCurrent: async () => true,
    expected: [], verifyMedia: async () => { if (++checks === 1) return true; if (throws) throw Error('verification'); return false; } });
  assert.equal(checks, 2); assert.doesNotMatch(JSON.stringify(payloads), /linky:replies:/);
  assert.match(JSON.stringify(payloads.at(-1)), /could not be confirmed/);
});
