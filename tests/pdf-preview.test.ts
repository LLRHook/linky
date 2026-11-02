import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { formatPdfSize, isPdf, parsePdf } from '../src/services/PdfPreview';
import { buildPdf, kitpPdf, pdfTitle, pdfUrl, simplePdf } from './fixtures/pdf';

const url = new URL(pdfUrl);
const heading = (title: string) => `BT /F1 24 Tf 72 720 Td (${title}) Tj ET BT /F1 11 Tf 72 680 Td (The body of the document is set in a smaller size than its heading.) Tj ET`;

test('the reported KITP PDF takes its first-page heading through object streams, ToUnicode maps and TJ kerning', () => {
  const bytes = kitpPdf();
  assert.deepEqual(parsePdf(bytes, url, bytes.length), { title: pdfTitle, titleSource: 'first page', bytes: bytes.length,
    pages: 2, createdAt: '2026-10-27T20:25:56.000Z' });
});

test('declared document titles take precedence, including UTF-16 titles, with the declared author', () => {
  const utf16 = Buffer.from('\ufeffR\u00e9sum\u00e9 of findings', 'utf16le').swap16().toString('hex');
  const result = parsePdf(simplePdf({ info: `<< /Title <${utf16}> /Author (Ada Lovelace) /CreationDate (D:20240102030405+05'30') >>`,
    content: heading('A different first-page heading') }), url);
  assert.equal(result?.title, 'R\u00e9sum\u00e9 of findings'); assert.equal(result?.titleSource, 'metadata');
  assert.equal(result?.author, 'Ada Lovelace'); assert.equal(result?.createdAt, '2024-01-01T21:34:05.000Z');
});

test('XMP titles are used when the information dictionary has none', () => {
  const metadata = '<x:xmpmeta><rdf:RDF><rdf:Description><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Annual &amp; Quarterly Report</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>';
  assert.equal(parsePdf(simplePdf({ metadata }), url)?.title, 'Annual & Quarterly Report');
});

test('placeholder and editor file-name titles fall through to the first-page heading', () => {
  for (const title of ['Microsoft Word - draft.docx', 'untitled', 'slides.pptx', '   ', 'Title']) {
    const result = parsePdf(simplePdf({ info: `<< /Title (${title}) >>`, content: heading('Quarterly Results Summary') }), url);
    assert.equal(result?.title, 'Quarterly Results Summary', title); assert.equal(result?.titleSource, 'first page');
  }
  assert.equal(parsePdf(simplePdf({ info: '<< /Title (Microsoft Word - Quarterly Plan) >>' }), url)?.title, 'Quarterly Plan');
});

test('rotated margin stamps are not headings', () => {
  // As on arXiv, the sideways stamp is set larger than the title.
  const stamp = 'BT /F1 1 Tf 0 30 -30 0 30 300 Tm (arXiv:1706.03762v7 [cs.CL] 2 Aug 2023) Tj ET ';
  assert.equal(parsePdf(simplePdf({ content: stamp + heading('Attention Is All You Need') }), url)?.title, 'Attention Is All You Need');
});

test('without a usable title the card names the file, labelled as a file name', () => {
  const cases = [
    'BT /F1 11 Tf 72 720 Td (Only body text at one size.) Tj ET',
    // The largest text is in a font whose codes cannot be decoded; a smaller line must not stand in for it.
    'BT /F2 30 Tf 72 720 Td <00410042> Tj ET BT /F1 18 Tf 72 690 Td (Smaller subtitle line) Tj ET BT /F1 11 Tf 72 600 Td (Body text that is clearly longer than the subtitle line above it.) Tj ET',
    // Glyph-by-glyph placement does not read as words.
    'BT /F1 24 Tf 72 720 Td (T) Tj 10 0 Td (i) Tj 10 0 Td (t) Tj 10 0 Td (l) Tj 10 0 Td (e) Tj ET BT /F1 11 Tf 72 600 Td (Body text that is longer than the heading.) Tj ET',
  ];
  for (const content of cases) {
    assert.deepEqual(parsePdf(simplePdf({ content }), url), { title: 'YM_working_group.pdf', titleSource: 'file name', pages: 1 }, content);
  }
  assert.equal(parsePdf(simplePdf(), new URL('https://example.com/papers/Quarterly%20Report.pdf'))?.title, 'Quarterly Report.pdf');
});

test('encrypted documents expose only their page count and file name', () => {
  const result = parsePdf(simplePdf({ info: '<< /Title (Ciphertext title) /Author (Someone) >>', content: heading('Ciphertext heading'),
    trailerExtra: ' /Encrypt << /Filter /Standard >>' }), url);
  assert.deepEqual(result, { title: 'YM_working_group.pdf', titleSource: 'file name', pages: 1 });
});

test('truncated prefixes and non-PDF bodies are handled without guessing', () => {
  const bytes = kitpPdf();
  assert.equal(parsePdf(bytes.subarray(0, 40), url, bytes.length)?.titleSource, 'file name');
  assert.equal(parsePdf(Buffer.from('<!doctype html><title>Not a PDF</title>'), url), null);
  assert.equal(isPdf(Buffer.from('%PDF-1.7\n')), true);
});

test('hostile structure stays bounded: inflation bombs, deep nesting, reference cycles and repeated object-stream offsets', () => {
  const started = Date.now();
  const bomb = buildPdf([
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] >>' },
    { id: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << >> /Contents [4 0 R 4 0 R 4 0 R 4 0 R 4 0 R 4 0 R 4 0 R 4 0 R] >>' },
    { id: 4, body: '', stream: Buffer.alloc(64 * 1024 * 1024, 0x20) },
  ], '<< /Root 1 0 R /Size 5 >>');
  assert.ok(bomb.length < 128 * 1024);
  assert.equal(parsePdf(bomb, url)?.titleSource, 'file name');
  const nested = buildPdf([{ id: 1, body: '['.repeat(100_000) }, { id: 2, body: '<< /Type /Catalog /Pages 2 0 R >>' }], '<< /Root 2 0 R >>');
  assert.equal(parsePdf(nested, url)?.titleSource, 'file name');
  const cycle = buildPdf([{ id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' }, { id: 2, body: '3 0 R' }, { id: 3, body: '2 0 R' }], '<< /Root 1 0 R >>');
  assert.equal(parsePdf(cycle, url)?.titleSource, 'file name');
  const repeated = `${Array.from({ length: 40_000 }, (_, index) => `${index + 10} 0`).join(' ')} `;
  const members = `[${'1 '.repeat(20_000)}]`;
  const stream = buildPdf([{ id: 1, body: `/Type /ObjStm /N 40000 /First ${repeated.length}`, stream: repeated + members }], '<< >>');
  assert.equal(parsePdf(stream, url)?.titleSource, 'file name');
  const badFlate = buildPdf([{ id: 1, body: '/Type /ObjStm /N 1 /First 4', stream: Buffer.from('not deflate data'), compress: false }], '<< >>');
  assert.equal(parsePdf(Buffer.concat([badFlate, Buffer.from(deflateSync(Buffer.alloc(10)))]), url)?.titleSource, 'file name');
  assert.ok(Date.now() - started < 5000, 'Hostile inputs must be rejected promptly');
});

test('sizes are compact and human-readable', () => {
  assert.equal(formatPdfSize(512), '512 bytes'); assert.equal(formatPdfSize(89_273), '87 KB');
  assert.equal(formatPdfSize(2_215_244), '2.1 MB'); assert.equal(formatPdfSize(4 * 1024 * 1024), '4 MB');
});
