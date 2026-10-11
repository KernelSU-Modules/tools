import { describe, expect, it } from 'vitest';
import { inspectZip, rangeReaderFromUrl, RangeFetchError, zipLimitsFromPolicy } from '../src/index.ts';
import { buildZip, VALID_PROP } from './zipwriter.ts';

const GH = 'https://github.com/demo/toolbox/releases/download/v1/demo.zip';
const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=xyz';

interface Log {
  url: string;
  range: string | null;
  auth: string | null;
}

/** Mock fetch serving `bytes` with Range support, simulating GitHub's redirect to the asset CDN. */
function mockServer(bytes: Uint8Array, opts: { ignoreRange?: boolean; badContentRange?: boolean; expireCdn?: boolean } = {}) {
  const log: Log[] = [];
  let cdnHits = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    log.push({ url, range: h.get('range'), auth: h.get('authorization') });
    const redirected = url === GH;
    if (url !== GH && url !== CDN) return new Response('nope', { status: 404 });
    if (url === CDN && opts.expireCdn && ++cdnHits > 0) return new Response('expired', { status: 403 });
    const finish = (res: Response) => {
      Object.defineProperty(res, 'url', { value: CDN });
      Object.defineProperty(res, 'redirected', { value: redirected });
      return res;
    };
    const range = h.get('range');
    const size = bytes.length;
    if (!range || opts.ignoreRange)
      return finish(new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { 'content-length': String(size) } }));
    let start: number;
    let end: number;
    // Like Azure Blob behind release-assets.githubusercontent.com: suffix ranges are not implemented.
    if (/^bytes=-\d+$/.test(range)) return finish(new Response('not implemented', { status: 501 }));
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m) return new Response('bad range', { status: 400 });
    start = Number(m[1]);
    end = Math.min(Number(m[2]), size - 1);
    if (start >= size) return finish(new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } }));
    const body = bytes.slice(start, end + 1);
    const cr = opts.badContentRange ? `bytes ${start + 1}-${end}/${size}` : `bytes ${start}-${end}/${size}`;
    return finish(new Response(body, { status: 206, headers: { 'content-range': cr, 'content-length': String(body.length) } }));
  }) as typeof fetch;
  return { fetch: f, log };
}

function pseudoRandom(n: number): Uint8Array {
  const b = new Uint8Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

describe('rangeReaderFromUrl', () => {
  it('small file: size + whole content in one request, following redirects', async () => {
    const zip = await buildZip([{ name: 'module.prop', data: VALID_PROP }]);
    const s = mockServer(zip);
    const r = await rangeReaderFromUrl(GH, { fetch: s.fetch });
    expect(r.size).toBe(zip.length);
    expect(r.requests).toBe(1);
    expect(r.finalUrl).toBe(CDN);
    expect(s.log[0]).toMatchObject({ url: GH, range: 'bytes=0-131071' });
    expect(await r.read(0, 4)).toEqual(zip.subarray(0, 4));
    expect((await inspectZip(r, zipLimitsFromPolicy())).ok).toBe(true);
    expect(r.requests).toBe(1);
  });

  it('large ZIP: head probe + tail window (module.prop first), auth dropped on the CDN', async () => {
    const zip = await buildZip([
      { name: 'module.prop', data: VALID_PROP },
      { name: 'blob.bin', data: pseudoRandom(1024 * 1024), method: 0 },
      ...Array.from({ length: 200 }, (_, i) => ({ name: `system/lib/file-${i}.so`, data: 'x'.repeat(i) })),
    ]);
    const s = mockServer(zip);
    const r = await rangeReaderFromUrl(GH, { fetch: s.fetch, headers: { Authorization: 'token secret', Accept: 'application/octet-stream' } });
    const res = await inspectZip(r, zipLimitsFromPolicy());
    expect(res.issues).toEqual([]);
    expect(res.value?.moduleProp).toBe(VALID_PROP);
    expect(r.requests).toBe(2);
    expect(s.log[0]!.auth).toBe('token secret');
    expect(s.log[1]).toMatchObject({ url: CDN, auth: null, range: `bytes=${zip.length - 131072}-${zip.length - 1}` });
  });

  it('large ZIP with module.prop in the middle: 3 requests', async () => {
    const zip = await buildZip([
      { name: 'a.bin', data: pseudoRandom(400_000), method: 0 },
      { name: 'module.prop', data: VALID_PROP },
      { name: 'b.bin', data: pseudoRandom(400_000), method: 0 },
    ]);
    const s = mockServer(zip);
    const r = await rangeReaderFromUrl(GH, { fetch: s.fetch });
    const res = await inspectZip(r, zipLimitsFromPolicy());
    expect(res.ok).toBe(true);
    expect(r.requests).toBe(3);
  });

  it('with a known size, fetches the tail window lazily', async () => {
    const zip = await buildZip([{ name: 'module.prop', data: VALID_PROP }, { name: 'b', data: pseudoRandom(300_000), method: 0 }]);
    const s = mockServer(zip);
    const r = await rangeReaderFromUrl(GH, { fetch: s.fetch, size: zip.length });
    expect(r.requests).toBe(0);
    const res = await inspectZip(r, zipLimitsFromPolicy());
    expect(res.ok).toBe(true);
    expect(r.requests).toBe(2);
    expect(s.log[0]!.range).toBe(`bytes=${zip.length - 131072}-${zip.length - 1}`);
  });

  it('reads spanning the tail window combine network and cache', async () => {
    const data = pseudoRandom(200_000);
    const s = mockServer(data);
    const r = await rangeReaderFromUrl(GH, { fetch: s.fetch, tailBytes: 4096 });
    expect(await r.read(data.length - 5000, 5000)).toEqual(data.subarray(data.length - 5000));
    expect(await r.read(10, 100)).toEqual(data.subarray(10, 110));
    await expect(r.read(data.length - 1, 2)).rejects.toThrow(RangeError);
  });

  it('small file served whole when the server ignores Range', async () => {
    const zip = await buildZip([{ name: 'module.prop', data: VALID_PROP }]);
    const s = mockServer(zip, { ignoreRange: true });
    const r = await rangeReaderFromUrl(GH, { fetch: s.fetch });
    expect(r.size).toBe(zip.length);
    expect((await inspectZip(r, zipLimitsFromPolicy())).ok).toBe(true);
  });

  it('large file + server ignoring Range -> error', async () => {
    const s = mockServer(pseudoRandom(500_000), { ignoreRange: true });
    await expect(rangeReaderFromUrl(GH, { fetch: s.fetch })).rejects.toThrow(RangeFetchError);
  });

  it('rejects inconsistent Content-Range', async () => {
    const s = mockServer(pseudoRandom(500_000), { badContentRange: true });
    await expect(rangeReaderFromUrl(GH, { fetch: s.fetch })).rejects.toThrow(/Content-Range/);
  });

  it('HTTP errors surface as RangeFetchError with status', async () => {
    const s = mockServer(new Uint8Array(10));
    await expect(rangeReaderFromUrl('https://github.com/x/y/releases/download/v/missing.zip', { fetch: s.fetch })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('empty file', async () => {
    const s = mockServer(new Uint8Array(0));
    const r = await rangeReaderFromUrl(GH, { fetch: s.fetch });
    expect(r.size).toBe(0);
    expect((await inspectZip(r, zipLimitsFromPolicy())).issues.map((i) => i.code)).toEqual(['zip-not-zip']);
  });

  it('falls back to the original URL when the redirect target expired', async () => {
    const data = pseudoRandom(400_000);
    const s = mockServer(data, { expireCdn: true });
    const r = await rangeReaderFromUrl(GH, { fetch: s.fetch });
    expect(await r.read(200_000, 10)).toEqual(data.subarray(200_000, 200_010));
    expect(s.log.map((l) => l.url)).toEqual([GH, CDN, GH]);
  });
});
