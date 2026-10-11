// Builds the Astro site from a synthetic page-data file and checks the generated HTML.
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiModuleDetail } from '@kernelsu-modules/schema';
import { buildSearchIndex, SITE_DATA_SCHEMA, type SiteData, type SiteModule } from '../src/lib/index.ts';
import { compactCount, displayUrl, safeHref, safeWebHref } from '../src/lib/format.ts';
import { buildSite } from '../src/lib/build.ts';

const C = 'c'.repeat(40);
const T = 'f'.repeat(40);
const H = '0'.repeat(64);

function mod(id: string, over: Partial<ApiModuleDetail> = {}): SiteModule {
  const rel = (version: string, versionCode: number, prerelease: boolean) => ({
    tag: `v${version}`,
    name: null,
    version,
    versionCode,
    prerelease,
    publishedAt: '2026-10-01T00:00:00Z',
    changelogHtml: `<p>notes ${version}</p>`,
    zip: { url: `https://github.com/o/${id}/releases/download/v${version}/${id}.zip`, name: `${id}.zip`, size: 2048, sha256: H },
    tagCommit: T,
    releaseUrl: `https://github.com/o/${id}/releases/tag/v${version}`,
    attestationUrl: `https://github.com/o/${id}/attestations`,
    immutable: true as const,
  });
  const detail = ApiModuleDetail.parse({
    id,
    name: `${id} <name>`,
    summary: 'Summary & "quotes"',
    authors: [{ name: 'Alice', url: 'https://github.com/alice' }],
    tags: ['tools'],
    metamodule: false,
    icon: null,
    stable: { version: '1.0', versionCode: 10, publishedAt: '2026-10-01T00:00:00Z' },
    detail: `api/v1/modules/${id}.json`,
    updatedAt: '2026-10-01T00:00:00Z',
    schemaVersion: 1,
    buildId: '0123456789abcdef',
    license: 'MIT',
    homepage: 'https://example.com/home',
    support: 'http://forum.example.com/t/1',
    compatibility: { androidMinApi: 29, architectures: ['arm64-v8a'] },
    source: { host: 'github', fullName: `o/${id}`, url: `https://github.com/o/${id}`, commit: C },
    readme: `api/v1/modules/${id}/readme`,
    releases: [rel('1.1-beta', 11, true), rel('1.0', 10, false)],
    health: { status: 'ok', lastSuccessAt: '2026-10-02T00:00:00Z' },
    ...over,
  });
  return {
    detail,
    readme:
      '<p>readme <img src="/assets/0123456789abcdef.png" alt=""> <code>style="x" &lt;script&gt;</code> ' +
      '<a href="https://img.example.com/x.png" rel="nofollow noopener noreferrer" target="_blank" class="image-link">remote</a></p>',
  };
}

const data: SiteData = {
  schemaVersion: SITE_DATA_SCHEMA,
  baseUrl: 'https://modules.kernelsu.org',
  portalUrl: 'https://developers.kernelsu.org',
  buildId: '0123456789abcdef',
  generatedAt: '2026-10-09T00:00:00Z',
  modules: [
    mod('alpha.mod', { metamodule: true, health: { status: 'stale', lastSuccessAt: null }, updatedAt: '2026-10-05T00:00:00Z' }),
    mod('zeta.mod', { stars: 1234, starsRepository: 'o/zeta-old' }),
  ],
};

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .flatMap((n) => {
      const f = path.join(dir, n);
      return statSync(f).isDirectory() ? walk(f, base) : [path.relative(base, f).split(path.sep).join('/')];
    })
    .sort();
}

let tmp: string;
let out1: string;
let out2: string;
let files: string[];
const get = (p: string) => readFileSync(path.join(out1, p), 'utf8');
const pages = () => files.filter((f) => f.endsWith('.html'));

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'kernelsu-site-test-'));
  const dataFile = path.join(tmp, 'site-data.json');
  writeFileSync(dataFile, JSON.stringify(data));
  out1 = path.join(tmp, 'out1');
  out2 = path.join(tmp, 'out2');
  // In parallel: builds must be isolated from each other.
  await Promise.all([
    buildSite({ dataFile, outDir: out1, site: data.baseUrl, logLevel: 'error' }),
    buildSite({ dataFile, outDir: out2, site: data.baseUrl, logLevel: 'error' }),
  ]);
  files = walk(out1);
}, 180_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('Astro site build', () => {
  it('emits every page per UI locale plus 404, sitemap, robots and favicon', () => {
    for (const p of [
      'index.html', 'en/index.html', 'zh-CN/index.html', 'en/modules/alpha.mod/index.html', 'en/modules/zeta.mod/index.html',
      'zh-CN/modules/alpha.mod/index.html', 'zh-CN/modules/zeta.mod/index.html', '404.html', 'sitemap.xml', 'robots.txt', 'favicon.ico',
    ])
      expect(files, p).toContain(p);
    // Besides pages only content-hashed assets: nothing Astro-internal leaks into dist.
    for (const f of files.filter((x) => !/\.(html|xml|txt|ico)$/.test(x))) expect(f).toMatch(/^assets\/[0-9a-f]{16}\.(css|js|svg)$/);
    expect(files.filter((f) => f.endsWith('.css'))).toHaveLength(1);
    expect(get('sitemap.xml')).toContain('<loc>https://modules.kernelsu.org/zh-CN/modules/zeta.mod/</loc>');
    expect(get('robots.txt')).toContain('Sitemap: https://modules.kernelsu.org/sitemap.xml');
  });

  it('is deterministic: a second build is byte-identical', () => {
    const sha = (dir: string, f: string) => createHash('sha256').update(readFileSync(path.join(dir, f))).digest('hex');
    expect(walk(out2)).toEqual(files);
    for (const f of files) expect(sha(out2, f), f).toBe(sha(out1, f));
  });

  it('escapes module-provided strings but injects the sanitized README as HTML', () => {
    const p = get('en/modules/zeta.mod/index.html');
    expect(p).toContain('zeta.mod &lt;name&gt;');
    expect(p).toMatch(/Summary &amp; (&quot;|&#34;|")quotes/);
    expect(p).not.toContain('<name>');
    expect(p).toContain('<img src="/assets/0123456789abcdef.png" alt="">');
    expect(p).toContain('<p>notes 1.0</p>');
  });

  it('detail page: transparency fields, badges, release history without prereleases', () => {
    const p = get('en/modules/alpha.mod/index.html');
    for (const s of ['Immutable release', 'Metamodule', 'Stale', 'MIT', 'example.com/home', '29 – ∞', 'arm64-v8a', H]) expect(p, s).toContain(s);
    expect(p).toContain('href="https://github.com/o/alpha.mod"');
    expect(p).toContain('href="https://github.com/o/alpha.mod/releases/tag/v1.0"');
    expect(p).toContain(`href="https://github.com/o/alpha.mod/commit/${T}"`);
    expect(p).toContain(`href="https://github.com/o/alpha.mod/tree/${C}"`);
    expect(p).toContain('href="https://github.com/o/alpha.mod/attestations"');
    expect(p).toContain('gh release verify v1.0 -R o/alpha.mod');
    expect(p).not.toContain('1.1-beta');
    const z = get('en/modules/zeta.mod/index.html');
    expect(z).toContain('Synced');
    expect(z).not.toContain('Stale');
  });

  it('module content is single-language: the same name / summary / README on every UI locale', () => {
    const zh = get('zh-CN/modules/zeta.mod/index.html');
    const en = get('en/modules/zeta.mod/index.html');
    expect(zh).toContain('<html lang="zh-CN"');
    for (const p of [zh, en]) {
      expect(p).toContain('zeta.mod &lt;name&gt;');
      expect(p).toContain('<img src="/assets/0123456789abcdef.png" alt="">');
      expect(p).toContain('class="image-link">remote</a>');
      expect(p).not.toMatch(/content-language|This description is shown in|该介绍以/);
    }
    expect(zh).toContain('不可变 Release');
    expect(zh).toContain('最近同步到变更');
    expect(en).toContain('Last change synced');
    // http homepage/support links are allowed, rendered like every external link
    expect(en).toContain('href="http://forum.example.com/t/1" rel="nofollow noopener noreferrer"');
  });

  it('header: labelled navs, language list, theme toggle, mobile menu, search combobox', () => {
    const p = get('zh-CN/modules/zeta.mod/index.html');
    expect(p).toMatch(/<nav[^>]*aria-label="语言"[^>]*>\s*<ul/);
    expect(p).toMatch(/<span aria-current="true" lang="zh-CN"[^>]*>\s*简体中文\s*<\/span>/);
    expect(p).toContain('href="/en/modules/zeta.mod/" hreflang="en" lang="en"');
    expect(p).toMatch(/<button type="button" id="theme-toggle" hidden aria-label="切换深色模式"/);
    expect(p).toMatch(/<details class="mobile-menu[^"]*">\s*<summary/);
    expect(p).toMatch(/<input[^>]*id="site-search"[^>]*role="combobox"[^>]*aria-expanded="false"[^>]*aria-controls="site-search-listbox"/);
    expect(p).toMatch(/id="site-search-listbox" role="listbox"/);
    // theme bootstrap: external, render-blocking, content-hashed, in <head>
    const head = p.slice(0, p.indexOf('</head>'));
    expect(head).toMatch(/<script src="\/assets\/[0-9a-f]{16}\.js"><\/script>/);
  });

  it('detail page: tab bar of in-page links (JS turns them into ARIA tabs), panels, verbatim versions', () => {
    const p = get('en/modules/zeta.mod/index.html');
    expect(p).toMatch(/<nav id="module-tabs"[^>]*aria-label="Module sections"/);
    for (const id of ['readme', 'releases', 'transparency']) {
      expect(p).toContain(`href="#${id}"`);
      expect(p).toMatch(new RegExp(`<section id="${id}" class="tab-panel`));
    }
    expect(p).toContain('Download 1.0');
    expect(p).not.toContain('v1.0 ·');
    // header: KernelSU logo as SVG icon next to favicon.ico; footer links the Developer Portal
    expect(p).toMatch(/<link rel="icon" href="\/assets\/[0-9a-f]{16}\.svg" type="image\/svg\+xml">/);
    expect(p).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">');
    expect(p).toContain('href="https://developers.kernelsu.org" class="link">KernelSU Developer Portal</a>');
    expect(get('zh-CN/modules/zeta.mod/index.html')).toContain('KernelSU 开发者门户');
  });

  it('list page: heading with module count, publish link, module rows with version and actions', () => {
    const list = get('en/index.html');
    expect(list).toContain('2 modules, published by their authors as immutable GitHub releases.');
    expect(list).toMatch(/<a href="https:\/\/developers\.kernelsu\.org" class="btn btn-primary[^"]*">[\s\S]*?Publish a module/);
    expect(list).toMatch(/<span class="label label-success"[^>]*>1\.0<\/span>/);
    expect(list).toMatch(/<time datetime="2026-10-01T00:00:00Z" data-relative>2026-10-01<\/time>/);
    expect(list).toContain('href="https://example.com/home" rel="nofollow noopener noreferrer" class="btn btn-sm">Homepage</a>');
    expect(list).toMatch(/<div id="list-tools" hidden/);
    expect(get('zh-CN/index.html')).toContain('共 2 个模块');
  });

  it('stars: compact count in the list row and the About box (linked to the counted repository); sort option', () => {
    for (const ui of ['en', 'zh-CN'] as const) {
      const list = get(`${ui}/index.html`);
      expect(list).toContain('<option value="stars">');
      const zeta = list.slice(list.indexOf('data-id="zeta.mod"'));
      expect(list).toMatch(/data-id="zeta.mod"[^>]*data-stars="1234"/);
      expect(list).toMatch(/data-id="alpha.mod"[^>]*data-stars="0"/);
      expect(zeta).toMatch(/class="stars inline-flex[^"]*" title="[^"]*1234[^"]*">[\s\S]*?1\.2k/);
    }
    expect(get('en/index.html')).toContain('Most stars');
    expect(get('zh-CN/index.html')).toContain('最多 Star');
    const alpha = get('en/index.html');
    expect(alpha.slice(alpha.indexOf('data-id="alpha.mod"'), alpha.indexOf('data-id="zeta.mod"'))).not.toContain('class="stars');
    const detail = get('en/modules/zeta.mod/index.html');
    expect(detail).toMatch(/href="https:\/\/github\.com\/o\/zeta-old\/stargazers" rel="nofollow noopener noreferrer" class="stars link[^"]*" title="1234 stars on GitHub">[\s\S]*?1\.2k/);
    expect(detail).toContain('of o/zeta-old');
    expect(get('zh-CN/modules/zeta.mod/index.html')).toContain('来自 o/zeta-old');
    expect(get('en/modules/alpha.mod/index.html')).not.toContain('class="stars');
  });

  it('lists modules newest first with localized links and alternates', () => {
    const list = get('zh-CN/index.html');
    expect(list.indexOf('data-id="alpha.mod"')).toBeLessThan(list.indexOf('data-id="zeta.mod"'));
    expect(list).toContain('href="/zh-CN/modules/zeta.mod/"');
    expect(list).toContain('<link rel="canonical" href="https://modules.kernelsu.org/zh-CN/">');
    expect(list).toContain('hreflang="en" href="https://modules.kernelsu.org/en/"');
    expect(list).toContain('hreflang="x-default" href="https://modules.kernelsu.org/en/"');
    expect(list).toContain('data-search="/search/zh-CN.json"');
    const root = get('index.html');
    expect(root).toContain('data-auto-locale="en zh-CN"');
    expect(root).toContain('<link rel="canonical" href="https://modules.kernelsu.org/en/">');
    expect(get('sitemap.xml')).not.toContain('<loc>https://modules.kernelsu.org/</loc>');
    const detail = get('en/modules/zeta.mod/index.html');
    expect(detail).toContain('hreflang="x-default" href="https://modules.kernelsu.org/en/modules/zeta.mod/"');
    expect(detail).toContain('hreflang="zh-CN" href="https://modules.kernelsu.org/zh-CN/modules/zeta.mod/"');
    expect(get('404.html')).toContain('noindex');
    expect(get('404.html')).not.toContain('rel="canonical"');
  });

  it('has no inline script/style/handlers and only same-origin script/style subresources', () => {
    for (const f of pages()) {
      const h = get(f);
      const scripts = [...h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      expect(scripts.length, f).toBeGreaterThan(0);
      for (const [, attrs, inner] of scripts) {
        expect(attrs, f).toMatch(/\ssrc="\/assets\/[0-9a-f]{16}\.js"/);
        expect(inner, f).toBe('');
      }
      expect(h, f).not.toMatch(/<style\b|\sstyle="|\son[a-z]+="/i);
      const css = [...h.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map((m) => m[0]);
      expect(css.length, f).toBe(1);
      for (const l of css) expect(l, f).toMatch(/href="\/assets\/[0-9a-f]{16}\.css"/);
    }
  });

  it('does not embed build-machine paths', () => {
    for (const f of files.filter((x) => /\.(html|js|css|xml)$/.test(x))) {
      const s = get(f);
      expect(s, f).not.toContain(tmp);
      expect(s, f).not.toContain(os.homedir());
    }
  });
});

describe('page-data helpers', () => {
  it('search index is per locale, sorted by id, with site-root-relative URLs', () => {
    const s = buildSearchIndex(data, 'zh-CN');
    expect(s.modules.map((m) => m.id)).toEqual(['alpha.mod', 'zeta.mod']);
    expect(s.modules[0]!.url).toBe('zh-CN/modules/alpha.mod/');
    expect(s.buildId).toBe(data.buildId);
  });
  it('search entries carry stars (null when not recorded)', () => {
    expect(buildSearchIndex(data, 'en').modules.map((m) => [m.id, m.stars])).toEqual([['alpha.mod', null], ['zeta.mod', 1234]]);
  });
  it('compactCount formats like GitHub, deterministically', () => {
    expect([0, 7, 999, 1000, 1049, 1050, 1234, 12_345, 999_949, 999_950, 1_500_000, 12_000_000].map(compactCount)).toEqual([
      '0', '7', '999', '1k', '1k', '1.1k', '1.2k', '12.3k', '999.9k', '1M', '1.5M', '12M',
    ]);
  });
  it('search entries carry the single-language name and summary', () => {
    for (const ui of ['en', 'zh-CN'] as const) {
      expect(buildSearchIndex(data, ui).modules[0]).toMatchObject({ name: 'alpha.mod <name>', summary: 'Summary & "quotes"' });
    }
  });
  it('safeHref refuses dangerous URLs', () => {
    expect(() => safeHref('javascript:alert(1)')).toThrow();
    expect(() => safeHref('//evil.example/x')).toThrow();
    expect(() => safeHref('http://x.example/')).toThrow();
    expect(safeWebHref('http://x.example/')).toBe('http://x.example/');
    expect(() => safeWebHref('javascript:alert(1)')).toThrow();
    expect(() => safeWebHref('http://x.example/"onmouseover=')).toThrow();
    expect(displayUrl('https://a.example/b')).toBe('a.example/b');
    expect(safeHref('https://github.com/a')).toBe('https://github.com/a');
    expect(safeHref('/assets/x.css')).toBe('/assets/x.css');
  });
});
