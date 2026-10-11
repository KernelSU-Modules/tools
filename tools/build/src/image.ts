// Image type sniffing and SVG sanitizing. Copied images are typed by their bytes, never by
// the remote Content-Type or file extension.
import { Parser } from 'htmlparser2';

export type ImageExt = 'png' | 'jpg' | 'gif' | 'webp' | 'svg';

const td = new TextDecoder('utf-8', { fatal: false });

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  if (b.length < offset + sig.length) return false;
  return sig.every((v, i) => b[offset + i] === v);
}

export function sniffImage(b: Uint8Array): ImageExt | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (looksLikeSvg(b)) return 'svg';
  return null;
}

function looksLikeSvg(b: Uint8Array): boolean {
  let s = td.decode(b.subarray(0, 4096)).replace(/^﻿/, '');
  for (;;) {
    s = s.trimStart();
    if (s.startsWith('<?xml')) {
      const i = s.indexOf('?>');
      if (i < 0) return false;
      s = s.slice(i + 2);
    } else if (s.startsWith('<!--')) {
      const i = s.indexOf('-->');
      if (i < 0) return false;
      s = s.slice(i + 3);
    } else if (/^<!doctype/i.test(s)) {
      const i = s.indexOf('>');
      if (i < 0 || s.slice(0, i).includes('[')) return false; // internal DTD subset (entities) refused
      s = s.slice(i + 1);
    } else break;
  }
  return /^<svg[\s>/]/.test(s);
}

const SVG_TAGS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text',
  'tspan', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'symbol', 'use', 'pattern', 'filter',
  'fegaussianblur', 'feoffset', 'femerge', 'femergenode', 'fecolormatrix', 'feblend', 'feflood', 'fecomposite',
  'fedropshadow', 'metadata',
]);
/** Removed together with their content. */
const SVG_DROP = new Set(['script', 'style', 'foreignobject', 'iframe', 'image', 'a', 'animate', 'animatemotion',
  'animatetransform', 'animatecolor', 'set', 'discard', 'handler', 'listener', 'feimage', 'video', 'audio', 'canvas',
  'object', 'embed', 'html', 'body']);

const SVG_ATTRS = new Set(
  (
    'id class viewbox width height x y x1 y1 x2 y2 cx cy r rx ry fx fy d points fill fill-opacity fill-rule clip-rule ' +
    'stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset ' +
    'stroke-opacity opacity transform gradientunits gradienttransform spreadmethod offset stop-color stop-opacity ' +
    'clip-path clippathunits mask maskunits maskcontentunits pattern patternunits patterncontentunits ' +
    'patterntransform font-family font-size font-weight font-style text-anchor dominant-baseline ' +
    'alignment-baseline baseline-shift letter-spacing word-spacing textlength lengthadjust xmlns xmlns:xlink ' +
    'version preserveaspectratio href xlink:href role aria-label aria-hidden shape-rendering text-rendering ' +
    'color-interpolation-filters visibility display dx dy filter in in2 stddeviation result mode operator values ' +
    'type flood-color flood-opacity k1 k2 k3 k4 color overflow xml:space'
  ).split(/\s+/),
);

const SVG_CASE: Record<string, string> = {
  viewbox: 'viewBox', lineargradient: 'linearGradient', radialgradient: 'radialGradient', clippath: 'clipPath',
  gradientunits: 'gradientUnits', gradienttransform: 'gradientTransform', spreadmethod: 'spreadMethod',
  clippathunits: 'clipPathUnits', maskunits: 'maskUnits', maskcontentunits: 'maskContentUnits',
  patternunits: 'patternUnits', patterncontentunits: 'patternContentUnits', patterntransform: 'patternTransform',
  textlength: 'textLength', lengthadjust: 'lengthAdjust', preserveaspectratio: 'preserveAspectRatio',
  stddeviation: 'stdDeviation', fegaussianblur: 'feGaussianBlur', feoffset: 'feOffset', femerge: 'feMerge',
  femergenode: 'feMergeNode', fecolormatrix: 'feColorMatrix', feblend: 'feBlend', feflood: 'feFlood',
  fecomposite: 'feComposite', fedropshadow: 'feDropShadow',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function safeValue(name: string, value: string): string | null {
  if (value.length > 65536) return null;
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000- ]/g, '').toLowerCase();
  if (name === 'href' || name === 'xlink:href') return value.trim().startsWith('#') && !/[\s"'<>]/.test(value.trim()) ? value.trim() : null;
  if (name === 'xmlns') return value === 'http://www.w3.org/2000/svg' ? value : null;
  if (name === 'xmlns:xlink') return value === 'http://www.w3.org/1999/xlink' ? value : null;
  if (/(?:javascript|vbscript|data):|expression\(|@import|<|>/.test(v)) return null;
  // Only local references in url(...).
  const urls = v.match(/url\(([^)]*)\)/g) ?? [];
  if (urls.some((u) => !/^url\(['"]?#[^'"()]+['"]?\)$/.test(u))) return null;
  return value;
}

/**
 * Whitelist-based SVG sanitizer (static shapes, text, gradients, masks, simple filters).
 * Returns null if the document is not an SVG root or nothing survives.
 */
export function sanitizeSvg(input: Uint8Array): Uint8Array | null {
  const src = td.decode(input).replace(/^﻿/, '');
  if (/<!ENTITY/i.test(src)) return null;
  const out: string[] = [];
  const stack: (string | null)[] = [];
  let skip = 0;
  let sawRoot = false;
  let rootOk = false;
  const parser = new Parser(
    {
      onopentag(rawName, attribs) {
        const name = rawName.toLowerCase();
        if (!sawRoot) {
          sawRoot = true;
          rootOk = name === 'svg';
        }
        if (skip) return void skip++;
        if (SVG_DROP.has(name) || !SVG_TAGS.has(name)) {
          skip = 1;
          return;
        }
        const tag = SVG_CASE[name] ?? name;
        let s = `<${tag}`;
        const seen = new Set<string>();
        if (stack.length === 0 && name === 'svg') {
          s += ' xmlns="http://www.w3.org/2000/svg"';
          seen.add('xmlns');
        }
        for (const [rawAttr, value] of Object.entries(attribs)) {
          const a = rawAttr.toLowerCase();
          if (!SVG_ATTRS.has(a) || seen.has(a) || a.startsWith('on')) continue;
          const v = safeValue(a, value);
          if (v === null) continue;
          seen.add(a);
          s += ` ${SVG_CASE[a] ?? a}="${esc(v)}"`;
        }
        out.push(s + '>');
        stack.push(tag);
      },
      onclosetag() {
        if (skip) return void skip--;
        const t = stack.pop();
        if (t) out.push(`</${t}>`);
      },
      ontext(text) {
        if (!skip && stack.length) out.push(esc(text));
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeCDATA: false },
  );
  parser.write(src);
  parser.end();
  while (stack.length) out.push(`</${stack.pop()}>`);
  if (!rootOk || out.length === 0) return null;
  return new TextEncoder().encode(out.join('') + '\n');
}
