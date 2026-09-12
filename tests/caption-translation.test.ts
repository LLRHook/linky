import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCaptionTranslator } from '../src/services/CaptionTranslation';

const translated = (text = 'Hello!', language = 'et') => ({ translatedText: text, detectedSourceLanguage: language });
const response = (...translations: unknown[]) => Response.json({ data: { translations } });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('batches separate caption paragraphs so an English introduction cannot mask an Estonian remainder', async () => {
  const requests: RequestInit[] = [], reserved: number[] = [];
  const translate = createCaptionTranslator('private-key', { reserve: async count => { reserved.push(count); return true; },
    fetch: async (url, options) => {
      assert.equal(url, 'https://translation.googleapis.com/language/translate/v2'); requests.push(options!);
      return response(translated('Do not rewrite this introduction.', 'en'), translated('Hello, my friends!'));
    },
  });
  const input = '  Keep this English intro exactly.\r\n\r\nTere, mu sõbrad!  ';
  assert.deepEqual(await translate(input), { text: '  Keep this English intro exactly.\r\n\r\nHello, my friends!  ', languages: ['et'] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(new Headers(requests[0].headers).get('x-goog-api-key'), 'private-key');
  assert.equal(requests[0].redirect, 'error');
  assert.deepEqual(JSON.parse(String(requests[0].body)), {
    q: ['Keep this English intro exactly.', 'Tere, mu sõbrad!'], target: 'en', format: 'text',
  });
  assert.deepEqual(reserved, [Array.from('Keep this English intro exactly.Tere, mu sõbrad!').length]);
});

test('preserves non-prose and English paragraphs while reporting distinct translated languages in order', async () => {
  const translate = createCaptionTranslator('key', { fetch: async (_url, options) => {
    assert.deepEqual(JSON.parse(String(options!.body)).q, ['Tere!', 'Already English.', 'Hola!', 'Aitäh!']);
    return response(translated('Hello!'), translated('Changed!', 'en-US'), translated('Hello!', 'es'), translated('Thank you!'));
  } });
  assert.deepEqual(await translate('Tere!\n\nAlready English.\n\n✨ 123\n\nHola!\n\nAitäh!'), {
    text: 'Hello!\n\nAlready English.\n\n✨ 123\n\nHello!\n\nThank you!', languages: ['et', 'es'],
  });
});

test('a divider separates an English introduction from one complete hard-wrapped Estonian paragraph', async () => {
  const body = [
    'Meie väike robot jalutas täna läbi',
    'pargi ja leidis tee äärest',
    'sinise',
    'vihmavarju. Ta viis selle lähedal asuvasse kohvikusse,',
    'kus sõbrad jõid teed ja rääkisid oma päevast.',
    '42',
    'Hiljem hakkas päike paistma ning kõik läksid koos koju.',
  ].join('\n');
  const intro = 'A small story from @example_robot for our friends.';
  const translate = createCaptionTranslator('key', { fetch: async (_url, options) => {
    const { q } = JSON.parse(String(options!.body));
    assert.deepEqual(q, ['A small story from __LINKY_TOKEN_0__ for our friends.', body]);
    // Stubbed API output tests batching and reconstruction, not Google's translation quality.
    return response(translated('Changed intro', 'en'), translated('The complete English caption.'));
  } });
  assert.deepEqual(await translate(`${intro}\n-\n${body}`), {
    text: `${intro}\n-\nThe complete English caption.`, languages: ['et'],
  });
});

test('keeps hard-wrapped sentences together with each newline convention', async () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const paragraph = `Tema tumedad${newline}elektroonilised produktsioonid${newline}on populaarsed.`;
    const translate = createCaptionTranslator('key', { fetch: async (_url, options) => {
      assert.deepEqual(JSON.parse(String(options!.body)).q, ['English introduction.', paragraph]);
      return response(translated('Leave unchanged', 'en'), translated('His dark electronic productions are popular.'));
    } });
    assert.deepEqual(await translate(`English introduction.${newline}  ---  ${newline}  ${paragraph}  `), {
      text: `English introduction.${newline}  ---  ${newline}  His dark electronic productions are popular.  `,
      languages: ['et'],
    });
  }
});

test('protects URLs, handles and Unicode hashtags from translation and restores them exactly', async () => {
  const tokens = ['@kasutaja.nimi', '#eestikeel', '#päev', "https://example.com/it's?q=üks&v=2", 'www.example.ee/page'];
  const input = `Tere ${tokens.join(' ')}!`;
  const translate = createCaptionTranslator('key', { fetch: async (_url, options) => {
    const { q } = JSON.parse(String(options!.body));
    assert.equal(q.length, 1);
    for (const token of tokens) assert.equal(q[0].includes(token), false);
    return response(translated(q[0].replace('Tere', 'Hello')));
  } });
  assert.deepEqual(await translate(input), { text: input.replace('Tere', 'Hello'), languages: ['et'] });
});

test('missing, changed or repeated protected tokens fail open instead of publishing altered links', async () => {
  for (const alter of [
    (text: string) => text.replace('__LINKY_TOKEN_0__', ''),
    (text: string) => text.replace('__LINKY_TOKEN_0__', '__LINKY_TRANSLATED_0__'),
    (text: string) => `${text} __LINKY_TOKEN_0__`,
  ]) {
    const translate = createCaptionTranslator('key', { fetch: async (_url, options) =>
      response(translated(alter(JSON.parse(String(options!.body)).q[0]))) });
    assert.equal(await translate('Tere https://example.com'), null);
  }
});

test('source text resembling a protection marker does not collide with actual protected tokens', async () => {
  const input = 'Tere __LINKY_TOKEN_0__ @someone';
  const translate = createCaptionTranslator('key', { fetch: async (_url, options) => {
    const text = JSON.parse(String(options!.body)).q[0];
    assert.equal(text, 'Tere __LINKY_TOKEN_0__ __LINKY_TOKEN__0__');
    return response(translated(text.replace('Tere', 'Hello')));
  } });
  assert.deepEqual(await translate(input), { text: input.replace('Tere', 'Hello'), languages: ['et'] });
});

test('decodes escaped API text once, including numeric Unicode, while preserving literal markup', async () => {
  const translate = createCaptionTranslator('key', { fetch: async () => response(translated(
    'It&#39;s &quot;good&quot; &amp; &#x1F60A; &lt;b&gt;plain&lt;/b&gt; &amp;lt; &nbsp;&rsquo; &#0; &#x110000;')) });
  assert.deepEqual(await translate('Tere!'), {
    text: 'It\'s "good" & 😊 <b>plain</b> &lt; \u00a0’ � �', languages: ['et'],
  });
});

test('invalid or incomplete provider responses never produce a partial translation', async () => {
  const invalid = [
    {}, { data: {} }, { data: { translations: [] } },
    { data: { translations: [translated(), translated()] } },
    { data: { translations: [null] } },
    ...[undefined, '', 42, 'und', 'zxx', 'mul', 'xx', '../../et'].map(language => ({ data: { translations: [
      { translatedText: 'Hello', detectedSourceLanguage: language },
    ] } })),
    ...[undefined, '', 42, 'x'.repeat(24_001)].map(text => ({ data: { translations: [
      { translatedText: text, detectedSourceLanguage: 'et' },
    ] } })),
  ];
  for (const payload of invalid) {
    const translate = createCaptionTranslator('key', { fetch: async () => Response.json(payload) });
    assert.equal(await translate('Tere!'), null);
  }
  const english = createCaptionTranslator('key', { fetch: async () => response(translated('Changed text', 'en')) });
  assert.equal(await english('Already English.'), null);
});

test('empty, non-prose, excessive input and too many segments do not reserve or call the API', async () => {
  const translate = createCaptionTranslator('key', {
    reserve: async () => assert.fail('No budget reservation for invalid captions'),
    fetch: async () => assert.fail('No request for invalid captions'),
  });
  for (const input of ['', ' \n\r\t ', '✨ 123', 'a'.repeat(12_001), Array(129).fill('Tere').join('\n\n'),
    'https://example.com/?a=1 @someone #päev', 'Tere ' + Array(800).fill('@a').join(' ')]) {
    assert.equal(await translate(input), null);
  }
  assert.equal(await createCaptionTranslator(' ', { fetch: async () => assert.fail('Missing key') })('Tere!'), null);
});

test('combined translated output must fit the output cap', async () => {
  const translate = createCaptionTranslator('key', { fetch: async () => response(
    translated('x'.repeat(12_000)), translated('y'.repeat(12_000))) });
  assert.equal(await translate('Tere\n\nAitäh'), null, 'the preserved paragraph separator counts toward the cap');
});

test('coalesces duplicates, reserves once, and never exposes mutable cached values', async () => {
  let complete!: (value: Response) => void, calls = 0, reservations = 0, now = 0;
  const translate = createCaptionTranslator('key', { now: () => now,
    reserve: async count => { reservations++; assert.equal(count, 6); return true; },
    fetch: async () => { calls++; return new Promise(resolve => { complete = resolve; }); },
  });
  const one = translate('Tere 😊'), two = translate('Tere 😊'); await settle();
  assert.equal(calls, 1); assert.equal(reservations, 1); complete(response(translated('Hello 😊')));
  const [first, second] = await Promise.all([one, two]);
  assert(first && second); first.text = 'changed'; first.languages.push('fake');
  assert.deepEqual(second, { text: 'Hello 😊', languages: ['et'] });
  assert.deepEqual(await translate('Tere 😊'), second); assert.equal(reservations, 1);
  now = 300_001; const later = translate('Tere 😊'); await settle();
  assert.equal(calls, 2); assert.equal(reservations, 2); complete(response(translated('Hello again')));
  assert.equal((await later)?.text, 'Hello again');
});

test('limits concurrent external requests to two without queueing unbounded captions', async () => {
  const pending: ((value: Response) => void)[] = [];
  const translate = createCaptionTranslator('key', { fetch: async () => new Promise(resolve => { pending.push(resolve); }) });
  const first = translate('Tere üks'), second = translate('Tere kaks'); await settle();
  assert.equal(await translate('Tere kolm'), null); assert.equal(pending.length, 2);
  pending.forEach(resolve => resolve(response(translated()))); await Promise.all([first, second]);
  const third = translate('Tere kolm'); await settle(); assert.equal(pending.length, 3);
  pending[2](response(translated())); assert(await third);
});

test('limits requests to sixty per minute and does not reserve beyond the limit', async () => {
  let now = 0, calls = 0, reservations = 0;
  const translate = createCaptionTranslator('key', { now: () => now,
    reserve: async () => { reservations++; return true; },
    fetch: async () => { calls++; return response(translated()); },
  });
  for (let i = 0; i < 60; i++) assert(await translate(`Tere ${i}`));
  assert.equal(await translate('Tere veel'), null); assert.equal(calls, 60); assert.equal(reservations, 60);
  now = 60_000; assert(await translate('Tere veel')); assert.equal(calls, 61);
});

test('bounded cache evicts old entries and caches all-English outcomes', async () => {
  let now = 0, calls = 0;
  const translate = createCaptionTranslator('key', { now: () => now, fetch: async () => { calls++; return response(translated()); } });
  for (let i = 0; i < 251; i++) { now += 1000; assert(await translate(`Tere ${i}`)); }
  assert.equal(calls, 251); assert(await translate('Tere 250')); assert.equal(calls, 251);
  now += 1000; assert(await translate('Tere 0')); assert.equal(calls, 252);
  let englishCalls = 0;
  const english = createCaptionTranslator('key', { fetch: async () => { englishCalls++; return response(translated('English', 'en')); } });
  assert.equal(await english('Already English'), null); assert.equal(await english('Already English'), null);
  assert.equal(englishCalls, 1);
});

test('403 and 429 responses open a bounded cooldown instead of repeatedly calling the provider', async () => {
  for (const status of [403, 429]) {
    let now = 0, calls = 0;
    const translate = createCaptionTranslator('key', { now: () => now, fetch: async () => {
      calls++; return calls === 1 ? new Response('private provider error', { status, headers: { 'retry-after': '120' } }) : response(translated());
    } });
    assert.equal(await translate('Tere üks'), null); now = 30_000;
    assert.equal(await translate('Tere kaks'), null); assert.equal(calls, 1);
    now = 300_001; assert(await translate('Tere kolm')); assert.equal(calls, 2);
  }
});

test('denied or failed budget reservations make no external request and can recover', async () => {
  for (const failure of ['deny', 'throw']) {
    let approved = false, calls = 0, reservations = 0;
    const translate = createCaptionTranslator('key', {
      reserve: async () => { reservations++; if (!approved && failure === 'throw') throw new Error('private journal path'); return approved; },
      fetch: async () => { calls++; return response(translated()); },
    });
    assert.equal(await translate('Tere!'), null); assert.equal(calls, 0); assert.equal(reservations, 1);
    approved = true; assert(await translate('Tere!')); assert.equal(calls, 1); assert.equal(reservations, 2);
  }
});

test('rejects oversized declared and streamed responses, malformed JSON and network failures', async () => {
  for (const kind of ['header', 'stream', 'json', 'network']) {
    let cancelled = false;
    const translate = createCaptionTranslator('key', { fetch: async () => {
      if (kind === 'network') throw new Error('private caption and API key');
      if (kind === 'json') return new Response('{bad json');
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(300_000))); },
        cancel() { cancelled = true; },
      }), { headers: kind === 'header' ? { 'content-length': '300000' } : {} });
    } });
    assert.equal(await translate('Tere!'), null);
    if (kind === 'header' || kind === 'stream') assert.equal(cancelled, true);
  }
});

test('five-second deadline covers stalled fetch, stalled body, and a delayed reservation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stage of ['fetch', 'body', 'reserve']) {
    let signal: AbortSignal | undefined, cancelled = false, calls = 0, approve!: (value: boolean) => void;
    const translate = createCaptionTranslator('key', {
      ...(stage === 'reserve' ? { reserve: async () => new Promise<boolean>(resolve => { approve = resolve; }) } : {}),
      fetch: async (_url, options) => {
        calls++; signal = options!.signal!;
        if (stage === 'fetch') return new Promise<Response>(() => {});
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      },
    });
    const result = translate('Tere!'); await settle(); t.mock.timers.tick(5000);
    assert.equal(await result, null);
    if (stage === 'reserve') { approve(true); await settle(); assert.equal(calls, 0); }
    else assert.equal(signal?.aborted, true);
    if (stage === 'body') assert.equal(cancelled, true);
  }
});
