/** Keep sentence punctuation and paired Markdown outside a URL's query string. */
function urlWithoutSuffix(url: string, prefix: string): string {
  const active = new Set<string>();
  const unescaped = (text: string) => (text.match(/\\*$/)?.[0].length ?? 0) % 2 === 0;
  const longestFirst = () => [...active].sort((a, b) => b.length - a.length);
  for (const match of prefix.matchAll(/\*{1,3}|_{1,2}|~~|\|\|/g)) {
    const before = prefix.slice(0, match.index);
    const after = prefix.slice(match.index + match[0].length);
    if (!unescaped(before) || (match[0][0] === '_' && /\w$/.test(before) && /^\w/.test(after))) continue;
    let remainder = match[0];
    for (const marker of /\S$/.test(before) ? longestFirst() : []) {
      if (remainder.endsWith(marker)) {
        active.delete(marker);
        remainder = remainder.slice(0, -marker.length);
      }
    }
    // A literal marker inside an earlier URL cannot open formatting around this one.
    if (remainder && !/[a-z][a-z\d+.-]*:\/\/\S*$/i.test(before)) active.add(remainder);
  }
  let link = url.replace(/[.,!?:;]+$/, '');
  let marker: string | undefined;
  while ((marker = longestFirst().find((value) => link.endsWith(value) &&
    unescaped(link.slice(0, -value.length))))) {
    active.delete(marker);
    link = link.slice(0, -marker.length).replace(/[.,!?:;]+$/, '');
  }
  return link;
}

/** Visit complete URL tokens, preserving surrounding text and nested URLs. */
export function mapLinks(content: string, transform: (url: string, position: number) => string): string {
  const schemes = /[a-z][a-z\d+.-]*:\/\//gi;
  let rewritten = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = schemes.exec(content)) !== null) {
    let end = schemes.lastIndex;
    const closing: string[] = [];
    // Balanced punctuation can belong to a URL. An unmatched closing delimiter
    // ends a Markdown link, allowing an adjacent link to be processed separately.
    while (end < content.length && !/[\s<>"`]/.test(content[end])) {
      const char = content[end];
      const opening = '([{'.indexOf(char);
      if (opening !== -1) closing.push(')]}'[opening]);
      else if (')]}'.includes(char)) {
        if (closing.pop() !== char) break;
      }
      end++;
    }
    // Consume other URLs too, including URLs nested inside their paths/queries.
    const url = content.slice(match.index, end);
    const withoutPunctuation = urlWithoutSuffix(url,
      content.slice(0, match.index).split(/\n[ \t]*\n/).pop()!);
    rewritten += content.slice(cursor, match.index) + transform(withoutPunctuation, match.index) +
      url.slice(withoutPunctuation.length);
    cursor = end;
    schemes.lastIndex = end;
  }
  return rewritten + content.slice(cursor);
}

/** Do not reveal text behind a suppressed link, code span, or spoiler. */
export function visibleLink(content: string, position: number): boolean {
  const prefix = content.slice(0, position);
  if (prefix.endsWith('<')) return false;
  let code = '';
  let spoiler = false;
  for (const match of prefix.matchAll(/`+|\|\|/g)) {
    if ((prefix.slice(0, match.index).match(/\\*$/)?.[0].length ?? 0) % 2) continue;
    if (match[0][0] === '`') {
      if (!code) code = match[0];
      else if (code === match[0]) code = '';
    } else if (!code) spoiler = !spoiler;
  }
  return !code && !spoiler;
}
