// Deployment shape: Pages advanced-mode entry (+ _routes.json) and the kernelsu-developer-portal-cron Worker entry.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import pages from '../src/entry/pages.ts';
import cronWorker, { cronServices } from '../src/entry/cron.ts';
import { runScheduled } from '../src/cron.ts';
import type { CronEnv, Env } from '../src/env.ts';
import { MemoryStore } from '../src/lib/cache.ts';
import { DYNAMIC_PREFIXES, pagesRoutes } from '../src/routes-config.ts';
import { setup } from './harness.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ctx = { waitUntil: () => {} };

describe('Pages Functions entry', () => {
  const env = (assets?: Env['ASSETS']) =>
    ({
      PORTAL_URL: 'https://developers.kernelsu.org',
      DATA_REPO: 'KernelSU-Modules/repo',
      TOOLS_REPO: 'KernelSU-Modules/tools',
      BOT_APP_ID: '1',
      BOT_APP_PRIVATE_KEY: 'x',
      MODULES_APP_ID: '2',
      MODULES_APP_PRIVATE_KEY: 'x',
      SESSION_KEY: btoa('k'.repeat(32)),
      MODULES_APP_WEBHOOK_SECRET: 'whsec',
      ASSETS: assets,
    }) as unknown as Env;

  it('_routes.json only routes the dynamic prefixes to Functions', () => {
    expect(pagesRoutes()).toMatchObject({ version: 1, include: ['/api/*', '/auth/*', '/webhooks/*', '/internal/*'], exclude: [] });
    expect(pagesRoutes().include).toHaveLength(DYNAMIC_PREFIXES.length);
  });

  it('redirects browser routes on *.pages.dev to the custom domain, but not webhooks', async () => {
    const r = await pages.fetch(new Request('https://kernelsu-developer-portal.pages.dev/auth/login?next=/x'), env(), ctx);
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe('https://developers.kernelsu.org/auth/login?next=/x');
    const api = await pages.fetch(new Request('https://abc123.kernelsu-developer-portal.pages.dev/api/me'), env(), ctx);
    expect(api.headers.get('location')).toBe('https://developers.kernelsu.org/api/me');
    const hook = await pages.fetch(new Request('https://kernelsu-developer-portal.pages.dev/webhooks/github', { method: 'POST', body: '{}' }), env(), ctx);
    expect(hook.status).toBe(401); // reached the handler (bad signature), not redirected
  });

  it('unknown dynamic paths are JSON 404s; anything else falls through to ASSETS with the CSP', async () => {
    const seen: string[] = [];
    const assets = { fetch: async (req: Request | string) => (seen.push(new URL(typeof req === 'string' ? req : req.url).pathname), new Response('<html>spa</html>', { headers: { 'content-type': 'text/html' } })) };
    const nf = await pages.fetch(new Request('https://developers.kernelsu.org/api/nope'), env(assets), ctx);
    expect(nf.status).toBe(404);
    expect(((await nf.json()) as any).error.code).toBe('not-found');
    const spa = await pages.fetch(new Request('https://developers.kernelsu.org/modules/x'), env(assets), ctx);
    expect(await spa.text()).toBe('<html>spa</html>');
    expect(spa.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(seen).toEqual(['/modules/x']);
  });

  it('wrangler.toml is a Pages config for portal/dist; the Portal keeps its _headers CSP', () => {
    const toml = read('../wrangler.toml');
    expect(toml).toMatch(/^name = "kernelsu-developer-portal"$/m);
    expect(toml).toMatch(/^pages_build_output_dir = "\.\.\/portal\/dist"$/m);
    expect(toml).not.toMatch(/^\[triggers\]/m);
    expect(toml).not.toMatch(/^main\s*=/m);
    expect(read('../../portal/public/_headers')).toMatch(/Content-Security-Policy: default-src 'self'/);
  });
});

describe('kernelsu-developer-portal-cron Worker entry', () => {
  it('wrangler config: cron triggers only, no routes / workers.dev', () => {
    const toml = read('../cron/wrangler.toml');
    expect(toml).toMatch(/^name = "kernelsu-developer-portal-cron"$/m);
    expect(toml).toMatch(/^main = "\.\.\/src\/entry\/cron\.ts"$/m);
    expect(toml).toMatch(/^crons = \["17 3 \* \* \*"\]$/m);
    expect(toml).toMatch(/^workers_dev = false$/m);
    expect(toml).not.toMatch(/^routes/m);
    expect(toml).toMatch(/^PAGES_PROJECTS = "kernelsu-modules-repo,kernelsu-developer-portal"$/m);
    expect(Object.keys(cronWorker)).toEqual(['scheduled']);
  });

  it('runs the scheduled work with only the cron bindings (no Modules App, no SESSION_KEY)', async () => {
    const h = await setup();
    const full = h.env;
    const env: CronEnv = {
      DATA_REPO: full.DATA_REPO,
      TOOLS_REPO: full.TOOLS_REPO,
      SYNC_WORKFLOW: full.SYNC_WORKFLOW,
      PORTAL_URL: full.PORTAL_URL,
      PAGES_PROJECTS: 'kernelsu-modules-repo',
      TELEGRAM_CHAT_ID: full.TELEGRAM_CHAT_ID,
      BOT_APP_ID: full.BOT_APP_ID,
      BOT_APP_PRIVATE_KEY: full.BOT_APP_PRIVATE_KEY,
      TELEGRAM_BOT_TOKEN: full.TELEGRAM_BOT_TOKEN,
      CF_API_TOKEN: full.CF_API_TOKEN,
      CF_ACCOUNT_ID: full.CF_ACCOUNT_ID,
    };
    const cache = new MemoryStore(new Map(), () => h.world.now);
    const svc = cronServices(env, { fetch: h.world.fetch, cache, now: () => h.world.now });
    h.world.canonical = 'c';
    h.world.deployments = [{ id: 'c', environment: 'production', created_on: '2026-01-01T00:00:00Z' }];
    h.world.workflowRuns = [{ id: 1, status: 'completed', conclusion: 'success', created_at: '2026-10-09T23:50:00Z', updated_at: '2026-10-09T23:55:00Z', html_url: 'u' }];
    const res = await runScheduled(svc, '17 3 * * *', Date.parse('2026-10-10T00:00:00Z'));
    expect(res).toMatchObject({ dispatched: true, health: { stale: false }, expired: [], pruned: { 'kernelsu-modules-repo': { deleted: [] } } });
    expect(h.world.dispatches.map((d) => d.inputs)).toEqual([{ reason: 'cron' }]);
    expect(() => svc.modules).toThrow(/MODULES_APP_ID/);
    // installation tokens stay in isolate memory (nothing sealed into the cache without SESSION_KEY)
    expect([...cache.map.keys()].some((k) => k.startsWith('tok/'))).toBe(false);
  });
});
