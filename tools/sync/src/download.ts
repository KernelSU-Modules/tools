// Release asset download: stream with a hard size cap, compute sha256 on the fly.
// The installation token is sent ONLY to api.github.com; redirects (to the asset CDN) are followed manually
// without credentials.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GITHUB_API, API_VERSION, USER_AGENT } from '@kernelsu-modules/github';

export class DownloadError extends Error {
  constructor(
    message: string,
    /** Validator-compatible issue code. */
    readonly code: 'asset-download-failed' | 'zip-too-large' | 'asset-size-mismatch',
    /** True when a retry might succeed (network/5xx); permanent problems are recorded as seen. */
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface DownloadedAsset {
  bytes: Uint8Array;
  sha256: string;
  size: number;
}

export interface DownloadOptions {
  fetch: typeof fetch;
  /** Owner/repo for the API asset endpoint. */
  fullName: string;
  assetId: number;
  token: string;
  maxBytes: number;
  /** Size reported by the API; must match exactly. */
  expectedSize?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

const API_HOST = new URL(GITHUB_API).host;

export async function downloadAsset(o: DownloadOptions): Promise<DownloadedAsset> {
  if (o.expectedSize !== undefined && o.expectedSize > o.maxBytes)
    throw new DownloadError(`asset is ${o.expectedSize} bytes; the limit is ${o.maxBytes} bytes`, 'zip-too-large', false);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('download timed out')), o.timeoutMs ?? 5 * 60_000);
  try {
    let url = new URL(`${GITHUB_API}/repos/${o.fullName}/releases/assets/${o.assetId}`);
    let res: Response | null = null;
    for (let hop = 0; hop <= (o.maxRedirects ?? 5); hop++) {
      const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/octet-stream' };
      // Credentials only for the very first request, and only if it really goes to the API host over https.
      if (hop === 0 && url.protocol === 'https:' && url.host === API_HOST) {
        headers.authorization = `Bearer ${o.token}`;
        headers['x-github-api-version'] = API_VERSION;
      }
      let r: Response;
      try {
        r = await o.fetch(url, { method: 'GET', headers, redirect: 'manual', signal: ac.signal });
      } catch (e) {
        throw new DownloadError(`network error: ${(e as Error).message}`, 'asset-download-failed', true);
      }
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        await r.body?.cancel().catch(() => {});
        const next = new URL(r.headers.get('location')!, url);
        if (next.protocol !== 'https:') throw new DownloadError(`refusing non-https redirect to ${next.host}`, 'asset-download-failed', false);
        url = next;
        continue;
      }
      res = r;
      break;
    }
    if (!res) throw new DownloadError('too many redirects', 'asset-download-failed', true);
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      const transient = res.status >= 500 || res.status === 429 || res.status === 403;
      throw new DownloadError(`HTTP ${res.status} from ${url.host}`, 'asset-download-failed', transient);
    }
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > o.maxBytes) {
      await res.body.cancel().catch(() => {});
      throw new DownloadError(`asset is ${declared} bytes; the limit is ${o.maxBytes} bytes`, 'zip-too-large', false);
    }

    const hash = createHash('sha256');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of Readable.fromWeb(res.body as any)) {
        const c = chunk as Uint8Array;
        size += c.byteLength;
        if (size > o.maxBytes) {
          ac.abort();
          throw new DownloadError(`asset exceeds the limit of ${o.maxBytes} bytes`, 'zip-too-large', false);
        }
        hash.update(c);
        chunks.push(c);
      }
    } catch (e) {
      if (e instanceof DownloadError) throw e;
      throw new DownloadError(`stream error: ${(e as Error).message}`, 'asset-download-failed', true);
    }
    if (o.expectedSize !== undefined && size !== o.expectedSize)
      throw new DownloadError(`downloaded ${size} bytes but the API reports ${o.expectedSize}`, 'asset-size-mismatch', false);
    const bytes = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
    return { bytes, sha256: hash.digest('hex'), size };
  } finally {
    clearTimeout(timer);
  }
}

/** "sha256:<hex>" -> hex, or null for other/absent digests. */
export function parseDigest(digest: string | null | undefined): string | null {
  if (!digest) return null;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return m ? m[1]!.toLowerCase() : null;
}
