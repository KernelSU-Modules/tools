import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDocs, renderDocs, rewriteHref, routeOf, outFileOf, slugify } from '../build/docs.ts';

describe('docs routing', () => {
  it('maps files to routes and output files', () => {
    expect(routeOf('index.md')).toBe('/docs/');
    expect(routeOf('checks.md')).toBe('/docs/checks');
    expect(routeOf('zh-CN/index.md')).toBe('/docs/zh-CN/');
    expect(routeOf('zh-CN/checks.md')).toBe('/docs/zh-CN/checks');
    expect(routeOf('guides/README.md')).toBe('/docs/guides/');
    expect(outFileOf('/docs/')).toBe('docs/index.html');
    expect(outFileOf('/docs/checks')).toBe('docs/checks.html');
    expect(outFileOf('/docs/zh-CN/')).toBe('docs/zh-CN/index.html');
  });
  it('rewrites relative .md links to extension-less routes', () => {
    expect(rewriteHref('releasing.md#using-the-module-release-action', 'index.md')).toBe('/docs/releasing#using-the-module-release-action');
    expect(rewriteHref('../index.md', 'zh-CN/faq.md')).toBe('/docs/');
    expect(rewriteHref('checks.md#x', 'zh-CN/faq.md')).toBe('/docs/zh-CN/checks#x');
    expect(rewriteHref('zh-CN/index.md', 'index.md')).toBe('/docs/zh-CN/');
    expect(rewriteHref('https://example.com/a.md', 'index.md')).toBeNull();
    expect(rewriteHref('#local', 'index.md')).toBeNull();
    expect(rewriteHref('img/a.png', 'index.md')).toBeNull();
  });
  it('slugs like GitHub, without user-content- prefix', () => {
    expect(slugify('release-not-immutable')).toBe('release-not-immutable');
    expect(slugify('Using the module-release action')).toBe('using-the-module-release-action');
    expect(slugify('Markdown and HTML in descriptions')).toBe('markdown-and-html-in-descriptions');
    expect(slugify('语言回退')).toBe('语言回退');
  });
});

describe('renderDocs', () => {
  it('renders anchors, dedupes ids, supports {#id} and placeholders', () => {
    const out = renderDocs(
      [
        { rel: 'checks.md', markdown: '# Checks\n\n### `release-not-immutable`\n\nx\n\n### Same\n\n### Same\n\n## Custom {#my-id}\n\nSee [faq](faq.md#q).' },
        { rel: 'zh-CN/checks.md', markdown: '# 校验\n\n### release-not-immutable\n' },
      ],
      'body{}',
    );
    const en = out.files.get('docs/checks.html') as string;
    expect(en).toContain('<h3 id="release-not-immutable">');
    expect(en).toContain('<h3 id="same">');
    expect(en).toContain('<h3 id="same-1">');
    expect(en).toContain('<h2 id="my-id">Custom');
    expect(en).toContain('href="/docs/faq#q"');
    expect(en).toContain('href="/docs/zh-CN/checks"'); // language switch
    expect(en).not.toContain('user-content-');
    expect(en).not.toMatch(/<script/);
    expect(out.files.has('docs/index.html')).toBe(true); // placeholder index
    expect(out.files.get('docs/zh-CN/checks.html')).toContain('<html lang="zh-CN">');
    expect(out.localeRoutes['zh-CN']).toEqual(['/checks']);
  });
  it('produces placeholder pages when there are no docs', () => {
    const out = renderDocs([], '');
    expect(out.files.get('docs/checks.html')).toContain('<h3 id="release-not-immutable">');
  });
  it('renders the real docs/developers tree (if present) with issue-code anchors', () => {
    const dir = fileURLToPath(new URL('../../docs/developers', import.meta.url));
    const out = buildDocs(dir, '');
    const checks = out.files.get('docs/checks.html') as string;
    expect(checks).toMatch(/<h3 id="[a-z0-9-]+">/);
    for (const p of out.pages) expect(p.html).not.toMatch(/href="[^"]*\.md(#[^"]*)?"/);
  });
});
