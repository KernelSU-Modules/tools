// Programmatic Astro build of the site (used by tools/build). Static output only: no adapter, no
// SSR, no integrations, nothing fetched from the network.
//
// Astro runs in a child process (astro-build.mjs) with cwd = the output's parent directory, so its
// temporary build state (prerender chunks; `cacheDir` = `<outDir>.astro-cache`, removed afterwards) lives
// next to the output, never in the source tree, and concurrent builds into different directories do not share
// it. The only thing Astro still writes under site/ is its generated type stubs (site/.astro/*.d.ts): identical
// for every build, gitignored and excluded from the builder fingerprint. The child also gets a fresh module
// graph, so repeated builds in one process cannot see stale page data.
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_DATA_ENV } from './load.ts';

export const SITE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNNER = fileURLToPath(new URL('./astro-build.mjs', import.meta.url));

export interface BuildSiteOptions {
  /** Page-data JSON (SiteData) written by tools/build. */
  dataFile: string;
  /** Directory receiving the static site (must not exist or be empty). */
  outDir: string;
  /** https origin used for canonical URLs / sitemap. */
  site: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export async function buildSite(o: BuildSiteOptions): Promise<void> {
  const outDir = path.resolve(o.outDir);
  const cwd = path.dirname(outDir);
  const cacheDir = `${outDir}.astro-cache`;
  await mkdir(cwd, { recursive: true });
  const args = JSON.stringify({ root: SITE_ROOT, outDir, cacheDir, site: o.site, logLevel: o.logLevel ?? 'warn' });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [RUNNER, args], {
        cwd,
        // Astro's stdout goes to our stderr: callers (the build CLI) keep stdout for results.
        stdio: ['ignore', 2, 2],
        env: {
          ...process.env,
          [SITE_DATA_ENV]: path.resolve(o.dataFile),
          // Astro's anonymous telemetry would phone home; the build must not touch the network.
          ASTRO_TELEMETRY_DISABLED: '1',
          DO_NOT_TRACK: '1',
          NODE_ENV: 'production',
        },
      });
      child.on('error', reject);
      child.on('exit', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`astro build failed (${signal ?? `exit code ${code}`})`)),
      );
    });
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}
