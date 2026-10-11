// Hono app of the Portal (Pages project `kernelsu-developer-portal`, advanced-mode `_worker.js`, see entry/pages.ts).
import { Hono } from 'hono';
import type { Env } from './env.ts';
import { CacheApiStore, MemoryStore, TieredCache } from './lib/cache.ts';
import { ApiError, errorBody } from './lib/errors.ts';
import { loadSession } from './lib/session.ts';
import { api } from './routes/api.ts';
import { auth } from './routes/auth.ts';
import { hooks } from './routes/hooks.ts';
import { DYNAMIC_PREFIXES } from './routes-config.ts';
import { Services, type Deps } from './services.ts';
import type { AppEnv } from './types.ts';

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com";

export const HSTS = 'max-age=31536000; includeSubDomains';

/** GitHub retry policy for Portal requests (the cron Worker keeps the client defaults). */
export const INTERACTIVE_RETRY = { maxDelayMs: 2000 } as const;

// Per-isolate memo: GitHub App JWTs, installation tokens, data snapshots and L1 cache survive across requests.
// L2 is the Cache API (per colo). It only stores on the custom domain: on *.pages.dev it is a no-op, so
// everything (rate limit markers, token/snapshot caches) degrades to per-isolate memory there.
const isolateL1 = new MemoryStore();
let memo: { key: string; svc: Services } | null = null;

export function defaultServices(env: Env): Services {
  const key = [env.MODULES_APP_ID, env.BOT_APP_ID, env.DATA_REPO, env.SESSION_KEY?.length].join('|');
  if (memo?.key === key) return memo.svc;
  const cacheApi = typeof caches !== 'undefined' && (caches as unknown as { default?: Cache }).default;
  const deps: Deps = {
    fetch: (input, init) => fetch(input, init),
    cache: new TieredCache(isolateL1, cacheApi ? new CacheApiStore(cacheApi) : null),
    now: () => Date.now(),
    // Interactive requests: never wait for a long Retry-After / rate-limit reset (default would be up to 10 s).
    retry: INTERACTIVE_RETRY,
  };
  memo = { key, svc: new Services(env, deps) };
  return memo.svc;
}

/**
 * Browser-facing routes only work on the PORTAL_URL host (OAuth callback URL, `__Host-` cookies), so
 * `/auth/*` and `/api/*` on `*.pages.dev` aliases redirect there. Webhooks stay reachable on any host.
 */
export function canonicalRedirect(req: Request, portalUrl: string): Response | null {
  const url = new URL(req.url);
  if (!url.hostname.endsWith('.pages.dev')) return null;
  if (!url.pathname.startsWith('/auth/') && !url.pathname.startsWith('/api/')) return null;
  let portal: URL;
  try {
    portal = new URL(portalUrl);
  } catch {
    return null;
  }
  if (portal.hostname === url.hostname) return null;
  return new Response(null, { status: 308, headers: { location: portal.origin + url.pathname + url.search, 'cache-control': 'no-store' } });
}

export function createApp(opts: { services?: (env: Env) => Services } = {}) {
  const services = opts.services ?? defaultServices;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const r = canonicalRedirect(c.req.raw, c.env.PORTAL_URL);
    if (r) return r;
    await next();
  });

  app.use('*', async (c, next) => {
    c.set('svc', services(c.env));
    c.set('session', null);
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'strict-origin-when-cross-origin');
    c.header('strict-transport-security', HSTS);
    if (!c.res.headers.has('content-security-policy')) c.header('content-security-policy', CSP);
    if (c.req.path.startsWith('/api/')) c.header('cache-control', 'no-store');
  });

  app.use('/api/*', async (c, next) => {
    const svc = c.var.svc;
    c.set('session', await loadSession(c, c.env, svc.deps));
    await next();
  });

  app.route('/auth', auth);
  app.route('/api', api);
  app.route('/', hooks);

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err.code, err.message, err.details), err.status);
    console.error('unhandled', err instanceof Error ? err.stack ?? err.message : String(err));
    return c.json(errorBody('internal', 'Internal error'), 500);
  });

  app.notFound(async (c) => {
    const p = c.req.path;
    if (DYNAMIC_PREFIXES.some((x) => p.startsWith(x)) || !c.env.ASSETS) return c.json(errorBody('not-found', 'Not found'), 404);
    // Static assets normally never reach the Functions worker (_routes.json only includes DYNAMIC_PREFIXES).
    const res = await c.env.ASSETS.fetch(c.req.raw);
    const out = new Response(res.body, res);
    out.headers.set('content-security-policy', CSP);
    return out;
  });

  return app;
}
