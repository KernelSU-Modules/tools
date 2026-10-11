#!/usr/bin/env node
// Detects drift between the issue codes documented in checks.md (one `### <code>` heading per code,
// in every language) and ISSUE_CODES exported by @kernelsu-modules/validator, and fails when a consumer
// (worker, sync, module-release action) emits an issue code that is not in ISSUE_CODES.
//
//   node docs/developers/check-codes.mjs   (re-runs itself under the workspace tsx if needed)
//
// Exit code 0 = in sync, 1 = drift, 2 = could not load the validator.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const validatorEntry = join(root, 'packages', 'validator', 'src', 'index.ts');
const docs = [join(here, 'checks.md'), join(here, 'zh-CN', 'checks.md')];

let ISSUE_CODES;
try {
  ({ ISSUE_CODES } = await import(pathToFileURL(validatorEntry).href));
  if (!ISSUE_CODES || typeof ISSUE_CODES !== 'object') throw new Error('ISSUE_CODES is not exported');
} catch (e) {
  const tsx = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  if (!process.env.KSU_CHECK_CODES_TSX && existsSync(tsx)) {
    const r = spawnSync(tsx, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, KSU_CHECK_CODES_TSX: '1' },
    });
    process.exit(r.status ?? 2);
  }
  console.error(`Cannot load ISSUE_CODES from ${relative(root, validatorEntry)}: ${e.message}`);
  console.error('Run with a TypeScript-capable runtime, e.g. `pnpm exec tsx docs/developers/check-codes.mjs`.');
  process.exit(2);
}

const known = new Set(Object.keys(ISSUE_CODES));
const HEADING = /^###\s+`?([a-z0-9][a-z0-9-]*)`?\s*$/gm;
let drift = false;

for (const file of docs) {
  const rel = relative(root, file);
  if (!existsSync(file)) {
    console.error(`${rel}: missing`);
    drift = true;
    continue;
  }
  const text = readFileSync(file, 'utf8');
  const documented = [...text.matchAll(HEADING)].map((m) => m[1]);
  const seen = new Set();
  const dupes = documented.filter((c) => (seen.has(c) ? true : (seen.add(c), false)));
  const missing = [...known].filter((c) => !seen.has(c));
  const unknown = [...seen].filter((c) => !known.has(c));
  if (missing.length || unknown.length || dupes.length) drift = true;
  for (const c of missing) console.error(`${rel}: not documented: ${c}`);
  for (const c of unknown) console.error(`${rel}: documented but not in ISSUE_CODES: ${c}`);
  for (const c of dupes) console.error(`${rel}: documented twice: ${c}`);
  if (!missing.length && !unknown.length && !dupes.length) console.log(`${rel}: ${seen.size} codes, in sync`);
}

/* ---------- issue codes emitted by consumers ---------- */
const SOURCE_DIRS = ['worker/src', 'tools/sync/src', 'actions/module-release/src'];
// Literals that look like codes but are not issue codes: HTTP error codes returned by worker routes.
const NOT_ISSUE_CODES = new Set(['rate-limited', 'bad-signature', 'bad-request', 'disabled']);
const CODE_PATTERNS = [
  /\bcode:\s*['"`]([a-z0-9][a-z0-9-]*)['"`]/g, // { code: 'x', ... }
  /\b(?:err|issue)\(\s*['"`]([a-z0-9][a-z0-9-]*)['"`]/g, // err('x', ...) / issue('x', ...) helpers
  /\bDownloadError\([^;]*?,\s*['"`]([a-z0-9][a-z0-9-]*)['"`],\s*(?:true|false|\w+)\s*\)/g, // new DownloadError(msg, 'x', transient)
];
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === 'dist' ? [] : walk(p);
    return /\.(ts|mts|tsx|js|mjs)$/.test(n) ? [p] : [];
  });
let scanned = 0;
for (const d of SOURCE_DIRS) {
  const abs = join(root, d);
  if (!existsSync(abs)) {
    console.error(`${d}: missing (expected issue-code sources)`);
    drift = true;
    continue;
  }
  for (const file of walk(abs)) {
    const text = readFileSync(file, 'utf8');
    scanned++;
    for (const re of CODE_PATTERNS) {
      for (const m of text.matchAll(re)) {
        const code = m[1];
        if (known.has(code) || NOT_ISSUE_CODES.has(code)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        console.error(`${relative(root, file)}:${line}: emits unknown issue code: ${code}`);
        drift = true;
      }
    }
  }
}
console.log(`${SOURCE_DIRS.join(', ')}: scanned ${scanned} files for emitted issue codes`);

process.exit(drift ? 1 : 0);
