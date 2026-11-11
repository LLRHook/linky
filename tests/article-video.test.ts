import assert from 'node:assert/strict';
import test from 'node:test';
import { ComponentType } from 'discord.js';
import { articleVideoComponents, isArticleVideo, messageHasArticleVideo, type PreparedArticle } from '../src/services/ArticlePosts';

const video = { name: 'future-post.mp4', url: 'https://cdn.example/post.mp4', data: new Uint8Array([1]) };
const avatar = { name: 'future-avatar.png', url: 'https://cdn.example/avatar.png', data: new Uint8Array([2]) };
const post: PreparedArticle = { source: 'https://publisher.com/post/1',
  embeds: [{ url: 'https://publisher.com/post/1', title: 'A future provider', description: 'Post text',
    author: { name: 'Author', icon_url: 'attachment://future-avatar.png' }, footer: { text: 'Publisher' } }], files: [avatar, video] };

test('article video blocks accept any provider and an uploaded avatar, and verify the video rather than the first file', () => {
  assert(isArticleVideo(video.name));
  for (const name of ['../post.mp4', 'a.mp4?x', 'image.png', undefined]) assert(!isArticleVideo(name));
  const components = articleVideoComponents([post], 'Shared by someone')!;
  assert(components);
  const serialized = components.map(value => ({ toJSON: () => value }));
  assert(messageHasArticleVideo(serialized, [post]));
  const block = components[1];
  assert.equal(block.type, ComponentType.Container);
  assert.match(JSON.stringify(block), /attachment:\/\/future-avatar.png/);
  assert.match(JSON.stringify(block), /attachment:\/\/future-post.mp4/);
  assert(!messageHasArticleVideo([], [post]));
  assert(!messageHasArticleVideo([{ toJSON: () => ({ type: ComponentType.Container, components: [
    { type: ComponentType.MediaGallery, items: [{ media: { url: 'attachment://other.mp4' } }] }],
  }) }], [post]));
});

test('article video blocks retain multi-card, multiple-video, unrelated-upload and text-limit fallbacks', () => {
  assert.equal(articleVideoComponents([post, { ...post, embeds: [{ ...post.embeds[0], url: post.source + '/2' }] }], ''), null);
  assert.equal(articleVideoComponents([{ ...post, files: [video, { ...video, name: 'another.mp4' }] }], ''), null);
  assert.equal(articleVideoComponents([{ ...post, files: [video, { ...avatar, name: 'unrelated.png' }] }], ''), null);
  assert.equal(articleVideoComponents([post], 'x'.repeat(4000)), null);
  assert.equal(articleVideoComponents([{ ...post, files: [avatar] }], ''), null);
});
