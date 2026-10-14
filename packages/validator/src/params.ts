import { PARAMS_KNOWN_KEYS, PARAMS_MAX_BYTES, ScriptParams, SUPPORTED_PARAMS_VERSIONS, type ScriptParam } from '@kernelsu-modules/schema';
import { issue, result, type Issue, type Result } from './issues.ts';

const CODE = 'script-params-invalid';
const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function fmtPath(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : String(p))).join('.').replace(/\.\[/g, '[');
}

/**
 * Object keys that appear more than once in the same JSON object (JSON.parse keeps the last one silently, Android's
 * org.json rejects the document). `text` must already be valid JSON.
 */
export function duplicateJsonKeys(text: string): string[] {
  const out: string[] = [];
  const stack: ({ keys: Set<string>; expectKey: boolean } | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.expectKey) {
        const k = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(k)) out.push(k);
        else top.keys.add(k);
        top.expectKey = false;
      }
      i = j;
    } else if (c === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',') {
      const top = stack.at(-1);
      if (top) top.expectKey = true;
    }
  }
  return out;
}

function unknownFieldIssues(data: Record<string, unknown>): Issue[] {
  const out: Issue[] = [];
  const check = (obj: unknown, known: readonly string[], prefix: string) => {
    if (!isMap(obj)) return;
    for (const k of Object.keys(obj)) {
      if (known.includes(k)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(issue(CODE, `params.json ${path}: unknown field, ignored.`, 'warning', path));
    }
  };
  check(data, PARAMS_KNOWN_KEYS.root, '');
  if (Array.isArray(data.params))
    data.params.forEach((p, i) => {
      if (!isMap(p) || typeof p.type !== 'string' || !Object.prototype.hasOwnProperty.call(PARAMS_KNOWN_KEYS, p.type) || p.type === 'root' || p.type === 'option')
        return;
      check(p, PARAMS_KNOWN_KEYS[p.type as 'bool' | 'enum' | 'string' | 'int'], `params[${i}]`);
      if (p.type === 'enum' && Array.isArray(p.options)) p.options.forEach((o, j) => check(o, PARAMS_KNOWN_KEYS.option, `params[${i}].options[${j}]`));
    });
  return out;
}

// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000\n\r]/;

/** Semantic checks of one schema-valid parameter; returns it with every default resolved. */
function checkParam(p: ScriptParam, at: string, issues: Issue[]): ScriptParam {
  const err = (path: string, message: string) => issues.push(issue(CODE, `params.json ${at}${path ? `.${path}` : ''}: ${message}`, 'error', `${at}${path ? `.${path}` : ''}`));
  switch (p.type) {
    case 'bool':
      return p;
    case 'enum': {
      const values = p.options.map((o) => o.value);
      const dup = [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
      if (dup.length) err('options', `duplicate option value${dup.length > 1 ? 's' : ''} ${dup.map((v) => JSON.stringify(v)).join(', ')}.`);
      const def = p.default ?? values[0]!;
      if (!values.includes(def)) err('default', `${JSON.stringify(def)} is not one of the option values (${values.map((v) => JSON.stringify(v)).join(', ')}).`);
      return { ...p, default: def };
    }
    case 'string': {
      const d = p.default;
      if (FORBIDDEN_CHARS.test(d)) err('default', 'must not contain NUL or newline characters.');
      if (d.length > p.maxLength) err('default', `is ${d.length} characters long; maxLength is ${p.maxLength}.`);
      return p;
    }
    case 'int': {
      if (p.min !== undefined && p.max !== undefined && p.min > p.max) {
        err('min', `min ${p.min} is greater than max ${p.max}.`);
        return p;
      }
      const def = p.default ?? p.min ?? 0;
      const implicit = p.default === undefined ? ' (implicit; set "default")' : '';
      if (p.min !== undefined && def < p.min) err('default', `${def}${implicit} is less than min ${p.min}.`);
      if (p.max !== undefined && def > p.max) err('default', `${def}${implicit} is greater than max ${p.max}.`);
      return { ...p, default: def };
    }
  }
}

/**
 * params.json of a one-shot script entry: JSON parse + schema + semantic checks (unique keys and option values,
 * defaults satisfy their own constraints). Every problem is a `script-params-invalid` issue;
 * unknown fields are warnings. The returned value has every default resolved (enum: first option, int: min or 0).
 */
export function parseParams(text: string, opts?: { maxBytes?: number }): Result<ScriptParams> {
  const issues: Issue[] = [];
  const maxBytes = opts?.maxBytes ?? PARAMS_MAX_BYTES;
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) return result([issue(CODE, `params.json is ${bytes} bytes; the limit is ${maxBytes} bytes.`)]);
  const body = text.replace(/^\uFEFF/, '');
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return result([issue(CODE, `params.json is not valid JSON: ${(e as Error).message.split('\n')[0]}`)]);
  }
  const dups = [...new Set(duplicateJsonKeys(body))];
  if (dups.length)
    issues.push(issue(CODE, `params.json repeats the object key${dups.length > 1 ? 's' : ''} ${dups.map((k) => JSON.stringify(k)).join(', ')} within one object.`));
  if (!isMap(data)) return result([...issues, issue(CODE, 'params.json must be a JSON object.')]);
  const sv = data.schemaVersion;
  if (sv !== undefined && !(SUPPORTED_PARAMS_VERSIONS as readonly unknown[]).includes(sv)) {
    issues.push(
      issue(CODE, `params.json schemaVersion ${JSON.stringify(sv)} is not supported (supported: ${SUPPORTED_PARAMS_VERSIONS.join(', ')}).`, 'error', 'schemaVersion'),
    );
    return result(issues);
  }
  issues.push(...unknownFieldIssues(data));

  const parsed = ScriptParams.safeParse(data);
  if (!parsed.success) {
    for (const zi of parsed.error.issues.slice(0, 20)) {
      const path = fmtPath(zi.path);
      issues.push(issue(CODE, `params.json ${path ? `${path}: ` : ''}${zi.message}`, 'error', path || undefined));
    }
    return result(issues);
  }

  const keys = parsed.data.params.map((p) => p.key);
  const dupKeys = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
  if (dupKeys.length) issues.push(issue(CODE, `params.json declares the key${dupKeys.length > 1 ? 's' : ''} ${dupKeys.join(', ')} more than once.`, 'error', 'params'));
  const params = parsed.data.params.map((p, i) => checkParam(p, `params[${i}]`, issues));
  return result(issues, { ...parsed.data, params });
}
