// Child-process entry for buildSite() (see build.ts). argv[2]: JSON options.
import { build } from 'astro';

const o = JSON.parse(process.argv[2] ?? '{}');
await build({
  root: o.root,
  outDir: o.outDir,
  cacheDir: o.cacheDir,
  site: o.site,
  logLevel: o.logLevel,
  mode: 'production',
});
