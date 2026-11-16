import { describe, expect, it } from 'vitest';
import type { LockedRelease } from '@kernelsu-modules/schema';
import { DownloadError, downloadAsset, parseDigest } from '../src/download.ts';
import { capSeen, recomputeReleases, restoreCandidates, truncateUtf8 } from '../src/releases.ts';
import type { GhRelease } from '../src/repo-api.ts';
import { mergeLock, parseLock } from '../src/data.ts';
import { sha256 } from './fake-github.ts';

function streamingFetch(chunks: number, chunkSize: number, opts: { redirect?: string } = {}): { fetch: typeof fetch; calls: { url: string; auth: string | null }[] } {
  const calls: { url: string; auth: string | null }[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input instanceof URL ? input.href : input);
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.startsWith('https://api.github.com/')) return new Response(null, { status: 302, headers: { location: opts.redirect ?? 'https://cdn.example.net/blob' } });
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i++ < chunks) c.enqueue(new Uint8Array(chunkSize).fill(1));
        else c.close();
      },
    });
    return new Response(body, { status: 200 }); // no content-length
  };
  return { fetch: f, calls };
}

describe('downloadAsset', () => {
  it('streams, hashes, and never forwards the token to the redirect host', async () => {
    const { fetch, calls } = streamingFetch(4, 1000);
    const r = await downloadAsset({ fetch, fullName: 'a/b', assetId: 1, token: 'secret', maxBytes: 10_000, expectedSize: 4000 });
    expect(r.size).toBe(4000);
    expect(r.sha256).toBe(sha256(new Uint8Array(4000).fill(1)));
    expect(calls[0]).toEqual({ url: 'https://api.github.com/repos/a/b/releases/assets/1', auth: 'Bearer secret' });
    expect(calls[1]).toEqual({ url: 'https://cdn.example.net/blob', auth: null });
  });

  it('aborts when the stream exceeds the cap (no content-length)', async () => {
    const { fetch } = streamingFetch(100, 1000);
    await expect(downloadAsset({ fetch, fullName: 'a/b', assetId: 1, token: 't', maxBytes: 5000 })).rejects.toMatchObject({ code: 'zip-too-large', transient: false });
  });

  it('detects size mismatches and refuses non-https redirects', async () => {
    await expect(downloadAsset({ fetch: streamingFetch(2, 10).fetch, fullName: 'a/b', assetId: 1, token: 't', maxBytes: 100, expectedSize: 30 })).rejects.toMatchObject({
      code: 'asset-size-mismatch',
    });
    await expect(
      downloadAsset({ fetch: streamingFetch(1, 1, { redirect: 'http://evil.example/x' }).fetch, fullName: 'a/b', assetId: 1, token: 't', maxBytes: 100 }),
    ).rejects.toBeInstanceOf(DownloadError);
  });

  it('parses digests', () => {
    expect(parseDigest(`sha256:${'A'.repeat(64)}`)).toBe('a'.repeat(64));
    expect(parseDigest('md5:abc')).toBeNull();
    expect(parseDigest(null)).toBeNull();
  });
});

const rel = (id: number, versionCode: number, prerelease = false): LockedRelease => ({
  releaseId: id,
  tag: `t${id}`,
  tagCommit: 'a'.repeat(40),
  name: null,
  body: null,
  prerelease,
  publishedAt: '2026-10-01T00:00:00Z',
  htmlUrl: 'https://github.com/a/b/releases/tag/x',
  immutable: true,
  asset: { id, name: 'x.zip', url: 'https://github.com/a/b/releases/download/x/x.zip', size: 1, sha256: 'b'.repeat(64), digest: null },
  version: String(versionCode),
  versionCode,
  prop: {},
});

describe('recomputeReleases', () => {
  it('keeps N newest, always keeps stable, prerelease only when newer than stable', () => {
    const accepted = [rel(1, 1), ...Array.from({ length: 5 }, (_, i) => rel(10 + i, 10 + i, true))];
    const r = recomputeReleases({ stable: null, prerelease: null, releases: [], maxVersionCode: null, maxStableVersionCode: null }, accepted, null, { keep: 3, gone: new Set(), changelogMaxBytes: 100 });
    expect(r.stable!.releaseId).toBe(1);
    expect(r.prerelease!.releaseId).toBe(14);
    expect(r.releases.map((x) => x.releaseId)).toEqual([14, 13, 1]);

    const r2 = recomputeReleases({ stable: null, prerelease: null, releases: [], maxVersionCode: null, maxStableVersionCode: null }, [rel(1, 5), rel(2, 4, true)], null, { keep: 10, gone: new Set(), changelogMaxBytes: 100 });
    expect(r2.prerelease).toBeNull();
  });
});

describe('recomputeReleases deletion', () => {
  const prev = { stable: rel(2, 2), prerelease: null, releases: [rel(2, 2), rel(1, 1)], maxVersionCode: 2, maxStableVersionCode: 2 };
  it('absence from the list alone deletes nothing; only confirmed ids are dropped', () => {
    const kept = recomputeReleases(prev, [], [], { keep: 10, gone: new Set(), changelogMaxBytes: 100 });
    expect([kept.stable!.releaseId, kept.releases.map((x) => x.releaseId), kept.note]).toEqual([2, [2, 1], null]);
    const dropped = recomputeReleases(prev, [], [], { keep: 10, gone: new Set([2]), changelogMaxBytes: 100 });
    expect([dropped.stable!.releaseId, dropped.releases.map((x) => x.releaseId), dropped.maxStableVersionCode]).toEqual([1, [1], 2]);
    expect(dropped.note).toMatch(/^stable-fallback:/);
    const none = recomputeReleases(prev, [], [], { keep: 10, gone: new Set([1, 2]), changelogMaxBytes: 100 });
    expect([none.stable, none.releases]).toEqual([null, []]);
    expect(none.note).toMatch(/^stable-unavailable:/);
  });
});

describe('restoreCandidates', () => {
  const gh = (id: number, day: number): GhRelease =>
    ({ id, tag_name: `t${id}`, name: null, body: null, html_url: '', draft: false, prerelease: false, immutable: true, published_at: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`, assets: [] }) as unknown as GhRelease;
  const ok = { ok: true, checkedAt: '2026-10-01T00:00:00Z' };
  it('only seen-ok releases newer than everything locked, newest `keep`, oldest first', () => {
    const list = [gh(5, 5), gh(4, 4), gh(3, 3), gh(2, 2), gh(1, 1)];
    const seen = { '1': ok, '2': ok, '3': ok, '4': { ok: false, code: 'version-not-newer', checkedAt: ok.checkedAt }, '5': ok };
    const locked = [{ ...rel(2, 2), publishedAt: '2026-10-02T00:00:00Z' }];
    expect(restoreCandidates(list, seen, locked, 10).map((r) => r.id)).toEqual([3, 5]); // 1 is older (trimmed), 4 was rejected
    expect(restoreCandidates(list, seen, locked, 1).map((r) => r.id)).toEqual([5]);
    expect(restoreCandidates(list, { ...seen, '5': { ok: false, skipped: true, checkedAt: ok.checkedAt } }, [], 10).map((r) => r.id)).toEqual([1, 2, 3]);
  });
});

describe('helpers', () => {
  it('caps seen to the newest ids', () => {
    const seen = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [String(i + 1), { ok: true, checkedAt: '2026-10-01T00:00:00Z' }]));
    const c = capSeen(seen);
    expect(Object.keys(c)).toHaveLength(200);
    expect(c['250']).toBeDefined();
    expect(c['50']).toBeUndefined();
  });

  it('truncates UTF-8 safely', () => {
    expect(truncateUtf8('ab中文', 4)).toBe('ab');
    expect(truncateUtf8('abc', 10)).toBe('abc');
  });

  it('parseLock drops invalid entries but keeps valid ones; mergeLock replaces only touched ids', () => {
    const { lock, invalid } = parseLock(JSON.stringify({ schemaVersion: 1, modules: { bad: { id: 'bad' } } }));
    expect(lock.modules).toEqual({});
    expect(invalid[0]!.file).toContain('bad');
    const merged = mergeLock({ schemaVersion: 1, modules: { a: 1 as never, b: 2 as never } }, { schemaVersion: 1, modules: { a: 3 as never, b: 4 as never } }, ['a']);
    expect(merged.modules).toEqual({ a: 3, b: 2 });
  });
});
