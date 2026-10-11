#!/usr/bin/env -S npx tsx
// pnpm --filter @kernelsu-modules/build start -- --data-dir <path> --out <dist> [--cache-dir <dir>] [--base-url <url>]
//   [--data-commit <sha>] [--portal-url <url>] [--report <file>]
// Relative paths are resolved against the directory pnpm was invoked from ($INIT_CWD).
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from './build.ts';

const USAGE =
  'usage: build --data-dir <path> --out <dist> [--cache-dir <dir>] [--base-url https://modules.kernelsu.org] [--data-commit <sha>] [--portal-url <url>] [--report <file>]';

function parse(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue;
    if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unexpected argument: ${a}\n${USAGE}`);
    const v = m[2] ?? argv[++i];
    if (v === undefined) throw new Error(`--${m[1]} needs a value`);
    out[m[1]!] = v;
  }
  return out;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  const known = new Set(['data-dir', 'out', 'cache-dir', 'base-url', 'data-commit', 'portal-url', 'report']);
  for (const k of Object.keys(args)) if (!known.has(k)) throw new Error(`unknown option --${k}\n${USAGE}`);
  if (!args['data-dir'] || !args['out']) throw new Error(USAGE);
  const cwd = process.env['INIT_CWD'] ?? process.cwd();
  const abs = (p: string | undefined) => (p === undefined ? undefined : path.resolve(cwd, p));
  const baseUrl = args['base-url'] ?? 'https://modules.kernelsu.org';
  if (!/^https:\/\/[^/\s]+\/?$/.test(baseUrl)) throw new Error('--base-url must be an https origin');

  const res = await build({
    dataDir: abs(args['data-dir'])!,
    outDir: abs(args['out'])!,
    cacheDir: abs(args['cache-dir']),
    baseUrl,
    dataCommit: args['data-commit'],
    portalUrl: args['portal-url'],
  });
  const counts = { ok: 0, stale: 0, skipped: 0 };
  for (const o of res.outcomes) counts[o.status]++;
  console.error(
    `[build] buildId=${res.buildId} files=${res.fileCount} modules ok=${counts.ok} stale=${counts.stale} skipped=${counts.skipped} warnings=${res.warnings.length}`,
  );
  if (args['report']) writeFileSync(abs(args['report'])!, JSON.stringify(res, null, 2) + '\n');
  if (process.env['GITHUB_OUTPUT']) appendFileSync(process.env['GITHUB_OUTPUT'], `build_id=${res.buildId}\n`);
  console.log(res.buildId);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    // BuildFailure: an expected refusal (unreachable inputs without a last good copy, file limit, …): no stack.
    const msg = e instanceof Error ? (e.name === 'BuildFailure' ? e.message : (e.stack ?? e.message)) : String(e);
    console.error(`[build] FAILED (nothing written; the live site keeps its previous deployment): ${msg}`);
    process.exit(1);
  },
);
