// OAuth 2.1 authorization server of the MCP endpoint (MCP authorization spec), stateless like the session cookie:
// client ids, authorization codes, access and refresh tokens are AES-GCM sealed under SESSION_KEY, each kind with its
// own AAD so one can never be used as another (nor as a session cookie).
//
// Every grant is bound to the Portal login it was approved from: `sid` and the session's absolute expiry `sexp`
// (SESSION_MAX_LIFETIME_MS after the GitHub login). Access tokens live ACCESS_TTL_S but never past `sexp`; refresh
// tokens expire at `sexp`. After that the MCP client must send the user through the browser again (Portal login).
// The GitHub uid must still be a maintainer on every MCP request and every refresh.
import { sha256Hex } from '@kernelsu-modules/github';
import { seal, unseal } from './crypto.ts';

export const MCP_SCOPE = 'admin';
export const ACCESS_TTL_S = 3600;
export const CODE_TTL_S = 120;

const PREFIX = { client: 'kmc_', code: 'kmo_', access: 'ksm_', refresh: 'ksr_' } as const;
type Kind = keyof typeof PREFIX;
const aad = (k: Kind) => `mcp-${k}/v1`;
const MAX_LEN = 4096;

/** Dynamically registered public client (RFC 7591): the client_id is the sealed registration. */
export interface McpClient {
  v: 1;
  /** client_name */
  n: string;
  /** redirect_uris */
  r: string[];
  iat: number;
}

/** What an approval grants: who, from which Portal login, to which client. */
export interface McpGrant {
  uid: number;
  login: string;
  /** Portal session id and its absolute expiry (epoch ms) */
  sid: string;
  sexp: number;
  /** clientRef() of the client_id */
  cid: string;
}
export interface McpCode extends McpGrant {
  v: 1;
  /** redirect_uri, PKCE S256 challenge, expiry (epoch ms) */
  ru: string;
  cc: string;
  exp: number;
}
export interface McpAccess extends McpGrant {
  v: 1;
  exp: number;
}
export interface McpRefresh extends McpGrant {
  v: 1;
}

async function sealAs(key: string, kind: Kind, value: unknown): Promise<string> {
  return PREFIX[kind] + (await seal(key, value, aad(kind)));
}
async function unsealAs<T extends { v: number }>(key: string, kind: Kind, raw: unknown): Promise<T | null> {
  if (typeof raw !== 'string' || !raw.startsWith(PREFIX[kind]) || raw.length > MAX_LEN) return null;
  const t = await unseal<T>(key, raw.slice(PREFIX[kind].length), aad(kind));
  return t && t.v === 1 ? t : null;
}

/** Short stable reference of a client_id (codes and tokens carry this, not the whole id). */
export const clientRef = async (clientId: string) => (await sha256Hex(clientId)).slice(0, 32);

export const MAX_REDIRECT_URIS = 3;
const MAX_REDIRECT_LEN = 256;
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https anywhere, http only on loopback (native clients, RFC 8252), or a private-use scheme (`cursor:`); no fragments. */
export function validRedirectUri(s: unknown): s is string {
  if (typeof s !== 'string' || !s || s.length > MAX_REDIRECT_LEN) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !BLOCKED_SCHEMES.has(u.protocol);
}

/** CSP source that allows navigating to the redirect URI (form-action also covers redirects after a form POST). */
export function redirectSource(uri: string): string {
  const u = new URL(uri);
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : u.protocol;
}

export const mintClient = (key: string, c: McpClient) => sealAs(key, 'client', c);
export const readClient = (key: string, raw: unknown) => unsealAs<McpClient>(key, 'client', raw);

export const mintCode = (key: string, g: McpGrant, ru: string, cc: string, now: number) =>
  sealAs(key, 'code', { v: 1, ...g, ru, cc, exp: Math.min(now + CODE_TTL_S * 1000, g.sexp) } satisfies McpCode);
export async function readCode(key: string, raw: unknown, now: number): Promise<McpCode | null> {
  const c = await unsealAs<McpCode>(key, 'code', raw);
  return c && c.exp > now ? c : null;
}

/** Access + refresh token pair for a grant whose Portal login is still valid. */
export async function mintTokens(key: string, g: McpGrant, now: number) {
  const exp = Math.min(now + ACCESS_TTL_S * 1000, g.sexp);
  const grant: McpGrant = { uid: g.uid, login: g.login, sid: g.sid, sexp: g.sexp, cid: g.cid };
  return {
    access_token: await sealAs(key, 'access', { v: 1, ...grant, exp } satisfies McpAccess),
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.floor((exp - now) / 1000)),
    refresh_token: await sealAs(key, 'refresh', { v: 1, ...grant } satisfies McpRefresh),
    scope: MCP_SCOPE,
  };
}
export async function readAccess(key: string, raw: unknown, now: number): Promise<McpAccess | null> {
  const t = await unsealAs<McpAccess>(key, 'access', raw);
  return t && Number.isSafeInteger(t.uid) && t.exp > now && t.sexp > now ? t : null;
}
export async function readRefresh(key: string, raw: unknown, now: number): Promise<McpRefresh | null> {
  const t = await unsealAs<McpRefresh>(key, 'refresh', raw);
  return t && Number.isSafeInteger(t.uid) && t.sexp > now ? t : null;
}

/** PKCE S256: BASE64URL(SHA256(verifier)) === challenge. */
export async function pkceOk(verifier: unknown, challenge: string): Promise<boolean> {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let bin = '';
  for (const b of d) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64 === challenge;
}
