import assert from 'node:assert/strict';
import test from 'node:test';
import { articleEmbeds, hasMixedArticleLinks, prepareArticlePosts } from '../src/services/ArticlePosts';
import type { ArticlePreview } from '../src/services/ArticlePreview';
import { expectedPreviews, inspectPreviews } from '../src/services/PreviewRecovery';

const canonical = 'https://publisher.example.com/news/article';
const sources = [canonical + '?utm_source=first', canonical + '?utm_source=second'];
const article = (source: string): ArticlePreview => ({ source, url: canonical, title: 'A public article',
  publisher: 'Publisher', description: 'Publisher metadata.', image: 'https://publisher.example.com/article.jpg' });

test('article aliases retain every source expectation while publishing one identical canonical card', async () => {
  const posts = await prepareArticlePosts(sources, async source => article(source));
  assert(posts); assert.equal(posts.length, 2); assert.deepEqual(posts.map(post => post.source), sources);
  const cards = articleEmbeds(posts);
  assert.equal(cards.length, 1); assert.equal(cards[0].url, canonical);
  const expected = expectedPreviews(sources.join(' '), sources.map(source => `<${source}>`).join(' '), [], posts);
  assert.equal(expected.length, 2); assert.deepEqual(expected.map(item => item.source), sources);
  const confirmed = inspectPreviews(cards, expected);
  assert.equal(confirmed.ok, true); assert.equal(confirmed.videoMetadata, false);
  assert.equal(inspectPreviews([{ ...cards[0], title: 'A different article' }], expected).ok, false);
});

test('conflicting metadata claiming one canonical article rejects the entire set', async () => {
  for (const changed of [
    { title: 'Different article' }, { description: 'Different excerpt' }, { publisher: 'Different publisher' },
    { image: 'https://publisher.example.com/other.jpg' }, { publishedAt: '2026-09-23T12:00:00Z' },
  ]) {
    const prepared = await prepareArticlePosts(sources, async source => ({ ...article(source),
      ...(source === sources[1] ? changed : {}) }));
    assert.equal(prepared, null, JSON.stringify(changed));
  }
});

test('deduplication keeps first canonical order and distinct articles remain distinct', async () => {
  const input = [sources[0], canonical + '-other', sources[1]];
  const posts = await prepareArticlePosts(input, async source => ({ ...article(source),
    ...(source.endsWith('-other') ? { url: source, title: 'Another article' } : {}) }));
  assert(posts); assert.equal(posts.length, 3);
  assert.deepEqual(articleEmbeds(posts).map(card => card.url), [canonical, canonical + '-other']);
});

test('article preparation retains all-or-nothing, source identity, cancellation and size constraints', async () => {
  assert.deepEqual(await prepareArticlePosts([]), []);
  assert.equal(await prepareArticlePosts(sources), null);
  assert.equal(await prepareArticlePosts([...sources, canonical, canonical + '-other'], async () => assert.fail('Over-limit lookup')), null);
  assert.equal(await prepareArticlePosts(sources, async source => source === sources[0] ? article(source) : null), null);
  assert.equal(await prepareArticlePosts(sources, async source => ({ ...article(source), source: canonical + '-wrong' })), null);
  assert.equal(await prepareArticlePosts(sources, async source => ({ ...article(source), title: '' })), null);
  const controller = new AbortController(); controller.abort();
  assert.equal(await prepareArticlePosts(sources, async () => assert.fail('Aborted lookup'), controller.signal), null);
  const pending = new AbortController();
  assert.equal(await prepareArticlePosts(sources, async source => { pending.abort(); return article(source); }, pending.signal), null);
  assert.deepEqual(articleEmbeds([]), []);
  assert.deepEqual(articleEmbeds([{ source: sources[0], embeds: [] }]), []);
  assert.deepEqual(articleEmbeds([{ source: sources[0], embeds: [{ title: 'Missing URL' }] }]), []);
});

test('article mixed detection respects disabled articles, hidden links and opt-out', () => {
  const social = 'https://x.com/jack/status/20';
  assert.equal(hasMixedArticleLinks(`${canonical} ${social}`, ['articles']), true);
  assert.equal(hasMixedArticleLinks(`${canonical} <${social}>`, ['articles']), false);
  assert.equal(hasMixedArticleLinks(`${canonical} ${social}`, ['x']), false);
  assert.equal(hasMixedArticleLinks(`${canonical} ${social} !nolinky`, ['articles']), false);
  assert.equal(hasMixedArticleLinks(sources.join(' '), ['articles']), false);
});
