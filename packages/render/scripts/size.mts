// Bundles @kernelsu-modules/render the way a Cloudflare Worker would (no Node built-ins allowed)
// and reports the minified / gzipped size.  Usage: pnpm --filter @kernelsu-modules/render size
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

export async function bundleRender(): Promise<{ bytes: number; gzip: number; inputs: Record<string, number> }> {
  const res = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    minify: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser', 'import'],
    mainFields: ['module', 'main'],
    target: 'es2022',
    metafile: true,
    logLevel: 'silent',
  });
  const code = res.outputFiles[0]!.contents;
  const inputs: Record<string, number> = {};
  for (const [file, info] of Object.entries(Object.values(res.metafile.outputs)[0]!.inputs)) {
    const pkg = /.*node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file)?.[1] ?? 'render';
    inputs[pkg] = (inputs[pkg] ?? 0) + info.bytesInOutput;
  }
  return { bytes: code.length, gzip: gzipSync(code).length, inputs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await bundleRender();
  console.log(`render bundle: ${(r.bytes / 1024).toFixed(1)} KiB minified, ${(r.gzip / 1024).toFixed(1)} KiB gzip`);
  for (const [k, v] of Object.entries(r.inputs).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${(v / 1024).toFixed(1)} KiB`);
}
