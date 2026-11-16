// MCP endpoint (/mcp) and its OAuth 2.1 authorization server (/oauth/*, /.well-known/*): dynamic registration,
// Portal login + consent, PKCE, tokens bound to the Portal login; tools backed by the admin domain.
import { describe, expect, it } from 'vitest';
import { base64UrlEncode, cookieHeader, cookiesFrom, login, MAINTAINER, setup, type H } from './harness.ts';
import { SESSION_MAX_LIFETIME_MS } from '../src/lib/session.ts';
import { validRedirectUri } from '../src/lib/mcpauth.ts';
import { TOOLS } from '../src/routes/mcp.ts';
import type { FakeUser } from './fake.ts';

const REDIRECT = 'http://127.0.0.1:33418/callback';
const VERIFIER = 'v'.repeat(20) + '-._~' + 'x'.repeat(30);

async function challenge(v: string) {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));
}

async function world() {
  const h = await setup();
  const alice = h.world.addUser(1, 'alice', '2014-05-06T00:00:00Z');
  const second = h.world.addUser(9001, 'second');
  const demo = h.world.addRepo({ id: 501, full_name: 'alice/demo', owner: { id: 1, login: 'alice' } });
  h.world.install(10, { id: 1, login: 'alice' }, [501]);
  h.world.publishModule(demo, 'demo.toolbox');
  return { h, alice, second, maint: h.world.users.get(MAINTAINER.id)! };
}

async function register(h: H, body: unknown = { client_name: 'Test Client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) {
  const r = await h.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { r, body: (await r.json()) as any };
}

async function authorizeUrl(clientId: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await challenge(VERIFIER),
    code_challenge_method: 'S256',
    state: 'st-1',
    scope: 'admin',
    resource: 'https://developers.kernelsu.org/mcp',
    ...extra,
  });
  return `/oauth/authorize?${q}`;
}

/** Hidden inputs of the consent form. */
function formOf(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([a-z_]+)" value="([^"]*)">/g)) out[m[1]!] = m[2]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return out;
}

const post = (h: H, path: string, form: Record<string, string>, jar?: Map<string, string>) =>
  h.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(jar ? { cookie: cookieHeader(jar) } : {}) },
    body: new URLSearchParams(form).toString(),
  });

/** Signed-in maintainer approves the consent page; returns the redirect to the client. */
async function consent(h: H, user: FakeUser, clientId: string, decision = 'allow') {
  const c = await login(h, user);
  const page = await h.request(await authorizeUrl(clientId), { headers: { cookie: cookieHeader(c.jar) } });
  if (page.status !== 200) return { page, jar: c.jar, location: page.headers.get('location') };
  const html = await page.text();
  const r = await post(h, '/oauth/authorize', { ...formOf(html), decision }, c.jar);
  return { page, html, jar: c.jar, r, location: r.headers.get('location') };
}

async function connect(h: H, user: FakeUser) {
  const { body: client } = await register(h);
  const { location } = await consent(h, user, client.client_id);
  const code = new URL(location!).searchParams.get('code')!;
  const r = await post(h, '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: VERIFIER });
  expect(r.status).toBe(200);
  return { clientId: client.client_id as string, code, tokens: (await r.json()) as any };
}

function rpc(h: H, token: string | null, msg: unknown, headers: Record<string, string> = {}) {
  return h.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(msg),
  });
}

let seq = 0;
async function call(h: H, token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(h, token, { jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } });
  expect(r.status).toBe(200);
  const res = ((await r.json()) as any).result;
  return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
}

describe('MCP OAuth', () => {
  it('discovery: 401 points at the protected-resource metadata, which points at the authorization server', async () => {
    const { h } = await world();
    const r = await rpc(h, null, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://developers.kernelsu.org/.well-known/oauth-protected-resource/mcp", scope="admin"',
    );
    for (const p of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const m = await h.request(p);
      expect(m.headers.get('access-control-allow-origin')).toBe('*');
      expect(await m.json()).toMatchObject({ resource: 'https://developers.kernelsu.org/mcp', authorization_servers: ['https://developers.kernelsu.org'] });
    }
    const as = (await (await h.request('/.well-known/oauth-authorization-server')).json()) as any;
    expect(as).toMatchObject({
      issuer: 'https://developers.kernelsu.org',
      authorization_endpoint: 'https://developers.kernelsu.org/oauth/authorize',
      token_endpoint: 'https://developers.kernelsu.org/oauth/token',
      registration_endpoint: 'https://developers.kernelsu.org/oauth/register',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    expect((await h.request('/.well-known/openid-configuration')).status).toBe(404);
    expect((await h.request('/oauth/token', { method: 'OPTIONS' })).status).toBe(204);
  });

  it('registration accepts loopback http, https and private-use schemes only', async () => {
    const { h } = await world();
    const ok = await register(h);
    expect(ok.r.status).toBe(201);
    expect(ok.body).toMatchObject({ client_name: 'Test Client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    expect(ok.body.client_id).toMatch(/^kmc_/);
    expect((await register(h, { redirect_uris: ['http://evil.example/cb'] })).body.error).toBe('invalid_redirect_uri');
    expect((await register(h, { redirect_uris: [] })).r.status).toBe(400);
    expect((await register(h, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' })).body.error).toBe('invalid_client_metadata');
    expect(validRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(validRedirectUri('http://localhost:1234/cb')).toBe(true);
    expect(validRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://a.example/cb#frag', 'http://10.0.0.1/cb', 'https://u:p@a.example/'])
      expect(validRedirectUri(bad), bad).toBe(false);
  });

  it('signed out: parks the request, goes through the Portal GitHub login, then shows the consent page', async () => {
    const { h, maint } = await world();
    const { body: client } = await register(h);
    const jar = new Map<string, string>();
    const r1 = await h.request(await authorizeUrl(client.client_id));
    expect(r1.status).toBe(302);
    expect(r1.headers.get('location')).toBe('/auth/login?next=%2Foauth%2Fauthorize%2Fcontinue');
    cookiesFrom(r1, jar);
    const r2 = await h.request(r1.headers.get('location')!, { headers: { cookie: cookieHeader(jar) } });
    cookiesFrom(r2, jar);
    const state = new URL(r2.headers.get('location')!).searchParams.get('state')!;
    h.world.oauthCodes.set('gh-code', maint.id);
    const r3 = await h.request(`/auth/callback?code=gh-code&state=${state}`, { headers: { cookie: cookieHeader(jar) } });
    expect(r3.headers.get('location')).toBe('/oauth/authorize/continue');
    cookiesFrom(r3, jar);
    const r4 = await h.request('/oauth/authorize/continue', { headers: { cookie: cookieHeader(jar), 'accept-language': 'zh-CN,zh;q=0.9' } });
    expect(r4.status).toBe(200);
    const html = await r4.text();
    expect(html).toContain('授权 MCP 客户端');
    expect(html).toContain('Test Client');
    expect(html).toContain('@maint');
    expect(r4.headers.get('content-security-policy')).toContain("form-action 'self' http://127.0.0.1:33418");
    expect(r4.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    // The parked request is consumed.
    cookiesFrom(r4, jar);
    expect((await h.request('/oauth/authorize/continue', { headers: { cookie: cookieHeader(jar) } })).status).toBe(400);
  });

  it('bad requests: unknown client / redirect mismatch are shown, the rest go back to the client', async () => {
    const { h, maint } = await world();
    const { body: client } = await register(h);
    expect((await h.request(await authorizeUrl('kmc_nope'))).status).toBe(400);
    expect((await h.request(await authorizeUrl(client.client_id, { redirect_uri: 'http://127.0.0.1:1/other' }))).status).toBe(400);
    const noPkce = await h.request(await authorizeUrl(client.client_id, { code_challenge_method: 'plain' }));
    const loc = new URL(noPkce.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('st-1');
    expect(new URL((await h.request(await authorizeUrl(client.client_id, { resource: 'https://evil.example/mcp' }))).headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
    // Deny
    const denied = await consent(h, maint, client.client_id, 'deny');
    expect(new URL(denied.location!).searchParams.get('error')).toBe('access_denied');
  });

  it('non-maintainers are refused; consent needs the session CSRF token', async () => {
    const { h, alice, maint } = await world();
    const { body: client } = await register(h);
    const a = await consent(h, alice, client.client_id);
    expect(a.page.status).toBe(302);
    expect(new URL(a.location!).searchParams.get('error')).toBe('access_denied');
    const m = await consent(h, maint, client.client_id);
    const forged = await post(h, '/oauth/authorize', { ...formOf(m.html!), csrf: 'nope', decision: 'allow' }, m.jar);
    expect(forged.status).toBe(400);
    expect(forged.headers.get('location')).toBeNull();
  });

  it('code exchange: PKCE, redirect_uri, client binding, single use; tokens work on /mcp and refresh', async () => {
    const { h, maint } = await world();
    const { body: client } = await register(h);
    const { body: other } = await register(h);
    const { location } = await consent(h, maint, client.client_id);
    const u = new URL(location!);
    expect(u.searchParams.get('state')).toBe('st-1');
    expect(u.searchParams.get('iss')).toBe('https://developers.kernelsu.org');
    const code = u.searchParams.get('code')!;
    const base = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: VERIFIER };
    expect(((await (await post(h, '/oauth/token', { ...base, code_verifier: 'w'.repeat(50) })).json()) as any).error).toBe('invalid_grant');
    expect(((await (await post(h, '/oauth/token', { ...base, client_id: other.client_id })).json()) as any).error).toBe('invalid_grant');
    expect(((await (await post(h, '/oauth/token', { ...base, redirect_uri: 'http://127.0.0.1:1/x' })).json()) as any).error).toBe('invalid_grant');
    expect((await post(h, '/oauth/token', { ...base, client_id: 'kmc_bad' })).status).toBe(401);
    const ok = await post(h, '/oauth/token', base);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const tokens = (await ok.json()) as any;
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'admin' });
    expect(tokens.access_token).toMatch(/^ksm_/);
    expect(tokens.refresh_token).toMatch(/^ksr_/);
    expect(((await (await post(h, '/oauth/token', base)).json()) as any).error).toBe('invalid_grant'); // reused

    expect((await rpc(h, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    // A refresh token or code is not an access token.
    expect((await rpc(h, tokens.refresh_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);

    h.world.now += 2 * 3600_000;
    expect((await rpc(h, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    const rf = await post(h, '/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    const fresh = (await rf.json()) as any;
    expect((await rpc(h, fresh.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    expect(((await (await post(h, '/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: other.client_id })).json()) as any).error).toBe('invalid_grant');
  });

  it('grants end with the Portal login they were approved from', async () => {
    const { h, maint } = await world();
    const loginAt = h.world.now;
    const { clientId, tokens } = await connect(h, maint);
    // Close to the end of the Portal login: access tokens are capped at the session expiry.
    h.world.now = loginAt + SESSION_MAX_LIFETIME_MS - 600_000;
    const late = (await (await post(h, '/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })).json()) as any;
    expect(late.expires_in).toBe(600);
    h.world.now = loginAt + SESSION_MAX_LIFETIME_MS + 1;
    expect((await rpc(h, late.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    const dead = await post(h, '/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(((await dead.json()) as any).error).toBe('invalid_grant');
  });
});

describe('MCP transport', () => {
  it('initialize, notifications, ping, unknown methods, bad JSON, origins, GET', async () => {
    const { h, maint } = await world();
    const t = (await connect(h, maint)).tokens.access_token;
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const r = await rpc(h, t, init);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const res = ((await r.json()) as any).result;
    expect(res).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'kernelsu-developer-portal' } });
    expect(res.instructions).toContain('https://developers.kernelsu.org/SKILL.md');
    const r2 = await rpc(h, t, { ...init, params: { ...init.params, protocolVersion: '1999-01-01' } });
    expect(((await r2.json()) as any).result.protocolVersion).toBe('2025-11-25');

    expect((await rpc(h, t, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect(await (await rpc(h, t, { jsonrpc: '2.0', id: 'p', method: 'ping' })).json()).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
    expect(((await (await rpc(h, t, { jsonrpc: '2.0', id: 2, method: 'resources/list' })).json()) as any).error.code).toBe(-32601);
    expect((await rpc(h, t, [{ jsonrpc: '2.0', id: 3, method: 'ping' }])).status).toBe(400);
    const bad = await h.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${t}` }, body: '{' });
    expect(((await bad.json()) as any).error.code).toBe(-32700);
    expect((await rpc(h, t, { jsonrpc: '2.0', id: 4, method: 'ping' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await rpc(h, t, { jsonrpc: '2.0', id: 5, method: 'ping' }, { origin: 'https://developers.kernelsu.org' })).status).toBe(200);
    expect((await rpc(h, t, { jsonrpc: '2.0', id: 6, method: 'ping' }, { 'mcp-protocol-version': '2000-01-01' })).status).toBe(400);
    expect((await h.request('/mcp', { headers: { authorization: `Bearer ${t}` } })).status).toBe(405);
    // Cookies alone never authenticate /mcp.
    const c = await login(h, maint);
    expect((await h.request('/mcp', { method: 'POST', headers: { cookie: cookieHeader(c.jar) }, body: JSON.stringify(init) })).status).toBe(401);
  });

  it('lists every tool with a JSON schema and annotations', async () => {
    const { h, maint } = await world();
    const t = (await connect(h, maint)).tokens.access_token;
    const r = (await (await rpc(h, t, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as any;
    expect(r.result.tools.map((x: any) => x.name)).toEqual(TOOLS.map((x) => x.name));
    for (const x of r.result.tools) {
      expect(x.inputSchema.type).toBe('object');
      expect(typeof x.annotations.readOnlyHint).toBe('boolean');
      expect(x.run).toBeUndefined();
    }
    expect(((await (await rpc(h, t, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } })).json()) as any).error.code).toBe(-32602);
  });
});

describe('MCP tools', () => {
  it('review flow: queue, request, changes, approve (commits via portal)', async () => {
    const { h, alice, maint } = await world();
    const a = await login(h, alice);
    const sub = (await (await a.post('/api/submissions', { repositoryId: 501, id: 'demo.toolbox' })).json()) as any;
    const t = (await connect(h, maint)).tokens.access_token;

    const q = await call(h, t, 'queue_list');
    expect(q.data).toHaveLength(1);
    expect(q.data[0]).toMatchObject({ id: 'demo.toolbox', request: { submissionId: sub.submissionId, kind: 'submit' } });
    expect((await call(h, t, 'request_get', { submissionId: sub.submissionId })).data).toMatchObject({ id: 'demo.toolbox', open: true });
    expect((await call(h, t, 'modules_list', { status: 'pending' })).data).toEqual([
      { id: 'demo.toolbox', status: 'pending', repository: 'alice/demo', request: { kind: 'submit', submissionId: sub.submissionId } },
    ]);
    expect((await call(h, t, 'module_get', { id: 'demo.toolbox' })).data).toMatchObject({ id: 'demo.toolbox', status: 'pending' });

    expect(await call(h, t, 'request_changes', { submissionId: sub.submissionId })).toMatchObject({ isError: true, data: { error: { code: 'bad-request' } } });
    expect((await call(h, t, 'request_reject', { submissionId: sub.submissionId, reasonCode: 'other' })).isError).toBe(true);

    expect((await call(h, t, 'request_approve', { submissionId: sub.submissionId })).isError).toBe(false);
    expect(h.world.record('demo.toolbox').status).toBe('listed');
    expect(h.world.record('demo.toolbox').review).toMatchObject({ decision: 'approved', decidedBy: MAINTAINER.id, decidedVia: 'portal' });
    expect(h.world.commitMessages()[0]).toContain(`github:${MAINTAINER.id} via portal`);
    expect((await call(h, t, 'request_approve', { submissionId: sub.submissionId })).isError).toBe(true);

    expect((await call(h, t, 'module_moderate', { id: 'demo.toolbox', action: 'suspend', reason: 'test' })).isError).toBe(false);
    expect(h.world.record('demo.toolbox').status).toBe('suspended');
    expect((await call(h, t, 'module_sync', { id: 'demo.toolbox' })).data).toMatchObject({ ok: true });
    expect(await call(h, t, 'module_sync', { id: 'demo.toolbox' })).toMatchObject({ isError: true, data: { error: { code: 'rate-limited' } } });
    expect((await call(h, t, 'module_get', { id: 'missing.mod' })).data.error.code).toBe('not-found');
  });

  it('maintainers and bans use the Bot for GitHub lookups; removed maintainers lose access and cannot refresh', async () => {
    const { h, second, maint } = await world();
    const t = (await connect(h, maint)).tokens.access_token;
    expect((await call(h, t, 'maintainer_add', { login: 'second' })).data).toMatchObject({ githubId: second.id, login: 'second' });
    expect((await call(h, t, 'maintainer_set_telegram', { githubId: second.id, telegramId: 42 })).data.telegramId).toBe(42);
    expect((await call(h, t, 'maintainers_list')).data.maintainers.map((m: any) => m.githubId)).toEqual([MAINTAINER.id, second.id]);

    const s2 = await connect(h, second);
    expect((await call(h, s2.tokens.access_token, 'banned_list')).data).toEqual({ banned: [] });
    expect((await call(h, t, 'maintainer_remove', { githubId: second.id })).data).toEqual({ removed: second.id });
    expect((await rpc(h, s2.tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(403);
    const rf = await post(h, '/oauth/token', { grant_type: 'refresh_token', refresh_token: s2.tokens.refresh_token, client_id: s2.clientId });
    expect(((await rf.json()) as any).error).toBe('invalid_grant');
    expect((await call(h, t, 'maintainer_remove', { githubId: MAINTAINER.id })).data.error.code).toBe('cannot-remove-self');

    expect((await call(h, t, 'user_ban', { githubId: 1, reason: 'spam' })).isError).toBe(false);
    expect((await call(h, t, 'banned_list')).data.banned).toMatchObject([{ githubId: 1, login: 'alice', reason: 'spam' }]);
    expect((await call(h, t, 'user_unban', { githubId: 1 })).isError).toBe(false);
    expect((await call(h, t, 'user_ban', { githubId: -1, reason: 'x' })).data.error.code).toBe('bad-request');
  });

  it('sync_status filters modules', async () => {
    const { h, maint } = await world();
    const t = (await connect(h, maint)).tokens.access_token;
    expect((await call(h, t, 'sync_status')).data).toMatchObject({ modules: [], runs: expect.any(Array) });
    expect((await call(h, t, 'sync_status', { ids: 'x' })).isError).toBe(true);
  });
});
