export interface RangeReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

function checkBounds(size: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size)
    throw new RangeError(`read(${offset}, ${length}) out of bounds (size ${size})`);
}

export function rangeReaderFromBytes(bytes: Uint8Array): RangeReader {
  return {
    size: bytes.length,
    async read(offset, length) {
      checkBounds(bytes.length, offset, length);
      return bytes.subarray(offset, offset + length);
    },
  };
}

export class RangeFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RangeFetchError';
  }
}

/** Default tail window fetched once and cached: covers EOCD (+64 KiB comment) and typical central directories. */
export const DEFAULT_TAIL_BYTES = 128 * 1024;

export interface UrlRangeReader extends RangeReader {
  /** URL after redirects (used for subsequent requests). */
  readonly finalUrl: string;
  /** Number of HTTP requests issued so far. */
  readonly requests: number;
}

async function readBodyLimited(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new RangeFetchError(`response body exceeds expected ${max} bytes`);
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function parseContentRange(h: string | null): { start: number; end: number; total: number } | { total: number; unsatisfied: true } | null {
  if (!h) return null;
  let m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+)\s*$/i.exec(h);
  if (m) return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
  m = /^\s*bytes\s+\*\/(\d+)\s*$/i.exec(h);
  if (m) return { total: Number(m[1]), unsatisfied: true };
  return null;
}

const discard = (res: Response) => res.body?.cancel().catch(() => {});

/**
 * HTTP Range reader.
 *
 * Without `opts.size`, the first request is `Range: bytes=0-(N-1)`: its Content-Range yields the
 * total size and the body is cached as a head window (whole file when it is small). Suffix ranges
 * (`bytes=-N`) are deliberately not used: GitHub's asset storage (release-assets.githubusercontent.com,
 * Azure Blob) answers them with 501. On the first read near the end of the file a tail window of N
 * bytes is fetched and cached, covering EOCD (+64 KiB comment) and typical central directories.
 * A typical inspectZip therefore costs 1-3 requests (2 when `size` is known: tail + module.prop record).
 * Redirects are followed (github.com -> release-assets.githubusercontent.com); later requests go
 * straight to the final URL, falling back to the original URL if the signed target expired.
 * Credentials in `headers` are not sent to a different origin. Throws RangeFetchError if the
 * server ignores Range for a file larger than N, or on HTTP/Content-Range errors.
 */
export async function rangeReaderFromUrl(
  url: string,
  opts?: { fetch?: typeof fetch; headers?: Record<string, string>; size?: number; tailBytes?: number },
): Promise<UrlRangeReader> {
  const doFetch = opts?.fetch ?? globalThis.fetch.bind(globalThis);
  const win = Math.max(1024, opts?.tailBytes ?? DEFAULT_TAIL_BYTES);
  const origin = new URL(url).origin;
  let finalUrl = url;
  let requests = 0;
  let size = opts?.size ?? -1;
  const segs: { start: number; data: Uint8Array }[] = [];
  let tailLoaded = false;

  const cached = (offset: number, length: number): Uint8Array | null => {
    for (const s of segs)
      if (offset >= s.start && offset + length <= s.start + s.data.length) return s.data.subarray(offset - s.start, offset - s.start + length);
    return null;
  };

  const headersFor = (target: string, range: string): Record<string, string> => {
    const h: Record<string, string> = {};
    const sameOrigin = new URL(target).origin === origin;
    for (const [k, v] of Object.entries(opts?.headers ?? {})) {
      const lk = k.toLowerCase();
      if (lk === 'range') continue;
      if (!sameOrigin && (lk === 'authorization' || lk === 'cookie')) continue;
      h[k] = v;
    }
    h.Range = range;
    return h;
  };

  const get = async (range: string): Promise<Response> => {
    const attempt = async (target: string) => {
      requests++;
      const res = await doFetch(target, { method: 'GET', headers: headersFor(target, range), redirect: 'follow' });
      if (res.url && res.url !== target) finalUrl = res.url;
      return res;
    };
    let res = await attempt(finalUrl);
    // Signed redirect targets expire: fall back to the original URL once.
    if (!res.ok && finalUrl !== url && (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410)) {
      await discard(res);
      finalUrl = url;
      res = await attempt(url);
    }
    return res;
  };

  /** GET bytes=offset-(offset+length-1); `expectTotal` < 0 means "learn the size from this response". */
  const fetchRange = async (offset: number, length: number, expectTotal: number): Promise<{ data: Uint8Array; total: number }> => {
    const res = await get(`bytes=${offset}-${offset + length - 1}`);
    if (res.status === 206) {
      const cr = parseContentRange(res.headers.get('content-range'));
      const ok =
        cr &&
        !('unsatisfied' in cr) &&
        cr.start === offset &&
        (expectTotal >= 0 ? cr.total === expectTotal && cr.end === offset + length - 1 : cr.end === Math.min(offset + length, cr.total) - 1);
      if (!ok) {
        await discard(res);
        throw new RangeFetchError(`unexpected Content-Range "${res.headers.get('content-range')}" for ${offset}+${length}`, 206);
      }
      const n = cr.end - cr.start + 1;
      const body = await readBodyLimited(res, n);
      if (body.length !== n) throw new RangeFetchError(`short range body (${body.length} of ${n} bytes)`, 206);
      return { data: body, total: cr.total };
    }
    if (res.status === 416 && expectTotal < 0) {
      const cr = parseContentRange(res.headers.get('content-range'));
      await discard(res);
      if (cr && 'unsatisfied' in cr && cr.total === 0) return { data: new Uint8Array(0), total: 0 };
      throw new RangeFetchError('HTTP 416 without a usable Content-Range', 416);
    }
    if (res.status === 200) {
      // Server ignored Range: acceptable only for a file that fits in one window.
      const len = Number(res.headers.get('content-length') ?? NaN);
      const known = expectTotal >= 0 ? expectTotal : len;
      if (Number.isFinite(known) && known <= win && offset === 0) {
        const all = await readBodyLimited(res, known);
        if (all.length !== known) throw new RangeFetchError(`short body (${all.length} of ${known} bytes)`, 200);
        if (!cached(0, known)) segs.push({ start: 0, data: all });
        return { data: all.subarray(0, Math.min(length, known)), total: known };
      }
      await discard(res);
      throw new RangeFetchError('server does not support HTTP Range requests', 200);
    }
    await discard(res);
    throw new RangeFetchError(`HTTP ${res.status} for ${url} range ${offset}+${length}`, res.status);
  };

  if (size < 0) {
    // Probe: size + head window in one request.
    const { data, total } = await fetchRange(0, win, -1);
    size = total;
    segs.push({ start: 0, data: data.length > total ? data.subarray(0, total) : data });
  }
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeFetchError(`invalid size ${size}`);

  const loadTail = async (): Promise<void> => {
    tailLoaded = true;
    const n = Math.min(size, win);
    const start = size - n;
    if (n === 0 || cached(start, n)) return;
    const got = await fetchRange(start, n, size);
    segs.push({ start: size - got.data.length, data: got.data });
  };

  return {
    get size() {
      return size;
    },
    get finalUrl() {
      return finalUrl;
    },
    get requests() {
      return requests;
    },
    async read(offset: number, length: number): Promise<Uint8Array> {
      checkBounds(size, offset, length);
      if (length === 0) return new Uint8Array(0);
      const hit = cached(offset, length);
      if (hit) return hit;
      const end = offset + length;
      const tailStart = Math.max(0, size - win);
      if (!tailLoaded && end > tailStart) {
        await loadTail();
        const again = cached(offset, length);
        if (again) return again;
      }
      if (offset < tailStart && end > tailStart) {
        const tail = cached(tailStart, size - tailStart);
        if (tail) {
          // Head part from the network, rest from the cached tail.
          const head = (await fetchRange(offset, tailStart - offset, size)).data;
          const out = new Uint8Array(length);
          out.set(head, 0);
          out.set(tail.subarray(0, end - tailStart), head.length);
          return out;
        }
      }
      return (await fetchRange(offset, length, size)).data;
    },
  };
}
