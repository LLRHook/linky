import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getProviderCandidates, parseProviderUrl, parseSocialUrl } from '../src/services/SocialProviders';

test('recognizes X and legacy Twitter posts with one status identity and cleaned source URL', () => {
  for (const host of ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']) {
    const parsed = parseSocialUrl(`https://${host}/jack/status/20?s=46&t=tracking#reply`);
    assert.deepEqual(parsed, { platform: 'x', sourceUrl: 'https://x.com/jack/status/20#reply',
      path: '/jack/status/20', fragment: '#reply', statusId: '20' });
  }
  for (const path of ['/i/status/20/', '/i/web/status/20', '/jack/status/20/photo/2', '/jack/status/20/video/1']) {
    assert.equal(parseSocialUrl('https://x.com' + path)?.statusId, '20');
  }
});

test('provides only independently vetted X recovery and retains existing Instagram/TikTok primaries', () => {
  assert.deepEqual(getProviderCandidates('https://twitter.com/jack/status/20?s=46#reply'), [
    { providerId: 'fixupx', platform: 'x', url: 'https://fixupx.com/jack/status/20#reply' },
    { providerId: 'fixvx', platform: 'x', url: 'https://vxtwitter.com/jack/status/20#reply' },
  ]);
  assert.deepEqual(getProviderCandidates('https://m.instagram.com/reels/DdFKS1ABmK4/?igsh=tracking'),
    [{ providerId: 'instagram7', platform: 'instagram', url: 'https://www.instagram7.com/reels/DdFKS1ABmK4/' }]);
  assert.deepEqual(getProviderCandidates('https://www.tiktok.com/@person/video/12345?share=1'),
    [{ providerId: 'tnktok', platform: 'tiktok', url: 'https://tnktok.com/@person/video/12345' }]);
});

test('recognizes observed provider URLs only through the static catalog and original post shapes', () => {
  const parsed = parseProviderUrl('https://fxtwitter.com/i/status/20?s=46');
  assert.equal(parsed?.providerId, 'fixupx');
  assert.equal(parsed?.sourceUrl, 'https://x.com/i/status/20');
  assert.equal(parseProviderUrl('https://fixvx.com/jack/status/20')?.providerId, 'fixvx');
  assert.equal(parseProviderUrl('https://www.instagram7.com/reel/ABC/')?.sourceUrl, 'https://www.instagram.com/reel/ABC/');
  assert.equal(parseProviderUrl('https://g.fixupx.com/jack/status/20')?.statusId, '20');
  assert.equal(parseProviderUrl('https://tnktok.com/ZABC/')?.sourceUrl, 'https://vm.tiktok.com/ZABC/');
  for (const url of ['https://fixupx.com:443/jack/status/20', 'https://evil.test/jack/status/20',
    'https://user@vxtwitter.com/jack/status/20', 'https://fixupx.com.evil.test/jack/status/20',
    'https://fixupx.com/jack', 'https://www.instagram7.com/reel/../ABC/']) {
    assert.equal(parseProviderUrl(url), null, url);
  }
});

test('preserves TikTok short-share paths without resolving or treating apex profiles as posts', () => {
  for (const host of ['vm.tiktok.com', 'vt.tiktok.com']) {
    assert.deepEqual(getProviderCandidates(`https://${host}/ZM123abc/?share=tracking#part`),
      [{ providerId: 'tnktok', platform: 'tiktok', url: 'https://tnktok.com/ZM123abc/#part' }]);
  }
  assert.equal(getProviderCandidates('https://www.tiktok.com/t/ZM123abc/')[0]?.url, 'https://tnktok.com/t/ZM123abc/');
  assert.equal(getProviderCandidates('https://m.tiktok.com/@person/photo/123')[0]?.url, 'https://tnktok.com/@person/photo/123');
  assert.equal(parseSocialUrl('https://tiktok.com/ZM123abc/'), null);
  assert.equal(parseSocialUrl('https://tiktok.com/@person'), null);
});

test('rejects non-posts, authority confusion, normalization tricks and nested links', () => {
  for (const raw of [
    'https://x.com', 'https://x.com/jack', 'https://x.com/intent/tweet',
    'https://x.com/jack/status/123abc', 'https://x.com/jack/status/123/photo/9',
    'https://x.com/jack/status/123/another/path', 'https://x.com/jack/status/123456789012345678901',
    'http://x.com/jack/status/20', 'https://x.com:443/jack/status/20',
    'https://jack@x.com/jack/status/20', 'https://x.com.evil.test/jack/status/20',
    'https://x.com./jack/status/20', 'https://example.com/?next=https://x.com/jack/status/20',
    'https://x.com/redirect?url=https://x.com/jack/status/20',
    'https://x.com/a/../jack/status/20', 'https://x.com/%2e%2e/jack/status/20',
    'https://x.com/jack%2fstatus/20', 'https://x.com\\@evil.test/jack/status/20',
    'https://x.com/jack/status/20\n', ' https://x.com/jack/status/20',
    'https://m.x.com/jack/status/20', 'https://evil.instagram.com/p/ABC',
    'https://instagram.com/person', 'https://instagram.com/reels/',
    'https://instagram.com/p/ABC/more', 'https://instagram.com/p/../../p/ABC',
    'https://tiktok.com/@user/video/123/more', 'https://vm.tiktok.com/a/b',
    'https://youtu.be/dQw4w9WgXcQ',
  ]) {
    assert.equal(parseSocialUrl(raw), null, raw);
    assert.deepEqual(getProviderCandidates(raw), [], raw);
  }
});

test('does not trust caller-supplied path, platform or host fields when creating provider URLs', () => {
  const source = parseSocialUrl('https://x.com/jack/status/20')!;
  const candidates = getProviderCandidates({ ...source, path: '//evil.test/collect', platform: 'instagram' });
  assert.equal(candidates[0].url, 'https://fixupx.com/jack/status/20');
  assert.deepEqual(getProviderCandidates({ ...source, sourceUrl: 'https://evil.test/jack/status/20' }), []);
});

test('Bluesky normalizes handles and keeps the actor plus record key as its post identity', () => {
  const parsed = parseSocialUrl('https://bsky.app/profile/BSKY.APP/post/3mk4lzkrnk22d/?ref=share#reply');
  assert.deepEqual(parsed, { platform: 'bluesky', sourceUrl: 'https://bsky.app/profile/bsky.app/post/3mk4lzkrnk22d#reply',
    path: '/profile/bsky.app/post/3mk4lzkrnk22d', fragment: '#reply', postId: 'bsky.app/3mk4lzkrnk22d' });
  const did = 'did:plc:z72i7hdynmk6r22z27h6tvur';
  assert.equal(parseSocialUrl(`https://bsky.app/profile/${did}/post/3mk4lzkrnk22d`)?.postId, `${did}/3mk4lzkrnk22d`);
  assert.equal(parseSocialUrl('https://bsky.app/profile/did:web:example.com/post/a_record:1')?.postId, 'did:web:example.com/a_record:1');
  assert.notEqual(parseSocialUrl('https://bsky.app/profile/other.bsky.social/post/3mk4lzkrnk22d')?.postId, parsed?.postId);
});

test('Bluesky uses the observed working VixBluesky primary with documented FxBluesky recovery', () => {
  const source = 'https://bsky.app/profile/bsky.app/post/3mk4lzkrnk22d';
  assert.deepEqual(getProviderCandidates(source), [
    { providerId: 'vixbluesky', platform: 'bluesky', url: 'https://bskx.app/profile/bsky.app/post/3mk4lzkrnk22d' },
    { providerId: 'fxbluesky', platform: 'bluesky', url: 'https://fxbsky.app/profile/bsky.app/post/3mk4lzkrnk22d' },
  ]);
  for (const [host, providerId] of [['bskx.app', 'vixbluesky'], ['fxbsky.app', 'fxbluesky']]) {
    const parsed = parseProviderUrl(`https://${host}/profile/bsky.app/post/3mk4lzkrnk22d`);
    assert.equal(parsed?.sourceUrl, source);
    assert.equal(parsed?.postId, 'bsky.app/3mk4lzkrnk22d');
    assert.equal(parsed?.providerId, providerId);
  }
});

test('Bluesky rejects profiles, invalid actors, encoded separators and dot-segment record keys', () => {
  for (const source of [
    'https://bsky.app/profile/bsky.app', 'https://bsky.app/profile/bsky.app/feed/3mk4lzkrnk22d',
    'https://bsky.app/profile/bsky.app/post/3mk4lzkrnk22d/extra',
    'https://bsky.app/profile/@bsky.app/post/3mk4lzkrnk22d',
    'https://bsky.app/profile/bad_handle.bsky.social/post/3mk4lzkrnk22d',
    'https://bsky.app/profile/-bad.bsky.social/post/3mk4lzkrnk22d',
    'https://bsky.app/profile/127.0.0.1/post/3mk4lzkrnk22d',
    'https://bsky.app/profile/localhost/post/3mk4lzkrnk22d',
    'https://bsky.app/profile/did:plc:invalid/post/3mk4lzkrnk22d',
    'https://bsky.app/profile/did:web:example.com:443/post/3mk4lzkrnk22d',
    'https://bsky.app/profile/bsky.app/post/.', 'https://bsky.app/profile/bsky.app/post/%2e%2e',
    'https://bsky.app/profile/bsky.app/post/a%2Fb',
    'https://bsky.app/profile/bsky.app/post/' + 'a'.repeat(513),
    'https://bsky.app/profile/bsky.app/post/' + 'a'.repeat(490),
  ]) assert.equal(parseSocialUrl(source), null, source);
});

test('Reddit post links retain paths while canonical and old-host aliases share a post identity', () => {
  const path = '/r/aww/comments/90bu6w/heat_index_was_110_degrees_so_we_offered_him_a/';
  for (const host of ['reddit.com', 'www.reddit.com', 'old.reddit.com']) {
    const parsed = parseSocialUrl(`https://${host}${path}?utm_source=share#comment`);
    assert.deepEqual(parsed, { platform: 'reddit', sourceUrl: `https://www.reddit.com${path}#comment`,
      path, fragment: '#comment', postId: '90bu6w' });
    assert.deepEqual(getProviderCandidates(`https://${host}${path}?share=1`),
      [{ providerId: 'vxreddit', platform: 'reddit', url: `https://vxreddit.com${path}` }]);
  }
  assert.equal(parseSocialUrl('https://www.reddit.com/comments/90bu6w')?.postId, '90bu6w');
  assert.equal(parseSocialUrl('https://www.reddit.com/r/aww/comments/90bu6w/comment/abc123/')?.postId, '90bu6w');
  assert.equal(parseSocialUrl('https://www.reddit.com/user/SomeUser/comments/90bu6w/a_post/')?.postId, '90bu6w');
  assert.equal(parseProviderUrl(`https://vxreddit.com${path}`)?.postId, '90bu6w');
  assert.equal(parseProviderUrl('https://vxreddit.com/comments/90bu6w')?.sourceUrl, 'https://www.reddit.com/comments/90bu6w');
});

test('Reddit short-share, feeds, profiles, galleries and invalid post paths remain untouched', () => {
  for (const source of ['https://redd.it/90bu6w', 'https://www.reddit.com/r/aww/s/ABC123',
    'https://www.reddit.com/r/aww', 'https://www.reddit.com/user/SomeUser', 'https://www.reddit.com/gallery/90bu6w',
    'https://www.reddit.com/r/aww/comments/90bu6w/title/comment/extra',
    'https://www.reddit.com/r/aww/comments/90bu6w/a%2Fb', 'https://www.reddit.com/r/aww/comments/',
    'https://www.reddit.com/r/aww/comments/invalid-id/title',
    'https://www.reddit.com/r/aww/comments/90bu6w/title.json',
  ]) assert.equal(parseSocialUrl(source), null, source);
});

test('Twitch clip URL forms normalize to one clip identity and the documented provider route', () => {
  const clip = 'ColdbloodedPowerfulDurianPupper-zS2syJ91CNRIqC4v';
  const forms = [`https://clips.twitch.tv/${clip}`, `https://www.twitch.tv/forsen/clip/${clip}`,
    `https://twitch.tv/forsen/clip/${clip}/`, `https://m.twitch.tv/forsen/clip/${clip}`];
  for (const url of forms) {
    assert.deepEqual(parseSocialUrl(`${url}?filter=clips#part`), { platform: 'twitch',
      sourceUrl: `https://clips.twitch.tv/${clip}#part`, path: `/${clip}`, fragment: '#part', postId: clip });
    assert.deepEqual(getProviderCandidates(url),
      [{ providerId: 'fxtwitch', platform: 'twitch', url: `https://fxtwitch.seria.moe/clip/${clip}` }]);
  }
  for (const path of [`/clip/${clip}`, `/forsen/clip/${clip}`]) {
    const parsed = parseProviderUrl(`https://fxtwitch.seria.moe${path}`);
    assert.equal(parsed?.providerId, 'fxtwitch');
    assert.equal(parsed?.sourceUrl, `https://clips.twitch.tv/${clip}`);
    assert.equal(parsed?.postId, clip);
  }
});

test('Twitch streams, VODs, embed-player URLs and unrelated fixer domains are excluded', () => {
  for (const url of ['https://twitch.tv/forsen', 'https://www.twitch.tv/videos/123456',
    'https://clips.twitch.tv/embed?clip=ExampleClip', 'https://clips.twitch.tv/clip/ExampleClip',
    'https://www.twitch.tv/forsen/clips', 'https://www.twitch.tv/forsen/clip/ExampleClip/extra',
    'https://player.twitch.tv/?channel=forsen', 'https://twitch.com/forsen/clip/ExampleClip',
  ]) assert.equal(parseSocialUrl(url), null, url);
  assert.equal(parseProviderUrl('https://fxtwitch.tv/forsen/clip/ExampleClip'), null);
  assert.equal(parseProviderUrl('https://fxtwitch.seria.moe/health'), null);
});

test('all new providers retain exact HTTPS authorities and do not trust caller-supplied identities', () => {
  const sources = ['https://bsky.app/profile/bsky.app/post/3mk4lzkrnk22d',
    'https://www.reddit.com/r/aww/comments/90bu6w/title', 'https://clips.twitch.tv/ExampleClip'];
  for (const source of sources) {
    const url = new URL(source);
    for (const invalid of [source.replace('https:', 'http:'), `https://${url.hostname}:443${url.pathname}`,
      `https://user@${url.hostname}${url.pathname}`, `https://${url.hostname}.evil.test${url.pathname}`,
      `https://${url.hostname}/../${url.pathname.slice(1)}`, `https://other.test/?next=${source}`]) {
      assert.equal(parseSocialUrl(invalid), null, invalid);
    }
    const parsed = parseSocialUrl(source)!;
    assert.deepEqual(getProviderCandidates({ ...parsed, platform: 'x', path: '//evil.test/collect', postId: 'forged' }), getProviderCandidates(source));
    for (const candidate of getProviderCandidates(source)) {
      const url = new URL(candidate.url);
      assert.equal(parseProviderUrl(`https://${url.hostname}:443${url.pathname}`), null);
      assert.equal(parseProviderUrl(`https://${url.hostname}.evil.test${url.pathname}`), null);
    }
  }
  assert.equal(parseProviderUrl('https://rxddit.com/comments/90bu6w'), null);
  assert.equal(parseProviderUrl('https://bskyx.app/profile/bsky.app/post/3mk4lzkrnk22d'), null);
});
