// Stateless session: AES-GCM sealed cookie (HttpOnly, Secure, SameSite=Lax, __Host- prefix) holding the
// user-to-server token (+ refresh token). The server stores no user tokens (only a refreshed token set for
// ≤2 min, sealed, so parallel requests can share one refresh). CSRF token = HMAC(sid).
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sha256Hex } from '@kernelsu-modules/github';
import type { Env } from '../env.ts';
import { getSecret, putSecret, type KvCache } from './cache.ts';
import { hmacB64, hmacVerify, seal, unseal } from './crypto.ts';
import { refreshTokens, type TokenSet } from './oauth.ts';

export const SESSION_COOKIE = '__Host-kernelsu-session';
export const STATE_COOKIE = '__Host-kernelsu-oauth';
/** Absolute session lifetime: a login is good for at most 30 days, however often the tokens are refreshed. */
export const SESSION_MAX_LIFETIME_MS = 30 * 86400_000;
/** Response header telling the SPA that a token refresh lost a race and the request should be retried once. */
export const SESSION_RETRY_HEADER = 'x-kernelsu-session';
/** Waits before re-checking the shared cache for a parallel request's refresh result. */
export const REFRESH_RETRY_WAITS_MS = [250, 750];
/** A refresh token that still fails this long after its first failure is dead: the cookie is cleared. */
const DEAD_AFTER_MS = 30_000;

export interface SessionData extends TokenSet {
  v: 1;
  /** random per-login id; CSRF token derives from it */
  sid: string;
  uid: number;
  login: string;
  avatar: string;
  /** absolute expiry (epoch ms), set at login and never extended by refreshes */
  exp: number;
}

export interface SessionDeps {
  fetch: typeof fetch;
  cache: KvCache;
  now: () => number;
}

const cookieOpts = (maxAge: number) => ({ path: '/', httpOnly: true, secure: true, sameSite: 'Lax' as const, maxAge });

export async function writeSession(c: Context, env: Env, s: SessionData, now: number) {
  let limit = s.exp;
  const tok = s.rtExp ?? (s.atExp && !s.rt ? s.atExp : null);
  if (tok) limit = Math.min(limit, tok);
  const maxAge = Math.max(60, Math.floor((limit - now) / 1000));
  setCookie(c, SESSION_COOKIE, await seal(env.SESSION_KEY, s, SESSION_COOKIE), cookieOpts(maxAge));
}

export function clearSession(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

/** Unseal the cookie without refreshing (logout). Null when absent/invalid. */
export async function readSession(c: Context, env: Env): Promise<SessionData | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  const s = await unseal<SessionData>(env.SESSION_KEY, raw, SESSION_COOKIE);
  return s && s.v === 1 && typeof s.exp === 'number' ? s : null;
}

/** Per-isolate single flight: parallel requests carrying the same refresh token share one token request. */
const inflight = new Map<string, Promise<TokenSet>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Refresh once per refresh token (GitHub refresh tokens are single-use): single flight within the isolate, and
 * the result is shared through the (sealed) cache for 2 minutes so a parallel request in another isolate that
 * loses the race can pick it up instead of logging the user out. Null when no fresh token set is available.
 */
async function refreshShared(env: Env, deps: SessionDeps, rt: string): Promise<{ tokens: TokenSet | null; key: string }> {
  const key = `rt/${(await sha256Hex(rt)).slice(0, 40)}`;
  const shared = await getSecret<TokenSet>(deps.cache, env.SESSION_KEY, key);
  if (shared) return { tokens: shared, key };
  let p = inflight.get(key);
  if (!p) {
    p = refreshTokens(env, deps.fetch, rt, deps.now()).then(async (t) => {
      await putSecret(deps.cache, env.SESSION_KEY, key, t, 120);
      return t;
    });
    inflight.set(key, p);
    p.then(
      () => inflight.delete(key),
      () => inflight.delete(key),
    );
  }
  try {
    return { tokens: await p, key };
  } catch {
    for (const ms of REFRESH_RETRY_WAITS_MS) {
      await sleep(ms);
      const t = await getSecret<TokenSet>(deps.cache, env.SESSION_KEY, key);
      if (t) return { tokens: t, key };
    }
    return { tokens: null, key };
  }
}

/**
 * Read + (if the access token is about to expire) refresh the session. Returns null when logged out/invalid.
 * A failed refresh does NOT clear the cookie right away: with parallel requests one wins the single-use refresh
 * token and sets the new cookie; clearing it from the losing response could log the user out. The losing
 * response is marked with `X-KernelSU-Session: retry` (the SPA retries once); the cookie is only cleared when the
 * same refresh token still fails ≥30 s after its first failure.
 */
export async function loadSession(c: Context, env: Env, deps: SessionDeps): Promise<SessionData | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  const now = deps.now();
  const s = await unseal<SessionData>(env.SESSION_KEY, raw, SESSION_COOKIE);
  if (!s || s.v !== 1 || typeof s.exp !== 'number' || s.exp <= now) {
    clearSession(c);
    return null;
  }
  if (s.atExp && s.atExp - 60_000 < now) {
    if (!s.rt || (s.rtExp && s.rtExp < now)) {
      clearSession(c);
      return null;
    }
    const { tokens, key } = await refreshShared(env, deps, s.rt);
    if (tokens) {
      const next: SessionData = { ...s, ...tokens };
      await writeSession(c, env, next, now);
      return next;
    }
    // The old access token may still be usable for a few seconds.
    if (s.atExp > now) return s;
    const deadKey = `rtdead/${key.slice(3)}`;
    const firstFail = Number(await deps.cache.get(deadKey));
    if (firstFail && now - firstFail >= DEAD_AFTER_MS) clearSession(c);
    else {
      if (!firstFail) await deps.cache.put(deadKey, String(now), 3600);
      c.header(SESSION_RETRY_HEADER, 'retry');
    }
    return null;
  }
  return s;
}

export const csrfToken = (env: Env, s: SessionData) => hmacB64(env.SESSION_KEY, `csrf:${s.sid}:${s.uid}`);
export const verifyCsrf = (env: Env, s: SessionData, token: string | null | undefined) => hmacVerify(env.SESSION_KEY, `csrf:${s.sid}:${s.uid}`, token);

export interface OAuthState {
  state: string;
  next: string;
  exp: number;
}
export async function writeState(c: Context, env: Env, st: OAuthState) {
  setCookie(c, STATE_COOKIE, await seal(env.SESSION_KEY, st, STATE_COOKIE), cookieOpts(600));
}
export async function readState(c: Context, env: Env): Promise<OAuthState | null> {
  const raw = getCookie(c, STATE_COOKIE);
  if (!raw) return null;
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: true });
  return unseal<OAuthState>(env.SESSION_KEY, raw, STATE_COOKIE);
}
