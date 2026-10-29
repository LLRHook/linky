import { constants, inflateSync } from 'node:zlib';

/** What a PDF card may say about a public document; text comes from the file, never from a summary. */
export interface PdfDocument {
  title: string;
  /** Where the title came from; the card names it so a heading or file name is not mistaken for declared metadata. */
  titleSource: 'metadata' | 'first page' | 'file name';
  author?: string;
  pages?: number;
  /** Total file size when the server declared it or the whole file was read. */
  bytes?: number;
  createdAt?: string;
}

// Parsing is synchronous, so every structure it walks is capped: objects, nesting, inflation and content operators.
const MAX_OBJECTS = 50_000, MAX_OBJECT_STREAMS = 256, MAX_DEPTH = 24, MAX_TOKENS = 4_000_000;
const MAX_INFLATED = 4 * 1024 * 1024, MAX_TOTAL_INFLATED = 24 * 1024 * 1024, MAX_CONTENT = 2 * 1024 * 1024;
const MAX_OPERATORS = 60_000, MAX_CMAP_CODES = 65_536;

type Ref = { ref: number };
type Value = number | boolean | null | string | Name | Ref | Value[] | Dict;
type Dict = Map<string, Value>;
class Name { constructor(readonly name: string) {} }
type PdfObject = { value: Value; stream?: { start: number; end: number; data?: Uint8Array } };

const isDict = (value: Value | undefined): value is Dict => value instanceof Map;
const isRef = (value: Value | undefined): value is Ref => typeof value === 'object' && value !== null && !Array.isArray(value) &&
  !(value instanceof Map) && !(value instanceof Name) && 'ref' in value;
const nameOf = (value: Value | undefined) => value instanceof Name ? value.name : undefined;

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set('()<>[]{}/%'.split('').map(char => char.charCodeAt(0)));

/** A bounded PDF tokenizer over a latin1 view of the bytes (one character per byte). */
class Lexer {
  /** Shared by every lexer over one file, so hostile structure cannot multiply the work. */
  constructor(readonly text: string, public position = 0, readonly end = text.length, readonly budget = { tokens: MAX_TOKENS }) {}
  private skip(): void {
    while (this.position < this.end) {
      const code = this.text.charCodeAt(this.position);
      if (WHITESPACE.has(code)) this.position++;
      else if (code === 37) { // % comment
        while (this.position < this.end && !/[\r\n]/.test(this.text[this.position])) this.position++;
      } else break;
    }
  }
  /** The next keyword without consuming it, or undefined at a value or the end. */
  peekKeyword(): string | undefined {
    this.skip();
    const match = /[A-Za-z'"*]+/y;
    match.lastIndex = this.position;
    const found = match.exec(this.text);
    return found && found.index < this.end ? found[0] : undefined;
  }
  /** One value, a keyword (as `{ keyword }`), or undefined at the end. */
  next(depth = 0): Value | { keyword: string } | undefined {
    if (--this.budget.tokens < 0 || depth > MAX_DEPTH) throw new Error('pdf_limits');
    this.skip();
    if (this.position >= this.end) return undefined;
    const text = this.text, char = text[this.position];
    if (char === '<' && text[this.position + 1] === '<') {
      this.position += 2;
      const dict: Dict = new Map();
      for (;;) {
        this.skip();
        if (this.position >= this.end) throw new Error('pdf_syntax');
        if (text.startsWith('>>', this.position)) { this.position += 2; return dict; }
        const key = this.next(depth + 1);
        if (!(key instanceof Name)) throw new Error('pdf_syntax');
        const value = this.value(depth + 1);
        if (!dict.has(key.name) && dict.size < 512) dict.set(key.name, value);
      }
    }
    if (char === '[') {
      this.position++;
      const array: Value[] = [];
      for (;;) {
        this.skip();
        if (this.position >= this.end) throw new Error('pdf_syntax');
        if (text[this.position] === ']') { this.position++; return array; }
        const value = this.value(depth + 1);
        if (array.length < 4096) array.push(value);
      }
    }
    if (char === '<') {
      const close = text.indexOf('>', this.position);
      if (close < 0 || close >= this.end) throw new Error('pdf_syntax');
      let hex = text.slice(this.position + 1, close).replace(/[\0\t\n\f\r ]/g, '');
      this.position = close + 1;
      if (!/^[0-9a-f]*$/i.test(hex)) throw new Error('pdf_syntax');
      if (hex.length % 2) hex += '0';
      return hex.replace(/../g, pair => String.fromCharCode(parseInt(pair, 16)));
    }
    if (char === '(') return this.literal();
    if (char === '/') {
      let cursor = this.position + 1;
      while (cursor < this.end && !WHITESPACE.has(text.charCodeAt(cursor)) && !DELIMITERS.has(text.charCodeAt(cursor))) cursor++;
      const raw = text.slice(this.position + 1, cursor);
      this.position = cursor;
      return new Name(raw.replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
    }
    const number = /[+-]?(?:\d+\.?\d*|\.\d+)/y;
    number.lastIndex = this.position;
    const numeric = number.exec(text);
    if (numeric && numeric.index < this.end) {
      this.position = number.lastIndex;
      return Number(numeric[0]);
    }
    const word = /[A-Za-z'"*]+/y;
    word.lastIndex = this.position;
    const keyword = word.exec(text);
    if (keyword && keyword.index < this.end) {
      this.position = word.lastIndex;
      if (keyword[0] === 'true' || keyword[0] === 'false') return keyword[0] === 'true';
      if (keyword[0] === 'null') return null;
      return { keyword: keyword[0] };
    }
    this.position++;
    return { keyword: char };
  }
  /** A value, folding `n g R` into a reference; keywords are not values here. */
  value(depth = 0): Value {
    const value = this.next(depth);
    if (value === undefined || isKeyword(value)) throw new Error('pdf_syntax');
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      // `n g R` is recognised textually; a parsed lookahead could re-read nested values repeatedly.
      const reference = /[\0\t\n\f\r ]+\d{1,5}[\0\t\n\f\r ]+R(?![A-Za-z0-9])/y;
      reference.lastIndex = this.position;
      if (reference.exec(this.text) && reference.lastIndex <= this.end) {
        this.position = reference.lastIndex;
        return { ref: value };
      }
    }
    return value;
  }
  private literal(): string {
    const text = this.text;
    let cursor = this.position + 1, nesting = 1, result = '';
    const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    while (cursor < this.end) {
      const char = text[cursor++];
      if (char === '\\') {
        const next = text[cursor++] ?? '';
        if (next in escapes) result += escapes[next];
        else if (/[0-7]/.test(next)) {
          let octal = next;
          while (octal.length < 3 && /[0-7]/.test(text[cursor] ?? '')) octal += text[cursor++];
          result += String.fromCharCode(parseInt(octal, 8) & 0xff);
        } else if (next === '\r') { if (text[cursor] === '\n') cursor++; }
        else if (next !== '\n') result += next;
      } else if (char === '(') { nesting++; result += char; }
      else if (char === ')') { if (!--nesting) { this.position = cursor; return result; } result += char; }
      else result += char;
      if (result.length > 65_536) throw new Error('pdf_limits');
    }
    throw new Error('pdf_syntax');
  }
}

const isKeyword = (value: unknown): value is { keyword: string } =>
  typeof value === 'object' && value !== null && 'keyword' in value;

// PDFDocEncoding differs from Latin-1 only in 0x80-0x9e (and a few unused low codes).
const PDF_DOC = '•†‡…—–ƒ⁄‹›−‰„“”‘’‚™ﬁﬂŁŒŠŸŽıłœšž';

/** A PDF text string: UTF-16BE or UTF-8 with a byte-order mark, otherwise PDFDocEncoding. */
function textString(bytes: string): string {
  if (bytes.startsWith('\xfe\xff')) {
    let result = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) result += String.fromCharCode(bytes.charCodeAt(index) << 8 | bytes.charCodeAt(index + 1));
    return result;
  }
  if (bytes.startsWith('\xef\xbb\xbf')) return Buffer.from(bytes.slice(3), 'latin1').toString('utf8');
  return bytes.replace(/[\x80-\x9e]/g, char => PDF_DOC[char.charCodeAt(0) - 0x80] ?? ' ');
}

const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufffd]/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** Declared titles that only repeat a template, an editor's file name or a placeholder are not titles. */
function usableTitle(raw: string | undefined): string | undefined {
  const title = clean(raw ?? '').replace(/^Microsoft (?:Word|PowerPoint|Excel) - /i, '');
  if (title.length < 3 || title.length > 400 || !/\p{L}/u.test(title) ||
      /^(?:untitled|title|document|slide \d+|no title|microsoft word|presentation\d*|layout \d+|\(?anonymous\)?)$/i.test(title) ||
      /\.(?:docx?|pdf|tex|dvi|pptx?|xlsx?|odt|rtf|indd|qxd|ps|eps|txt|html?)$/i.test(title)) return undefined;
  return title;
}

function pdfDate(raw: string | undefined): string | undefined {
  const date = /^(?:D:)?(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?(Z|[+-]\d\d'?\d\d'?|[+-]\d\d)?/.exec(clean(raw ?? ''));
  if (!date) return undefined;
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', zone] = date;
  const offset = !zone || zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.replace(/'/g, '').slice(3, 5) || '00'}`;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`, time = Date.parse(iso);
  return Number.isFinite(time) && Number(year) >= 1990 && time <= Date.now() + 86_400_000 ? new Date(time).toISOString() : undefined;
}

/** The bounded object graph of a (possibly truncated) PDF. */
class PdfFile {
  readonly objects = new Map<number, PdfObject>();
  readonly trailers: Dict[] = [];
  private inflated = 0;
  private readonly budget = { tokens: MAX_TOKENS };
  constructor(readonly bytes: Uint8Array, readonly text: string) {
    this.scan();
    const containers = [...this.objects.values()].filter(object => object.stream && isDict(object.value) &&
      nameOf(object.value.get('Type')) === 'ObjStm').slice(0, MAX_OBJECT_STREAMS);
    for (const object of containers) this.expand(object);
  }
  /** Direct objects in file order; later definitions (incremental updates) replace earlier ones. */
  private scan(): void {
    const header = /(\d{1,7})[\0\t\n\f\r ]+\d{1,5}[\0\t\n\f\r ]+obj\b/g;
    for (let match = header.exec(this.text); match && this.objects.size < MAX_OBJECTS; match = header.exec(this.text)) {
      const lexer = new Lexer(this.text, header.lastIndex, this.text.length, this.budget);
      try {
        const value = lexer.value();
        const object: PdfObject = { value };
        if (lexer.peekKeyword() === 'stream' && isDict(value)) {
          lexer.next();
          let start = lexer.position;
          if (this.text[start] === '\r') start++;
          if (this.text[start] === '\n') start++;
          const length = value.get('Length');
          let end = typeof length === 'number' && Number.isInteger(length) && length >= 0 && start + length <= this.text.length &&
            /^[\r\n]*endstream/.test(this.text.slice(start + length, start + length + 12)) ? start + length : -1;
          if (end < 0) {
            const found = this.text.indexOf('endstream', start);
            end = found < 0 ? this.text.length : found;
            while (end > start && /[\r\n]/.test(this.text[end - 1])) end--;
          }
          object.stream = { start, end };
          header.lastIndex = Math.max(header.lastIndex, end);
        } else header.lastIndex = Math.max(header.lastIndex, lexer.position);
        this.objects.set(Number(match[1]), object);
        if (isDict(value) && nameOf(value.get('Type')) === 'XRef') this.trailers.push(value);
      } catch { /* A damaged or truncated object is skipped. */ }
    }
    const trailer = /\btrailer\b/g;
    for (let match = trailer.exec(this.text); match && this.trailers.length < 64; match = trailer.exec(this.text)) {
      try {
        const value = new Lexer(this.text, trailer.lastIndex, this.text.length, this.budget).value();
        if (isDict(value)) this.trailers.push(value);
      } catch { /* Truncated trailers carry nothing usable. */ }
    }
  }
  private expand(object: PdfObject): void {
    if (!isDict(object.value)) return;
    const data = this.streamData(object), count = object.value.get('N'), first = object.value.get('First');
    if (!data || typeof count !== 'number' || typeof first !== 'number' || count > MAX_OBJECTS || first > data.length) return;
    const text = Buffer.from(data).toString('latin1'), lexer = new Lexer(text, 0, first, this.budget);
    const entries: [number, number][] = [];
    for (let index = 0; index < count; index++) {
      const id = lexer.next(), offset = lexer.next();
      if (typeof id !== 'number' || typeof offset !== 'number') break;
      entries.push([id, offset]);
    }
    for (const [id, offset] of entries) {
      if (this.objects.has(id) || this.objects.size >= MAX_OBJECTS) continue;
      if (offset < 0 || first + offset >= text.length) continue;
      try { this.objects.set(id, { value: new Lexer(text, first + offset, text.length, this.budget).value() }); }
      catch (error) { if (this.budget.tokens < 0) throw error; /* Skip a damaged member. */ }
    }
  }
  resolve(value: Value | undefined, depth = 0): Value | undefined {
    while (isRef(value) && depth++ < 16) value = this.objects.get(value.ref)?.value;
    return isRef(value) ? undefined : value;
  }
  dict(value: Value | undefined): Dict | undefined {
    const resolved = this.resolve(value);
    return isDict(resolved) ? resolved : undefined;
  }
  stream(value: Value | undefined): Uint8Array | undefined {
    let depth = 0;
    while (isRef(value) && depth++ < 16) {
      const object = this.objects.get(value.ref);
      if (!object) return undefined;
      if (object.stream) return this.streamData(object);
      value = object.value;
    }
    return undefined;
  }
  /** Flate or unfiltered stream data, inflated within the per-stream and per-file budgets. */
  streamData(object: PdfObject): Uint8Array | undefined {
    if (!object.stream || !isDict(object.value)) return undefined;
    if (object.stream.data) return object.stream.data;
    const filter = object.value.get('Filter'), filters = Array.isArray(filter) ? filter.map(nameOf) : filter === undefined ? [] : [nameOf(filter)];
    const raw = this.bytes.subarray(object.stream.start, object.stream.end);
    if (filters.length > 1 || filters.some(name => name !== 'FlateDecode' && name !== 'Fl')) return undefined;
    let data: Uint8Array = raw;
    if (filters.length) {
      const budget = Math.min(MAX_INFLATED, MAX_TOTAL_INFLATED - this.inflated);
      if (budget <= 0) return undefined;
      try { data = inflateSync(raw, { maxOutputLength: budget, finishFlush: constants.Z_SYNC_FLUSH }); }
      catch { return undefined; }
      this.inflated += data.byteLength;
    }
    object.stream.data = data;
    return data;
  }
  /** The latest trailer naming a document catalog. */
  trailer(key: 'Root' | 'Info'): Dict | undefined {
    for (const trailer of [...this.trailers].reverse()) {
      const dict = this.dict(trailer.get(key));
      if (dict) return dict;
    }
    if (key === 'Root') for (const object of this.objects.values()) {
      if (isDict(object.value) && nameOf(object.value.get('Type')) === 'Catalog') return object.value;
    }
    return undefined;
  }
}

/** A font's code-to-text decoder from its ToUnicode CMap or simple encoding; undefined when its text is not recoverable. */
type FontDecoder = { width: 1 | 2; decode: (code: number) => string | undefined };

const GLYPHS: Record<string, string> = { space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quoteright: '’', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',',
  hyphen: '-', minus: '−', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>',
  question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', underscore: '_', quoteleft: '‘',
  braceleft: '{', bar: '|', braceright: '}', endash: '–', emdash: '—', quotedblleft: '“', quotedblright: '”',
  ff: 'ff', fi: 'fi', fl: 'fl', ffi: 'ffi', ffl: 'ffl', dotlessi: 'ı', bullet: '•', ellipsis: '…', dieresis: '¨',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

function glyphText(name: string): string | undefined {
  if (/^[A-Za-z]$/.test(name)) return name;
  const unicode = /^uni([0-9A-F]{4})$/.exec(name);
  return unicode ? String.fromCharCode(parseInt(unicode[1], 16)) : GLYPHS[name];
}

function parseCMap(text: string): FontDecoder | undefined {
  const map = new Map<number, string>();
  const utf16 = (hex: string) => {
    let result = '';
    for (let index = 0; index + 3 < hex.length; index += 4) result += String.fromCharCode(parseInt(hex.slice(index, index + 4), 16));
    return result;
  };
  let width: 1 | 2 = 1;
  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (space && /<[0-9a-f]{4}>/i.test(space[1])) width = 2;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-f]{1,8})>\s*<([0-9a-f]{0,64})>/gi)) {
      if (map.size >= MAX_CMAP_CODES) break;
      map.set(parseInt(pair[1], 16), utf16(pair[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1].matchAll(/<([0-9a-f]{1,8})>\s*<([0-9a-f]{1,8})>\s*(?:<([0-9a-f]{0,64})>|\[([^\]]{0,65536})\])/gi)) {
      const low = parseInt(range[1], 16), high = parseInt(range[2], 16);
      if (high < low || high - low > MAX_CMAP_CODES || map.size + high - low > MAX_CMAP_CODES) continue;
      const listed = range[4] ? [...range[4].matchAll(/<([0-9a-f]{0,64})>/gi)].map(item => utf16(item[1])) : undefined;
      const base = range[3] ?? '';
      for (let code = low; code <= high; code++) {
        if (listed) { if (listed[code - low] !== undefined) map.set(code, listed[code - low]); continue; }
        // The last UTF-16 unit increments across the range.
        const prefix = utf16(base.slice(0, -4)), last = parseInt(base.slice(-4) || '0', 16) + code - low;
        map.set(code, prefix + String.fromCharCode(last & 0xffff));
      }
    }
  }
  return map.size ? { width, decode: code => map.get(code) } : undefined;
}

function fontDecoder(file: PdfFile, font: Dict | undefined): FontDecoder | undefined {
  if (!font) return undefined;
  const toUnicode = file.stream(font.get('ToUnicode'));
  if (toUnicode) return parseCMap(Buffer.from(toUnicode.subarray(0, 512 * 1024)).toString('latin1'));
  if (nameOf(font.get('Subtype')) === 'Type0') return undefined;
  const differences = new Map<number, string>();
  const encoding = file.resolve(font.get('Encoding'));
  const list = isDict(encoding) ? file.resolve(encoding.get('Differences')) : undefined;
  if (Array.isArray(list)) {
    let code = 0;
    for (const item of list) {
      if (typeof item === 'number') code = item;
      else if (item instanceof Name) differences.set(code++, item.name);
    }
  }
  const named = nameOf(isDict(encoding) ? encoding.get('BaseEncoding') : encoding);
  if (named && !['WinAnsiEncoding', 'StandardEncoding', 'MacRomanEncoding', 'PDFDocEncoding'].includes(named)) return undefined;
  return { width: 1, decode: code => {
    const glyph = differences.get(code);
    if (glyph !== undefined) return glyphText(glyph);
    // Printable ASCII is shared by the standard simple encodings; other codes are not guessed.
    return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : undefined;
  } };
}

/** `upright` is false for rotated or skewed text, such as an arXiv margin stamp. */
type Run = { size: number; text: string; line: number; upright: boolean };

/** Text runs of the first page, with their effective type size, in content order. */
function firstPageRuns(file: PdfFile): Run[] {
  const root = file.trailer('Root');
  let node = file.dict(root?.get('Pages')), resources = file.dict(node?.get('Resources'));
  for (let depth = 0; node && nameOf(node.get('Type')) !== 'Page' && depth < 16; depth++) {
    const kids = file.resolve(node.get('Kids'));
    node = Array.isArray(kids) ? file.dict(kids[0]) : undefined;
    resources = file.dict(node?.get('Resources')) ?? resources;
  }
  if (!node) return [];
  const contents = file.resolve(node.get('Contents'));
  const parts = (Array.isArray(contents) ? contents : [node.get('Contents')]).slice(0, 64).map(part => file.stream(part));
  if (parts.some(part => !part)) return [];
  let content = '';
  for (const part of parts as Uint8Array[]) {
    content += Buffer.from(part).toString('latin1') + '\n';
    if (content.length > MAX_CONTENT) return [];
  }
  const fonts = file.dict(resources?.get('Font'));
  const decoders = new Map<string, FontDecoder | undefined>();
  const runs: Run[] = [];
  const lexer = new Lexer(content, 0, content.length, { tokens: MAX_OPERATORS * 4 });
  let operands: Value[] = [], operators = 0, font: FontDecoder | undefined, size = 0, scale = 1, leading = 0, line = 0, y = 0, upright = true;
  const show = (value: Value) => {
    if (typeof value !== 'string' || !value) return '';
    // Text in a font without recoverable codes still has a size; it must not let a smaller line pose as the heading.
    if (!font) return '\ufffd';
    let text = '';
    for (let index = 0; index + font.width <= value.length; index += font.width) {
      const code = font.width === 2 ? value.charCodeAt(index) << 8 | value.charCodeAt(index + 1) : value.charCodeAt(index);
      const decoded = font.decode(code);
      if (decoded === undefined) return '\ufffd';
      text += decoded;
    }
    return text;
  };
  const emit = (text: string) => {
    if (text) runs.push({ size: Math.round(Math.abs(size * scale) * 10) / 10, text, line, upright });
  };
  const moveTo = (next: number) => { if (Math.abs(next - y) > 0.5) line++; y = next; };
  for (;;) {
    let token: ReturnType<Lexer['next']>;
    try { token = lexer.next(); } catch { break; }
    if (token === undefined || ++operators > MAX_OPERATORS) break;
    if (!isKeyword(token)) { if (operands.length < 64) operands.push(token); continue; }
    const op = token.keyword, number = (index: number) => typeof operands[index] === 'number' ? operands[index] as number : 0;
    if (op === 'BI') { // Inline image data is binary; skip to its end marker.
      const end = content.indexOf('EI', lexer.position);
      if (end < 0) break;
      lexer.position = end + 2;
    } else if (op === 'BT') { scale = 1; upright = true; }
    else if (op === 'Tf') {
      const name = nameOf(operands[0]);
      if (name && !decoders.has(name)) decoders.set(name, fontDecoder(file, file.dict(fonts?.get(name))));
      font = name ? decoders.get(name) : undefined;
      size = number(1);
    } else if (op === 'Tm') {
      scale = Math.hypot(number(2), number(3)) || Math.hypot(number(0), number(1)) || 1;
      upright = Math.abs(number(1)) <= Math.abs(number(0)) / 1000 && Math.abs(number(2)) <= Math.abs(number(3)) / 1000 && number(0) > 0 && number(3) > 0;
      moveTo(number(5));
    } else if (op === 'Td' || op === 'TD') {
      if (op === 'TD') leading = -number(1);
      if (number(1)) moveTo(y + number(1) * scale);
      else if (number(0) > 0 && runs.length && !runs.at(-1)!.text.endsWith(' ')) emit(' ');
    } else if (op === 'TL') leading = number(0);
    else if (op === 'T*' || op === "'" || op === '"') {
      moveTo(y - leading * scale);
      if (op !== 'T*') emit(show(operands.at(-1)!));
    } else if (op === 'Tj') emit(show(operands[0]));
    else if (op === 'TJ' && Array.isArray(operands[0])) {
      let text = '';
      for (const item of operands[0]) {
        if (typeof item === 'number') { if (item < -180 && !text.endsWith(' ')) text += ' '; }
        else text += show(item);
      }
      emit(text);
    } else if (op === 'ET') line++;
    operands = [];
  }
  return runs;
}

/** The first block of the page's largest type, when it is clearly larger than the body and reads as words. */
function headingTitle(runs: Run[]): string | undefined {
  const real = runs.filter(run => run.text.trim() && run.size > 0 && run.upright);
  if (!real.length) return undefined;
  const bySize = new Map<number, number>();
  for (const run of real) bySize.set(run.size, (bySize.get(run.size) ?? 0) + run.text.length);
  const body = [...bySize].sort((a, b) => b[1] - a[1])[0][0];
  const largest = Math.max(...real.map(run => run.size));
  if (largest < body * 1.15) return undefined;
  let title = '', started = false, line = -1;
  for (const run of runs) {
    if (!run.upright) continue;
    const heading = Math.abs(run.size - largest) < 0.25;
    if (!heading) {
      // A footnote mark or tiny decoration inside a heading does not end it.
      if (started && (run.text.trim().length > 2 || run.size > largest * 0.6)) break;
      continue;
    }
    if (started && run.line !== line && !/[\s-]$/.test(title)) title += ' ';
    title += run.text; started = true; line = run.line;
    if (title.length > 400) return undefined;
  }
  const result = clean(title);
  const words = result.split(' ').filter(word => /\p{L}/u.test(word));
  if (result.includes('\ufffd') || words.length < 1 || result.length < 4 ||
      words.reduce((total, word) => total + word.length, 0) / words.length < 2.5) return undefined;
  return usableTitle(result);
}

function fileName(url: URL): string {
  const segment = url.pathname.split('/').filter(Boolean).at(-1) ?? url.hostname;
  let name = segment;
  try { name = decodeURIComponent(segment); } catch { /* Keep the encoded name. */ }
  return clean(name).slice(0, 200) || url.hostname;
}

export function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 1024)).toString('latin1').includes('%PDF-');
}

/** Card facts from a public PDF (possibly only a prefix of it); falls back to a labelled file name. */
export function parsePdf(bytes: Uint8Array, url: URL, totalBytes?: number): PdfDocument | null {
  if (!isPdf(bytes)) return null;
  const text = Buffer.from(bytes).toString('latin1');
  const result: PdfDocument = { title: fileName(url), titleSource: 'file name',
    ...(totalBytes && totalBytes > 0 ? { bytes: totalBytes } : {}) };
  let file: PdfFile;
  try { file = new PdfFile(bytes, text); } catch { return result; }
  const encrypted = file.trailers.some(trailer => trailer.has('Encrypt'));
  try {
    const root = file.trailer('Root'), pages = file.dict(root?.get('Pages'))?.get('Count');
    const count = typeof pages === 'number' ? pages : Math.max(0, ...[...file.objects.values()].map(object =>
      isDict(object.value) && nameOf(object.value.get('Type')) === 'Pages' && typeof object.value.get('Count') === 'number'
        ? object.value.get('Count') as number : 0));
    if (Number.isInteger(count) && count > 0 && count <= 100_000) result.pages = count;
    // Encrypted strings are ciphertext; only structure (the page count) is meaningful.
    if (encrypted) return result;
    const info = file.trailer('Info');
    const infoText = (key: string) => { const value = file.resolve(info?.get(key)); return typeof value === 'string' ? textString(value) : undefined; };
    const metadata = file.stream(root?.get('Metadata'));
    const xmp = metadata && /<dc:title>[\s\S]{0,2000}?<rdf:li[^>]*>([\s\S]{0,2000}?)<\/rdf:li>/.exec(Buffer.from(metadata.subarray(0, 256 * 1024)).toString('utf8'));
    const xmpTitle = xmp?.[1].replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/gi, (_, entity: string) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ??
      String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))));
    const author = usableTitle(infoText('Author'));
    if (author && author.length <= 300) result.author = author;
    const created = pdfDate(infoText('CreationDate'));
    if (created) result.createdAt = created;
    const declared = usableTitle(infoText('Title')) ?? usableTitle(xmpTitle);
    if (declared) return { ...result, title: declared, titleSource: 'metadata' };
    const heading = headingTitle(firstPageRuns(file));
    if (heading) return { ...result, title: heading, titleSource: 'first page' };
  } catch { /* Malformed structure keeps the labelled file name. */ }
  return result;
}

export function formatPdfSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}
