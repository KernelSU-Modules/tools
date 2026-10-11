// Offline stand-in for the network, used by the tests and by preview.ts.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FetchError, type HttpGet } from '../src/index.ts';
import { REPO_COMMITS } from './fixtures/regen.ts';

export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export interface FakeNetOptions {
  /** Serve "# tampered" instead of toolbox's README.md. */
  tamper?: boolean;
  /** Hosts that fail with a network error (e.g. raw.githubusercontent.com). */
  down?: string[];
  /** Respond with this HTTP status for the first N requests to a host: {host: [status, n]}. */
  flaky?: Record<string, [status: number, times: number]>;
}

/** Offline network: fixture repos at their locked commits + a few fake image hosts. */
export function fakeGet(opts: FakeNetOptions = {}): HttpGet & { calls: string[] } {
  const calls: string[] = [];
  const flaky = new Map(Object.entries(opts.flaky ?? {}).map(([h, v]) => [h, [...v] as [number, number]]));
  const get = (async (url: string, { maxBytes }: { maxBytes: number }) => {
    calls.push(url);
    const u = new URL(url);
    if (opts.down?.includes(u.hostname)) throw new FetchError(`connect ECONNRESET: ${url}`, 'network');
    const f = flaky.get(u.hostname);
    if (f && f[1] > 0) {
      f[1]--;
      return { status: f[0], headers: {}, body: new Uint8Array() };
    }
    const ok = (body: Uint8Array) => {
      if (body.length > maxBytes) throw new FetchError(`too large: ${url}`, 'limit');
      return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body };
    };
    const notFound = { status: 404, headers: {}, body: new Uint8Array() };
    if (u.hostname === 'raw.githubusercontent.com') {
      const [owner, repo, commit, ...rest] = u.pathname.slice(1).split('/');
      const p = rest.map(decodeURIComponent).join('/');
      const full = `${owner}/${repo}`;
      if (REPO_COMMITS[full] === commit) {
        const f = path.join(FIX, 'repos', full, p);
        if (!existsSync(f)) return notFound;
        const body = new Uint8Array(readFileSync(f));
        if (opts.tamper && full === 'demo/toolbox' && p === 'README.md') return ok(new TextEncoder().encode('# tampered'));
        return ok(body);
      }
      return notFound;
    }
    if (u.hostname === 'img.example.com') {
      const f = path.join(FIX, 'web/img.example.com', u.pathname);
      return existsSync(f) ? ok(new Uint8Array(readFileSync(f))) : notFound;
    }
    if (u.hostname === 'redirect.example.com') {
      const n = Number(u.pathname.slice(2));
      return { status: 302, headers: { location: `/r${n + 1}` }, body: new Uint8Array() };
    }
    if (u.hostname === 'huge.example.com') {
      const big = new Uint8Array(300_000);
      big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      return ok(big);
    }
    if (u.hostname === 'gone.example.com') return notFound;
    throw new FetchError(`network unreachable: ${url}`, 'network');
  }) as unknown as HttpGet & { calls: string[] };
  get.calls = calls;
  return get;
}

