import { base64UrlEncode, hmacSha256Hex } from '@kernelsu-modules/github';
import { DEFAULT_POLICY } from '@kernelsu-modules/schema';
import YAML from 'yaml';
import { createApp } from '../src/app.ts';
import type { Env } from '../src/env.ts';
import { MemoryStore } from '../src/lib/cache.ts';
import { Services } from '../src/services.ts';
import { BOT_APP_ID, DATA_REPO, FakeWorld, MODULES_APP_ID, TOOLS_REPO, type FakeUser } from './fake.ts';

let pem: Promise<string> | null = null;
function rsaPem(): Promise<string> {
  pem ??= (async () => {
    const kp = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
    let bin = '';
    for (const b of der) bin += String.fromCharCode(b);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/.{64}/g, '$&\n')}\n-----END PRIVATE KEY-----\n`;
  })();
  return pem;
}

export const MAINTAINER = { id: 9000, login: 'maint', tg: 555 };
export const CHAT_ID = -1001234;

export async function setup(opts: { telegram?: boolean } = {}) {
  const world = new FakeWorld();
  const key = await rsaPem();
  const env: Env = {
    DATA_REPO,
    TOOLS_REPO,
    SYNC_WORKFLOW: 'sync-build-deploy.yml',
    PORTAL_URL: 'https://developers.kernelsu.org',
    SITE_URL: 'https://modules.kernelsu.org',
    MODULES_APP_SLUG: 'kernelsu-modules',
    PAGES_PROJECTS: 'kernelsu-modules-repo,kernelsu-developer-portal',
    TELEGRAM_CHAT_ID: opts.telegram === false ? '' : String(CHAT_ID),
    MODULES_APP_ID,
    MODULES_APP_PRIVATE_KEY: key,
    MODULES_APP_CLIENT_ID: 'Iv1.client',
    MODULES_APP_CLIENT_SECRET: 'client-secret',
    MODULES_APP_WEBHOOK_SECRET: 'gh-webhook-secret',
    BOT_APP_ID,
    BOT_APP_PRIVATE_KEY: key,
    SESSION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    TELEGRAM_BOT_TOKEN: opts.telegram === false ? undefined : '123:abc',
    TG_FORWARD_SECRET: 'tg-forward-secret',
    TELEGRAM_WEBHOOK_SECRET: 'tg-direct-secret',
    CF_API_TOKEN: 'cf-token',
    CF_ACCOUNT_ID: 'acct',
  };
  const cache = new MemoryStore(new Map(), () => world.now);
  const svc = new Services(env, { fetch: world.fetch, cache, now: () => world.now });
  const app = createApp({ services: () => svc });
  world.addUser(MAINTAINER.id, MAINTAINER.login);
  await world.seedData({
    'policy.yaml': YAML.stringify(DEFAULT_POLICY),
    'maintainers.yaml': YAML.stringify({ maintainers: [{ github: { id: MAINTAINER.id, login: MAINTAINER.login }, telegram: { id: MAINTAINER.tg } }] }),
    'banned.yaml': YAML.stringify({ banned: [] }),
    'README.md': '# data\n',
  });
  const request = (path: string, init: RequestInit = {}) => app.request(path, init, env);
  return { world, env, svc, app, cache, request };
}
export type H = Awaited<ReturnType<typeof setup>>;

export function cookiesFrom(res: Response, jar: Map<string, string> = new Map()) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair!.indexOf('=');
    const name = pair!.slice(0, i);
    const value = pair!.slice(i + 1);
    if (/max-age=0/i.test(c) || value === '') jar.delete(name);
    else jar.set(name, value);
  }
  return jar;
}
export const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/** Full login flow; returns a client that sends the session cookie and CSRF token. */
export async function login(h: H, user: FakeUser) {
  const jar = new Map<string, string>();
  const r1 = await h.request('/auth/login?next=/modules');
  cookiesFrom(r1, jar);
  const state = new URL(r1.headers.get('location')!).searchParams.get('state')!;
  const code = `code-${user.id}-${Math.random()}`;
  h.world.oauthCodes.set(code, user.id);
  const r2 = await h.request(`/auth/callback?code=${encodeURIComponent(code)}&state=${state}`, { headers: { cookie: cookieHeader(jar) } });
  if (r2.status !== 302) throw new Error(`login failed ${r2.status} ${await r2.text()}`);
  cookiesFrom(r2, jar);
  const me = (await (await h.request('/api/me', { headers: { cookie: cookieHeader(jar) } })).json()) as { csrf: string };
  const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    h.request(path, {
      method,
      headers: { cookie: cookieHeader(jar), 'x-csrf-token': me.csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { jar, csrf: me.csrf, call, get: (p: string) => call('GET', p), post: (p: string, b: unknown = {}) => call('POST', p, b) };
}

export async function signedTelegram(h: H, update: unknown, secret = 'tg-forward-secret') {
  const body = JSON.stringify(update);
  const sig = 'sha256=' + (await hmacSha256Hex(secret, body));
  return h.request('/internal/telegram', { method: 'POST', body, headers: { 'x-kernelsu-signature': sig, 'content-type': 'application/json' } });
}

export async function githubHook(h: H, event: string, payload: unknown, secret = 'gh-webhook-secret') {
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + (await hmacSha256Hex(secret, body));
  return h.request('/webhooks/github', { method: 'POST', body, headers: { 'x-hub-signature-256': sig, 'x-github-event': event } });
}

export const callback = (data: string, fromId: number) => ({
  update_id: 1,
  callback_query: { id: 'cq1', from: { id: fromId }, data, message: { message_id: 1, chat: { id: CHAT_ID } } },
});

export { base64UrlEncode };
