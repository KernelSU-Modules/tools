import { INT32_MAX } from '@kernelsu-modules/schema';
import { moduleIdFormatError } from './id.ts';
import { issue, result, type Issue, type Result } from './issues.ts';

export const REQUIRED_PROP_FIELDS = ['id', 'name', 'version', 'versionCode', 'author', 'description'] as const;

export interface ModuleProp {
  /** Effective key -> value map exactly as ksud sees it (later duplicates win, values untrimmed). */
  props: Record<string, string>;
  /** The six required fields, trimmed (Rust `str::trim`, as ksud does for `id`). */
  id: string;
  name: string;
  version: string;
  versionCode: number;
  author: string;
  description: string;
}

/* ------------------------------------------------------------------------------------------------
 * Faithful port of the java-properties crate (KernelSU2/java-properties @ 42a4aa9) that ksud uses
 * to read module.prop (`PropertiesIter::new_with_encoding(.., UTF_8).read_into(..)` into a HashMap):
 *   - natural lines end at LF, CR or CRLF; the text after the last terminator is a final line;
 *   - a first natural line matching ^[ \t\r\n\f]*[#!] is a comment (never continued);
 *   - an odd number of trailing backslashes joins the next natural line (leading Unicode
 *     White_Space of the continuation is stripped); a continuation that hits EOF drops the
 *     whole logical line;
 *   - key = after leading [ \t\f], chars up to an unescaped ':', '=', ' ', '\t', '\f';
 *     separator = [ \t\f]*[:=][ \t\f]* or [ \t\f]+; value = the rest (trailing whitespace kept);
 *   - escapes \t \n \f \r \uXXXX ('+' sign accepted, surrogates rejected), \X -> X, a dangling
 *     backslash -> NUL; a malformed \u escape aborts parsing (ksud then refuses the module);
 *   - pairs go into a HashMap, so later duplicates override earlier ones.
 * Parity is checked against the Rust crate with a corpus (see test/prop.test.ts).
 * ---------------------------------------------------------------------------------------------- */

export interface PropPair {
  key: string;
  value: string;
  /** 1-based number of the first natural line of the logical line. */
  line: number;
  /** Separator used: '=' / ':' / whitespace only. */
  separator: '=' | ':' | ' ' | '';
}

export interface JavaPropertiesResult {
  /** Pairs in file order, up to (excluding) the first error. */
  pairs: PropPair[];
  /** First parse error; ksud aborts reading module.prop on it. */
  error?: { line: number; message: string };
  /** A trailing backslash continued into EOF: that last logical line is silently dropped. */
  droppedTrailingLine?: number;
}

/** Characters Rust's `char::is_whitespace` (Unicode White_Space) accepts; used by `str::trim*`. */
const RUST_WS = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function rustTrimStart(s: string): string {
  let i = 0;
  while (i < s.length && RUST_WS.has(s.charCodeAt(i))) i++;
  return s.slice(i);
}

/** Rust `str::trim` (Unicode White_Space on both ends). */
export function rustTrim(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && RUST_WS.has(s.charCodeAt(a))) a++;
  while (b > a && RUST_WS.has(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** The crate's "ignorable whitespace" class: [\x20\t\r\n\x0c]. */
const isPropWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f';
const COMMENT_RE = /^[ \t\r\n\f]*[#!]/;

function naturalLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d) {
      out.push(text.slice(start, i));
      if (text.charCodeAt(i + 1) === 0x0a) i++;
      start = i + 1;
    } else if (c === 0x0a) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function endingBackslashes(s: string): number {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s.charCodeAt(i) === 0x5c; i--) n++;
  return n;
}

class PropSyntaxError extends Error {}

function unescape(s: string): string {
  const cps = Array.from(s);
  let out = '';
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = cps[++i];
    if (n === undefined) {
      out += '\0';
      break;
    }
    switch (n) {
      case 't':
        out += '\t';
        break;
      case 'n':
        out += '\n';
        break;
      case 'f':
        out += '\f';
        break;
      case 'r':
        out += '\r';
        break;
      case 'u': {
        if (cps.length - (i + 1) < 4) throw new PropSyntaxError('Malformed \\uxxxx encoding: not enough digits.');
        const tmp = cps.slice(i + 1, i + 5).join('');
        i += 4;
        // Rust u16::from_str_radix(tmp, 16): optional leading '+', then hex digits only.
        if (!/^\+?[0-9A-Fa-f]+$/.test(tmp)) throw new PropSyntaxError('Malformed \\uxxxx encoding: not hex.');
        const val = parseInt(tmp, 16);
        if (val >= 0xd800 && val <= 0xdfff) throw new PropSyntaxError('Malformed \\uxxxx encoding: invalid character.');
        out += String.fromCharCode(val);
        break;
      }
      default:
        out += n;
    }
  }
  return out;
}

/** Split one logical line into key / separator / value (the crate's LINE_RE), or null for comments and blank lines. */
function splitLine(line: string): { key: string; value: string; separator: PropPair['separator'] } | { comment: string } | null {
  if (COMMENT_RE.test(line)) {
    // [ws]*[#!][ws]*(.*?)[ws]*$ — the crate unescapes comment text too (so a bad \u in a comment is an error).
    let a = 0;
    while (isPropWs(line[a])) a++;
    a++;
    while (a < line.length && isPropWs(line[a])) a++;
    let b = line.length;
    while (b > a && isPropWs(line[b - 1])) b--;
    return { comment: line.slice(a, b) };
  }
  let i = 0;
  while (i < line.length && isPropWs(line[i])) i++;
  const keyStart = i;
  while (i < line.length) {
    const c = line[i]!;
    if (c === '\\') i += 2;
    else if (c === ':' || c === '=' || isPropWs(c)) break;
    else i++;
  }
  if (i > line.length) i = line.length; // a trailing lone backslash belongs to the key
  const key = line.slice(keyStart, i);
  if (i >= line.length) return key.length ? { key, value: '', separator: '' } : null;
  let j = i;
  while (j < line.length && isPropWs(line[j])) j++;
  if (line[j] === ':' || line[j] === '=') {
    const separator = line[j] as ':' | '=';
    j++;
    while (j < line.length && isPropWs(line[j])) j++;
    return { key, value: line.slice(j), separator };
  }
  // Whitespace-only separator (line[i] is whitespace here, so [ws]+ matched at least one char).
  return { key, value: line.slice(j), separator: ' ' };
}

/** Parse Java-properties text exactly like ksud's java-properties crate (input: decoded text, BOM already removed). */
export function parseJavaProperties(text: string): JavaPropertiesResult {
  const physical = naturalLines(text);
  const pairs: PropPair[] = [];
  let k = 0;
  while (k < physical.length) {
    const lineNo = k + 1;
    let cur = physical[k++]!;
    let buf = cur;
    if (!COMMENT_RE.test(cur)) {
      while (endingBackslashes(cur) % 2 === 1) {
        buf = buf.slice(0, -1);
        if (k >= physical.length) return { pairs, droppedTrailingLine: lineNo };
        cur = physical[k++]!;
        buf += rustTrimStart(cur);
      }
    }
    const parsed = splitLine(buf);
    if (!parsed) continue;
    try {
      if ('comment' in parsed) {
        unescape(parsed.comment);
        continue;
      }
      pairs.push({ key: unescape(parsed.key), value: unescape(parsed.value), line: lineNo, separator: parsed.separator });
    } catch (e) {
      if (e instanceof PropSyntaxError) return { pairs, error: { line: lineNo, message: e.message } };
      throw e;
    }
  }
  return { pairs };
}

/** ksud metamodule.rs `is_metamodule`: `metamodule` trimmed equals "1" or (ASCII case-insensitively) "true". */
export function isMetamoduleProp(props: Record<string, string>): boolean {
  if (!Object.prototype.hasOwnProperty.call(props, 'metamodule')) return false;
  const t = rustTrim(props.metamodule!);
  return t === '1' || /^true$/i.test(t);
}

/**
 * One-shot script entry marker: `oneshot` read exactly like ksud reads `metamodule` (trimmed value equals "1" or,
 * ASCII case-insensitively, "true"). ksud itself ignores the key; the manager uses it to run the ZIP instead of
 * installing it.
 */
export function isOneshotProp(props: Record<string, string>): boolean {
  if (!Object.prototype.hasOwnProperty.call(props, 'oneshot')) return false;
  const t = rustTrim(props.oneshot!);
  return t === '1' || /^true$/i.test(t);
}

const shown = (s: string) => JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}…` : s);

/**
 * Parse and validate module.prop with ksud's semantics (see parseJavaProperties); the resulting map
 * is what KernelSU installs. Additionally:
 *   - a malformed escape (ksud refuses the module) is an error;
 *   - a duplicate of a required key is an error (only ever useful for spoofing); other duplicates warn;
 *   - pairs that rely on ':' / whitespace separators warn (other tools read plain key=value lines).
 */
export function parseModuleProp(text: string): Result<ModuleProp> {
  const issues: Issue[] = [];
  const props: Record<string, string> = Object.create(null);
  const firstLine = new Map<string, number>();
  const required = new Set<string>(REQUIRED_PROP_FIELDS);
  const parsed = parseJavaProperties(text);
  let oddLines = 0;

  for (const p of parsed.pairs) {
    if ((p.separator === ':' || p.separator === ' ') && ++oddLines <= 5) {
      const sep = p.separator === ':' ? '":"' : 'whitespace';
      issues.push(
        issue(
          'prop-line-invalid',
          `module.prop line ${p.line} uses ${sep} instead of "=" as separator; KernelSU reads it as ${shown(p.key)}=${shown(p.value)}.`,
          'warning',
          `module.prop:${p.line}`,
        ),
      );
    }
    const prev = firstLine.get(p.key);
    if (prev !== undefined) {
      issues.push(
        issue(
          'prop-duplicate-key',
          `module.prop defines ${shown(p.key)} more than once (lines ${prev} and ${p.line}); KernelSU uses the last one.`,
          required.has(p.key) ? 'error' : 'warning',
          `module.prop:${p.line}`,
        ),
      );
    } else firstLine.set(p.key, p.line);
    props[p.key] = p.value;
  }
  if (parsed.error)
    issues.push(
      issue(
        'prop-syntax',
        `module.prop line ${parsed.error.line}: ${parsed.error.message} KernelSU refuses to install the module.`,
        'error',
        `module.prop:${parsed.error.line}`,
      ),
    );
  if (parsed.droppedTrailingLine !== undefined)
    issues.push(
      issue(
        'prop-line-invalid',
        `module.prop line ${parsed.droppedTrailingLine} ends with a line-continuation backslash at the end of the file; KernelSU ignores that line.`,
        'warning',
        `module.prop:${parsed.droppedTrailingLine}`,
      ),
    );

  const get = (k: string) => (Object.prototype.hasOwnProperty.call(props, k) ? rustTrim(props[k]!) : '');
  for (const f of REQUIRED_PROP_FIELDS) {
    if (!get(f)) issues.push(issue('prop-missing-field', `module.prop is missing a non-empty "${f}".`, 'error', f));
  }

  const id = get('id');
  if (id) {
    const fmt = moduleIdFormatError(id);
    if (fmt) issues.push(issue('prop-id-invalid', `module.prop id ${shown(id)} ${fmt}.`, 'error', 'id'));
  }

  let versionCode = NaN;
  const vc = get('versionCode');
  if (vc) {
    if (!/^-?[0-9]+$/.test(vc)) {
      issues.push(issue('prop-versioncode-invalid', `module.prop versionCode ${shown(vc)} is not a decimal integer.`, 'error', 'versionCode'));
    } else {
      const digits = vc.replace(/^-?0*/, '');
      const n = digits.length > 12 ? Infinity : Number(digits) * (vc.startsWith('-') ? -1 : 1);
      if (!(n >= 1 && n <= INT32_MAX))
        issues.push(issue('prop-versioncode-range', `module.prop versionCode ${vc} is outside 1..${INT32_MAX}.`, 'error', 'versionCode'));
      else versionCode = n;
    }
  }

  const plain: Record<string, string> = { ...props };
  return result(issues, {
    props: plain,
    id,
    name: get('name'),
    version: get('version'),
    versionCode,
    author: get('author'),
    description: get('description'),
  });
}
