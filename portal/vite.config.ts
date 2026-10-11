import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { buildDocs } from './build/docs.ts';

const DOCS_DIR = fileURLToPath(new URL('../docs/developers', import.meta.url));
const DOCS_CSS = fileURLToPath(new URL('./build/docs.css', import.meta.url));

const loadDocs = () => buildDocs(DOCS_DIR, readFileSync(DOCS_CSS, 'utf8'));

/** Renders ../docs/developers/**\/*.md to static pages under dist/docs (build) or serves them (dev). */
function developerDocs(): Plugin {
  return {
    name: 'kernelsu-developer-docs',
    config() {
      // Which docs exist in non-default locales, so the SPA can link /docs/zh-CN/... only when present.
      return { define: { __DOCS_LOCALE_ROUTES__: JSON.stringify(loadDocs().localeRoutes) } };
    },
    generateBundle() {
      for (const [fileName, source] of loadDocs().files) this.emitFile({ type: 'asset', fileName, source });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/docs') {
          res.statusCode = 308;
          res.setHeader('Location', '/docs/' + url.search);
          return res.end();
        }
        if (!url.pathname.startsWith('/docs/')) return next();
        const files = loadDocs().files;
        const rel = url.pathname.slice(1);
        const candidates = rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`];
        for (const c of candidates) {
          const body = files.get(c);
          if (body === undefined) continue;
          const type = c.endsWith('.css') ? 'text/css' : c.endsWith('.svg') ? 'image/svg+xml' : c.endsWith('.html') ? 'text/html' : 'application/octet-stream';
          res.setHeader('Content-Type', `${type}; charset=utf-8`);
          return res.end(body);
        }
        res.statusCode = 404;
        res.end('Not found');
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [preact(), developerDocs()],
  build: {
    target: 'es2022',
    // No inline scripts / data: URIs in the output (CSP: script-src 'self'; img-src without data:).
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
    reportCompressedSize: true,
  },
  server: {
    // `pnpm dev` (non-mock) talks to a local `wrangler dev` of the Worker.
    proxy: mode === 'mock' ? undefined : { '/api': 'http://127.0.0.1:8787', '/auth': 'http://127.0.0.1:8787' },
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
}));
