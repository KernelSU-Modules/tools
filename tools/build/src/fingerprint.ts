// Builder fingerprint: sha256 over the code that turns the data repo into dist/ (sorted relative paths + file
// contents, tests excluded) plus pnpm-lock.yaml. Part of the buildId, so a fix to the builder, the site templates,
// the renderer, the schema or the validator changes the buildId and gets deployed even when the data did not change.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root of the tools monorepo (this file is tools/build/src/fingerprint.ts). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Directories (relative to REPO_ROOT) whose files make up the builder. */
export const FINGERPRINT_DIRS = ['tools/build', 'site', 'packages/render', 'packages/schema', 'packages/validator'] as const;
/** Single files hashed in addition. */
export const FINGERPRINT_FILES = ['pnpm-lock.yaml'] as const;

const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', '__tests__', 'dist', '.astro', '.cache', '.turbo', 'coverage', 'preview-dist']);
const SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|^\.DS_Store$/;

function walk(root: string, rel: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, p, out);
    } else if (e.isFile() && !SKIP_FILE.test(e.name)) out.push(p);
  }
}

/** Sorted repository-relative paths that are hashed into the fingerprint. */
export function fingerprintFiles(root = REPO_ROOT): string[] {
  const out: string[] = [];
  for (const d of FINGERPRINT_DIRS) walk(root, d, out);
  for (const f of FINGERPRINT_FILES) out.push(f);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const memo = new Map<string, string>();

/** sha256 hex of (path NUL length NUL bytes)* over fingerprintFiles(); missing single files hash as absent. */
export function builderFingerprint(root = REPO_ROOT): string {
  const hit = memo.get(root);
  if (hit) return hit;
  const h = createHash('sha256');
  for (const p of fingerprintFiles(root)) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = readFileSync(path.join(root, p));
    } catch {
      bytes = null;
    }
    h.update(`${p}\0${bytes ? bytes.length : -1}\0`);
    if (bytes) h.update(bytes);
  }
  const fp = h.digest('hex');
  memo.set(root, fp);
  return fp;
}
