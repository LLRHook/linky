export interface EnglishCaption { text: string; languages: string[] }
interface Options {
  fetch?: typeof fetch;
  now?: () => number;
  reserve?: (characters: number) => Promise<boolean>;
}

const TTL = 5 * 60_000, BODY_LIMIT = 256_000;
const languages = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
const entities = new Map(Object.entries({ amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>',
  quot: '"', QUOT: '"', apos: "'", nbsp: '\u00a0', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»' }));
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const copy = (value: EnglishCaption | null): EnglishCaption | null =>
  value ? { text: value.text, languages: [...value.languages] } : null;

/** Decode one layer of API escaping, never HTML tags or recursively escaped user text. */
function unescape(text: string): string {
  return text.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return entities.get(name) ?? entity;
    const hex = name[1].toLowerCase() === 'x';
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

interface Segment { index: number; text: string; leading: string; trailing: string; tokens: [string, string][] }
function segmentsOf(text: string): { parts: string[]; segments: Segment[] } | null {
  if (!text.trim() || text.length > 24_000 || Array.from(text).length > 12_000) return null;
  // Blank lines and divider lines separate captions; single newlines often just hard-wrap a sentence.
  const parts: string[] = [], lines = text.split(/(\r\n|\r|\n)/), segments: Segment[] = [];
  let paragraph = '', prefix = '__LINKY_TOKEN_';
  while (text.includes(prefix)) prefix += '_';
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index], ending = lines[index + 1] ?? '';
    if (!line.trim() || /^[ \t]*[-–—_=*•.]+[ \t]*$/.test(line)) {
      if (paragraph) parts.push(paragraph);
      paragraph = ''; parts.push(line + ending);
    } else paragraph += line + ending;
  }
  if (paragraph) parts.push(paragraph);
  for (const [index, part] of parts.entries()) {
    const text = part.trim();
    const tokens: [string, string][] = [];
    const protectedText = text.replace(/(?:https?:\/\/|www\.)[^\s<>]+|(?<![\p{L}\p{M}\p{N}_])[#@][\p{L}\p{M}\p{N}_][\p{L}\p{M}\p{N}_.]*/giu, value => {
      const marker = `${prefix}${tokens.length}__`;
      tokens.push([marker, value]); return marker;
    });
    if (!/\p{L}/u.test(tokens.reduce((value, [marker]) => value.replace(marker, ''), protectedText))) continue;
    const start = part.indexOf(text);
    segments.push({ index, text: protectedText, tokens, leading: part.slice(0, start), trailing: part.slice(start + text.length) });
  }
  return segments.length && segments.length <= 128 &&
    segments.reduce((count, segment) => count + Array.from(segment.text).length, 0) <= 12_000 ? { parts, segments } : null;
}

function parseCaption(payload: unknown, source: NonNullable<ReturnType<typeof segmentsOf>>): EnglishCaption | null {
  const translations = record(record(payload).data).translations;
  if (!Array.isArray(translations) || translations.length !== source.segments.length) return null;
  const parts = [...source.parts], detected = new Set<string>();
  for (const [index, item] of translations.entries()) {
    const value = record(item), language = typeof value.detectedSourceLanguage === 'string'
      ? value.detectedSourceLanguage.toLowerCase() : '';
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language) || ['und', 'zxx', 'mul'].includes(language.split('-')[0]) ||
        !languages.of(language) || typeof value.translatedText !== 'string' || !value.translatedText.trim() ||
        value.translatedText.length > 24_000) return null;
    if (language.split('-')[0] === 'en') continue;
    const segment = source.segments[index];
    let translated = unescape(value.translatedText).trim();
    for (const [marker, token] of segment.tokens) {
      // A changed or repeated placeholder cannot be restored safely; retain the original caption instead.
      if (translated.split(marker).length !== 2) return null;
      translated = translated.replace(marker, () => token);
    }
    parts[segment.index] = segment.leading + translated + segment.trailing;
    detected.add(language);
  }
  const text = parts.join('');
  return detected.size && text.length <= 24_000 ? { text, languages: [...detected] } : null;
}

/** Google Basic v2: autodetect each paragraph, with bounded requests and optional durable budget admission. */
export function createCaptionTranslator(apiKey: string, options: Options = {}) {
  const fetchText = options.fetch ?? fetch, now = options.now ?? Date.now;
  const cache = new Map<string, { value: EnglishCaption | null; expiresAt: number }>();
  const pending = new Map<string, Promise<EnglishCaption | null>>();
  let starts: { time: number; sent: boolean }[] = [], blockedUntil = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  function expire(): void {
    clearTimeout(expiryTimer);
    for (const [key, entry] of cache) if (entry.expiresAt <= now()) cache.delete(key);
    if (cache.size) {
      expiryTimer = setTimeout(expire, Math.max(1, Math.min(...[...cache.values()].map(entry => entry.expiresAt)) - now()));
      expiryTimer.unref();
    }
  }

  async function request(source: NonNullable<ReturnType<typeof segmentsOf>>, slot: typeof starts[number]) {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<null>(resolve => {
      timer = setTimeout(() => {
        controller.abort(); void reader?.cancel().catch(() => {}); resolve(null);
      }, 5000);
    });
    const perform = async (): Promise<{ value: EnglishCaption | null } | null> => {
      const q = source.segments.map(segment => segment.text);
      if (options.reserve && !await options.reserve(q.reduce((count, text) => count + Array.from(text).length, 0))) return null;
      if (controller.signal.aborted || now() < blockedUntil) return null;
      slot.sent = true; slot.time = now();
      const response = await fetchText('https://translation.googleapis.com/language/translate/v2', {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Goog-Api-Key': apiKey.trim() },
        body: JSON.stringify({ q, target: 'en', format: 'text' }), signal: controller.signal, redirect: 'error',
      });
      if (!response.ok || controller.signal.aborted || Number(response.headers.get('content-length')) > BODY_LIMIT) {
        if ([403, 429].includes(response.status)) {
          const value = response.headers.get('retry-after') ?? '';
          const retry = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now();
          blockedUntil = Math.max(blockedUntil, now() + Math.min(TTL, Math.max(response.status === 403 ? TTL : 60_000, retry || 0)));
        }
        void response.body?.cancel().catch(() => {}); return null;
      }
      reader = response.body?.getReader();
      if (!reader) return null;
      const body = Buffer.alloc(BODY_LIMIT);
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > BODY_LIMIT) return null;
        body.set(value, size); size += value.byteLength;
      }
      if (controller.signal.aborted) return null;
      return { value: parseCaption(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, size))), source) };
    };
    try { return await Promise.race([perform(), deadline]); }
    catch { return null; }
    finally { clearTimeout(timer!); void reader?.cancel().catch(() => {}); }
  }

  return async (text: string): Promise<EnglishCaption | null> => {
    if (!apiKey.trim() || typeof text !== 'string') return null;
    expire();
    const cached = cache.get(text);
    if (cached) return copy(cached.value);
    const waiting = pending.get(text);
    if (waiting) return copy(await waiting);
    const source = segmentsOf(text);
    starts = starts.filter(slot => slot.time > now() - 60_000);
    if (!source || pending.size >= 2 || starts.length >= 60 || now() < blockedUntil) return null;
    const slot = { time: now(), sent: false }; starts.push(slot);
    const work = request(source, slot).then(result => {
      if (result) {
        cache.set(text, { value: result.value, expiresAt: now() + TTL });
        while (cache.size > 250) cache.delete(cache.keys().next().value!);
        expire();
      }
      return result?.value ?? null;
    }).finally(() => {
      pending.delete(text);
      if (!slot.sent) starts = starts.filter(value => value !== slot);
    });
    pending.set(text, work);
    return copy(await work);
  };
}
