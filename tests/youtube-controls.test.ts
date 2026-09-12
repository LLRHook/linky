import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ButtonStyle, ComponentType, type APIActionRowComponent, type APIComponentInMessageActionRow } from 'discord.js';
import { controlsForYouTube, mergeYouTubeControls, parseYouTubeControl, removeYouTubeControls } from '../src/services/YouTubeControls';
import { formatYouTubeStatistics } from '../src/services/YouTube';

const A = 'dQw4w9WgXcQ', B = 'abcdefghijk';
const card = (id = A) => formatYouTubeStatistics({ viewCount: '20651', likeCount: '0', commentCount: '57',
  topComment: { author: 'Viewer', text: 'A useful comment.' } }, `https://youtu.be/${id}`)!;
const other: APIActionRowComponent<APIComponentInMessageActionRow> = { type: ComponentType.ActionRow, components: [
  { type: ComponentType.Button, style: ButtonStyle.Link, label: 'Original post', url: 'https://youtu.be/' + A },
  { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Remove', custom_id: 'linky:remove' },
] };

test('one video has one readable stats button and a comment button, with no extra embed or message', () => {
  const result = controlsForYouTube([card()])!;
  assert.deepEqual(result.videoIds, [A]);
  assert.equal(result.controls.length, 1);
  assert.deepEqual(result.controls[0].components, [
    { type: 2, style: 2, custom_id: `linky:yt:stats:${A}`, label: '20.7K views · 0 likes · 57 comments' },
    { type: 2, style: 2, custom_id: `linky:yt:comment:${A}`, label: 'Top comment' },
  ]);
});

test('multiple videos keep identifiable controls and unavailable fields are omitted', () => {
  const second = formatYouTubeStatistics({ likeCount: '99999999999999999999' }, `https://youtu.be/${B}`)!;
  const result = controlsForYouTube([card(), second])!;
  assert.equal(result.controls[1].components.length, 1);
  assert.match(result.controls[0].components[0].label!, /^1 · /);
  assert.equal(result.controls[1].components[0].label, '2 · 100,000,000T likes');
  assert(result.controls.flatMap(row => row.components).every(button => button.label!.length <= 80));
  assert.deepEqual(result.videoIds, [A, B]);
});

test('replacement and expiry remove only YouTube controls, preserving Original post and Remove', () => {
  const yt = controlsForYouTube([card()])!.controls;
  assert.deepEqual(mergeYouTubeControls([other], yt), [other, ...yt]);
  assert.deepEqual(mergeYouTubeControls([other, ...yt], yt), [other, ...yt]);
  assert.deepEqual(removeYouTubeControls([other, ...yt]), [other]);
  const mixed = { ...other, components: [...other.components, ...yt[0].components] };
  assert.deepEqual(removeYouTubeControls([mixed]), [other]);
  assert.equal(other.components.length, 2, 'Never mutate another control owner\'s row');
});

test('controls stay within the legacy row limit and refuse incompatible V2 layouts', () => {
  const yt = controlsForYouTube([card()])!.controls;
  assert.equal(mergeYouTubeControls(Array(5).fill(other), yt), null);
  const v2 = { type: ComponentType.TextDisplay, content: 'Preserve this content' } as const;
  assert.equal(mergeYouTubeControls([v2], yt), null);
  assert.deepEqual(removeYouTubeControls([v2]), [v2]);
});

test('malformed, duplicate and excessive video cards fail closed', () => {
  for (const cards of [[], [card(), card()], Array(4).fill(card()), [{ ...card(), url: 'https://evil.test' }], [{}]]) {
    assert.equal(controlsForYouTube(cards), null);
  }
  assert.deepEqual(parseYouTubeControl(`linky:yt:comment:${A}`), { action: 'comment', videoId: A });
  for (const id of ['linky:remove', `linky:yt:other:${A}`, `linky:yt:stats:${A}:extra`, 'linky:yt:stats:../video']) {
    assert.equal(parseYouTubeControl(id), null);
  }
});
