import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttachmentBuilder } from 'discord.js';
import { attachmentBudget, fitsAttachmentBudget, guildAttachmentBudget } from '../src/services/AttachmentLimits';

const MiB = 1024 * 1024;

test('Discord upload allowances become bounded output budgets with a 1 MiB margin', () => {
  for (const [upload, output] of [[10, 9], [20, 19], [50, 49], [64, 63], [100, 63], [500, 63], [2, 1]]) {
    assert.equal(attachmentBudget(upload * MiB), output * MiB);
  }
  assert.equal(attachmentBudget(undefined), 19 * MiB);
  assert.equal(attachmentBudget(10 * MiB - 1), 9 * MiB - 1, 'Never round a supplied upload limit upward');
});

test('invalid or unusably small explicit upload limits cannot become a larger default budget', () => {
  for (const value of [null, NaN, Infinity, -Infinity, -1, 0, 1, 2 * MiB - 1, 10.5, '10485760', true, {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(attachmentBudget(value), 0, String(value));
  }
});

test('automatic budgets use only Discord server boost tiers and never infer a Nitro allowance', () => {
  for (const tier of [undefined, null, 0, 1, -1, 4, NaN, '2', '3', { premiumType: 2 }]) {
    assert.equal(guildAttachmentBudget(tier), 19 * MiB, String(tier));
  }
  assert.equal(guildAttachmentBudget(2), 49 * MiB);
  assert.equal(guildAttachmentBudget(3), 63 * MiB);
});

test('prepared attachments must be nonempty local buffers that fit a valid output budget', () => {
  const file = new AttachmentBuilder(Buffer.alloc(2 * MiB));
  assert.equal(fitsAttachmentBudget(file, 2 * MiB), true);
  assert.equal(fitsAttachmentBudget(file, 2 * MiB - 1), false);
  for (const budget of [0, -1, NaN, Infinity, 64 * MiB]) assert.equal(fitsAttachmentBudget(file, budget), false);
  assert.equal(fitsAttachmentBudget(new AttachmentBuilder(Buffer.alloc(0)), 19 * MiB), false);
  assert.equal(fitsAttachmentBudget(new AttachmentBuilder('https://example.test/unbounded.mp4'), 19 * MiB), false);
});
