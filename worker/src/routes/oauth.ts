// OAuth 2.1 for the MCP endpoint (MCP authorization spec, 2025-06-18+): protected-resource and authorization-server
// metadata, dynamic client registration, an authorization endpoint that rides on the Portal's GitHub login plus an
// explicit consent page, and the token endpoint (authorization_code + PKCE S256, refresh_token). Public clients only.
// Tokens and codes are sealed (lib/mcpauth.ts); grants never outlive the Portal login they were approved from.
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sha256Hex } from '@kernelsu-modules/github';
import { seal, unseal } from '../lib/crypto.ts';
import {
  clientRef,
  MAX_REDIRECT_URIS,
  MCP_SCOPE,
  mintClient,
  mintCode,
  mintTokens,
  pkceOk,
  readClient,
  readCode,
  readRefresh,
  redirectSource,
  validRedirectUri,
  type McpClient,
  type McpGrant,
} from '../lib/mcpauth.ts';
import { csrfToken, loadSession, verifyCsrf, type SessionData } from '../lib/session.ts';
import { maintainerByGithub } from '../domain/ops.ts';
import type { AppEnv } from '../types.ts';

export const MCP_PATH = '/mcp';
export const PRM_PATH = '/.well-known/oauth-protected-resource';
export const ASM_PATH = '/.well-known/oauth-authorization-server';
/** Sealed pending authorization request while the user signs in to the Portal. */
export const AUTHZ_COOKIE = '__Host-kernelsu-mcp-authz';

export const portalOrigin = (c: Context<AppEnv>) => new URL(c.env.PORTAL_URL).origin;
export const resourceUrl = (c: Context<AppEnv>) => portalOrigin(c) + MCP_PATH;
export const resourceMetadataUrl = (c: Context<AppEnv>) => portalOrigin(c) + PRM_PATH + MCP_PATH;

export const oauth = new Hono<AppEnv>();

/* ------------------------------------------------------------ CORS for non-cookie endpoints -------------------- */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
  'access-control-max-age': '86400',
};
for (const p of ['/.well-known/*', '/oauth/register', '/oauth/token']) {
  oauth.options(p, (c) => c.body(null, 204, CORS));
  oauth.use(p, async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(CORS)) c.header(k, v);
    c.header('cache-control', c.req.path.startsWith('/.well-known/') ? 'public, max-age=3600' : 'no-store');
  });
}

/* ------------------------------------------------------------ metadata ------------------------------------------ */

const prm = (c: Context<AppEnv>) =>
  c.json({
    resource: resourceUrl(c),
    authorization_servers: [portalOrigin(c)],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'KernelSU Modules maintainer tools',
    resource_documentation: `${portalOrigin(c)}/SKILL.md`,
  });
// RFC 9728: clients try the path-suffixed URL first, then the root.
oauth.get(PRM_PATH + MCP_PATH, prm);
oauth.get(PRM_PATH, prm);

oauth.get(ASM_PATH, (c) => {
  const o = portalOrigin(c);
  return c.json({
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${o}/SKILL.md`,
  });
});

// Any other /.well-known path: JSON 404 (never the SPA's index.html).
oauth.all('/.well-known/*', (c) => c.json({ error: 'not_found' }, 404));

/* ------------------------------------------------------------ registration (RFC 7591) ------------------------- */

const oauthError = (c: Context<AppEnv>, error: string, description: string, status: 400 | 401 = 400) =>
  c.json({ error, error_description: description }, status);

async function formOrJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const ct = c.req.header('content-type') ?? '';
  try {
    if (ct.includes('application/json')) {
      const b = await c.req.json();
      return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
    }
    const f = await c.req.parseBody();
    return Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'string'));
  } catch {
    return {};
  }
}

oauth.post('/oauth/register', async (c) => {
  const b = await formOrJson(c);
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECT_URIS || !uris.every(validRedirectUri))
    return oauthError(c, 'invalid_redirect_uri', `redirect_uris: 1-${MAX_REDIRECT_URIS} URIs; https, http on localhost/127.0.0.1/[::1], or a private-use scheme; ≤256 characters, no fragment.`);
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none')
    return oauthError(c, 'invalid_client_metadata', 'Only public clients are supported (token_endpoint_auth_method "none").');
  const name = typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim().slice(0, 64) : 'MCP client';
  const now = c.var.svc.now();
  const client: McpClient = { v: 1, n: name, r: [...new Set(uris as string[])], iat: now };
  return c.json(
    {
      client_id: await mintClient(c.env.SESSION_KEY, client),
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: client.r,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: MCP_SCOPE,
    },
    201,
  );
});

/* ------------------------------------------------------------ authorization endpoint -------------------------- */

interface AuthzRequest {
  clientId: string;
  client: McpClient;
  redirectUri: string;
  challenge: string;
  state: string | null;
}
type Parsed = { ok: true; req: AuthzRequest } | { ok: false; fatal: string } | { ok: false; redirect: string; error: string; description: string; state: string | null };

/** Validates an authorization request. Problems before the redirect URI is trusted are `fatal` (shown, never redirected). */
async function parseAuthz(c: Context<AppEnv>, q: Record<string, string | undefined>): Promise<Parsed> {
  const clientId = q.client_id ?? '';
  const client = await readClient(c.env.SESSION_KEY, clientId);
  if (!client) return { ok: false, fatal: 'Unknown client_id. Register the client again (remove and re-add the MCP server).' };
  const redirectUri = q.redirect_uri ?? (client.r.length === 1 ? client.r[0]! : '');
  if (!client.r.includes(redirectUri)) return { ok: false, fatal: 'redirect_uri does not match the registered redirect URIs.' };
  const state = q.state ?? null;
  const fail = (error: string, description: string): Parsed => ({ ok: false, redirect: redirectUri, error, description, state });
  if (q.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be "code".');
  if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? '')) return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  if (q.resource && q.resource.replace(/\/$/, '') !== resourceUrl(c) && q.resource.replace(/\/$/, '') !== portalOrigin(c))
    return fail('invalid_target', `resource must be ${resourceUrl(c)}.`);
  if (q.scope && q.scope.split(' ').some((s) => s && s !== MCP_SCOPE)) return fail('invalid_scope', `The only scope is "${MCP_SCOPE}".`);
  return { ok: true, req: { clientId, client, redirectUri, challenge: q.code_challenge!, state } };
}

function redirectWith(c: Context<AppEnv>, uri: string, params: Record<string, string | null>) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set('iss', portalOrigin(c));
  c.header('cache-control', 'no-store');
  return c.redirect(u.toString(), 302);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const STRINGS = {
  en: {
    title: 'Authorize MCP client',
    ask: (client: string, login: string) => `<b>${client}</b> wants to use the KernelSU Modules maintainer tools as <b>@${login}</b>.`,
    can: 'It will be able to read the review queue and registry state, approve and reject requests, moderate modules, and manage maintainers and bans — every change is committed to the data repository in your name.',
    until: (d: string) => `Access ends with your current Portal login (${d}) or when you are no longer a maintainer.`,
    redirect: 'Redirects to',
    allow: 'Allow',
    deny: 'Deny',
    error: 'Authorization failed',
    back: 'Back to the Portal',
  },
  zh: {
    title: '授权 MCP 客户端',
    ask: (client: string, login: string) => `<b>${client}</b> 请求以 <b>@${login}</b> 的身份使用 KernelSU Modules 维护者工具。`,
    can: '它将能够查看审核队列和注册表状态、批准和拒绝请求、管理模块、增删维护者和封禁用户——所有改动都会以你的名义提交到数据仓库。',
    until: (d: string) => `授权随你当前的 Portal 登录一同失效（${d}），你不再是维护者时也会立即失效。`,
    redirect: '回调地址',
    allow: '允许',
    deny: '拒绝',
    error: '授权失败',
    back: '返回 Portal',
  },
};
const langOf = (c: Context<AppEnv>) => (/^zh\b/i.test(c.req.header('accept-language') ?? '') ? 'zh' : 'en');

const STYLE =
  'body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#1d2330}' +
  '.card{background:#fff;border:1px solid #e3e6ec;border-radius:12px;padding:24px 28px;max-width:480px;margin:16px}' +
  'h1{font-size:19px;margin:0 0 12px}p{margin:10px 0}.muted{color:#5d6576;font-size:13px}code{background:#eef0f4;padding:1px 6px;border-radius:6px;word-break:break-all}' +
  '.row{display:flex;gap:10px;margin-top:18px}button{font:inherit;padding:8px 18px;border-radius:8px;border:1px solid #c9ceda;background:#fff;cursor:pointer}' +
  'button.primary{background:#2f6fec;border-color:#2f6fec;color:#fff}' +
  '@media (prefers-color-scheme:dark){body{background:#14161b;color:#e6e8ee}.card{background:#1c1f26;border-color:#2c313c}.muted{color:#9aa2b2}code{background:#2a2f3a}button{background:#232733;color:#e6e8ee;border-color:#3a4050}}';

function htmlPage(c: Context<AppEnv>, title: string, body: string, status: 200 | 400 | 403 = 200, formTarget?: string) {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTarget ? ` ${formTarget}` : ''}; frame-ancestors 'none'; base-uri 'none'`;
  c.header('content-security-policy', csp);
  c.header('cache-control', 'no-store');
  c.header('x-frame-options', 'DENY');
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main class="card">${body}</main></body></html>`, status);
}

function fatalPage(c: Context<AppEnv>, msg: string) {
  const t = STRINGS[langOf(c)];
  return htmlPage(c, t.error, `<h1>${esc(t.error)}</h1><p>${esc(msg)}</p><p><a href="/">${esc(t.back)}</a></p>`, 400);
}

function consentPage(c: Context<AppEnv>, s: SessionData, req: AuthzRequest, csrf: string) {
  const t = STRINGS[langOf(c)];
  const hidden = (k: string, v: string | null) => (v === null ? '' : `<input type="hidden" name="${k}" value="${esc(v)}">`);
  const until = new Date(s.exp).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const body =
    `<h1>${esc(t.title)}</h1>` +
    `<p>${t.ask(esc(req.client.n), esc(s.login))}</p>` +
    `<p class="muted">${esc(t.can)}</p>` +
    `<p class="muted">${esc(t.until(until))}</p>` +
    `<p class="muted">${esc(t.redirect)}: <code>${esc(req.redirectUri)}</code></p>` +
    `<form method="post" action="/oauth/authorize">` +
    hidden('client_id', req.clientId) +
    hidden('redirect_uri', req.redirectUri) +
    hidden('code_challenge', req.challenge) +
    hidden('state', req.state) +
    hidden('csrf', csrf) +
    `<div class="row"><button class="primary" type="submit" name="decision" value="allow">${esc(t.allow)}</button>` +
    `<button type="submit" name="decision" value="deny">${esc(t.deny)}</button></div></form>`;
  return htmlPage(c, t.title, body, 200, redirectSource(req.redirectUri));
}

/** GET /oauth/authorize (and the resume after login): validate, require a Portal login of a maintainer, show consent. */
async function authorize(c: Context<AppEnv>, q: Record<string, string | undefined>) {
  const p = await parseAuthz(c, q);
  if (!p.ok) return 'fatal' in p ? fatalPage(c, p.fatal) : redirectWith(c, p.redirect, { error: p.error, error_description: p.description, state: p.state });
  const svc = c.var.svc;
  const s = await loadSession(c, c.env, svc.deps);
  if (!s) {
    // Not signed in: park the request (sealed, 10 min) and go through the Portal's GitHub login.
    const raw = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string')).toString();
    setCookie(c, AUTHZ_COOKIE, await seal(c.env.SESSION_KEY, { q: raw, exp: svc.now() + 600_000 }, AUTHZ_COOKIE), {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 600,
    });
    c.header('cache-control', 'no-store');
    return c.redirect(`/auth/login?next=${encodeURIComponent('/oauth/authorize/continue')}`, 302);
  }
  if (!maintainerByGithub(await svc.data.snapshot(), s.uid))
    return redirectWith(c, p.req.redirectUri, { error: 'access_denied', error_description: 'The MCP tools are for KernelSU Modules maintainers only.', state: p.req.state });
  return consentPage(c, s, p.req, await csrfToken(c.env, s));
}

oauth.get('/oauth/authorize', (c) => authorize(c, c.req.query()));

oauth.get('/oauth/authorize/continue', async (c) => {
  const raw = getCookie(c, AUTHZ_COOKIE);
  const parked = raw ? await unseal<{ q: string; exp: number }>(c.env.SESSION_KEY, raw, AUTHZ_COOKIE) : null;
  deleteCookie(c, AUTHZ_COOKIE, { path: '/', secure: true });
  if (!parked || parked.exp < c.var.svc.now()) return fatalPage(c, 'The authorization request expired. Start the connection from your MCP client again.');
  const q = Object.fromEntries(new URLSearchParams(parked.q));
  // Back from the login: only continue when it worked, never loop into another login.
  if (!(await loadSession(c, c.env, c.var.svc.deps))) return fatalPage(c, 'Sign-in to the Portal did not complete. Start the connection from your MCP client again.');
  return authorize(c, q);
});

/** Consent form: same checks again (session, maintainer, request), plus the session's CSRF token. */
oauth.post('/oauth/authorize', async (c) => {
  const svc = c.var.svc;
  const f = (await formOrJson(c)) as Record<string, string | undefined>;
  const s = await loadSession(c, c.env, svc.deps);
  if (!s || !(await verifyCsrf(c.env, s, f.csrf))) return fatalPage(c, 'Your Portal session changed or expired. Start the connection from your MCP client again.');
  const p = await parseAuthz(c, { ...f, response_type: 'code', code_challenge_method: 'S256' });
  if (!p.ok) return 'fatal' in p ? fatalPage(c, p.fatal) : redirectWith(c, p.redirect, { error: p.error, error_description: p.description, state: p.state });
  const { req } = p;
  if (f.decision !== 'allow') return redirectWith(c, req.redirectUri, { error: 'access_denied', error_description: 'The user denied the request.', state: req.state });
  if (!maintainerByGithub(await svc.data.snapshot(), s.uid))
    return redirectWith(c, req.redirectUri, { error: 'access_denied', error_description: 'The MCP tools are for KernelSU Modules maintainers only.', state: req.state });
  const grant: McpGrant = { uid: s.uid, login: s.login, sid: s.sid, sexp: s.exp, cid: await clientRef(req.clientId) };
  const code = await mintCode(c.env.SESSION_KEY, grant, req.redirectUri, req.challenge, svc.now());
  return redirectWith(c, req.redirectUri, { code, state: req.state });
});

/* ------------------------------------------------------------ token endpoint ---------------------------------- */

oauth.post('/oauth/token', async (c) => {
  const svc = c.var.svc;
  const key = c.env.SESSION_KEY;
  const now = svc.now();
  const b = await formOrJson(c);
  const clientId = typeof b.client_id === 'string' ? b.client_id : '';
  if (!(await readClient(key, clientId))) return oauthError(c, 'invalid_client', 'Unknown client_id.', 401);
  const cid = await clientRef(clientId);
  let grant: McpGrant;
  if (b.grant_type === 'authorization_code') {
    const code = await readCode(key, b.code, now);
    if (!code || code.cid !== cid) return oauthError(c, 'invalid_grant', 'Invalid or expired authorization code.');
    if (b.redirect_uri !== code.ru) return oauthError(c, 'invalid_grant', 'redirect_uri does not match the authorization request.');
    if (!(await pkceOk(b.code_verifier, code.cc))) return oauthError(c, 'invalid_grant', 'PKCE verification failed.');
    // Single use (best effort: the Cache API is per colo; codes also expire after CODE_TTL_S).
    const used = `mcpcode/${(await sha256Hex(b.code as string)).slice(0, 40)}`;
    if (await svc.deps.cache.get(used)) return oauthError(c, 'invalid_grant', 'Authorization code already used.');
    await svc.deps.cache.put(used, '1', 300);
    grant = code;
  } else if (b.grant_type === 'refresh_token') {
    const rt = await readRefresh(key, b.refresh_token, now);
    if (!rt || rt.cid !== cid) return oauthError(c, 'invalid_grant', 'Invalid refresh token, or the Portal login it was granted from has ended; authorize again.');
    grant = rt;
  } else {
    return oauthError(c, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token.');
  }
  if (!maintainerByGithub(await svc.data.snapshot(), grant.uid)) return oauthError(c, 'invalid_grant', 'Not a KernelSU Modules maintainer.');
  return c.json(await mintTokens(key, grant, now));
});
