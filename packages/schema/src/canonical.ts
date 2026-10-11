/** Recursively sort object keys (arrays keep their order); `undefined` members are dropped. */
export function sortKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(sortKeys) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out as T;
  }
  return v;
}

/**
 * Canonical JSON for data repo files written by tools (sources.lock.json, status.json):
 * recursively sorted keys, 2-space indent, trailing newline.
 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 2) + '\n';
}
