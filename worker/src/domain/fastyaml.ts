// Fast path for the YAML subset our own serializer emits (block mappings, block sequences of scalars, plain /
// single- / double-quoted scalars, [] and {}). Anything else returns FALLBACK and the caller uses the `yaml`
// package. Why: `yaml` costs ~0.1 ms per record file, i.e. ~30 ms for 300 records on a cold snapshot build,
// which alone would blow the Workers Free 10 ms CPU budget; this parser is ~10x cheaper.
// Equivalence with YAML.parse (YAML 1.2 core schema) is property-tested in test/fastyaml.test.ts.
import YAML from 'yaml';

export const FALLBACK: unique symbol = Symbol('fallback');
type F = typeof FALLBACK;
interface Line {
  indent: number;
  text: string;
}

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?: (.*))?$/;
const isSeqLine = (t: string) => t === '-' || t.startsWith('- ');

export function parseYaml(src: string): unknown {
  let v: unknown | F = FALLBACK;
  try {
    v = fastYaml(src);
  } catch {
    v = FALLBACK;
  }
  return v === FALLBACK ? YAML.parse(src) : v;
}

export function fastYaml(src: string): unknown | F {
  if (src.includes('\t') || src.includes('\r') || src.charCodeAt(0) === 0xfeff) return FALLBACK;
  const lines: Line[] = [];
  for (const raw of src.split('\n')) {
    const t = raw.trimStart();
    if (t === '') continue;
    if (t.startsWith('#') || t.startsWith('---') || t.startsWith('...') || t.startsWith('%')) return FALLBACK;
    lines.push({ indent: raw.length - t.length, text: t.replace(/ +$/, '') });
  }
  if (!lines.length) return FALLBACK;
  const pos = { i: 0 };
  const v = block(lines, pos, lines[0]!.indent);
  if (v === FALLBACK || pos.i !== lines.length) return FALLBACK;
  return v;
}

function block(lines: Line[], pos: { i: number }, indent: number): unknown | F {
  const first = lines[pos.i]!;
  if (first.indent !== indent) return FALLBACK;
  return isSeqLine(first.text) ? seq(lines, pos, indent) : map(lines, pos, indent);
}

function map(lines: Line[], pos: { i: number }, indent: number): Record<string, unknown> | F {
  const out: Record<string, unknown> = {};
  while (pos.i < lines.length) {
    const l = lines[pos.i]!;
    if (l.indent < indent) break;
    if (l.indent > indent) return FALLBACK;
    const m = KEY_LINE.exec(l.text);
    if (!m) return FALLBACK;
    const key = m[1]!;
    if (Object.prototype.hasOwnProperty.call(out, key) || key === '__proto__') return FALLBACK;
    pos.i++;
    const rest = m[2];
    if (rest === undefined || rest === '') {
      const next = lines[pos.i];
      if (next && (next.indent > indent || (next.indent === indent && isSeqLine(next.text)))) {
        const v = block(lines, pos, next.indent);
        if (v === FALLBACK) return FALLBACK;
        out[key] = v;
      } else out[key] = null;
    } else {
      const v = scalar(rest);
      if (v === FALLBACK) return FALLBACK;
      out[key] = v;
    }
  }
  return out;
}

function seq(lines: Line[], pos: { i: number }, indent: number): unknown[] | F {
  const out: unknown[] = [];
  while (pos.i < lines.length) {
    const l = lines[pos.i]!;
    if (l.indent < indent) break;
    if (l.indent > indent) return FALLBACK;
    if (!isSeqLine(l.text)) break;
    const rest = l.text.slice(2);
    // nested collections inside sequences are not part of the subset
    if (rest === '' || rest.startsWith(' ') || isSeqLine(rest) || KEY_LINE.test(rest)) return FALLBACK;
    const v = scalar(rest);
    if (v === FALLBACK) return FALLBACK;
    out.push(v);
    pos.i++;
  }
  return out;
}

function scalar(s: string): unknown | F {
  if (s === '[]') return [];
  if (s === '{}') return {};
  const c = s[0];
  if (c === '"') {
    if (s.length < 2 || !s.endsWith('"')) return FALLBACK;
    try {
      const v = JSON.parse(s);
      return typeof v === 'string' ? v : FALLBACK;
    } catch {
      return FALLBACK;
    }
  }
  if (c === "'") {
    if (s.length < 2 || !s.endsWith("'")) return FALLBACK;
    const inner = s.slice(1, -1);
    if (inner.replace(/''/g, '').includes("'")) return FALLBACK;
    return inner.replace(/''/g, "'");
  }
  if (/^[[\]{}&*!|>%@`,#]/.test(s) || /^[-?:](\s|$)/.test(s)) return FALLBACK;
  if (s.includes(': ') || s.includes(' #') || s.endsWith(':')) return FALLBACK;
  if (/^(?:null|Null|NULL|~)$/.test(s)) return null;
  if (/^(?:true|True|TRUE)$/.test(s)) return true;
  if (/^(?:false|False|FALSE)$/.test(s)) return false;
  if (/^0[oxOX]/.test(s) || /^[-+]?\.(?:inf|Inf|INF)$/.test(s) || /^\.(?:nan|NaN|NAN)$/.test(s)) return FALLBACK;
  if (/^[-+]?[0-9]+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : FALLBACK;
  }
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  return s;
}
