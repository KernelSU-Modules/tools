// Post-build CSP guard. The site is served with `script-src 'self'; style-src 'self'` (headers.ts),
// so anything inline would either be blocked in browsers or tempt someone to loosen the CSP.
// The build fails on: inline <script> (no src, or a body), <style> elements, style= attributes,
// on* event handlers, javascript:/vbscript: URLs, data: navigation URLs, SVG animations that set a
// javascript: value, <noscript> holding scripts or markup in attributes (mXSS), embedding elements,
// third-party script/style/font/preload/preconnect origins and third-party images (img-src 'self' data:).
// Uses a real HTML tokenizer, so text such as `style="` inside <code> is fine.
import { Parser } from 'htmlparser2';

const SUBRESOURCE_RELS = new Set([
  'stylesheet', 'preload', 'modulepreload', 'icon', 'shortcut', 'apple-touch-icon', 'manifest', 'prefetch', 'preconnect', 'dns-prefetch', 'prerender',
]);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'background', 'ping']);
/** Attributes that navigate (a data: URL there is a script-capable document). */
const NAV_ATTRS = new Set(['href', 'action', 'formaction', 'xlink:href']);
const SVG_ANIMATION = new Set(['animate', 'set', 'animatemotion', 'animatetransform', 'animatecolor']);
const ANIMATION_VALUE_ATTRS = ['to', 'from', 'by', 'values'];
const FORBIDDEN_ELEMENTS = new Set(['iframe', 'object', 'embed', 'base', 'frame', 'frameset', 'applet']);

/** Same-origin: a root-relative or relative path, never a scheme or protocol-relative URL. */
function sameOrigin(url: string): boolean {
  const u = url.trim();
  return u !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//') && !u.startsWith('\\');
}

// eslint-disable-next-line no-control-regex
const squash = (url: string) => url.replace(/[\u0000- ]/g, '');
function jsUrl(url: string): boolean {
  return /^(?:javascript|vbscript):/i.test(squash(url));
}
const dataUrl = (url: string) => /^data:/i.test(squash(url));

/** srcset candidates -> URLs. */
const srcsetUrls = (v: string) => v.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '').filter(Boolean);
const imageOk = (url: string) => sameOrigin(url) || dataUrl(url);

export function checkHtmlCsp(html: string): string[] {
  const problems: string[] = [];
  let inScript = false;
  let scriptBody = '';
  let noscript = 0;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'style') problems.push(`<${name}> has an inline style attribute`);
          if (/^on/i.test(k)) problems.push(`<${name}> has an inline event handler ${k}=`);
          if (URL_ATTRS.has(k) && jsUrl(v)) problems.push(`<${name}> has a javascript:/vbscript: URL`);
          if (NAV_ATTRS.has(k) && dataUrl(v)) problems.push(`<${name}> has a data: URL in ${k}=`);
          if (noscript && v.includes('<')) problems.push(`<noscript> contains markup inside an attribute of <${name}>`);
        }
        if (SVG_ANIMATION.has(name)) {
          for (const k of ANIMATION_VALUE_ATTRS) {
            const v = attrs[k];
            if (v !== undefined && v.split(';').some(jsUrl)) problems.push(`<${name}> animates to a javascript: URL`);
          }
        }
        if (name === 'noscript') noscript++;
        if (noscript && name === 'script') problems.push('<noscript> contains a <script>');
        if (name === 'img' || name === 'source' || name === 'image') {
          const srcs = [attrs['src'], attrs['href'], attrs['xlink:href']].filter((x): x is string => x !== undefined);
          if (attrs['srcset'] !== undefined) srcs.push(...srcsetUrls(attrs['srcset']));
          for (const u of srcs) if (!imageOk(u)) problems.push(`third-party image <${name} src="${u}"> (img-src 'self' data:)`);
        }
        if (name === 'style') problems.push('inline <style> element');
        if (FORBIDDEN_ELEMENTS.has(name)) problems.push(`<${name}> element`);
        if (name === 'meta' && (attrs['http-equiv'] ?? '').toLowerCase() === 'refresh') problems.push('<meta http-equiv=refresh>');
        if (name === 'script') {
          inScript = true;
          scriptBody = '';
          const src = attrs['src'];
          if (src === undefined) problems.push('inline <script> without src');
          else if (!sameOrigin(src)) problems.push(`third-party <script src="${src}">`);
        }
        if (name === 'link') {
          const rels = (attrs['rel'] ?? '').toLowerCase().split(/\s+/);
          const href = attrs['href'] ?? '';
          if (rels.some((r) => SUBRESOURCE_RELS.has(r)) && !sameOrigin(href)) problems.push(`third-party <link rel="${attrs['rel']}" href="${href}">`);
        }
      },
      ontext(text) {
        if (inScript) scriptBody += text;
      },
      onclosetag(name) {
        if (name === 'noscript' && noscript > 0) noscript--;
        if (name === 'script') {
          if (scriptBody.trim()) problems.push('<script> with an inline body');
          inScript = false;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();
  return problems;
}

/** Throws listing every violation across `pages` (path -> HTML). */
export function assertCspClean(pages: Iterable<[string, string]>): void {
  const all: string[] = [];
  for (const [p, html] of pages) for (const problem of checkHtmlCsp(html)) all.push(`${p}: ${problem}`);
  if (all.length) {
    const shown = all.slice(0, 20).join('\n  ');
    throw new Error(`CSP check failed (${all.length} problem${all.length === 1 ? '' : 's'}):\n  ${shown}${all.length > 20 ? '\n  …' : ''}`);
  }
}
