/** Make provider prose inert. Default truncation preserves YouTube source-length semantics; reply pages opt into a serialized character budget. */
export function sanitizeReplyText(value: string, limit: number, serializedLimit = false): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, ' ')
    .replace(/(?:https?:\/\/|www\.|\bdiscord\.gg\/|\bdiscord(?:app)?\.com\/invite\/)\S+/gi, '[link]')
    .replace(/\s+/g, ' ').trim();
  if (!serializedLimit) {
    const shortened = clean.length > limit ? clean.slice(0, limit - 1).trimEnd() + '…' : clean;
    return [...shortened].map(character => character === '@' ? '@\u200b' : '\\`*_{}[]()<>~|#+-'.includes(character) ? '\\' + character : character).join('');
  }
  const tokens = [...clean].map(character => character === '@' ? '@\u200b' : '\\`*_{}[]()<>~|#+-'.includes(character) ? '\\' + character : character);
  if (tokens.join('').length <= limit) return tokens.join('');
  let shortened = '';
  for (const token of tokens) {
    if (shortened.length + token.length > limit - 1) break;
    shortened += token;
  }
  return shortened.trimEnd() + '…';
}
