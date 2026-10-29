import { deflateSync } from 'node:zlib';

export const pdfUrl = 'https://www.kitp.ucsb.edu/sites/default/files/YM_working_group.pdf';
export const pdfTitle = 'Proof by OpenAI of the Existence of Quantum Yang-Mills theory';

export type PdfPart = { id: number; body: string; stream?: Buffer | string; compress?: boolean };

/** Assemble a PDF from object bodies; `packed` ids are placed in one compressed object stream, as pdfTeX does. */
export function buildPdf(parts: PdfPart[], trailer: string, packed: number[] = []): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.5\n%\xbf\xf7\xa2\xfe\n', 'latin1')];
  const direct = parts.filter(part => !packed.includes(part.id));
  const members = parts.filter(part => packed.includes(part.id));
  const object = (part: PdfPart) => {
    if (part.stream === undefined) return Buffer.from(`${part.id} 0 obj\n${part.body}\nendobj\n`, 'latin1');
    const raw = Buffer.isBuffer(part.stream) ? part.stream : Buffer.from(part.stream, 'latin1');
    const data = part.compress === false ? raw : deflateSync(raw);
    const filter = part.compress === false ? '' : ' /Filter /FlateDecode';
    return Buffer.concat([Buffer.from(`${part.id} 0 obj\n<< ${part.body}${filter} /Length ${data.length} >>\nstream\n`, 'latin1'),
      data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
  };
  for (const part of direct) chunks.push(object(part));
  if (members.length) {
    let offsets = '', body = '';
    for (const member of members) { offsets += `${member.id} ${body.length} `; body += `${member.body}\n`; }
    const id = Math.max(...parts.map(part => part.id)) + 1;
    chunks.push(object({ id, body: `/Type /ObjStm /N ${members.length} /First ${offsets.length}`, stream: offsets + body }));
  }
  chunks.push(Buffer.from(`trailer\n${trailer}\nstartxref\n0\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

const cmap = (entries: string) => `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CMapName /TeX-builtin def /CMapType 2 def
1 begincodespacerange <00> <FF> endcodespacerange
${entries}
endcmap CMapName currentdict /CMap defineresource pop end end`;

/** The reported KITP working-group PDF's first-page structure (pdfTeX 1.40, object streams, ToUnicode, TJ kerning, ff ligature). */
export function kitpPdf(): Buffer {
  const toUnicode = cmap(`2 beginbfrange
<20> <7E> <0020>
<0B> <0B> <00660066>
endbfrange`);
  const content = `BT
/F41 17.2154 Tf 143.485 615.392 Td [(Pro)-26(of)-302(b)26(y)-302(Op)-26(enAI)-302(of)-302(the)-302(Existence)-301(of)-302(Quan)26(tum)]TJ 100.387 -21.918 Td [(Y)78(ang-Mills)-302(theory)]TJ
/F42 11.9552 Tf -43.797 -28.891 Td [(Statemen)27(t)-326(b)27(y)-326(the)-326(shepherding)-327(commi)1(ttee)]TJ -43.749 -21.148 Td [(Mic)27(hael)-326(R.)-326(Douglas,)-327(Da)28(vid)-327(J.)-326(Gross)-327(\\050C)1(hair\\051,)-327(Arth)27(u)1(r)-327(Ja\\013e,)]TJ
/F42 11.9552 Tf 0 -13.948 Td [(The)-326(working)-326(group)-326(reviewed)-326(the)-326(submitted)-326(argument)-326(in)-326(detail)-326(and)-326(reports)-326(its)-326(findings)-326(here.)]TJ
/F42 11.9552 Tf 0 -13.948 Td [(Further)-326(statements)-326(follow)-326(on)-326(the)-326(next)-326(page)-326(of)-326(this)-326(document.)]TJ
ET`;
  return buildPdf([
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, body: '<< /Type /Pages /Count 2 /Kids [3 0 R 9 0 R] >>' },
    { id: 3, body: '<< /Type /Page /Parent 2 0 R /Resources 4 0 R /Contents 5 0 R /MediaBox [0 0 612 792] >>' },
    { id: 4, body: '<< /Font << /F41 6 0 R /F42 7 0 R >> /ProcSet [/PDF /Text] >>' },
    { id: 5, body: '', stream: content },
    { id: 6, body: '<< /Type /Font /Subtype /Type1 /BaseFont /CMR17 /ToUnicode 8 0 R >>' },
    { id: 7, body: '<< /Type /Font /Subtype /Type1 /BaseFont /CMR12 /ToUnicode 8 0 R >>' },
    { id: 8, body: '', stream: toUnicode },
    { id: 9, body: '<< /Type /Page /Parent 2 0 R /Resources 4 0 R /MediaBox [0 0 612 792] >>' },
    { id: 10, body: '<< /Creator (TeX) /Producer (pdfTeX-1.40.29) /CreationDate (D:20261027202556Z) >>' },
  ], '<< /Root 1 0 R /Info 10 0 R /Size 12 >>', [1, 2, 3, 4, 6, 7, 9, 10]);
}

/** A one-page PDF with the given Info dictionary and page content in a simple WinAnsi font. */
export function simplePdf(options: { info?: string; content?: string; trailerExtra?: string; metadata?: string } = {}): Buffer {
  const parts: PdfPart[] = [
    { id: 1, body: `<< /Type /Catalog /Pages 2 0 R${options.metadata ? ' /Metadata 7 0 R' : ''} >>` },
    { id: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] >>' },
    { id: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 8 0 R >> >> /Contents 5 0 R >>' },
    { id: 4, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
    { id: 5, body: '', stream: options.content ?? 'BT /F1 11 Tf 72 720 Td (Body text only.) Tj ET' },
    { id: 6, body: options.info ?? '<< >>' },
    { id: 8, body: '<< /Type /Font /Subtype /Type0 /BaseFont /Unknown /Encoding /Identity-H >>' },
  ];
  if (options.metadata) parts.push({ id: 7, body: '/Type /Metadata /Subtype /XML', stream: options.metadata, compress: false });
  return buildPdf(parts, `<< /Root 1 0 R /Info 6 0 R /Size 9${options.trailerExtra ?? ''} >>`);
}

export const pdfResponse = (body: Uint8Array | ReadableStream<Uint8Array>, type = 'application/pdf', headers: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-type': type, ...headers } });
