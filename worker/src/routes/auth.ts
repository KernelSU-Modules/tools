// /auth/*: GitHub App user authorization (login) and the post-installation callback.
import { Hono } from 'hono';
import { timingSafeEqual } from '@kernelsu-modules/github';
import { randomToken } from '../lib/crypto.ts';
import { ApiError } from '../lib/errors.ts';
import { authorizeUrl, exchangeCode, revokeToken } from '../lib/oauth.ts';
import {
  clearSession,
  loadSession,
  readSession,
  readState,
  SESSION_MAX_LIFETIME_MS,
  verifyCsrf,
  writeSession,
  writeState,
  type SessionData,
} from '../lib/session.ts';
import { deferrer, type AppEnv } from '../types.ts';

const ORIGIN = 'https://portal.invalid';

/**
 * Post-login redirect target: a same-origin path, else "/". The value is normalized first (percent-decoding up
 * to 3 times, dot segments) and anything that could resolve off-origin is rejected: "//host", "/\\host",
 * "/.//host", "/%2F%2Fhost", "/%5Chost", control characters, absolute URLs.
 */
export function safeNext(next: string | undefined | null): string {
  if (!next || typeof next !== 'string' || next.length > 512 || !next.startsWith('/')) return '/';
  let probe = next;
  for (let i = 0; i < 3; i++) {
    let d: string;
    try {
      d = decodeURIComponent(probe);
    } catch {
      return '/';
    }
    if (d === probe) break;
    probe = d;
  }
  if (/[\u0000-\u001f\u007f\\]/.test(probe)) return '/';
  const offOrigin = (p: string) => {
    if (!p.startsWith('/') || p.startsWith('//')) return true;
    try {
      const u = new URL(p, ORIGIN);
      return u.origin !== ORIGIN || u.pathname.startsWith('//');
    } catch {
      return true;
    }
  };
  if (offOrigin(probe) || offOrigin(next)) return '/';
  const u = new URL(next, ORIGIN);
  const out = u.pathname + u.search + u.hash;
  return offOrigin(out) ? '/' : out;
}

const page = (title: string, msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${msg}</p><p><a href="/auth/login">Sign in again</a> · <a href="/">Portal</a></p>`;

export const auth = new Hono<AppEnv>();

auth.get('/login', async (c) => {
  const state = randomToken(18);
  await writeState(c, c.env, { state, next: safeNext(c.req.query('next')), exp: c.var.svc.now() + 600_000 });
  return c.redirect(authorizeUrl(c.env, state), 302);
});

/**
 * Two shapes reach the callback URL:
 *  1. normal login: ?code&state            -> state must match the sealed state cookie (CSRF protection).
 *  2. post-installation: ?code&installation_id&setup_action (no state). With "Request user authorization
 *     (OAuth) during installation" enabled GitHub redirects here after install and does NOT echo any state,
 *     so we cannot bind the code to this browser. Trade-off: accepting it allows a "login CSRF" (an attacker
 *     could get a victim logged in as the attacker). Mitigations: (a) if the browser already has a valid
 *     session we keep it and ignore the code entirely, so an existing login is never replaced; (b) the
 *     session only ever acts as the GitHub account it shows in the UI, every write re-checks admin rights
 *     on GitHub, and nothing the victim does can grant the attacker access to the victim's repos.
 *     Any other shape without state is rejected.
 */
auth.get('/callback', async (c) => {
  const svc = c.var.svc;
  const q = c.req.query();
  if (q.error) return c.redirect(`/?auth_error=${encodeURIComponent(q.error.slice(0, 64))}`, 302);
  let next = '/';
  if (q.state !== undefined) {
    const st = await readState(c, c.env);
    if (!st || st.exp < svc.now() || !timingSafeEqual(st.state, q.state)) {
      return c.html(page('Login failed', 'Login state is missing or expired. Please try again.'), 400);
    }
    next = safeNext(st.next);
  } else if (q.setup_action && (q.installation_id || q.setup_action === 'request')) {
    const params = new URLSearchParams({ setup_action: q.setup_action });
    if (q.installation_id && /^\d+$/.test(q.installation_id)) params.set('installation_id', q.installation_id);
    next = `/?${params}`;
    const existing = await loadSession(c, c.env, svc.deps);
    if (existing || !q.code) return c.redirect(next, 302);
  } else {
    return c.html(page('Login failed', 'Invalid callback request.'), 400);
  }
  if (!q.code) return c.html(page('Login failed', 'Missing authorization code.'), 400);

  let tokens;
  try {
    tokens = await exchangeCode(c.env, svc.deps.fetch, q.code, svc.now());
  } catch (e) {
    return c.html(page('Login failed', 'GitHub rejected the authorization code. Please try again.'), 400);
  }
  const me = await svc.userClient(tokens.at).get<{ id: number; login: string; avatar_url: string }>('/user');
  const session: SessionData = {
    v: 1,
    sid: randomToken(12),
    uid: me.data.id,
    login: me.data.login,
    avatar: me.data.avatar_url,
    exp: svc.now() + SESSION_MAX_LIFETIME_MS,
    ...tokens,
  };
  await writeSession(c, c.env, session, svc.now());
  return c.redirect(next, 302);
});

/**
 * Logout: requires the CSRF token of the session (X-CSRF-Token), revokes the GitHub user token
 * (DELETE /applications/{client_id}/token) and clears the cookie. Without a valid session it only clears.
 */
auth.post('/logout', async (c) => {
  const s = await readSession(c, c.env);
  if (s) {
    if (!(await verifyCsrf(c.env, s, c.req.header('x-csrf-token')))) throw new ApiError(403, 'csrf', 'Missing or invalid X-CSRF-Token.');
    const svc = c.var.svc;
    const p = revokeToken(c.env, svc.deps.fetch, s.at)
      .then((ok) => {
        if (!ok) console.error('token revocation was not confirmed');
      })
      .catch((e) => console.error('token revocation failed', (e as Error).message));
    const defer = deferrer(c);
    if (defer) defer(p);
    else await p;
  }
  clearSession(c);
  c.header('cache-control', 'no-store');
  return c.json({ ok: true });
});
