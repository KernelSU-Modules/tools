// @ts-check
// Static site for modules.kernelsu.org. Built by tools/build via buildSite() (src/lib/build.ts);
// `KSU_SITE_DATA=<page-data.json> pnpm exec astro dev` works for local development.
// CSP (`_headers`): script-src 'self'; style-src 'self' -> nothing may be inlined.
import { defineConfig, passthroughImageService } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

/** Content-hashed names only: deterministic, cacheable as immutable under /assets/*. */
const HASHED_NAMES = {
  hashCharacters: /** @type {const} */ ('hex'),
  entryFileNames: 'assets/[hash:16].js',
  chunkFileNames: 'assets/[hash:16].js',
  assetFileNames: 'assets/[hash:16][extname]',
};

export default defineConfig({
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
    assets: 'assets',
    inlineStylesheets: 'never',
  },
  compressHTML: true,
  devToolbar: { enabled: false },
  prefetch: false,
  image: { service: passthroughImageService() },
  vite: {
    plugins: [tailwindcss()],
    build: {
      // Never inline scripts/styles/assets as data: or <script> bodies.
      assetsInlineLimit: 0,
      cssCodeSplit: false,
      rolldownOptions: { output: HASHED_NAMES },
    },
    environments: {
      // Astro names client chunks "<name>.<hash>.js" unless overridden per environment.
      client: { build: { assetsInlineLimit: 0, rolldownOptions: { output: HASHED_NAMES } } },
    },
  },
});
