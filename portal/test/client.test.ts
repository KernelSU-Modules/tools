import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, parseRetryAfter } from '../src/api/client.ts';

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => handler(url, init ?? {}));
}
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('ApiClient', () => {
  it('stores csrf from /api/me and sends it only on mutating requests', async () => {
    const f = fakeFetch((url) =>
      url === '/api/me' ? ok({ user: { id: 1, login: 'a', avatarUrl: '' }, isMaintainer: false, csrf: 'tok', installUrl: 'x' }) : ok({ ok: true }),
    );
    const api = new ApiClient({ fetch: f });
    await api.me();
    await api.repos();
    await api.precheck(42);
    await api.unban(7);
    const [, getInit] = f.mock.calls[1]!;
    expect((getInit!.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();
    const [url, postInit] = f.mock.calls[2]!;
    expect(url).toBe('/api/precheck');
    expect(postInit!.method).toBe('POST');
    expect((postInit!.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok');
    expect((postInit!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(postInit!.body as string)).toEqual({ repositoryId: 42 });
    expect(postInit!.credentials).toBe('same-origin');
    const [delUrl, delInit] = f.mock.calls[3]!;
    expect(delUrl).toBe('/api/admin/banned/7');
    expect(delInit!.method).toBe('DELETE');
    expect((delInit!.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok');
  });

  it('builds contract URLs with encoding', async () => {
    const f = fakeFetch(() => ok({}));
    const api = new ApiClient({ fetch: f });
    await api.checkId('a/b');
    await api.syncModule('demo.toolbox');
    await api.moderate('x', 'unsuspend', 'fixed');
    await api.reject('abcdefghij', { reasonCode: 'other', reason: 'r' });
    await api.approve('abcdefghij');
    await api.transfer({ id: 'm', repositoryId: 3 });
    await api.submit({ id: 'm', repositoryId: 3 });
    await api.preview({ repositoryId: 3 });
    await api.maintainers();
    await api.addMaintainer('octocat');
    await api.setMaintainerTelegram(583231, 42);
    await api.setMaintainerTelegram(583231, null);
    await api.removeMaintainer(583231);
    expect(f.mock.calls.map(([u, i]) => `${i!.method} ${u}`)).toEqual([
      'GET /api/ids/a%2Fb',
      'POST /api/modules/demo.toolbox/sync',
      'POST /api/admin/modules/x/unsuspend',
      'POST /api/admin/requests/abcdefghij/reject',
      'POST /api/admin/requests/abcdefghij/approve',
      'POST /api/transfers',
      'POST /api/submissions',
      'POST /api/preview',
      'GET /api/admin/maintainers',
      'POST /api/admin/maintainers',
      'PATCH /api/admin/maintainers/583231',
      'PATCH /api/admin/maintainers/583231',
      'DELETE /api/admin/maintainers/583231',
    ]);
    expect(JSON.parse(f.mock.calls[2]![1]!.body as string)).toEqual({ reason: 'fixed' });
    expect(JSON.parse(f.mock.calls[9]![1]!.body as string)).toEqual({ login: 'octocat' });
    expect(JSON.parse(f.mock.calls[10]![1]!.body as string)).toEqual({ telegramId: 42 });
    expect(JSON.parse(f.mock.calls[11]![1]!.body as string)).toEqual({ telegramId: null });
  });

  it('maps {error:{code,message}} into ApiError with Retry-After', async () => {
    const api = new ApiClient({ fetch: fakeFetch(() => ok({ error: { code: 'rate-limited', message: 'slow down' } }, 429, { 'Retry-After': '120' })) });
    const e = await api.syncModule('x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 429, code: 'rate-limited', message: 'slow down', retryAfter: 120 });
    expect((e as ApiError).isRateLimited).toBe(true);
  });

  it('handles non-JSON error bodies and network failures', async () => {
    const api = new ApiClient({ fetch: fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' })) });
    await expect(api.repos()).rejects.toMatchObject({ status: 502, code: 'http_502', message: 'Bad Gateway' });
    const api2 = new ApiClient({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(api2.repos()).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('401 is flagged as unauthorized', async () => {
    const api = new ApiClient({ fetch: fakeFetch(() => ok({ error: { code: 'unauthorized', message: 'no session' } }, 401)) });
    const e = (await api.modules().catch((x: unknown) => x)) as ApiError;
    expect(e.isUnauthorized).toBe(true);
  });

  it('accepts empty 2xx bodies', async () => {
    const api = new ApiClient({ fetch: fakeFetch(() => new Response(null, { status: 204 })) });
    await expect(api.approve('abcdefghij')).resolves.toBeNull();
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('garbage')).toBeNull();
    const now = Date.parse('2026-10-10T00:00:00Z');
    expect(parseRetryAfter('Sat, 10 Oct 2026 00:01:00 GMT', now)).toBe(60);
    expect(parseRetryAfter('Sat, 10 Oct 2026 00:00:00 GMT', now + 5000)).toBe(0);
  });

  it('logout sends the CSRF token', async () => {
    const f = fakeFetch((url) => (url === '/api/me' ? ok({ user: { id: 1, login: 'a', avatarUrl: '' }, isMaintainer: false, csrf: 'tok', installUrl: 'x' }) : ok({ ok: true })));
    const api = new ApiClient({ fetch: f });
    await api.me();
    await api.logout();
    const [url, init] = f.mock.calls[1]!;
    expect(url).toBe('/auth/logout');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok');
  });

  it('repos returns {repos, truncated}', async () => {
    const f = fakeFetch(() => ok({ repos: [], truncated: true }));
    const api = new ApiClient({ fetch: f });
    expect(await api.repos()).toEqual({ repos: [], truncated: true });
  });

  it('retries once after X-KernelSU-Session: retry (concurrent token refresh)', async () => {
    let n = 0;
    const f = fakeFetch(() => {
      n++;
      if (n === 1) return ok({ error: { code: 'unauthorized', message: 'Sign in first.' } }, 401, { 'X-KernelSU-Session': 'retry' });
      return ok({ user: { id: 1, login: 'a', avatarUrl: '' }, isMaintainer: false, csrf: 'tok2', installUrl: 'x' });
    });
    const api = new ApiClient({ fetch: f, sessionRetryDelayMs: 1 });
    const me = await api.me();
    expect(me.user?.login).toBe('a');
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[1]![0]).toBe('/api/me');
  });

  it('retries /api/me with user:null + retry header, but only once', async () => {
    const f = fakeFetch(() => ok({ user: null, isMaintainer: false, csrf: '', installUrl: 'x' }, 200, { 'X-KernelSU-Session': 'retry' }));
    const api = new ApiClient({ fetch: f, sessionRetryDelayMs: 1 });
    const me = await api.me();
    expect(me.user).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
    const f401 = fakeFetch(() => ok({ error: { code: 'unauthorized', message: 'x' } }, 401, { 'X-KernelSU-Session': 'retry' }));
    const api2 = new ApiClient({ fetch: f401, sessionRetryDelayMs: 1 });
    await expect(api2.modules()).rejects.toMatchObject({ status: 401 });
    expect(f401).toHaveBeenCalledTimes(2);
    // without the header: no retry
    const plain = fakeFetch(() => ok({ error: { code: 'unauthorized', message: 'x' } }, 401));
    await expect(new ApiClient({ fetch: plain, sessionRetryDelayMs: 1 }).modules()).rejects.toMatchObject({ status: 401 });
    expect(plain).toHaveBeenCalledTimes(1);
  });
});
