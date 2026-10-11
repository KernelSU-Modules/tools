// KernelSU Modules App user-to-server OAuth (GitHub App user authorization; no scopes).
import type { Env } from '../env.ts';

export interface TokenSet {
  at: string;
  /** epoch ms; null when the App has token expiration disabled */
  atExp: number | null;
  rt?: string;
  rtExp?: number | null;
}

export const callbackUrl = (env: Env) => `${env.PORTAL_URL.replace(/\/$/, '')}/auth/callback`;

export function authorizeUrl(env: Env, state: string): string {
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', env.MODULES_APP_CLIENT_ID);
  u.searchParams.set('redirect_uri', callbackUrl(env));
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'true');
  return u.toString();
}

export class OAuthError extends Error {}

async function tokenRequest(env: Env, f: typeof fetch, params: Record<string, string>, now: number): Promise<TokenSet> {
  const res = await f('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'KernelSU-Modules' },
    body: JSON.stringify({ client_id: env.MODULES_APP_CLIENT_ID, client_secret: env.MODULES_APP_CLIENT_SECRET, ...params }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) throw new OAuthError(data.error_description ?? data.error ?? `token endpoint returned ${res.status}`);
  return {
    at: data.access_token,
    atExp: data.expires_in ? now + data.expires_in * 1000 : null,
    ...(data.refresh_token ? { rt: data.refresh_token, rtExp: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : null } : {}),
  };
}

export function exchangeCode(env: Env, f: typeof fetch, code: string, now: number): Promise<TokenSet> {
  return tokenRequest(env, f, { code, redirect_uri: callbackUrl(env) }, now);
}

export function refreshTokens(env: Env, f: typeof fetch, refreshToken: string, now: number): Promise<TokenSet> {
  return tokenRequest(env, f, { grant_type: 'refresh_token', refresh_token: refreshToken }, now);
}

/**
 * Revoke a user access token (logout): DELETE /applications/{client_id}/token with Basic client_id:client_secret.
 * Best effort; returns whether GitHub confirmed (204) or the token was already invalid (404/422).
 */
export async function revokeToken(env: Env, f: typeof fetch, accessToken: string): Promise<boolean> {
  const res = await f(`https://api.github.com/applications/${encodeURIComponent(env.MODULES_APP_CLIENT_ID)}/token`, {
    method: 'DELETE',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Basic ${btoa(`${env.MODULES_APP_CLIENT_ID}:${env.MODULES_APP_CLIENT_SECRET}`)}`,
      'content-type': 'application/json',
      'user-agent': 'KernelSU-Modules',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  return res.status === 204 || res.status === 404 || res.status === 422;
}
