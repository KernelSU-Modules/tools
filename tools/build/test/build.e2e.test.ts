import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { ApiIndex, ApiModuleDetail, ApiModules, ApiUpdateJson, type SourcesLock } from '@kernelsu-modules/schema';
import { build, BuildFailure, checkHtmlCsp, NO_RELEASE_NOTES, type BuildOptions, type BuildResult } from '../src/index.ts';
import { fakeGet, FIX, type FakeNetOptions } from './fake-net.ts';
import { COMMITS, repoFiles } from './fixtures/regen.ts';

const DATA_COMMIT = 'd'.repeat(40);
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const noSleep = async () => {};

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? walk(f, base) : [path.relative(base, f)];
  });
}

const read = (dir: string, p: string) => readFileSync(path.join(dir, p), 'utf8');
const readJson = (dir: string, p: string) => JSON.parse(read(dir, p)) as unknown;

let tmp: string;
let out1: string;
let out2: string;
let r1: BuildResult;
let r2: BuildResult;
let get1: ReturnType<typeof fakeGet>;

/** Fixture build with test defaults (offline network, no backoff sleeps). */
function run(over: Partial<BuildOptions> & { outDir: string }, net: FakeNetOptions = {}): Promise<BuildResult> {
  return build({
    dataDir: path.join(FIX, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    dataCommit: DATA_COMMIT,
    httpGet: fakeGet(net),
    log: () => {},
    sleep: noSleep,
    ...over,
  });
}

/** Copy of the fixture data dir with an edited lock (and extra / replaced records). */
function dataWith(name: string, edit: (lock: SourcesLock) => void, records: Record<string, unknown> = {}): string {
  const data = path.join(tmp, name);
  cpSync(path.join(FIX, 'data'), data, { recursive: true });
  const lock = JSON.parse(readFileSync(path.join(data, 'sources.lock.json'), 'utf8')) as SourcesLock;
  edit(lock);
  writeFileSync(path.join(data, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
  for (const [id, rec] of Object.entries(records)) writeFileSync(path.join(data, 'modules', `${id}.yaml`), YAML.stringify(rec));
  return data;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'kernelsu-build-test-'));
  const cache = path.join(tmp, 'cache');
  cpSync(path.join(FIX, 'cache'), cache, { recursive: true });
  out1 = path.join(tmp, 'dist1');
  out2 = path.join(tmp, 'dist2');
  get1 = fakeGet();
  r1 = await run({ outDir: out1, httpGet: get1, now: () => 1_000 });
  // Different data commit: the output does not depend on it, neither does the buildId.
  r2 = await run({ outDir: out2, now: () => 2_000, dataCommit: 'e'.repeat(40) });
}, 240_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('build (fixtures, offline)', () => {
  it('selects only listed modules with a stable release; falls back to cached content when fetching fails', () => {
    expect(r1.outcomes).toEqual([
      { id: 'demo.meta', status: 'stale', contentCommit: COMMITS.metaOld },
      { id: 'demo.nostable', status: 'skipped', reason: 'no validated stable release in the lock (module hidden)' },
      { id: 'demo.toolbox', status: 'ok', contentCommit: COMMITS.toolbox },
    ]);
  });

  it('buildId depends on the output-relevant inputs only, not on the data commit', () => {
    expect(r1.buildId).toMatch(/^[0-9a-f]{16}$/);
    expect(r2.buildId).toBe(r1.buildId);
    expect(r2.repoCommit).toBe('e'.repeat(40));
    expect(ApiIndex.parse(readJson(out2, 'api/v1/index.json')).repoCommit).toBe('e'.repeat(40));
  });

  it('is deterministic: identical file set and digests across runs (except the informational repoCommit)', () => {
    const files = walk(out1).filter((f) => f !== 'build-manifest.json').sort();
    expect(walk(out2).filter((f) => f !== 'build-manifest.json').sort()).toEqual(files);
    for (const f of files) if (f !== 'api/v1/index.json') expect(read(out2, f), f).toBe(read(out1, f));
    const m = readJson(out1, 'build-manifest.json') as { buildId: string; files: Record<string, string>; fileCount: number };
    expect(m.buildId).toBe(r1.buildId);
    expect(Object.keys(m.files)).toEqual(files);
    for (const f of files) expect(m.files[f], f).toBe(sha(readFileSync(path.join(out1, f))));
    expect(m.fileCount).toBe(files.length + 1);
    expect(r1.fileCount).toBe(files.length + 1);
  });

  it('API outputs validate against the schemas', () => {
    const index = ApiIndex.parse(readJson(out1, 'api/v1/index.json'));
    expect(index).toMatchObject({ schemaVersion: 1, buildId: r1.buildId, repoCommit: DATA_COMMIT, modules: 'api/v1/modules.json' });
    expect(index.generatedAt).toBe('2026-10-09T12:00:00Z');
    const list = ApiModules.parse(readJson(out1, index.modules));
    expect(list.modules.map((m) => m.id)).toEqual(['demo.meta', 'demo.toolbox']);
    for (const s of list.modules) {
      const d = ApiModuleDetail.parse(readJson(out1, s.detail));
      expect(d.buildId).toBe(r1.buildId);
      // The API path is extension-less (Pages serves readme.html there and 308-redirects *.html to it).
      expect(d.readme).toBe(`api/v1/modules/${d.id}/readme`);
      expect(existsSync(path.join(out1, `${d.readme}.html`)), d.readme!).toBe(true);
      if (d.icon) expect(existsSync(path.join(out1, d.icon))).toBe(true);
      ApiUpdateJson.parse(readJson(out1, `api/v1/modules/${d.id}/update.json`));
    }
  });

  it('module content is single-language (top-level name / summary, one README)', () => {
    const list = ApiModules.parse(readJson(out1, 'api/v1/modules.json'));
    expect(list.modules.find((m) => m.id === 'demo.toolbox')).toMatchObject({ name: 'Demo Toolbox', summary: 'Utilities for rooted Android devices' });
    const raw = (readJson(out1, 'api/v1/modules.json') as { modules: object[] }).modules[0]!;
    expect(raw).not.toHaveProperty('locales');
    expect(raw).not.toHaveProperty('defaultLocale');
    expect(walk(path.join(out1, 'api/v1/modules/demo.toolbox')).sort()).toEqual(['changelog.md', 'readme.html', 'update.json']);
  });

  it('module detail carries transparency fields, releases incl. prereleases, and sanitized changelogs', () => {
    const d = ApiModuleDetail.parse(readJson(out1, 'api/v1/modules/demo.toolbox.json'));
    expect(d.source).toEqual({ host: 'github', fullName: 'demo/toolbox', url: 'https://github.com/demo/toolbox', commit: COMMITS.toolbox });
    expect(d.homepage).toBe('http://example.org/demo-toolbox');
    expect(d.releases.map((r) => [r.tag, r.prerelease])).toEqual([['v1.3.0-beta', true], ['v1.2.0', false], ['v1.1.0', false]]);
    expect(d.stable.versionCode).toBe(120);
    const st = d.releases[1]!;
    expect(st.attestationUrl).toBe('https://github.com/demo/toolbox/attestations');
    expect(st.changelogHtml).not.toMatch(/onerror|<script/i);
    expect(st.changelogHtml).toContain(`https://github.com/demo/toolbox/blob/${COMMITS.toolboxTag120}/docs/zh-CN.md`);
    expect(st.changelogHtml).toMatch(/<img src="\/assets\/[0-9a-f]{16}\.jpg" alt="shot"/);
    expect(st.changelogHtml).toContain('<a href="https://gone.example.com/x.png" rel="nofollow noopener noreferrer" target="_blank" class="image-link">gone</a>');
    expect(d.releases[2]!.changelogHtml).toBeNull();
    expect(d.health).toEqual({ status: 'ok', lastSuccessAt: '2026-10-09T12:00:00Z' });
    expect(d.updatedAt).toBe('2026-10-02T00:00:00Z');
    const meta = ApiModuleDetail.parse(readJson(out1, 'api/v1/modules/demo.meta.json'));
    expect(meta.metamodule).toBe(true);
    expect(meta.health.status).toBe('stale');
    expect(meta.source.commit).toBe(COMMITS.metaOld);
  });

  it('update.json points at the site-hosted raw changelog of the stable release', () => {
    const u = ApiUpdateJson.parse(readJson(out1, 'api/v1/modules/demo.toolbox/update.json'));
    expect(u).toEqual({
      version: '1.2.0',
      versionCode: 120,
      zipUrl: 'https://github.com/demo/toolbox/releases/download/v1.2.0/toolbox-1.2.0.zip',
      changelog: 'https://modules.kernelsu.org/api/v1/modules/demo.toolbox/changelog.md',
    });
    // Raw Markdown body of the stable release (not rendered: served as text/markdown).
    expect(read(out1, 'api/v1/modules/demo.toolbox/changelog.md')).toBe(
      '### Changes\n- Fixed <img src=x onerror=alert(1)>\n- New [docs](docs/zh-CN.md)\n\n![shot](https://img.example.com/photo.jpg)\n![gone](https://gone.example.com/x.png)\n',
    );
    expect(read(out1, 'api/v1/modules/demo.meta/changelog.md')).toBe('Meta release\n');
    expect(read(out1, '_headers')).toContain('/api/v1/modules/:id/changelog.md\n  Content-Type: text/markdown; charset=utf-8\n');
  });

  it('an empty stable release body yields "(no release notes)"; long bodies are truncated to changelogMaxBytes', async () => {
    const data = dataWith('data-notes', (lock) => {
      lock.modules['demo.toolbox']!.stable!.body = '   ';
      for (const r of [lock.modules['demo.meta']!.stable!, lock.modules['demo.meta']!.releases[0]!]) r.body = 'é'.repeat(70_000);
    });
    const out = path.join(tmp, 'dist-notes');
    await run({ dataDir: data, outDir: out });
    expect(read(out, 'api/v1/modules/demo.toolbox/changelog.md')).toBe(`${NO_RELEASE_NOTES}\n`);
    const long = read(out, 'api/v1/modules/demo.meta/changelog.md');
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(65_536 + 8);
    expect(long.endsWith('…\n')).toBe(true);
    expect(long).not.toContain('�');
  }, 120_000);

  it('README fragments: sanitized, same-origin images only, uncopied images become links', () => {
    const html = read(out1, 'api/v1/modules/demo.toolbox/readme.html');
    expect(html).not.toMatch(/<script|onclick|style=|onerror/i);
    expect(html).toContain('<div align="center">');
    expect(html).toContain('Raw <b>HTML</b> paragraph');
    // every <img> is a local, root-absolute asset
    const srcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]!);
    expect(srcs.length).toBeGreaterThanOrEqual(4);
    for (const s of srcs) expect(s).toMatch(/^\/assets\/[0-9a-f]{16}\.(png|jpg|gif|webp|svg)$/);
    for (const s of srcs) expect(existsSync(path.join(out1, s))).toBe(true);
    // limit exceeded -> link; unsafe / not an image / redirect loop -> dropped
    expect(html).toContain('<a href="https://huge.example.com/big.png" rel="nofollow noopener noreferrer" target="_blank" class="image-link">Huge</a>');
    expect(html).not.toContain('10.0.0.1');
    expect(html).not.toContain('notimage');
    expect(html).not.toContain('redirect.example.com');
    expect(html).toContain(`href="https://github.com/demo/toolbox/blob/${COMMITS.toolbox}/docs/zh-CN.md"`);
    expect(html).toContain(`href="https://github.com/demo/toolbox/blob/${COMMITS.toolbox}/LICENSE"`);
    expect(html).toContain('href="#user-content-features-"');
    expect(html).toContain('<h2 id="user-content-features-">Features ✨</h2>');
  });

  it('copied SVGs are sanitized', () => {
    const svgs = walk(path.join(out1, 'assets')).filter((f) => f.endsWith('.svg'));
    expect(svgs.length).toBeGreaterThanOrEqual(2); // badge + meta icon (+ site logo)
    for (const f of svgs) {
      const s = read(path.join(out1, 'assets'), f);
      expect(s, f).not.toMatch(/<script|onload|onmouseover|javascript:|foreignObject|<set|style=/i);
    }
  });

  it('remote images are refetched only after the TTL (second run is served from cache)', () => {
    expect(get1.calls.some((u) => u.startsWith('https://img.example.com/badge.svg'))).toBe(true);
    expect(get1.calls.some((u) => u.includes('10.0.0.1'))).toBe(false); // refused before any request
    expect(get1.calls.filter((u) => u.startsWith('https://redirect.example.com/')).length).toBe(4); // 1 + 3 redirects
  });

  it('emits the site: per-locale list and detail pages, search indexes, 404, _headers', () => {
    for (const p of [
      'index.html', 'en/index.html', 'zh-CN/index.html', 'en/modules/demo.toolbox/index.html', 'zh-CN/modules/demo.toolbox/index.html',
      'en/modules/demo.meta/index.html', '404.html', 'search/en.json', 'search/zh-CN.json', '_headers', 'favicon.ico', 'robots.txt', 'sitemap.xml',
    ])
      expect(existsSync(path.join(out1, p)), p).toBe(true);
    expect(existsSync(path.join(out1, 'en/modules/demo.suspended/index.html'))).toBe(false);
    expect(existsSync(path.join(out1, 'api/v1/modules/demo.suspended.json'))).toBe(false);
    expect(existsSync(path.join(out1, 'api/v1/modules/demo.pending.json'))).toBe(false);
    expect(existsSync(path.join(out1, 'api/v1/modules/demo.nostable.json'))).toBe(false);

    const search = readJson(out1, 'search/zh-CN.json') as { buildId: string; modules: { id: string; name: string; url: string }[] };
    expect(search.buildId).toBe(r1.buildId);
    expect(search.modules.find((m) => m.id === 'demo.toolbox')).toMatchObject({ name: 'Demo Toolbox', url: 'zh-CN/modules/demo.toolbox/' });

    const zh = read(out1, 'zh-CN/modules/demo.toolbox/index.html');
    expect(zh).toContain('Demo Toolbox');
    expect(zh).toContain(COMMITS.toolboxTag120.slice(0, 12));
    expect(zh).toContain('https://github.com/demo/toolbox/attestations');
    expect(zh).toContain(sha('demo/toolbox:toolbox-1.2.0.zip'));
    expect(zh).toContain('不可变 Release');
    expect(zh).toContain('href="http://example.org/demo-toolbox" rel="nofollow noopener noreferrer"');
    expect(zh).not.toContain('v1.3.0-beta'); // prereleases are recorded but not shown
    // Site page README = the API fragment: local copies, everything else linked.
    expect(zh).toMatch(/<img src="\/assets\/[0-9a-f]{16}\.png" alt="Screenshot"/);
    expect(zh).toContain('class="image-link">Huge</a>');
    for (const m of zh.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)) expect(m[1]!, m[1]).toMatch(/^\/assets\//);
    for (const m of zh.matchAll(/<img[^>]*\ssrc="(\/assets\/[^"]+)"/g)) expect(existsSync(path.join(out1, m[1]!)), m[1]).toBe(true);
    const meta = read(out1, 'en/modules/demo.meta/index.html');
    expect(meta).toContain('Metamodule');
    expect(meta).toContain('Stale');
    expect(meta).toContain('Last change synced');

    const headers = read(out1, '_headers');
    expect(headers).toContain("Content-Security-Policy: default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'");
    expect(headers).not.toContain('https:;');
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toMatch(/\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/);
    expect(headers).toMatch(/\/api\/v1\/\*\n {2}Cache-Control: public, max-age=60/);
  });

  it('site HTML has no inline scripts/styles/handlers and no third-party subresources', () => {
    const pages = walk(out1).filter((x) => x.endsWith('.html'));
    for (const f of pages) expect(checkHtmlCsp(read(out1, f)), f).toEqual([]);
    for (const f of pages.filter((x) => !x.startsWith('api/'))) {
      const html = read(out1, f);
      for (const m of html.matchAll(/<script\b[^>]*>/g)) expect(m[0], f).toMatch(/\ssrc="(?:\.\.\/|\.\/|\/)[^"]*assets\/[0-9a-f]{16}\.js"/);
      expect(html, f).not.toMatch(/<style\b|\sstyle="|\son[a-z]+="/i);
      for (const m of html.matchAll(/<link\b[^>]*>/g)) if (/rel="(stylesheet|icon)"/.test(m[0])) expect(m[0], f).not.toContain('https://');
    }
  });

  it('a digest mismatch is a content error: unverified content is never published, only that module is skipped', async () => {
    const out = path.join(tmp, 'dist-tamper');
    const res = await run({ outDir: out, cacheDir: path.join(tmp, 'empty-cache') }, { tamper: true });
    expect(res.outcomes.find((o) => o.id === 'demo.toolbox')).toMatchObject({ status: 'skipped' });
    expect(res.outcomes.find((o) => o.id === 'demo.toolbox')!.reason).toMatch(/sha256 mismatch for README.md/);
    expect(res.outcomes.find((o) => o.id === 'demo.meta')).toMatchObject({ status: 'skipped' });
    expect(ApiModules.parse(readJson(out, 'api/v1/modules.json')).modules).toEqual([]);
    expect(read(out, 'en/index.html')).not.toContain('tampered');
  }, 120_000);

  it('unreachable module inputs without a last good copy fail the whole build (previous output kept)', async () => {
    const out = path.join(tmp, 'dist-down');
    cpSync(out1, out, { recursive: true });
    const get = fakeGet({ down: ['raw.githubusercontent.com'] });
    await expect(
      run({ outDir: out, cacheDir: path.join(tmp, 'empty-cache-2'), httpGet: get, retry: { retries: 2, baseDelayMs: 1 } }),
    ).rejects.toThrow(BuildFailure);
    expect(read(out, 'build-manifest.json')).toBe(read(out1, 'build-manifest.json'));
    // the repository fetch was retried (1 + 2 attempts) before giving up
    expect(get.calls.filter((u) => u.endsWith(`${COMMITS.metaNew}/module.yaml`)).length).toBe(3);
  }, 120_000);

  it('unreachable module inputs with a verified last good copy serve it stale', async () => {
    const data = dataWith('data-moved', (lock) => {
      const c = lock.modules['demo.toolbox']!.content!;
      c.commit = '7'.repeat(40);
      c.files = { ...c.files, 'README.md': sha('changed upstream') };
    });
    const res = await run(
      { dataDir: data, outDir: path.join(tmp, 'dist-stale'), retry: { retries: 1, baseDelayMs: 1 } },
      { down: ['raw.githubusercontent.com'] },
    );
    expect(res.outcomes.find((o) => o.id === 'demo.toolbox')).toEqual({ id: 'demo.toolbox', status: 'stale', contentCommit: COMMITS.toolbox });
    expect(res.warnings.some((w) => w.includes('using last good content'))).toBe(true);
  }, 120_000);

  it('transient 5xx / 429 are retried with backoff and then succeed', async () => {
    const sleeps: number[] = [];
    const res = await run(
      {
        outDir: path.join(tmp, 'dist-flaky'),
        cacheDir: path.join(tmp, 'empty-cache-3'),
        retry: { retries: 3, baseDelayMs: 10, maxDelayMs: 15 },
        sleep: async (ms) => void sleeps.push(ms),
      },
      { flaky: { 'raw.githubusercontent.com': [503, 2] } },
    );
    expect(res.outcomes.find((o) => o.id === 'demo.toolbox')).toMatchObject({ status: 'ok' });
    expect(sleeps.slice(0, 2)).toEqual([10, 15]);
  }, 120_000);

  it('a module whose files would collide with another module is skipped, not fatal', async () => {
    const files = repoFiles('demo/collide', ['module.yaml', 'README.md']);
    const data = dataWith(
      'data-collide',
      (lock) => {
        const t = lock.modules['demo.toolbox']!;
        lock.modules['demo.toolbox.json'] = {
          ...structuredClone(t),
          id: 'demo.toolbox.json',
          repositoryId: 1006,
          fullName: 'demo/collide',
          content: { ref: 'main', commit: COMMITS.collide, fetchedAt: '2026-10-02T00:00:00Z', manifestPath: 'module.yaml', files },
        };
      },
      {
        'demo.toolbox.json': {
          id: 'demo.toolbox.json',
          status: 'listed',
          source: { host: 'github', repositoryId: 1006, ownerId: 506, fullName: 'demo/collide' },
          createdAt: '2026-08-01T00:00:00Z',
          updatedAt: '2026-08-01T00:00:00Z',
        },
      },
    );
    const out = path.join(tmp, 'dist-collide');
    const res = await run({ dataDir: data, outDir: out });
    const o = res.outcomes.find((x) => x.id === 'demo.toolbox.json')!;
    expect(o.status).toBe('skipped');
    expect(o.reason).toMatch(/output path collision: .*api\/v1\/modules\/demo\.toolbox\.json/);
    expect(res.outcomes.find((x) => x.id === 'demo.toolbox')).toMatchObject({ status: 'ok' });
    expect(statSync(path.join(out, 'api/v1/modules/demo.toolbox.json')).isFile()).toBe(true);
    expect(ApiModules.parse(readJson(out, 'api/v1/modules.json')).modules.map((m) => m.id)).toEqual(['demo.meta', 'demo.toolbox']);
  }, 120_000);

  it('global file budget: images degrade to links instead of failing; non-image overflow fails', async () => {
    const out = path.join(tmp, 'dist-budget');
    const res = await run({ outDir: out, fileLimits: { soft: 0 } });
    expect(res.warnings.some((w) => w.includes('file budget reached'))).toBe(true);
    const d = ApiModuleDetail.parse(readJson(out, 'api/v1/modules/demo.toolbox.json'));
    expect(d.icon).toBeNull();
    const html = read(out, 'api/v1/modules/demo.toolbox/readme.html');
    expect(html).not.toContain('<img');
    expect(html).toContain('class="image-link">Screenshot</a>');
    expect(walk(path.join(out, 'assets')).filter((f) => /\.(png|jpg|gif|webp)$/.test(f))).toEqual([]);
    expect(res.buildId).not.toBe(r1.buildId); // different output -> different buildId

    await expect(run({ outDir: path.join(tmp, 'dist-overflow'), fileLimits: { soft: 0, max: 10 } })).rejects.toThrow(/above the safety limit 10/);
  }, 120_000);

  it('buildId ignores unrelated data changes but follows output-relevant ones', async () => {
    // status.json, a pending record and lock bookkeeping (seen, lastAttemptAt, a hidden module) do not reach the output.
    const data = dataWith(
      'data-noise',
      (lock) => {
        const t = lock.modules['demo.toolbox']!;
        t.seen['999'] = { ok: false, code: 'asset-none', checkedAt: '2026-10-10T00:00:00Z' };
        t.health.lastAttemptAt = '2026-10-10T00:00:00Z';
        lock.modules['demo.suspended']!.health.message = 'x: changed';
      },
      {
        'demo.pending': { ...(YAML.parse(read(path.join(FIX, 'data/modules'), 'demo.pending.yaml')) as object), updatedAt: '2026-10-10T00:00:00Z' },
      },
    );
    writeFileSync(path.join(data, 'status.json'), '{"schemaVersion":1,"modules":{}}\n');
    const quiet = await run({ dataDir: data, outDir: path.join(tmp, 'dist-noise') });
    expect(quiet.buildId).toBe(r1.buildId);

    const other = await run({ outDir: path.join(tmp, 'dist-fp'), builderFingerprint: '0'.repeat(64) });
    expect(other.buildId).not.toBe(r1.buildId);
    const base = await run({ outDir: path.join(tmp, 'dist-base'), baseUrl: 'https://mirror.example.org' });
    expect(base.buildId).not.toBe(r1.buildId);
    expect(ApiUpdateJson.parse(readJson(path.join(tmp, 'dist-base'), 'api/v1/modules/demo.toolbox/update.json')).changelog).toBe(
      'https://mirror.example.org/api/v1/modules/demo.toolbox/changelog.md',
    );
  }, 240_000);

  it('an empty data repo (no modules/ directory, empty lock) builds a site without modules', async () => {
    const data = path.join(tmp, 'empty-data');
    mkdirSync(data);
    cpSync(path.join(FIX, 'data', 'policy.yaml'), path.join(data, 'policy.yaml'));
    writeFileSync(path.join(data, 'sources.lock.json'), '{\n  "modules": {},\n  "schemaVersion": 1\n}\n');
    const out = path.join(tmp, 'dist-empty');
    const res = await run({ dataDir: data, outDir: out });
    expect(res.outcomes).toEqual([]);
    expect(ApiModules.parse(readJson(out, 'api/v1/modules.json')).modules).toEqual([]);
    for (const p of ['index.html', 'en/index.html', 'zh-CN/index.html', 'search/en.json', '_headers', 'build-manifest.json']) expect(existsSync(path.join(out, p)), p).toBe(true);
  }, 240_000);

  it('global input errors fail the whole build and keep the previous output', async () => {
    const data = path.join(tmp, 'bad-data');
    cpSync(path.join(FIX, 'data'), data, { recursive: true });
    writeFileSync(path.join(data, 'sources.lock.json'), '{"schemaVersion": 2, "modules": {}}');
    const out = path.join(tmp, 'dist-bad');
    cpSync(out1, out, { recursive: true });
    await expect(run({ dataDir: data, outDir: out })).rejects.toThrow(/sources.lock.json invalid/);
    expect(read(out, 'build-manifest.json')).toBe(read(out1, 'build-manifest.json'));
  });
});
