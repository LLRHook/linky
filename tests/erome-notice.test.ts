import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eromeNotice } from '../src/services/EromeDelivery';

test('attachment notices preserve quality and first-item limits without promising to retain the Discord source', () => {
  for (const [count, kind] of [[1, 'video'], [3, 'video'], [0, 'image']] as const) {
    const notice = eromeNotice(count, kind);
    assert.ok(notice.startsWith('\n-# '));
    assert.match(notice, /Full album: Original post/);
    assert.doesNotMatch(notice, /album kept/i);
    if (kind === 'image') {
      assert.match(notice, /Original image quality/);
      assert.doesNotMatch(notice, /compressed/);
    } else {
      assert.match(notice, /Video may be compressed to fit Discord/);
      assert.match(notice, count > 1 ? /First of 3 videos/ : /Video preview/);
    }
  }
});
