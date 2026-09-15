import { resolve4 } from 'node:dns/promises';
import { boundedEromeBody, isEromeImageUrl, parseEromeUrl } from './EromeAlbum';
import { cancelRegionalResponse, connectHttps, isPublicIpv4, regionalAbortable } from './RegionalHttp';
import type { RequestOptions } from 'node:https';
import { isStrongEtag } from './RegionalProtocol';

export const MAX_EROME_IMAGE_BYTES = 8 * 1024 * 1024;
type Mime = 'image/jpeg' | 'image/png';
export type EromeImageSource = { bytes: number; etag: string; mimeType: Mime };
type Dependencies = { dns?: (hostname: string) => Promise<string[]>; connect?: (options: RequestOptions, signal: AbortSignal) => Promise<Response> };

/** Separate image transport; regional MP4 jobs retain their existing strict protocol and allowlist. */
export function createEromeImageDownloader({ dns = resolve4, connect = connectHttps }: Dependencies = {}) {
  async function request(source: string, album: string, method: 'HEAD' | 'GET', signal: AbortSignal, etag?: string) {
    if (!isEromeImageUrl(source) || parseEromeUrl(album)?.url !== album) throw Error('erome_image_source');
    const url = new URL(source), addresses = await regionalAbortable(dns(url.hostname), signal);
    if (!addresses.length || addresses.length > 32 || !addresses.every(isPublicIpv4)) throw Error('erome_image_dns');
    const response = await regionalAbortable(connect({ protocol: 'https:', hostname: url.hostname, servername: url.hostname,
      port: 443, path: url.pathname, method, agent: false, family: 4, rejectUnauthorized: true, maxHeaderSize: 8192,
      headers: { Accept: 'image/jpeg, image/png', 'Accept-Encoding': 'identity', Referer: album,
        'User-Agent': 'Linky/1.0 (+https://linkybot.dev)', ...(etag ? { 'If-Match': etag } : {}) },
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{ address: addresses[0], family: 4 }]) : callback(null, addresses[0], 4),
    }, signal), signal, cancelRegionalResponse);
    const encoding = response.headers.get('content-encoding');
    if (response.status !== 200 || response.redirected || response.headers.has('set-cookie') || response.headers.has('content-range') ||
        encoding !== null && encoding !== 'identity') { cancelRegionalResponse(response); throw Error('erome_image_headers'); }
    return response;
  }
  function metadata(response: Response): EromeImageSource | null {
    const length = response.headers.get('content-length'), etag = response.headers.get('etag');
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    return length && /^[1-9]\d{0,7}$/.test(length) && Number(length) <= MAX_EROME_IMAGE_BYTES &&
      isStrongEtag(etag) && (mime === 'image/jpeg' || mime === 'image/png')
      ? { bytes: Number(length), etag, mimeType: mime } : null;
  }
  return {
    async inspect(source: string, album: string, signal: AbortSignal): Promise<EromeImageSource | null> {
      try {
        const response = await request(source, album, 'HEAD', AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
        try { return metadata(response); } finally { cancelRegionalResponse(response); }
      } catch { return null; }
    },
    async download(source: string, album: string, expected: EromeImageSource, signal: AbortSignal): Promise<Buffer | null> {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      try {
        const response = await request(source, album, 'GET', deadline, expected.etag), actual = metadata(response);
        if (!actual || actual.bytes !== expected.bytes || actual.etag !== expected.etag || actual.mimeType !== expected.mimeType) {
          cancelRegionalResponse(response); return null;
        }
        return await boundedEromeBody(response, MAX_EROME_IMAGE_BYTES, deadline);
      } catch { return null; }
    },
  };
}
