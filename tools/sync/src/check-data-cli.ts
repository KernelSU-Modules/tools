#!/usr/bin/env node
// pnpm --filter @kernelsu-modules/sync check-data -- --data-dir <path> [--now <iso>]
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkDataDir } from './check-data.ts';

const USAGE = `Usage: check-data --data-dir <path> [--now <iso>]

  --data-dir     data repo checkout to validate (read-only)
  --now          evaluate request expiry at this time instead of the current time

Exit code 1 when any error is found; warnings (e.g. stale entries the next sync removes) do not fail.`;

function main(): number {
  let args;
  try {
    // pnpm forwards the `--` separator literally (`pnpm check-data -- --data-dir x`).
    const argv = process.argv.slice(2);
    args = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : argv,
      options: {
        'data-dir': { type: 'string' },
        now: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }).values;
  } catch (e) {
    console.error((e as Error).message + '\n\n' + USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args['data-dir'] || (args.now !== undefined && Number.isNaN(Date.parse(args.now)))) {
    console.error(USAGE);
    return 2;
  }
  // Relative paths are relative to where the user invoked pnpm, not the package directory.
  const dataDir = resolve(process.env.INIT_CWD ?? process.cwd(), args['data-dir']);
  const { issues, stats } = checkDataDir(dataDir, args.now ? { now: new Date(args.now) } : {});
  for (const i of issues) console[i.severity === 'error' ? 'error' : 'log'](`${i.severity.toUpperCase()} ${i.file}: ${i.message}`);
  const errors = issues.filter((i) => i.severity === 'error').length;
  console.log(
    `\n${dataDir}: ${errors} error(s), ${issues.length - errors} warning(s). ` +
      Object.entries(stats)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  );
  return errors ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
