import { describe, expect, it } from 'vitest';
import { safeNext } from '../src/routes/auth.ts';
import { cookieHeader, cookiesFrom, login, setup } from './harness.ts';

describe('auth', () => {
  it('normal login validates the state cookie and sets a sealed session', async () => {
    const h = await setup();
    const alice = h.world.addUser(1, 'alice');
    const c = await login(h, alice);
    expect(c.jar.get('__Host-kernelsu-session')).toBeTruthy();
    expect(c.jar.get('__Host-kernelsu-session')).not.toContain('ghu_'); // encrypted, token not visible
    const me = (await (await c.get('/api/me')).json()) as any;
    expect(me.user).toMatchObject({ id: 1, login: 'alice' });
    expect(me.isMaintainer).toBe(false);
    expect(me.csrf).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(me.installUrl).toBe('https://github.com/apps/kernelsu-modules/installations/new');
  });

  it('login redirect carries next and returns there', async () => {
    const h = await setup();
    const r1 = await h.request('/auth/login?next=/admin/requests/abc');
    expect(r1.status).toBe(302);
    const loc = new URL(r1.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('Iv1.client');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://developers.kernelsu.org/auth/callback');
    const jar = cookiesFrom(r1);
    h.world.addUser(1, 'alice');
    h.world.oauthCodes.set('c1', 1);
    const r2 = await h.request(`/auth/callback?code=c1&state=${loc.searchParams.get('state')}`, { headers: { cookie: cookieHeader(jar) } });
    expect(r2.status).toBe(302);
    expect(r2.headers.get('location')).toBe('/admin/requests/abc');
  });

  it('rejects a state mismatch or a missing state cookie', async () => {
    const h = await setup();
    h.world.addUser(1, 'alice');
    h.world.oauthCodes.set('c1', 1);
    const r1 = await h.request('/auth/login');
    const jar = cookiesFrom(r1);
    expect((await h.request('/auth/callback?code=c1&state=forged', { headers: { cookie: cookieHeader(jar) } })).status).toBe(400);
    expect((await h.request('/auth/callback?code=c1&state=whatever')).status).toBe(400);
    expect(h.world.oauthCodes.has('c1')).toBe(true); // code never exchanged
  });

  it('rejects stateless callbacks that are not the post-install shape', async () => {
    const h = await setup();
    h.world.addUser(1, 'alice');
    h.world.oauthCodes.set('c1', 1);
    const r = await h.request('/auth/callback?code=c1');
    expect(r.status).toBe(400);
    expect(h.world.oauthCodes.has('c1')).toBe(true);
  });

  it('post-install callback (code + installation_id + setup_action, no state) logs in', async () => {
    const h = await setup();
    h.world.addUser(1, 'alice');
    h.world.oauthCodes.set('c1', 1);
    const r = await h.request('/auth/callback?code=c1&installation_id=42&setup_action=install');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/?setup_action=install&installation_id=42');
    const jar = cookiesFrom(r);
    const me = (await (await h.request('/api/me', { headers: { cookie: cookieHeader(jar) } })).json()) as any;
    expect(me.user.login).toBe('alice');
  });

  it('post-install callback keeps an existing session and does not exchange the code', async () => {
    const h = await setup();
    const alice = h.world.addUser(1, 'alice');
    h.world.addUser(2, 'mallory');
    const c = await login(h, alice);
    h.world.oauthCodes.set('evil', 2);
    const r = await h.request('/auth/callback?code=evil&installation_id=42&setup_action=install', { headers: { cookie: cookieHeader(c.jar) } });
    expect(r.status).toBe(302);
    expect(r.headers.getSetCookie().some((x) => x.startsWith('__Host-kernelsu-session='))).toBe(false);
    expect(h.world.oauthCodes.has('evil')).toBe(true);
    const me = (await (await c.get('/api/me')).json()) as any;
    expect(me.user.login).toBe('alice');
  });

  it('refreshes an expired access token using the refresh token', async () => {
    const h = await setup();
    const alice = h.world.addUser(1, 'alice');
    const c = await login(h, alice);
    h.world.now += 9 * 3600_000; // past the 8h access-token expiry
    const r = await c.get('/api/me');
    expect(r.headers.getSetCookie().some((x) => x.startsWith('__Host-kernelsu-session='))).toBe(true);
    expect(((await r.json()) as any).user.login).toBe('alice');
  });

  it('safeNext only allows same-origin relative paths', () => {
    expect(safeNext('/modules?x=1#y')).toBe('/modules?x=1#y');
    expect(safeNext('/admin/requests/abc')).toBe('/admin/requests/abc');
    expect(safeNext('/a/../b')).toBe('/b');
    expect(safeNext('/a//b')).toBe('/a//b');
    for (const bad of [
      '//evil.com/x',
      '/\\evil.com',
      '/\\/evil.com',
      'https://evil.com',
      '/.//evil.com',
      '/./\\evil.com',
      '/x/..//evil.com',
      '/%2F%2Fevil.com',
      '/%2f/evil.com',
      '/%5Cevil.com',
      '/%2e//evil.com',
      '/%252F%252Fevil.com',
      '/%25252F%25252Fevil.com',
      '/\t/evil.com',
      '/%09/evil.com',
      '/%0a/evil.com',
      'javascript:alert(1)',
      ' /x',
      '',
    ])
      expect(safeNext(bad), bad).toBe('/');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext('/' + 'a'.repeat(600))).toBe('/');
    // every accepted value resolves to the same origin when used as a Location
    for (const ok of ['/modules?x=1#y', '/a/../b', '/a//b', '/x?next=//evil.com']) {
      const out = safeNext(ok);
      expect(new URL(out, 'https://developers.kernelsu.org').origin).toBe('https://developers.kernelsu.org');
    }
  });

  it('the session has an absolute 30-day lifetime that refreshes do not extend', async () => {
    const h = await setup();
    const c = await login(h, h.world.addUser(1, 'alice'));
    for (let day = 1; day <= 29; day++) {
      h.world.now += 86400_000; // access token expired -> refreshed each time
      const r = await c.get('/api/me');
      expect(((await r.json()) as any).user?.login, `day ${day}`).toBe('alice');
      const set = r.headers.getSetCookie().find((x) => x.startsWith('__Host-kernelsu-session='));
      if (set) cookiesFrom(r, c.jar);
    }
    h.world.now += 2 * 86400_000;
    const r = await c.get('/api/me');
    expect(((await r.json()) as any).user).toBeNull();
    expect(r.headers.getSetCookie().some((x) => x.startsWith('__Host-kernelsu-session=') && /Max-Age=0/i.test(x))).toBe(true);
  });

  it('parallel requests with an expired access token share one refresh (single-use refresh tokens)', async () => {
    const h = await setup();
    const c = await login(h, h.world.addUser(1, 'alice'));
    h.world.now += 9 * 3600_000;
    const n = h.world.requests.length;
    const rs = await Promise.all([c.get('/api/me'), c.get('/api/me'), c.get('/api/me')]);
    for (const r of rs) expect(((await r.json()) as any).user?.login).toBe('alice');
    expect(h.world.requests.slice(n).filter((x) => x.includes('/login/oauth/access_token'))).toHaveLength(1);
  });

  it('a lost refresh race does not clear the cookie; a dead refresh token is cleared later', async () => {
    const h = await setup();
    const c = await login(h, h.world.addUser(1, 'alice'));
    h.world.now += 9 * 3600_000;
    // the refresh token was already used by a parallel request that ran in another colo (no shared cache)
    h.world.refreshFails = true;
    const r1 = await c.get('/api/me');
    expect(((await r1.json()) as any).user).toBeNull();
    expect(r1.headers.get('x-kernelsu-session')).toBe('retry');
    expect(r1.headers.getSetCookie().some((x) => x.startsWith('__Host-kernelsu-session='))).toBe(false);
    // still failing 30 s later: the refresh token is dead -> cookie cleared
    h.world.now += 31_000;
    const r2 = await c.get('/api/me');
    expect(r2.headers.get('x-kernelsu-session')).toBeNull();
    expect(r2.headers.getSetCookie().some((x) => x.startsWith('__Host-kernelsu-session=') && /Max-Age=0/i.test(x))).toBe(true);
  });

  it('logout requires the CSRF token and revokes the GitHub user token', async () => {
    const h = await setup();
    const c = await login(h, h.world.addUser(1, 'alice'));
    const noCsrf = await h.request('/auth/logout', { method: 'POST', headers: { cookie: cookieHeader(c.jar) } });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.headers.getSetCookie().some((x) => x.startsWith('__Host-kernelsu-session='))).toBe(false);
    expect(h.world.revoked).toEqual([]);
    const r = await c.post('/auth/logout');
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie().some((x) => x.startsWith('__Host-kernelsu-session=;') || /Max-Age=0/i.test(x))).toBe(true);
    expect(h.world.revoked).toEqual(['ghu_1']);
    // without a session it just clears
    expect((await h.request('/auth/logout', { method: 'POST' })).status).toBe(200);
  });

  it('sends HSTS on Functions responses', async () => {
    const h = await setup();
    expect((await h.request('/api/me')).headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  });
});

describe('CSRF', () => {
  it('requires a session and a valid X-CSRF-Token on mutating API calls', async () => {
    const h = await setup();
    const c = await login(h, h.world.addUser(1, 'alice'));
    const noSession = await h.request('/api/submissions', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(noSession.status).toBe(401);
    const noToken = await h.request('/api/submissions', {
      method: 'POST',
      body: '{}',
      headers: { cookie: cookieHeader(c.jar), 'content-type': 'application/json' },
    });
    expect(noToken.status).toBe(403);
    expect(((await noToken.json()) as any).error.code).toBe('csrf');
    const bad = await c.call('POST', '/api/submissions', {}, { 'x-csrf-token': c.csrf.slice(0, -2) + 'xx' });
    expect(bad.status).toBe(403);
    // another user's token does not work for this session
    const other = await login(h, h.world.addUser(2, 'bob'));
    expect((await c.call('POST', '/api/submissions', {}, { 'x-csrf-token': other.csrf })).status).toBe(403);
    // valid token passes CSRF and reaches validation
    const ok = await c.post('/api/submissions', {});
    expect(ok.status).toBe(400);
  });
});
