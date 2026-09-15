/** Limit decoded response bytes while reading; Content-Length alone cannot bound chunked or compressed bodies. */
export async function readBoundedJson(response: Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid JSON response limit');
  if (!response.body) throw new Error('Missing JSON response body');
  if (Number(response.headers.get('content-length')) > maxBytes) {
    void response.body.cancel().catch(() => {});
    throw new Error('JSON response exceeds its byte limit');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error('JSON response exceeds its byte limit');
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
