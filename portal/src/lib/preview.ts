import type { PreviewResponse } from '../api/types.ts';

/**
 * Renders the raw Markdown returned by POST /api/preview in the browser with the same renderer and
 * sanitizer as the site build (`@kernelsu-modules/render`, DOM-free). Loaded on demand so it only ships in
 * the preview chunk. Relative links/images resolve against `ctx` (fullName@commit/docPath).
 */
export async function renderPreview(res: Pick<PreviewResponse, 'markdown' | 'ctx'>): Promise<string> {
  const { renderMarkdown } = await import('@kernelsu-modules/render');
  return renderMarkdown(res.markdown, { fullName: res.ctx.fullName, commit: res.ctx.commit, docPath: res.ctx.docPath }).html;
}

/**
 * Builds the srcdoc for the sandboxed preview iframe (`sandbox=""`: no scripts, no
 * same-origin, no forms, no popups, no top navigation). The HTML comes from the
 * sanitizer of @kernelsu-modules/render (same as the site build); the meta CSP below is
 * defense in depth. Styles come from /preview.css via <link>, so neither CSP needs
 * 'unsafe-inline' or a hash.
 *
 * CSP notes (verified in Chromium and Firefox, see test/preview-csp.test.ts): a srcdoc
 * document inherits the Portal's CSP (`style-src 'self'`), and with `sandbox=""` it has an
 * opaque origin — but the inherited policy keeps the Portal's origin as its 'self', so
 * the absolute `${origin}/preview.css` link is allowed by both the inherited policy and
 * the inner meta policy, while inline <style>/style="" stay blocked.
 */
export function buildPreviewDoc(html: string, opts: { origin: string; lang?: string; dark?: boolean }): string {
  const origin = opts.origin.replace(/\/+$/, '');
  const csp = [
    "default-src 'none'",
    `style-src ${origin}`,
    'img-src https: data:',
    "font-src 'none'",
    "script-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  return (
    '<!doctype html>' +
    `<html${opts.lang ? ` lang="${escapeAttr(opts.lang)}"` : ''} class="${opts.dark ? 'dark' : 'light'}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">` +
    '<meta name="referrer" content="no-referrer">' +
    `<link rel="stylesheet" href="${escapeAttr(origin)}/preview.css">` +
    `</head><body><main class="markdown-body">${html}</main></body></html>`
  );
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
