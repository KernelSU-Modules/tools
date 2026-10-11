// Bundles the Pages Functions entry (src/entry/pages.ts) into `<out>/_worker.js` (Pages "advanced mode") and
// writes `<out>/_routes.json` so only the dynamic prefixes invoke Functions. Run after the Portal build:
//   pnpm --filter @kernelsu-modules/portal build && pnpm --filter @kernelsu-modules/worker build
// Usage: tsx scripts/build-pages.ts [--out ../portal/dist] [--metafile <path>]
import { build } from 'esbuild';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pagesRoutes } from '../src/routes-config.ts';

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, opt('--out', '../portal/dist')!);
if (!existsSync(resolve(out, 'index.html'))) {
  console.error(`${out}/index.html not found: build the Portal first (pnpm --filter @kernelsu-modules/portal build).`);
  process.exit(1);
}
if (existsSync(resolve(out, '404.html'))) {
  // Pages only applies the SPA fallback (unknown path -> /index.html) when there is no top-level 404.html.
  console.error(`${out}/404.html exists; it would disable the Pages SPA fallback.`);
  process.exit(1);
}

const workerFile = resolve(out, '_worker.js');
const result = await build({
  entryPoints: [resolve(root, 'src/entry/pages.ts')],
  outfile: workerFile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2023',
  conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
  mainFields: ['module', 'main'],
  minify: true,
  legalComments: 'none',
  metafile: !!opt('--metafile'),
  logLevel: 'warning',
});
if (opt('--metafile')) writeFileSync(resolve(opt('--metafile')!), JSON.stringify(result.metafile));
writeFileSync(resolve(out, '_routes.json'), JSON.stringify(pagesRoutes(), null, 2) + '\n');

const size = statSync(workerFile).size;
const gz = gzipSync(readFileSync(workerFile)).length;
console.log(`_worker.js ${(size / 1024).toFixed(1)} KiB (gzip ${(gz / 1024).toFixed(1)} KiB), _routes.json -> ${out}`);
