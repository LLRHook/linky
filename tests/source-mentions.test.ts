import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Collection, type Message } from 'discord.js';
import { sourceMentionUsers } from '../src/services/SourceMentions';

const ONE = '1700000000000000001', TWO = '1700000000000000002', THREE = '1700000000000000003';
const tag = (id: string) => `<@${id}>`;
function source(content: string, resolved: string[] = [ONE, TWO, THREE]) {
  return { content, mentions: { users: new Collection(resolved.map(id => [id, { id }])) } } as unknown as Pick<Message, 'content' | 'mentions'>;
}

test('mention recipients are the intersection of explicit user tokens and Discord-resolved users', () => {
  const input = source(`${tag(TWO)} <@!${ONE}> ${tag(TWO)} ${tag(THREE)} <@&${ONE}> @everyone @here`, [ONE, TWO]);
  assert.deepEqual(sourceMentionUsers(input), [TWO, ONE], 'Legacy syntax and duplicates preserve first source occurrence order');
  assert.deepEqual(sourceMentionUsers(source('No user tags, even with mention metadata.')), []);
  assert.deepEqual(sourceMentionUsers(source(`${tag(ONE)} <@!${TWO}>`, [])), []);
});

test('code spans and fences cannot add recipients even when mention metadata contains the user', () => {
  for (const hidden of [`\`${tag(ONE)}\``, `\`\`${tag(ONE)} \` literal\`\``,
    `\`\`\`txt\n${tag(ONE)}\n\`\`\``, `\`unclosed ${tag(ONE)}`]) {
    assert.deepEqual(sourceMentionUsers(source(`${tag(TWO)} ${hidden}`)), [TWO], hidden);
  }
  assert.deepEqual(sourceMentionUsers(source(`\`${tag(ONE)}\` ${tag(TWO)} \`\`\`\n${tag(THREE)}\n\`\`\` ${tag(ONE)}`)), [TWO, ONE]);
});

test('escaped tags and escaped delimiters follow source visibility without notifying hidden spoiler mentions', () => {
  for (const count of [1, 3, 5]) {
    assert.deepEqual(sourceMentionUsers(source(`${'\\'.repeat(count)}${tag(ONE)} ${tag(TWO)}`)), [TWO]);
  }
  for (const count of [0, 2, 4]) {
    assert.deepEqual(sourceMentionUsers(source(`${'\\'.repeat(count)}${tag(ONE)}`)), [ONE]);
  }
  for (const content of [`||${tag(ONE)}|| ${tag(TWO)}`, `${tag(TWO)} ||${tag(ONE)}`,
    `||hidden \\|| ${tag(ONE)}|| ${tag(TWO)}`, `\`||${tag(ONE)}\` ${tag(TWO)}`]) {
    assert.deepEqual(sourceMentionUsers(source(content)), [TWO], content);
  }
  assert.deepEqual(sourceMentionUsers(source(`\\\`${tag(ONE)} \\||${tag(TWO)}`)), [ONE, TWO], 'Escaped delimiters do not open code or spoilers');
});

test('missing metadata, malformed IDs, role tags and suppressed angle wrappers fail closed', () => {
  assert.deepEqual(sourceMentionUsers({ content: tag(ONE) } as Pick<Message, 'content' | 'mentions'>), []);
  const input = source(`<@123> <@123456789012345678901> <@!> <@&${ONE}> <<@${ONE}>> ${tag(TWO)}`);
  assert.deepEqual(sourceMentionUsers(input), [TWO]);
});

test('recipient cap counts unique visible resolved users, not duplicates or hidden matches', () => {
  const ids = Array.from({ length: 105 }, (_, index) => String(1700000000000000000n + BigInt(index)));
  const content = `\`${tag(THREE)}\` ` + ids.map(id => `${tag(id)} <@!${id}>`).join(' ');
  assert.deepEqual(sourceMentionUsers(source(content, ids)), ids.slice(0, 100));
  assert.equal(sourceMentionUsers(source(content, ids.filter((_, index) => index % 2 === 0))).length, 53);
});
