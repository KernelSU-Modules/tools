// Whitelist HTML sanitizer. DOM-free: htmlparser2 tokenizes, we re-serialize
// only whitelisted elements/attributes with full escaping, and emit a balanced tree.
// Because every text node and attribute value is re-escaped and no raw-text / foreign
// (svg, math) elements are ever emitted, the browser's re-parse of our output cannot
// produce markup that we did not explicitly allow.
import { Parser } from 'htmlparser2';

export type UrlKind = 'link' | 'image';

export interface SanitizeOptions {
  /**
   * Rewrites a (scheme-checked) URL. Return null to drop the attribute.
   * Called for a[href], img[src], img/source[srcset] candidates. Fragment-only
   * links ("#x") never reach this hook. For images, `{ link }` replaces the <img> with a plain
   * link to `link` labelled with the alt text (srcset candidates returning `{ link }` are dropped).
   */
  transformUrl?: (url: string, kind: UrlKind) => string | null | { link: string };
}

/** Prefix for user-provided ids/names, mirroring GitHub (prevents DOM clobbering of page ids). */
export const ID_PREFIX = 'user-content-';

const VOID = new Set(['br', 'hr', 'img', 'source', 'col', 'input', 'wbr']);

/** Dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'applet', 'form', 'noscript', 'template',
  'textarea', 'select', 'option', 'optgroup', 'button', 'svg', 'math', 'title', 'head', 'xmp',
  'noembed', 'noframes', 'plaintext', 'frameset', 'frame', 'audio', 'video', 'canvas', 'dialog',
  'portal', 'fencedframe', 'search', 'map', 'datalist', 'meter', 'progress', 'slot',
]);

const GLOBAL_ATTRS = ['id', 'title', 'lang', 'dir', 'class'];
const ALIGN_ATTRS = ['align'];

/** tag -> allowed attributes (in addition to GLOBAL_ATTRS). */
const TAGS: Record<string, readonly string[]> = {
  a: ['href', 'name'],
  abbr: [], b: [], bdi: [], bdo: [], big: [], blockquote: [], br: [], caption: ALIGN_ATTRS, center: [],
  cite: [], code: [], col: ['span', 'width', 'align', 'valign'], colgroup: ['span', 'width', 'align', 'valign'],
  dd: [], del: [], details: ['open'], dfn: [], div: ALIGN_ATTRS, dl: [], dt: [], em: [],
  figcaption: [], figure: [], h1: ALIGN_ATTRS, h2: ALIGN_ATTRS, h3: ALIGN_ATTRS, h4: ALIGN_ATTRS,
  h5: ALIGN_ATTRS, h6: ALIGN_ATTRS, hr: [], i: [], img: ['src', 'srcset', 'alt', 'width', 'height', 'align'],
  input: ['type', 'checked', 'disabled'], ins: [], kbd: [], li: ['value'], mark: [],
  ol: ['start', 'type', 'reversed'], p: ALIGN_ATTRS, picture: [], pre: [], q: [], rp: [], rt: [], ruby: [],
  s: [], samp: [], section: [], small: [], source: ['srcset', 'media', 'type', 'width', 'height'], span: [],
  strike: [], strong: [], sub: [], summary: [], sup: [],
  table: ['align', 'width'], tbody: ['align', 'valign'], td: ['colspan', 'rowspan', 'align', 'valign', 'width'],
  tfoot: ['align', 'valign'], th: ['colspan', 'rowspan', 'align', 'valign', 'width', 'scope'],
  thead: ['align', 'valign'], tr: ['align', 'valign'], tt: [], u: [], ul: [], var: [], wbr: [],
};

const ALLOWED_CLASS =
  /^(?:markdown-alert(?:-(?:title|note|tip|important|warning|caution))?|footnotes(?:-sep|-list)?|footnote-(?:ref|backref|item)|task-list-item(?:-checkbox)?|contains-task-list|anchor|emoji|image-link|language-[A-Za-z0-9_+#.-]{1,32})$/;

const MAX_ATTR = 4096;
const MAX_URL = 4096;
const MAX_DATA_URL = 256 * 1024;

export function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

export function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/** What a browser's URL parser would see: trims C0 controls/space, removes tab/CR/LF anywhere. */
export function normalizeUrl(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
}

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/i;

/** Scheme check. Returns the normalized URL or null if unsafe. Relative URLs are allowed. */
export function checkUrl(raw: string, kind: UrlKind): string | null {
  const url = normalizeUrl(raw);
  if (!url) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  const m = SCHEME.exec(url);
  if (!m) {
    // Relative. Reject anything that could still smuggle a scheme through odd parsers.
    if (url.length > MAX_URL) return null;
    return url;
  }
  const scheme = m[1]!.toLowerCase();
  if (scheme === 'https' || scheme === 'http') return url.length > MAX_URL ? null : url;
  if (kind === 'link' && scheme === 'mailto') return url.length > MAX_URL ? null : url;
  if (kind === 'image' && scheme === 'data') return url.length <= MAX_DATA_URL && DATA_IMAGE.test(url) ? url : null;
  return null;
}

function isExternal(url: string): boolean {
  return /^(?:https?:)?\/\//i.test(url);
}

function prefixId(v: string): string | null {
  const s = v.trim();
  if (!s || s.length > 256 || /\s/.test(s)) return null;
  return s.startsWith(ID_PREFIX) ? s : ID_PREFIX + s;
}

function intAttr(v: string, min: number, max: number): string | null {
  if (!/^\s*-?\d{1,9}\s*$/.test(v)) return null;
  const n = parseInt(v, 10);
  return n >= min && n <= max ? String(n) : null;
}

function dimension(v: string): string | null {
  const m = /^\s*(\d{1,5})(\.\d+)?\s*(%|px)?\s*$/i.exec(v);
  if (!m) return null;
  return m[3] === '%' ? `${m[1]}%` : m[1]!;
}

const ALIGN = new Set(['left', 'center', 'right', 'justify', 'top', 'middle', 'bottom']);
const VALIGN = new Set(['top', 'middle', 'bottom', 'baseline']);

const isHtmlSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';

/**
 * Split a srcset into (url, descriptors) candidates exactly like browsers do (WHATWG HTML "parse a
 * srcset attribute"): candidates are separated by a comma that ends the URL or follows the
 * descriptors, with or without whitespace ("a.png 1x,b.png 2x" is two candidates), while a comma
 * inside a URL ("a.png,b.png 2x") is part of that URL.
 */
export function parseSrcset(value: string): { url: string; descriptors: string[] }[] {
  const out: { url: string; descriptors: string[] }[] = [];
  let pos = 0;
  const n = value.length;
  while (pos < n) {
    while (pos < n && (isHtmlSpace(value[pos]) || value[pos] === ',')) pos++;
    if (pos >= n) break;
    const start = pos;
    while (pos < n && !isHtmlSpace(value[pos])) pos++;
    let url = value.slice(start, pos);
    const descriptors: string[] = [];
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      while (pos < n && isHtmlSpace(value[pos])) pos++;
      let current = '';
      let state: 'in' | 'parens' | 'after' = 'in';
      for (;;) {
        const c = value[pos];
        if (state === 'in') {
          if (c === undefined) {
            if (current) descriptors.push(current);
            break;
          }
          if (isHtmlSpace(c)) {
            if (current) descriptors.push(current);
            current = '';
            state = 'after';
          } else if (c === ',') {
            pos++;
            if (current) descriptors.push(current);
            break;
          } else {
            current += c;
            if (c === '(') state = 'parens';
          }
        } else if (state === 'parens') {
          if (c === undefined) {
            descriptors.push(current);
            break;
          }
          current += c;
          if (c === ')') state = 'in';
        } else {
          if (c === undefined) break;
          if (!isHtmlSpace(c)) {
            state = 'in';
            continue; // reconsume
          }
        }
        pos++;
      }
    }
    out.push({ url, descriptors });
  }
  return out;
}

export function sanitizeSrcset(value: string, opts: SanitizeOptions): string | null {
  const out: string[] = [];
  for (const cand of parseSrcset(value)) {
    if (!cand.url || cand.descriptors.length > 1) continue;
    const desc = cand.descriptors[0] ?? '';
    if (desc && !/^\d+(?:\.\d+)?[wx]$/.test(desc)) continue;
    let url = checkUrl(cand.url, 'image');
    if (!url || url.startsWith('data:')) continue;
    if (opts.transformUrl) {
      const t = opts.transformUrl(url, 'image');
      url = typeof t === 'string' ? t : null;
    }
    if (!url) continue;
    url = checkUrl(url, 'image');
    if (!url || /[\s,]/.test(url)) continue;
    out.push(desc ? `${url} ${desc}` : url);
  }
  return out.length ? out.join(', ') : null;
}

interface Cleaned {
  attrs: [string, string][];
  /** img only: replace the element with a link to this URL. */
  link?: string;
}

function cleanAttrs(tag: string, attribs: Record<string, string>, opts: SanitizeOptions): Cleaned {
  const allowed = TAGS[tag]!;
  const out: [string, string][] = [];
  let imageLink: string | undefined;
  let isLink = false;
  let external = false;
  for (const [rawName, rawValue] of Object.entries(attribs)) {
    const name = rawName.toLowerCase();
    if (!(GLOBAL_ATTRS.includes(name) || allowed.includes(name))) continue;
    if (rawValue.length > (name === 'src' || name === 'srcset' ? MAX_DATA_URL : MAX_ATTR)) continue;
    let v: string | null = rawValue;
    switch (name) {
      case 'id':
      case 'name':
        v = prefixId(rawValue);
        break;
      case 'class': {
        const keep = rawValue.split(/\s+/).filter((c) => ALLOWED_CLASS.test(c));
        v = keep.length ? keep.join(' ') : null;
        break;
      }
      case 'lang':
        v = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(rawValue) ? rawValue : null;
        break;
      case 'dir':
        v = ['ltr', 'rtl', 'auto'].includes(rawValue.toLowerCase()) ? rawValue.toLowerCase() : null;
        break;
      case 'align':
        v = ALIGN.has(rawValue.trim().toLowerCase()) ? rawValue.trim().toLowerCase() : null;
        break;
      case 'valign':
        v = VALIGN.has(rawValue.trim().toLowerCase()) ? rawValue.trim().toLowerCase() : null;
        break;
      case 'width':
      case 'height':
        v = dimension(rawValue);
        break;
      case 'colspan':
      case 'rowspan':
      case 'span':
        v = intAttr(rawValue, 1, 1000);
        break;
      case 'start':
      case 'value':
        v = intAttr(rawValue, -1e9, 1e9);
        break;
      case 'type':
        if (tag === 'ol') v = /^[1aAiI]$/.test(rawValue) ? rawValue : null;
        else if (tag === 'input') v = rawValue.toLowerCase() === 'checkbox' ? 'checkbox' : null;
        else if (tag === 'source') v = /^image\/[a-z0-9.+-]{1,64}$/i.test(rawValue) ? rawValue.toLowerCase() : null;
        else v = null;
        break;
      case 'scope':
        v = ['row', 'col', 'rowgroup', 'colgroup'].includes(rawValue.toLowerCase()) ? rawValue.toLowerCase() : null;
        break;
      case 'open':
      case 'reversed':
      case 'checked':
      case 'disabled':
        v = '';
        break;
      case 'media':
        v = rawValue.length <= 256 ? rawValue : null;
        break;
      case 'href': {
        const raw = normalizeUrl(rawValue);
        if (raw.startsWith('#')) {
          const id = prefixId(decodeFragment(raw.slice(1)));
          v = id ? `#${encodeFragment(id)}` : null;
          isLink = v !== null;
          break;
        }
        let u = checkUrl(raw, 'link');
        if (u && opts.transformUrl) {
          const t = opts.transformUrl(u, 'link');
          u = typeof t === 'string' ? t : null;
        }
        if (u) u = checkUrl(u, 'link');
        v = u || null;
        if (v) {
          isLink = true;
          external = isExternal(v);
        }
        break;
      }
      case 'src': {
        let u = checkUrl(rawValue, 'image');
        if (u && !u.startsWith('data:') && opts.transformUrl) {
          const t = opts.transformUrl(u, 'image');
          if (t !== null && typeof t === 'object') {
            const l = checkUrl(t.link, 'link');
            if (l && isExternal(l)) imageLink = l;
            u = null;
          } else u = t;
        }
        if (u) u = checkUrl(u, 'image');
        v = u || null;
        break;
      }
      case 'srcset':
        v = sanitizeSrcset(rawValue, opts);
        break;
      default:
        // title, alt: free text, escaped on output.
        break;
    }
    if (v === null) continue;
    if (out.some(([n]) => n === name)) continue;
    out.push([name, v]);
  }
  if (tag === 'a' && isLink && !out.some(([n, v]) => n === 'href' && v.startsWith('#'))) {
    out.push(['rel', 'nofollow noopener noreferrer']);
    if (external) out.push(['target', '_blank']);
  }
  if (tag === 'img') {
    if (imageLink) return { attrs: out.filter(([n]) => n === 'alt' || n === 'title'), link: imageLink };
    if (!out.some(([n]) => n === 'src' || n === 'srcset')) return { attrs: [] };
    out.push(['loading', 'lazy'], ['decoding', 'async'], ['referrerpolicy', 'no-referrer']);
  }
  if (tag === 'input') {
    if (!out.some(([n, v]) => n === 'type' && v === 'checkbox')) return { attrs: [] };
    if (!out.some(([n]) => n === 'disabled')) out.push(['disabled', '']);
  }
  return { attrs: out };
}

function imageLabel(alt: string | undefined, url: string): string {
  const a = alt?.trim();
  if (a) return a;
  const last = url.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? url;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function decodeFragment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function encodeFragment(s: string): string {
  return encodeURIComponent(s).replace(/%2F/g, '/').replace(/%3A/g, ':');
}

function serializeOpen(tag: string, attrs: [string, string][]): string {
  let s = `<${tag}`;
  for (const [n, v] of attrs) s += v === '' && n !== 'alt' ? ` ${n}` : ` ${n}="${escapeAttr(v)}"`;
  return s + '>';
}

/**
 * Sanitize an HTML fragment against the whitelist above. Output is balanced and contains only
 * whitelisted elements/attributes; disallowed elements are unwrapped (children kept), except
 * DROP_WITH_CONTENT ones which are removed with their content.
 */
export function sanitize(html: string, opts: SanitizeOptions = {}): string {
  const out: string[] = [];
  /** For each open event: the emitted tag name, or null when the element was unwrapped. */
  const stack: (string | null)[] = [];
  let skip = 0;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        if (skip > 0) {
          skip++;
          return;
        }
        if (DROP_WITH_CONTENT.has(tag)) {
          skip = 1;
          return;
        }
        if (!(tag in TAGS)) {
          stack.push(null);
          return;
        }
        const { attrs, link } = cleanAttrs(tag, attribs, opts);
        if (link) {
          // Image that must not be loaded from its remote origin: show a link to it instead
          // (just the label when already inside a link, to avoid nested <a>).
          const label = escapeText(imageLabel(attrs.find(([n]) => n === 'alt')?.[1], link));
          out.push(
            stack.includes('a')
              ? label
              : `${serializeOpen('a', [['href', link], ['rel', 'nofollow noopener noreferrer'], ['target', '_blank'], ['class', 'image-link']])}${label}</a>`,
          );
          stack.push(null);
          return;
        }
        if ((tag === 'img' || tag === 'input') && attrs.length === 0) {
          stack.push(null);
          return;
        }
        if (tag === 'source' && !attrs.some(([n]) => n === 'srcset')) {
          stack.push(null);
          return;
        }
        out.push(serializeOpen(tag, attrs));
        stack.push(VOID.has(tag) ? null : tag);
      },
      onclosetag() {
        if (skip > 0) {
          skip--;
          return;
        }
        const tag = stack.pop();
        if (tag) out.push(`</${tag}>`);
      },
      ontext(text) {
        if (skip > 0) return;
        out.push(escapeText(text));
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: false },
  );
  parser.write(html);
  parser.end();
  while (stack.length) {
    const tag = stack.pop();
    if (tag) out.push(`</${tag}>`);
  }
  return out.join('');
}
