import { describe, expect, it } from 'vitest';
import { renderChangelog, renderMarkdown, resolveRepoUrl } from '../src/index.ts';
import { parseSrcset, sanitizeSrcset } from '../src/sanitize.ts';

const C = 'b'.repeat(40);
const ctx = { fullName: 'octo/mod', commit: C, docPath: 'docs/zh-CN.md' };

describe('renderMarkdown', () => {
  it('renders GFM features', () => {
    const md = [
      '# Title',
      '',
      '## Install :rocket:',
      '',
      '## Install',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | ~~2~~ |',
      '',
      '- [x] done',
      '- [ ] todo',
      '',
      '> [!WARNING]',
      '> Be careful',
      '',
      'Footnote[^n].',
      '',
      '[^n]: The note.',
      '',
      'https://autolink.example/path',
    ].join('\n');
    const { html } = renderMarkdown(md, ctx);
    expect(html).toContain('<h1 id="user-content-title">Title</h1>');
    expect(html).toContain('<h2 id="user-content-install-">Install 🚀</h2>');
    expect(html).toContain('<h2 id="user-content-install">Install</h2>');
    expect(html).toContain('<table>');
    expect(html).toContain('<s>2</s>');
    expect(html).toContain('<ul class="contains-task-list">');
    expect(html).toContain('<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled checked> done</li>');
    expect(html).toContain('<div class="markdown-alert markdown-alert-warning">\n<p class="markdown-alert-title">Warning</p>');
    expect(html).toContain('Be careful');
    expect(html).not.toContain('[!WARNING]');
    expect(html).toContain('href="#user-content-fn1"');
    expect(html).toContain('id="user-content-fn1"');
    expect(html).toContain('<a href="https://autolink.example/path" rel="nofollow noopener noreferrer" target="_blank">');
  });

  it('resolves relative links and images at the locked commit', () => {
    const md = '![shot](../img/a.png) [doc](other.md#x) [root](/LICENSE) <img src="./b.gif"> [ext](https://e.example) ![abs](https://cdn.example/c.png) ![http](http://cdn.example/d.png)';
    const { html, images } = renderMarkdown(md, ctx);
    expect(html).toContain(`src="https://raw.githubusercontent.com/octo/mod/${C}/img/a.png"`);
    expect(html).toContain(`href="https://github.com/octo/mod/blob/${C}/docs/other.md#x"`);
    expect(html).toContain(`href="https://github.com/octo/mod/blob/${C}/LICENSE"`);
    expect(html).toContain(`src="https://raw.githubusercontent.com/octo/mod/${C}/docs/b.gif"`);
    expect(images).toEqual([
      `https://raw.githubusercontent.com/octo/mod/${C}/img/a.png`,
      `https://raw.githubusercontent.com/octo/mod/${C}/docs/b.gif`,
      'https://cdn.example/c.png',
      'https://cdn.example/d.png',
    ]);
  });

  it('lets resolveImage rewrite to local copies', () => {
    const { html, images } = renderMarkdown('![a](a.png) ![b](https://x.example/b.png)', {
      ...ctx,
      docPath: 'README.md',
      resolveImage: (u) => (u.endsWith('a.png') ? '../../assets/0123456789abcdef.png' : null),
    });
    expect(html).toContain('src="../../assets/0123456789abcdef.png"');
    expect(html).toContain('src="https://x.example/b.png"');
    expect(images).toHaveLength(2);
  });

  it('remoteImages: "link" replaces uncopied images with links (Manager WebView mode)', () => {
    const { html } = renderMarkdown(
      '![local](a.png) ![Badge](https://img.example/b.svg) [![CI](https://img.example/ci.svg)](https://ci.example/) ![](https://img.example/path/c%20d.png) ![bad](https://10.0.0.1/x.png)',
      {
        ...ctx,
        docPath: 'README.md',
        remoteImages: 'link',
        resolveImage: (u) => (u.endsWith('a.png') ? '/assets/0123456789abcdef.png' : u.includes('10.0.0.1') ? '' : null),
      },
    );
    expect(html).toContain('<img src="/assets/0123456789abcdef.png" alt="local"');
    expect(html).toContain('<a href="https://img.example/b.svg" rel="nofollow noopener noreferrer" target="_blank" class="image-link">Badge</a>');
    // Inside a link: only the label, no nested <a>.
    expect(html).toContain('<a href="https://ci.example/" rel="nofollow noopener noreferrer" target="_blank">CI</a>');
    expect(html).toContain('class="image-link">c d.png</a>');
    expect(html).not.toContain('alt="bad"');
    expect(html).not.toContain('10.0.0.1');
    expect(html).not.toMatch(/<img[^>]+src="https:/);
  });

  it('handles srcset in picture/source', () => {
    const { html, images } = renderMarkdown('<picture><source srcset="dark.png 2x, light.png 1x"><img src="light.png"></picture>', {
      ...ctx,
      docPath: 'README.md',
    });
    expect(html).toContain(`srcset="https://raw.githubusercontent.com/octo/mod/${C}/dark.png 2x, https://raw.githubusercontent.com/octo/mod/${C}/light.png 1x"`);
    expect(images).toContain(`https://raw.githubusercontent.com/octo/mod/${C}/dark.png`);
  });

  // Audit B16: candidates separated by commas without whitespace, parsed like browsers do.
  it('splits srcset candidates on commas without spaces (WHATWG parsing)', () => {
    expect(parseSrcset('a.png 1x,b.png 2x')).toEqual([
      { url: 'a.png', descriptors: ['1x'] },
      { url: 'b.png', descriptors: ['2x'] },
    ]);
    expect(parseSrcset(' a.png,  b.png 2x ,c.png')).toEqual([
      { url: 'a.png', descriptors: [] },
      { url: 'b.png', descriptors: ['2x'] },
      { url: 'c.png', descriptors: [] },
    ]);
    // A comma inside a URL belongs to the URL (browsers do not split there).
    expect(parseSrcset('https://a.example/a.png,https://b.example/b.png 2x')).toEqual([
      { url: 'https://a.example/a.png,https://b.example/b.png', descriptors: ['2x'] },
    ]);
    expect(parseSrcset('a.png foo(1, 2) 1x')).toEqual([{ url: 'a.png', descriptors: ['foo(1, 2)', '1x'] }]);

    expect(sanitizeSrcset('https://e.example/x.png 1x,javascript:alert(1) 2x', {})).toBe('https://e.example/x.png 1x');
    expect(sanitizeSrcset('https://e.example/a.png 1x,https://e.example/b.png 2x', {})).toBe('https://e.example/a.png 1x, https://e.example/b.png 2x');
    expect(sanitizeSrcset('https://a.example/a.png,https://b.example/b.png 2x', {})).toBeNull();
    const { html } = renderMarkdown('<picture><source srcset="dark.png 2x,light.png 1x"><img src="light.png"></picture>', { ...ctx, docPath: 'README.md' });
    expect(html).toContain(`srcset="https://raw.githubusercontent.com/octo/mod/${C}/dark.png 2x, https://raw.githubusercontent.com/octo/mod/${C}/light.png 1x"`);
  });

  it('rejects an invalid context', () => {
    expect(() => renderMarkdown('[x](a)', { fullName: 'bad name', commit: C, docPath: 'a' })).toThrow();
  });
});

describe('renderChangelog', () => {
  it('keeps line breaks and resolves against the repo root', () => {
    const html = renderChangelog('line1\nline2\n\n![i](shot.png)', { fullName: 'octo/mod', commit: C });
    expect(html).toContain('line1<br>');
    expect(html).toContain(`https://raw.githubusercontent.com/octo/mod/${C}/shot.png`);
  });
});

describe('resolveRepoUrl', () => {
  it('keeps traversal inside the repo', () => {
    expect(resolveRepoUrl('../../../../etc/passwd', 'link', ctx)).toBe(`https://github.com/octo/mod/blob/${C}/etc/passwd`);
    expect(resolveRepoUrl('//evil.example/x.png', 'image', ctx)).toBe('https://evil.example/x.png');
  });
});
