// SSRF-guarded HTTPS fetching for the builder (Node only).
// - https only, every hop re-checked, at most `maxRedirects` redirects
// - hostnames are resolved by our own lookup that rejects non-public addresses; the socket
//   connects to exactly the validated address (no DNS-rebinding window)
// - hard size limit while streaming, total deadline
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** One request, no redirect following. Must reject bodies above maxBytes. */
export type HttpGet = (url: string, opts: { maxBytes: number; timeoutMs: number }) => Promise<HttpResponse>;

export class FetchError extends Error {
  constructor(
    message: string,
    /** policy: refused for safety (non-https, non-public, …); limit: too large; http: status; network */
    readonly kind: 'policy' | 'limit' | 'http' | 'network',
    readonly status?: number,
  ) {
    super(message);
  }
}

const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const)
  blocked.addSubnet(a, p, 'ipv6');

/** True only for globally routable unicast addresses. */
export function isPublicIp(ip: string): boolean {
  // Scoped (zone id) addresses such as "fe80::1%eth0" are link-local by definition; URL parsing would throw on them.
  if (ip.includes('%')) return false;
  const v = net.isIP(ip);
  if (v === 0) return false;
  if (v === 4) return !blocked.check(ip, 'ipv4');
  // Normalize (e.g. "::ffff:127.0.0.1" -> "::ffff:7f00:1") and refuse IPv4-mapped forms outright.
  // (Do not add ::ffff:0:0/96 to the BlockList: Node maps every IPv4 check onto it.)
  let norm: string;
  try {
    norm = new URL(`https://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return false;
  }
  if (norm.startsWith('::ffff:')) return false;
  return !blocked.check(norm, 'ipv6');
}

const BAD_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

/** Static checks on a URL before any network activity. */
export function checkFetchUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError(`invalid URL: ${raw}`, 'policy');
  }
  if (u.protocol !== 'https:') throw new FetchError(`only https is allowed: ${raw}`, 'policy');
  if (u.username || u.password) throw new FetchError('credentials in URL are not allowed', 'policy');
  if (u.port && u.port !== '443') throw new FetchError(`non-default port refused: ${raw}`, 'policy');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new FetchError(`non-public address refused: ${host}`, 'policy');
  } else if (BAD_HOST.test(host) || !host.includes('.')) {
    throw new FetchError(`non-public hostname refused: ${host}`, 'policy');
  }
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** dns.lookup replacement that refuses hostnames resolving to any non-public address. */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCb): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return callback(err, '');
    const list = (addrs as dns.LookupAddress[]).filter((a) => !options.family || a.family === options.family);
    const bad = list.find((a) => !isPublicIp(a.address));
    if (bad || list.length === 0) {
      const e: NodeJS.ErrnoException = new Error(`${hostname} resolves to non-public address ${bad?.address ?? '(none)'}`);
      e.code = 'EKSUNONPUBLIC';
      return callback(e, '');
    }
    if (options.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
}

/** Default HttpGet: node:https with guarded DNS. */
export const nodeHttpGet: HttpGet = (url, { maxBytes, timeoutMs }) =>
  new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = checkFetchUrl(url);
    } catch (e) {
      return reject(e);
    }
    const req = https.get(
      u,
      {
        agent: false,
        lookup: guardedLookup as unknown as typeof dns.lookup,
        timeout: timeoutMs,
        headers: { 'user-agent': 'kernelsu-modules-build (+https://modules.kernelsu.org)', accept: '*/*' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        if (status >= 300 && status < 400) {
          res.resume();
          req.destroy();
          clearTimeout(deadline);
          return resolve({ status, headers, body: new Uint8Array() });
        }
        const declared = Number(headers['content-length'] ?? NaN);
        if (declared > maxBytes) {
          req.destroy();
          clearTimeout(deadline);
          return reject(new FetchError(`too large (${declared} > ${maxBytes}): ${url}`, 'limit'));
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        res.on('data', (c: Uint8Array) => {
          size += c.length;
          if (size > maxBytes) req.destroy(new FetchError(`too large (> ${maxBytes}): ${url}`, 'limit'));
          else chunks.push(c);
        });
        res.on('end', () => {
          clearTimeout(deadline);
          const body = new Uint8Array(size);
          let off = 0;
          for (const c of chunks) {
            body.set(c, off);
            off += c.length;
          }
          resolve({ status, headers, body });
        });
        res.on('error', (e) => {
          clearTimeout(deadline);
          reject(e instanceof FetchError ? e : new FetchError(String(e), 'network'));
        });
      },
    );
    const deadline = setTimeout(() => req.destroy(new FetchError(`timeout: ${url}`, 'network')), timeoutMs);
    req.on('timeout', () => req.destroy(new FetchError(`timeout: ${url}`, 'network')));
    req.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(deadline);
      if (e instanceof FetchError) return reject(e);
      reject(new FetchError(`${e.message}: ${url}`, e.code === 'EKSUNONPUBLIC' ? 'policy' : 'network'));
    });
  });

/** GET with manual redirect following; each hop passes checkFetchUrl. */
export async function fetchFollow(
  get: HttpGet,
  url: string,
  opts: { maxRedirects: number; maxBytes: number; timeoutMs?: number },
): Promise<{ url: string; body: Uint8Array; contentType: string | null }> {
  let current = url;
  for (let hop = 0; ; hop++) {
    checkFetchUrl(current);
    let res: HttpResponse;
    try {
      res = await get(current, { maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs ?? 20_000 });
    } catch (e) {
      if (e instanceof FetchError) throw e;
      throw new FetchError(`${(e as Error).message}: ${current}`, 'network');
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop >= opts.maxRedirects) throw new FetchError(`too many redirects: ${url}`, 'policy');
      const loc = res.headers['location'];
      if (!loc) throw new FetchError(`redirect without location: ${current}`, 'http', res.status);
      current = new URL(loc, current).href;
      continue;
    }
    if (res.status !== 200) throw new FetchError(`HTTP ${res.status}: ${current}`, 'http', res.status);
    if (res.body.length > opts.maxBytes) throw new FetchError(`too large: ${current}`, 'limit');
    return { url: current, body: res.body, contentType: res.headers['content-type'] ?? null };
  }
}

export interface RetryPolicy {
  /** Extra attempts after the first. */
  retries: number;
  /** First backoff; doubled per attempt. */
  baseDelayMs: number;
  /** Backoff cap (also caps a server-sent Retry-After). */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { retries: 3, baseDelayMs: 1000, maxDelayMs: 8000 };

/** Temporary failures worth retrying: network errors/timeouts, 429 and 5xx. */
export function isTransient(e: unknown): boolean {
  if (!(e instanceof FetchError)) return false;
  if (e.kind === 'network') return true;
  return e.kind === 'http' && e.status !== undefined && (e.status === 429 || e.status >= 500);
}

/** fetchFollow with exponential backoff on transient failures; the last error is rethrown. */
export async function fetchRetry(
  get: HttpGet,
  url: string,
  opts: { maxRedirects: number; maxBytes: number; timeoutMs?: number },
  retry: RetryPolicy = DEFAULT_RETRY,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ url: string; body: Uint8Array; contentType: string | null }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchFollow(get, url, opts);
    } catch (e) {
      if (attempt >= retry.retries || !isTransient(e)) throw e;
      await sleep(Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt));
    }
  }
}
