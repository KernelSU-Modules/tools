import type { MarkdownIt } from 'markdown-it';
import { createMarkdown } from './markdown.ts';
import { sanitize, type UrlKind } from './sanitize.ts';

export { sanitize, checkUrl, escapeAttr, escapeText, ID_PREFIX, type SanitizeOptions, type UrlKind } from './sanitize.ts';
export { slugify } from './markdown.ts';

export interface RenderContext {
  /** "owner/repo" */
  fullName: string;
  /** Locked content commit (40 hex). */
  commit: string;
  /** Repository-relative path of the Markdown document; relative links resolve against its directory. */
  docPath: string;
  /**
   * Called with every absolute https image URL (after relative resolution).
   * Return a replacement (e.g. a local copy "/assets/ab12….png"), null for "not copied" (see
   * `remoteImages`), or "" to drop the image entirely (e.g. unsafe / not an image).
   */
  resolveImage?: (absUrl: string) => string | null;
  /**
   * Images without a local copy (no resolveImage, or it returned null):
   * "keep" (default) leaves the remote https URL as the src; "link" replaces the <img> with a
   * link to the remote URL labelled with its alt text (for clients that only load same-origin
   * subresources, e.g. the Manager WebView).
   */
  remoteImages?: 'keep' | 'link';
}

// Created (and warmed up) at module evaluation: in a Worker this runs during isolate startup,
// so the one-off regex compilation / JIT cost does not count against a request's CPU budget.
const docMd: MarkdownIt = createMarkdown({ breaks: false, headingIds: true });
const notesMd: MarkdownIt = createMarkdown({ breaks: true, headingIds: false });

const FULL_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PLACEHOLDER_HOST = 'repo.invalid';

function docDir(docPath: string): string {
  const i = docPath.lastIndexOf('/');
  return i < 0 ? '' : docPath.slice(0, i + 1);
}

/**
 * Resolve a (scheme-checked) URL found in a document at `docPath` of `fullName@commit`.
 * Relative links -> https://github.com/{fullName}/blob/{commit}/{path}
 * Relative images -> https://raw.githubusercontent.com/{fullName}/{commit}/{path}
 * Root-relative paths ("/x.png") are repository-root relative, as on GitHub.
 */
export function resolveRepoUrl(url: string, kind: UrlKind, ctx: Pick<RenderContext, 'fullName' | 'commit' | 'docPath'>): string | null {
  if (!FULL_NAME.test(ctx.fullName) || !COMMIT.test(ctx.commit)) throw new Error('invalid render context');
  if (url.startsWith('data:')) return url;
  let u: URL;
  try {
    const rootRelative = url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\');
    u = new URL(rootRelative ? url.slice(1) : url, `https://${PLACEHOLDER_HOST}/${rootRelative ? '' : docDir(ctx.docPath)}`);
  } catch {
    return null;
  }
  if (u.host !== PLACEHOLDER_HOST) {
    if (u.protocol === 'mailto:') return kind === 'link' ? u.href : null;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (kind === 'image' && u.protocol === 'http:') u.protocol = 'https:';
    return u.href;
  }
  const path = u.pathname.replace(/^\/+/, '');
  if (kind === 'image') {
    if (!path) return null;
    return `https://raw.githubusercontent.com/${ctx.fullName}/${ctx.commit}/${path}`;
  }
  if (!path) return `https://github.com/${ctx.fullName}/tree/${ctx.commit}${u.search}${u.hash}`;
  return `https://github.com/${ctx.fullName}/blob/${ctx.commit}/${path}${u.search}${u.hash}`;
}

function render(md: MarkdownIt, src: string, ctx: RenderContext): { html: string; images: string[] } {
  const images: string[] = [];
  const seen = new Set<string>();
  const raw = md.render(src);
  const html = sanitize(raw, {
    transformUrl(url, kind) {
      const abs = resolveRepoUrl(url, kind, ctx);
      if (!abs || kind === 'link' || abs.startsWith('data:')) return abs;
      if (!seen.has(abs)) {
        seen.add(abs);
        images.push(abs);
      }
      const r = ctx.resolveImage?.(abs) ?? null;
      if (r !== null) return r;
      return ctx.remoteImages === 'link' ? { link: abs } : abs;
    },
  });
  return { html, images };
}

/** Render an author Markdown document (README etc.) to sanitized HTML. */
export function renderMarkdown(md: string, ctx: RenderContext): { html: string; images: string[] } {
  return render(docMd, md, ctx);
}

/**
 * Repository-relative paths of the images a Markdown document at `docPath` references (relative or root-relative
 * image URLs, resolved like renderMarkdown does; absolute URLs to other hosts are ignored). Deduplicated, in
 * document order. Used by sync (tracked images) and by the release action (metadata sync to a distribution repo).
 */
export function referencedImagePaths(md: string, o: { fullName: string; commit: string; docPath: string }): string[] {
  const prefix = `https://raw.githubusercontent.com/${o.fullName}/${o.commit}/`;
  const out: string[] = [];
  let images: string[];
  try {
    images = renderMarkdown(md, o).images;
  } catch {
    return out;
  }
  for (const url of images) {
    if (!url.startsWith(prefix)) continue;
    try {
      const p = url.slice(prefix.length).split(/[?#]/)[0]!.split('/').map(decodeURIComponent).join('/');
      if (p && !out.includes(p)) out.push(p);
    } catch {
      /* undecodable path: the build cannot fetch it either */
    }
  }
  return out;
}

/** Render GitHub release notes (soft line breaks preserved, links resolved against the repo root). */
export function renderChangelog(md: string, ctx: Omit<RenderContext, 'docPath'>): string {
  return renderNotes(md, ctx).html;
}

/** renderChangelog that also reports the referenced absolute https image URLs. */
export function renderNotes(md: string, ctx: Omit<RenderContext, 'docPath'>): { html: string; images: string[] } {
  return render(notesMd, md, { ...ctx, docPath: '' });
}

/** Sanitize arbitrary HTML against the sanitizer's whitelist (relative URLs are kept as-is). */
export function sanitizeHtml(html: string): string {
  return sanitize(html);
}

// Warm-up (see above): exercise markdown-it, linkify, the plugins and the sanitizer once.
renderMarkdown('# w :+1:\n\n- [x] *a* https://example.com/x <b title="t">b</b>\n\n> [!NOTE]\n> n[^1]\n\n[^1]: f\n\n| a |\n|---|\n| ![i](i.png) |', {
  fullName: 'a/b',
  commit: '0000000000000000000000000000000000000000',
  docPath: 'README.md',
});
