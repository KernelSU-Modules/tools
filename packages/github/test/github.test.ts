import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GitHubClient, GitHubError, GitHubNetworkError, PreconditionFailed, commitWithRetry, hmacSha256Hex, importRsaPrivateKey,
  parseNextLink, signJwtRs256, verifySha256Signature, withTrailers,
} from '../src/index.ts';

describe('crypto', () => {
  it('signs RS256 JWTs with PKCS#1 and PKCS#8 keys', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const type of ['pkcs1', 'pkcs8'] as const) {
      const pem = privateKey.export({ type, format: 'pem' }).toString();
      const jwt = await signJwtRs256(await importRsaPrivateKey(pem), { iss: '1' });
      const [h, p, s] = jwt.split('.');
      const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey(privateKey), Buffer.from(s!, 'base64url'));
      expect(ok).toBe(true);
    }
  });

  it('verifies sha256= signatures', async () => {
    const sig = 'sha256=' + (await hmacSha256Hex('secret', 'body'));
    expect(await verifySha256Signature('secret', 'body', sig)).toBe(true);
    expect(await verifySha256Signature('secret', 'body!', sig)).toBe(false);
    expect(await verifySha256Signature('secret', 'body', null)).toBe(false);
  });
});

describe('helpers', () => {
  it('parses Link headers and trailers', () => {
    expect(parseNextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"')).toBe('https://api.github.com/x?page=2');
    expect(parseNextLink(null)).toBeNull();
    expect(withTrailers('s', { Action: 'approve', Module: 'a.b', Empty: '' })).toBe('s\n\nAction: approve\nModule: a.b\n');
  });
});

/** Minimal in-memory Git Data API. */
function fakeGit(opts: { raceOnce?: boolean } = {}) {
  let n = 0;
  const id = () => (++n).toString(16).padStart(40, '0');
  const blobs = new Map<string, string>();
  const trees = new Map<string, Record<string, string>>();
  const commits = new Map<string, { tree: string }>();
  const t0 = id(); trees.set(t0, { 'a.txt': (() => { const b = id(); blobs.set(b, 'A'); return b; })() });
  const c0 = id(); commits.set(c0, { tree: t0 });
  let head = c0;
  let raced = !opts.raceOnce;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const m = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const p = url.pathname.replace('/repos/o/r', '');
    if (m === 'GET' && p === '/git/ref/heads/main') return json(200, { object: { sha: head } });
    if (m === 'GET' && p.startsWith('/git/commits/')) return json(200, { tree: { sha: commits.get(p.split('/')[3]!)!.tree } });
    if (m === 'GET' && p.startsWith('/git/trees/')) {
      const t = trees.get(p.split('/')[3]!)!;
      return json(200, { truncated: false, tree: Object.entries(t).map(([path, sha]) => ({ path, type: 'blob', sha })) });
    }
    if (m === 'GET' && p.startsWith('/git/blobs/')) return json(200, { content: btoa(blobs.get(p.split('/')[3]!)!), encoding: 'base64' });
    if (m === 'POST' && p === '/git/blobs') { const b = id(); blobs.set(b, body.content); return json(201, { sha: b }); }
    if (m === 'POST' && p === '/git/trees') {
      const t = { ...trees.get(body.base_tree)! };
      for (const e of body.tree) { if (e.sha === null) delete t[e.path]; else t[e.path] = e.sha; }
      const s = id(); trees.set(s, t); return json(201, { sha: s });
    }
    if (m === 'POST' && p === '/git/commits') { const s = id(); commits.set(s, { tree: body.tree }); return json(201, { sha: s }); }
    if (m === 'PATCH' && p === '/git/refs/heads/main') {
      if (!raced) { raced = true; return json(422, { message: 'Update is not a fast forward' }); }
      head = body.sha; return json(200, {});
    }
    return json(404, { message: `unhandled ${m} ${p}` });
  };
  return { fetch: f, read: (path: string) => { const t = trees.get(commits.get(head)!.tree)!; return t[path] ? blobs.get(t[path]!)! : null; } };
}

describe('commitWithRetry', () => {
  it('commits, retries on non-fast-forward, and re-runs mutate', async () => {
    const git = fakeGit({ raceOnce: true });
    const gh = new GitHubClient('t', { fetch: git.fetch });
    let calls = 0;
    const res = await commitWithRetry(gh, { owner: 'o', repo: 'r' }, async (reader) => {
      calls++;
      expect(await reader.read('a.txt')).toBe('A');
      expect(await reader.list('')).toEqual(['a.txt']);
      return { files: { 'b.txt': 'B', 'a.txt': null }, message: 'm' };
    });
    expect(res.attempts).toBe(2);
    expect(calls).toBe(2);
    expect(git.read('b.txt')).toBe('B');
    expect(git.read('a.txt')).toBeNull();
  });

  it('propagates PreconditionFailed without committing', async () => {
    const git = fakeGit();
    const gh = new GitHubClient('t', { fetch: git.fetch });
    await expect(commitWithRetry(gh, { owner: 'o', repo: 'r' }, async () => { throw new PreconditionFailed('nope'); })).rejects.toBeInstanceOf(PreconditionFailed);
    expect(git.read('a.txt')).toBe('A');
  });

  it('skips empty plans', async () => {
    const gh = new GitHubClient('t', { fetch: fakeGit().fetch });
    expect((await commitWithRetry(gh, { owner: 'o', repo: 'r' }, async () => ({ files: {}, message: 'm' }))).commit).toBeNull();
  });
});

describe('commitWithRetry: edge cases', () => {
  it('drops deletions of paths that are not in the base tree', async () => {
    const git = fakeGit();
    const gh = new GitHubClient('t', { fetch: git.fetch });
    expect((await commitWithRetry(gh, { owner: 'o', repo: 'r' }, async () => ({ files: { 'nope.txt': null }, message: 'm' }))).commit).toBeNull();
    const r = await commitWithRetry(gh, { owner: 'o', repo: 'r' }, async () => ({ files: { 'nope.txt': null, 'c.txt': 'C' }, message: 'm' }));
    expect(r.commit).not.toBeNull();
    expect(git.read('c.txt')).toBe('C');
  });

  it('does not retry a protected-branch 422', async () => {
    const git = fakeGit();
    const f: typeof fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'PATCH') return new Response(JSON.stringify({ message: 'Protected branch update failed for refs/heads/main.' }), { status: 422 });
      return git.fetch(input, init);
    };
    let calls = 0;
    const gh = new GitHubClient('t', { fetch: f });
    await expect(commitWithRetry(gh, { owner: 'o', repo: 'r' }, async () => (calls++, { files: { 'b.txt': 'B' }, message: 'm' }))).rejects.toMatchObject({ status: 422 });
    expect(calls).toBe(1);
  });
});

describe('GitHubClient retries, timeouts, pagination', () => {
  const seq = (responses: (() => Response | Promise<Response>)[]) => {
    const calls: { method: string; url: string }[] = [];
    const f: typeof fetch = async (input, init) => {
      calls.push({ method: init?.method ?? 'GET', url: String(input) });
      const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
      return r();
    };
    return { f, calls };
  };
  const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
  const sleeps: number[] = [];
  const opts = (f: typeof fetch) => ({ fetch: f, sleep: async (ms: number) => void sleeps.push(ms) });

  it('retries idempotent reads on 5xx and network errors, not POSTs', async () => {
    const a = seq([res(502), () => Promise.reject(new TypeError('fetch failed')), res(200, { ok: 1 })]);
    expect((await new GitHubClient('t', opts(a.f)).get('/x')).data).toEqual({ ok: 1 });
    expect(a.calls).toHaveLength(3);
    const b = seq([res(502), res(200)]);
    await expect(new GitHubClient('t', opts(b.f)).post('/x', {})).rejects.toMatchObject({ status: 502 });
    expect(b.calls).toHaveLength(1);
  });

  it('retries rate limits (any method) but not permission 403s or 422s', async () => {
    const a = seq([res(403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '2' }), res(201, { id: 1 })]);
    expect((await new GitHubClient('t', opts(a.f)).post('/x', {})).status).toBe(201);
    expect(sleeps.at(-1)).toBe(2000);
    const b = seq([res(403, { message: 'Resource not accessible by integration' }), res(200)]);
    const e = await new GitHubClient('t', opts(b.f)).get('/x').catch((x) => x);
    expect(e).toBeInstanceOf(GitHubError);
    expect([e.forbidden, e.rateLimited, b.calls.length]).toEqual([true, false, 1]);
    const c = seq([res(422, { message: 'Validation Failed' }), res(200)]);
    await expect(new GitHubClient('t', opts(c.f)).get('/x')).rejects.toMatchObject({ status: 422 });
    expect(c.calls).toHaveLength(1);
    // A reset far in the future fails fast (rate-limited error) instead of sleeping for an hour.
    const d = seq([res(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) })]);
    const e2 = await new GitHubClient('t', opts(d.f)).get('/x').catch((x) => x);
    expect([e2.rateLimited, d.calls.length]).toEqual([true, 1]);
  });

  it('aborts slow requests (timeout) and reports a network error', async () => {
    const slow: typeof fetch = (_i, init) =>
      new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)));
    await expect(new GitHubClient('t', { fetch: slow, timeoutMs: 20, retry: false }).get('/x')).rejects.toBeInstanceOf(GitHubNetworkError);
  });

  it('paginate ignores etag (no 304 crash) and stops on allowed errors', async () => {
    const a = seq([() => new Response(JSON.stringify([1, 2]), { status: 200, headers: { link: '<https://api.github.com/x?page=2>; rel="next"' } }), res(200, [3])]);
    const gh = new GitHubClient('t', opts(a.f));
    expect(await gh.paginate('/x', { etag: '"abc"' })).toEqual([1, 2, 3]);
    const b = seq([res(404, { message: 'Not Found' })]);
    expect(await new GitHubClient('t', opts(b.f)).paginate('/x', { allow: [404] })).toEqual([]);
  });
});
