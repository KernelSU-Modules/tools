import { MODULE_ID_PATTERN, foldId, type Policy } from '@kernelsu-modules/schema';
import { issue, type Issue } from './issues.ts';

export const MODULE_ID_MIN = 2;
export const MODULE_ID_MAX = 64;

/** Format-only check shared by module.yaml / module.prop / ID requests. Returns a reason or null. */
export function moduleIdFormatError(id: string): string | null {
  if (id.length < MODULE_ID_MIN || id.length > MODULE_ID_MAX)
    return `must be ${MODULE_ID_MIN}-${MODULE_ID_MAX} characters long (got ${id.length})`;
  if (!MODULE_ID_PATTERN.test(id)) return 'must match ^[a-zA-Z][a-zA-Z0-9._-]+$';
  return null;
}

/**
 * File-like suffixes an ID may not end with (case-insensitive). The static site and API derive paths from the ID
 * ("api/v1/modules/{id}.json" next to the directory "api/v1/modules/{id}/", "{locale}/modules/{id}/", …), so an ID
 * such as "foo.json" would collide with the files of "foo" or be served with the wrong type.
 */
export const RESERVED_ID_SUFFIXES = ['.json', '.html', '.htm', '.md', '.xml', '.txt'] as const;

/** The reserved file suffix an ID ends with (as spelled in RESERVED_ID_SUFFIXES), or null. */
export function reservedSuffix(id: string): string | null {
  const f = foldId(id);
  return RESERVED_ID_SUFFIXES.find((s) => f.endsWith(s)) ?? null;
}

/** Returns the reserved rule an ID hits (case-insensitive), or null. */
export function reservedMatch(id: string, policy: Pick<Policy, 'id'>): string | null {
  const f = foldId(id);
  for (const r of policy.id.reservedIds) if (foldId(r) === f) return `reserved ID "${r}"`;
  for (const p of policy.id.reservedPrefixes) {
    const fp = foldId(p);
    if (!fp) continue;
    if (f.startsWith(fp)) return `reserved prefix "${p}"`;
    // "org.kernelsu" is as reserved as "org.kernelsu.*"
    if (/[._-]$/.test(fp) && f === fp.slice(0, -1)) return `reserved prefix "${p}"`;
  }
  return null;
}

/**
 * ID rules: format, reserved file suffixes, reserved IDs/prefixes (case-insensitive), and case-fold collisions
 * against existing IDs (an identical existing ID is not a collision; the caller decides
 * whether "taken" applies).
 */
export function checkModuleId(id: string, policy: Policy, existingIds?: Iterable<string>): Issue[] {
  const issues: Issue[] = [];
  const fmt = moduleIdFormatError(id);
  if (fmt) {
    issues.push(issue('id-invalid', `Module ID "${id}" ${fmt}.`));
    return issues;
  }
  const sfx = reservedSuffix(id);
  if (sfx) issues.push(issue('id-reserved-suffix', `Module ID "${id}" ends with the reserved file suffix "${sfx}".`));
  const r = reservedMatch(id, policy);
  if (r) issues.push(issue('id-reserved', `Module ID "${id}" matches ${r}.`));
  if (existingIds) {
    const f = foldId(id);
    for (const e of existingIds) {
      if (e !== id && foldId(e) === f) {
        issues.push(issue('id-collision', `Module ID "${id}" collides with existing ID "${e}" (case-insensitive).`));
        break;
      }
    }
  }
  return issues;
}
