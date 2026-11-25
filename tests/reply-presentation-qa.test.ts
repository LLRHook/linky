import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXReplies } from '../src/services/XReplies';
import { replyMediaUrl } from '../src/services/ReplyThreads';
import fixture from './fixtures/x-conversation.json';
test('X mixed media follows media.all order with photo and video fallback', () => {
 const data: any = structuredClone(fixture);
 const video = { type: 'video', url: 'https://video.twimg.com/v.mp4', thumbnail_url: 'https://pbs.twimg.com/poster.jpg' };
 const photo = { type: 'photo', url: 'https://pbs.twimg.com/photo.jpg' };
 data.replies[0].media = { all: [video, photo], videos: [video], photos: [photo] };
 const media = () => parseXReplies(data, data.status.id, 0)!.replies.find(r => r.handle === data.replies[0].author.screen_name)!.media!.map(m => m.url);
 assert.deepEqual(media(), [video.thumbnail_url, photo.url]);
 delete data.replies[0].media.all;
 assert.deepEqual(media(), [photo.url, video.thumbnail_url]);
});
test('asset URL bound applies after Unicode URL normalization', () => {
 assert.equal(replyMediaUrl('https://pbs.twimg.com/' + '\u00e9'.repeat(1000), 'X', false), undefined);
 const prefix = 'https://pbs.twimg.com/';
 assert.equal(replyMediaUrl(prefix + 'a'.repeat(2048 - prefix.length), 'X', false)?.length, 2048);
 assert.equal(replyMediaUrl(prefix + 'a'.repeat(2049 - prefix.length), 'X', false), undefined);
});
