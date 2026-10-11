/**
 * Build-time renderer for the developer docs (docs/developers/**\/*.md -> dist/docs/**).
 *
 * Docs are trusted repository content rendered once at build time with markdown-it; nothing
 * here ships to the browser. URL scheme (Workers Static Assets, html_handling auto-trailing-slash):
 *   developers/index.md            -> docs/index.html            -> /docs/
 *   developers/checks.md           -> docs/checks.html           -> /docs/checks
 *   developers/zh-CN/index.md      -> docs/zh-CN/index.html      -> /docs/zh-CN/
 *   developers/zh-CN/checks.md     -> docs/zh-CN/checks.html     -> /docs/zh-CN/checks
 * Heading ids are plain GitHub-style slugs (no "user-content-" prefix) so /docs/checks#<code> works.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import MarkdownIt from 'markdown-it';

export const DOC_LOCALES = ['zh-CN'] as const; // non-default locales (top-level directories)
export type DocLang = 'en' | (typeof DOC_LOCALES)[number];

const PREFERRED_ORDER = ['index', 'getting-started', 'module-yaml', 'releasing', 'closed-source', 'checks', 'portal', 'faq'];
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif)$/i;

/** Common validator issue codes, used only for the placeholder checks page (when checks.md is missing). */
const PLACEHOLDER_CODES = [
  'release-not-immutable', 'asset-none', 'asset-multiple', 'zip-too-large', 'zip-bomb-ratio', 'zip-path-traversal',
  'prop-missing-field', 'prop-id-mismatch', 'prop-versioncode-range', 'version-not-newer', 'manifest-schema',
  'manifest-path-missing', 'id-reserved', 'id-collision',
];

export interface DocSource {
  /** Path relative to the docs root, posix separators, e.g. "zh-CN/checks.md". */
  rel: string;
  markdown: string;
}

export interface DocPage {
  rel: string;
  lang: DocLang;
  /** Locale-independent key, e.g. "checks" or "index" or "guides/foo". */
  key: string;
  route: string;
  outFile: string;
  title: string;
  html: string;
}

export interface DocsOutput {
  /** outFile (relative to dist) -> content */
  files: Map<string, string | Uint8Array>;
  pages: DocPage[];
  /** Routes per non-default locale, relative to that locale root (e.g. "/checks", "/"). */
  localeRoutes: Record<string, string[]>;
}

/** GitHub-compatible heading slug (github-slugger): lowercase, drop punctuation, spaces -> "-". */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

export function langOf(rel: string): DocLang {
  const first = rel.split('/')[0]!;
  return (DOC_LOCALES as readonly string[]).includes(first) ? (first as DocLang) : 'en';
}

/** "zh-CN/guides/index.md" -> key "guides/index" */
export function keyOf(rel: string): string {
  const lang = langOf(rel);
  const noLang = lang === 'en' ? rel : rel.slice(lang.length + 1);
  return noLang.replace(/\.md$/i, '').replace(/(^|\/)readme$/i, '$1index');
}

export function routeOf(rel: string): string {
  const lang = langOf(rel);
  const key = keyOf(rel);
  const base = lang === 'en' ? '/docs/' : `/docs/${lang}/`;
  if (key === 'index') return base;
  if (key.endsWith('/index')) return base + key.slice(0, -'index'.length);
  return base + key;
}

export function outFileOf(route: string): string {
  const p = route.replace(/^\//, '');
  return p.endsWith('/') ? `${p}index.html` : `${p}.html`;
}

/** Rewrites a link found in `fromRel`; returns null when it should stay untouched. */
export function rewriteHref(href: string, fromRel: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#') || href.startsWith('/')) return null;
  const [pathPart, ...hashParts] = href.split('#');
  const hash = hashParts.length ? `#${hashParts.join('#')}` : '';
  if (!/\.md$/i.test(pathPart!)) return null;
  const target = posix.normalize(posix.join(posix.dirname(fromRel), pathPart!));
  if (target.startsWith('..')) return null;
  return routeOf(target) + hash;
}

function createMd(fromRel: () => string): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  // Heading ids: explicit "{#id}" suffix, else slug of the text; de-duplicated per document.
  md.core.ruler.push('heading_ids', (state) => {
    const used = new Map<string, number>();
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.type !== 'heading_open') continue;
      const inline = tokens[i + 1];
      if (!inline || inline.type !== 'inline') continue;
      let id: string | null = null;
      const m = inline.content.match(/\s*\{#([A-Za-z0-9_.:-]+)\}\s*$/);
      if (m) {
        id = m[1]!;
        inline.content = inline.content.slice(0, m.index);
        const last = inline.children?.[inline.children.length - 1];
        if (last && last.type === 'text') last.content = last.content.replace(/\s*\{#[A-Za-z0-9_.:-]+\}\s*$/, '');
      } else {
        const text = (inline.children ?? []).filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('');
        id = slugify(text);
      }
      if (!id) continue;
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      t.attrSet('id', n === 0 ? id : `${id}-${n}`);
    }
  });
  const defaultHeadingClose = md.renderer.rules.heading_close;
  md.renderer.rules.heading_close = (tokens, idx, options, env, self) => {
    const open = tokens[idx - 2];
    const rawId = open?.attrGet('id');
    const id = rawId == null ? null : String(rawId);
    const anchor = id && open!.tag !== 'h1' ? ` <a class="anchor" href="#${md.utils.escapeHtml(id)}" aria-label="Link to this section">#</a>` : '';
    return anchor + (defaultHeadingClose ? defaultHeadingClose(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options));
  };
  const defaultLinkOpen = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const t = tokens[idx]!;
    const rawHref = t.attrGet('href');
    const href = rawHref == null ? null : String(rawHref);
    if (href) {
      const r = rewriteHref(href, fromRel());
      if (r) t.attrSet('href', r);
      else if (/^https?:\/\//i.test(href)) t.attrSet('rel', 'noopener');
    }
    return defaultLinkOpen ? defaultLinkOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
  return md;
}

function titleOf(markdown: string, fallback: string): string {
  const m = markdown.match(/^#\s+(.+?)\s*#*\s*$/m);
  return m ? m[1]!.replace(/\{#[^}]+\}\s*$/, '').replace(/[`*_]/g, '').trim() : fallback;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const UI: Record<DocLang, Record<'portal' | 'docs' | 'nav' | 'other' | 'placeholder' | 'site', string>> = {
  en: { portal: 'Portal', docs: 'Documentation', nav: 'Documentation pages', other: '简体中文', placeholder: 'This page has not been written yet.', site: 'Module site' },
  'zh-CN': { portal: '开发者门户', docs: '文档', nav: '文档目录', other: 'English', placeholder: '此页面尚未编写。', site: '模块网站' },
};

function sortPages(a: DocPage, b: DocPage): number {
  const ia = PREFERRED_ORDER.indexOf(a.key);
  const ib = PREFERRED_ORDER.indexOf(b.key);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  return a.key.localeCompare(b.key);
}

function layout(page: DocPage, siblings: DocPage[], counterpart: DocPage | undefined): string {
  const ui = UI[page.lang];
  const nav = siblings
    .map((p) => `<li><a href="${p.route}"${p.route === page.route ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`)
    .join('');
  const other = counterpart
    ? `<a href="${counterpart.route}" hreflang="${counterpart.lang}" lang="${counterpart.lang}">${ui.other}</a>`
    : '';
  return `<!doctype html>
<html lang="${page.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(page.title)} · KernelSU Developer Portal</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/docs/docs.css">
${counterpart ? `<link rel="alternate" hreflang="${counterpart.lang}" href="${counterpart.route}">` : ''}
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header class="top"><div class="wrap">
<a class="brand" href="/"><img src="/favicon.svg" alt="" width="24" height="24"> KernelSU Developer Portal <span>${ui.docs}</span></a>
<nav class="top-nav"><a href="/">${ui.portal}</a><a href="https://modules.kernelsu.org/">${ui.site}</a>${other}</nav>
</div></header>
<div class="wrap layout">
<nav class="sidebar" aria-label="${ui.nav}"><ul>${nav}</ul></nav>
<main id="content" class="content">
${page.html}
</main>
</div>
</body>
</html>
`;
}

export function placeholderSources(existing: Set<string>): DocSource[] {
  const out: DocSource[] = [];
  if (!existing.has('index.md') && !existing.has('README.md')) {
    out.push({ rel: 'index.md', markdown: `# Developer documentation\n\n${UI.en.placeholder}\n\n- [Checks](checks.md)\n` });
  }
  if (!existing.has('checks.md')) {
    out.push({
      rel: 'checks.md',
      markdown: `# Checks\n\n${UI.en.placeholder}\n\n## Issue codes\n\n${PLACEHOLDER_CODES.map((c) => `### ${c}\n\nSee the check run output for details.\n`).join('\n')}`,
    });
  }
  return out;
}

/**
 * Fails the build on literal `**` left in the output (outside code). CommonMark does not close emphasis when the
 * closing `**` follows punctuation and precedes a letter, e.g. `**原因：**模块` — write `**原因**：模块` instead.
 */
function unrenderedEmphasisGuard(rel: string, html: string): string {
  const text = html.replace(/<(code|pre)\b[^>]*>[\s\S]*?<\/\1>/g, '');
  const m = /.{0,30}\*\*.{0,30}/.exec(text);
  if (m) throw new Error(`docs/${rel}: unrendered "**" near: ${m[0]} (move punctuation outside the bold markers)`);
  return html;
}

export function renderDocs(sources: DocSource[], css: string): DocsOutput {
  const all = [...sources, ...placeholderSources(new Set(sources.map((s) => s.rel)))];
  let current = '';
  const md = createMd(() => current);
  const pages: DocPage[] = all.map((s) => {
    current = s.rel;
    const route = routeOf(s.rel);
    return {
      rel: s.rel,
      lang: langOf(s.rel),
      key: keyOf(s.rel),
      route,
      outFile: outFileOf(route),
      title: titleOf(s.markdown, keyOf(s.rel)),
      html: unrenderedEmphasisGuard(s.rel, md.render(s.markdown)),
    };
  });
  const files = new Map<string, string | Uint8Array>();
  const byLang = new Map<DocLang, DocPage[]>();
  for (const p of pages) byLang.set(p.lang, [...(byLang.get(p.lang) ?? []), p]);
  for (const list of byLang.values()) list.sort(sortPages);
  for (const p of pages) {
    const counterpart = pages.find((o) => o.key === p.key && o.lang !== p.lang);
    files.set(p.outFile, layout(p, byLang.get(p.lang)!, counterpart));
  }
  files.set('docs/docs.css', css);
  const localeRoutes: Record<string, string[]> = {};
  for (const l of DOC_LOCALES) localeRoutes[l] = (byLang.get(l) ?? []).map((p) => p.route.slice(`/docs/${l}`.length));
  return { files, pages, localeRoutes };
}

/** Reads every *.md (and image asset) under `dir`. Missing dir -> empty. */
export function readDocsDir(dir: string): { sources: DocSource[]; assets: Map<string, Uint8Array> } {
  const sources: DocSource[] = [];
  const assets = new Map<string, Uint8Array>();
  if (!existsSync(dir)) return { sources, assets };
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(d, name);
      const st = statSync(full);
      const rel = relative(dir, full).split(sep).join('/');
      if (st.isDirectory()) walk(full);
      else if (/\.md$/i.test(name)) sources.push({ rel, markdown: readFileSync(full, 'utf8') });
      else if (ASSET_EXT.test(name)) assets.set(`docs/${rel}`, readFileSync(full));
    }
  };
  walk(dir);
  return { sources, assets };
}

export function buildDocs(dir: string, css: string): DocsOutput {
  const { sources, assets } = readDocsDir(dir);
  const out = renderDocs(sources, css);
  for (const [k, v] of assets) out.files.set(k, v);
  return out;
}
