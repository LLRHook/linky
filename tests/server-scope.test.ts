import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateScope } from '../src/services/ServerScope';

const base = { guildId: 'server', channelId: 'channel' };

test('scope retains legacy all-server, exact-channel and disabled choices', () => {
  assert.equal(evaluateScope(base).enabled, false);
  assert.equal(evaluateScope({ ...base, serverEnabled: true }).enabled, true);
  assert.equal(evaluateScope({ ...base, operatorServerIds: ['server'] }).enabled, true);
  assert.equal(evaluateScope({ ...base, operatorChannelIds: ['channel'] }).enabled, true);
  assert.equal(evaluateScope({ ...base, serverEnabled: false, operatorServerIds: ['server'], operatorChannelIds: ['channel'] }).reason, 'server-disabled');
});

test('channel preferences only restrict scope and never opt in a server', () => {
  assert.equal(evaluateScope({ ...base, preferences: { channelIds: ['channel'] } }).enabled, false);
  assert.equal(evaluateScope({ ...base, serverEnabled: true, preferences: { channelIds: [] } }).reason, 'channel-excluded');
  assert.equal(evaluateScope({ ...base, serverEnabled: true, preferences: { channelIds: ['other'] } }).enabled, false);
  assert.equal(evaluateScope({ ...base, serverEnabled: true, preferences: { channelIds: ['channel'] } }).enabled, true);
});

test('selected parents include threads while legacy operator channel IDs stay exact', () => {
  const thread = { guildId: 'server', channelId: 'thread', threadParentId: 'channel' };
  assert.equal(evaluateScope({ ...thread, serverEnabled: true, preferences: { channelIds: ['channel'] } }).enabled, true);
  assert.equal(evaluateScope({ ...thread, operatorChannelIds: ['channel'] }).enabled, false);
  assert.equal(evaluateScope({ ...thread, operatorChannelIds: ['channel'], preferences: { channelIds: ['channel'] } }).enabled, false);
  assert.equal(evaluateScope({ ...thread, operatorChannelIds: ['thread'], preferences: { channelIds: ['channel'] } }).enabled, true);
  assert.equal(evaluateScope({ ...base, serverEnabled: true, preferences: { channelIds: ['category'] } }).enabled, false);
});
