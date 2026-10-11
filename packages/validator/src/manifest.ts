import YAML from 'yaml';
import { DEFAULT_POLICY, MANIFEST_KNOWN_KEYS, ModuleManifest, SUPPORTED_MANIFEST_VERSIONS } from '@kernelsu-modules/schema';
import { issue, result, type Issue, type Result } from './issues.ts';

const MAX_ALIASES = 20;

function fmtPath(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : String(p))).join('.').replace(/\.\[/g, '[');
}

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Unknown fields are warnings (ignored), so a manifest written for a newer revision of schemaVersion 1 still
 * validates with an older validator. The schema itself strips them.
 */
function unknownFieldIssues(data: Record<string, unknown>): Issue[] {
  const out: Issue[] = [];
  const check = (obj: unknown, known: readonly string[], prefix: string) => {
    if (!isMap(obj)) return;
    for (const k of Object.keys(obj)) {
      if (known.includes(k)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(issue('manifest-schema', `${path}: unknown field, ignored.`, 'warning', path));
    }
  };
  check(data, MANIFEST_KNOWN_KEYS.root, '');
  if (Array.isArray(data.authors)) data.authors.forEach((a, i) => check(a, MANIFEST_KNOWN_KEYS.author, `authors[${i}]`));
  check(data.compatibility, MANIFEST_KNOWN_KEYS.compatibility, 'compatibility');
  check(data.release, MANIFEST_KNOWN_KEYS.release, 'release');
  return out;
}

/** module.yaml: YAML parse + schema (with normalization) + semantic checks. */
export function parseManifest(text: string, opts?: { maxBytes?: number }): Result<ModuleManifest> {
  const issues: Issue[] = [];
  const maxBytes = opts?.maxBytes ?? DEFAULT_POLICY.limits.manifestMaxBytes;
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) {
    issues.push(issue('manifest-too-large', `module.yaml is ${bytes} bytes; the limit is ${maxBytes} bytes.`));
    return result(issues);
  }

  let data: unknown;
  try {
    const doc = YAML.parseDocument(text.replace(/^\uFEFF/, ''), { uniqueKeys: true, prettyErrors: false, strict: true });
    if (doc.errors.length) {
      for (const e of doc.errors.slice(0, 5)) issues.push(issue('manifest-yaml', `YAML error: ${e.message.split('\n')[0]}`));
      return result(issues);
    }
    data = doc.toJS({ maxAliasCount: MAX_ALIASES });
  } catch (e) {
    issues.push(issue('manifest-yaml', `YAML error: ${(e as Error).message.split('\n')[0]}`));
    return result(issues);
  }

  if (!isMap(data)) {
    issues.push(issue('manifest-schema', 'module.yaml must be a YAML mapping.'));
    return result(issues);
  }
  // The major version check stays strict: unknown majors are rejected before anything else.
  const sv = data.schemaVersion;
  if (typeof sv === 'number' && !(SUPPORTED_MANIFEST_VERSIONS as readonly number[]).includes(sv)) {
    issues.push(
      issue('manifest-unsupported-version', `schemaVersion ${sv} is not supported (supported: ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}).`, 'error', 'schemaVersion'),
    );
    return result(issues);
  }

  issues.push(...unknownFieldIssues(data));

  const parsed = ModuleManifest.safeParse(data);
  if (!parsed.success) {
    for (const zi of parsed.error.issues) {
      const path = fmtPath(zi.path);
      issues.push(issue('manifest-schema', path ? `${path}: ${zi.message}` : zi.message, 'error', path || undefined));
    }
    return result(issues);
  }
  const m = parsed.data;

  // Semantic checks beyond the schema.
  for (const k of ['homepage', 'support'] as const) {
    if (m[k]?.startsWith('http://')) issues.push(issue('manifest-schema', `${k}: plain http:// URL; use https:// if the site supports it.`, 'warning', k));
  }
  const c = m.compatibility;
  if (c?.androidMinApi !== undefined && c.androidMaxApi !== undefined && c.androidMinApi > c.androidMaxApi)
    issues.push(issue('manifest-schema', 'compatibility.androidMinApi must not be greater than androidMaxApi.', 'error', 'compatibility'));
  if (m.tags && new Set(m.tags).size !== m.tags.length)
    issues.push(issue('manifest-schema', 'tags contains duplicates (tags are case-insensitive).', 'warning', 'tags'));
  if (c?.architectures && new Set(c.architectures).size !== c.architectures.length)
    issues.push(issue('manifest-schema', 'compatibility.architectures contains duplicates.', 'warning', 'compatibility.architectures'));

  return result(issues, m);
}

/** Repository files module.yaml references: icon, then the description document (deduplicated). */
export function manifestReferencedPaths(m: ModuleManifest): string[] {
  const out: string[] = [];
  for (const p of [m.icon, m.description]) if (p && !out.includes(p)) out.push(p);
  return out;
}
