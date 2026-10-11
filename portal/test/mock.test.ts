import { describe, expect, it } from 'vitest';
import { createState, CSRF, handle, idAvailability } from '../src/mock/server.ts';

const call = async (s: ReturnType<typeof createState>, method: string, path: string, body?: unknown, csrf = true) => {
  const headers = new Headers(csrf ? { 'X-CSRF-Token': CSRF } : {});
  const res = await handle(s, method, new URL(path, 'http://localhost'), headers, body);
  return { status: res.status, headers: res.headers, body: res.status === 204 ? null : await res.json() };
};

describe('mock API (keeps fixtures honest with the contract)', () => {
  it('requires CSRF on mutating requests and a session for APIs', async () => {
    const s = createState('developer');
    expect((await call(s, 'POST', '/api/precheck', { repositoryId: 100002 }, false)).status).toBe(403);
    const out = createState('signed-out');
    expect((await call(out, 'GET', '/api/me')).body.user).toBeNull();
    expect((await call(out, 'GET', '/api/repos')).status).toBe(401);
    expect((await call(s, 'GET', '/api/admin/queue')).status).toBe(403);
  });
  it('fixtures cover every record status', async () => {
    const s = createState('developer');
    const mods = (await call(s, 'GET', '/api/modules')).body as { status: string }[];
    expect(new Set(mods.map((m) => m.status))).toEqual(new Set(['pending', 'listed', 'rejected', 'suspended', 'archived']));
  });
  it('submit -> pending -> approve -> listed', async () => {
    const s = createState('maintainer');
    expect(idAvailability(s, 'zygisk_assistant').available).toBe(true);
    const r = await call(s, 'POST', '/api/submissions', { repositoryId: 100002, id: 'zygisk_assistant' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending');
    expect(r.body.submissionId).toMatch(/^[a-z0-9]{10}$/);
    expect(idAvailability(s, 'zygisk_assistant').status).toBe('pending');
    expect((await call(s, 'POST', `/api/admin/requests/${r.body.submissionId}/approve`, {})).status).toBe(200);
    expect((await call(s, 'GET', '/api/modules/zygisk_assistant')).body.status).toBe('listed');
    expect((await call(s, 'POST', `/api/admin/requests/${r.body.submissionId}/approve`, {})).status).toBe(409);
  });
  it('maintainers: enriched list, add by login, bind / clear Telegram id, remove with guards', async () => {
    const s = createState('maintainer');
    const list = async () => (await call(s, 'GET', '/api/admin/maintainers')).body.maintainers as { githubId: number; login: string; telegramId: number | null }[];
    expect((await list())[0]).toEqual({ githubId: 2001, login: 'kernelsu-maintainer', name: 'KernelSU Maintainer', avatarUrl: '', telegramId: 555000111 });
    expect((await call(s, 'POST', '/api/admin/maintainers', { login: 'nobody' })).status).toBe(404);
    expect((await call(s, 'POST', '/api/admin/maintainers', { login: 'github' })).body.error.code).toBe('not-a-user');
    expect((await call(s, 'POST', '/api/admin/maintainers', { login: 'spammer' })).body.error.code).toBe('banned');
    expect((await call(s, 'POST', '/api/admin/maintainers', { login: 'second-maintainer' })).status).toBe(409);
    const added = await call(s, 'POST', '/api/admin/maintainers', { login: '@Octocat' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ githubId: 583231, login: 'octocat', telegramId: null });
    expect((await call(s, 'PATCH', '/api/admin/maintainers/583231', { telegramId: 555000111 })).body.error.code).toBe('telegram-taken');
    expect((await call(s, 'PATCH', '/api/admin/maintainers/583231', { telegramId: '42' })).status).toBe(400);
    expect((await call(s, 'PATCH', '/api/admin/maintainers/583231', { telegramId: 42 })).body.telegramId).toBe(42);
    expect((await call(s, 'PATCH', '/api/admin/maintainers/583231', { telegramId: null })).body.telegramId).toBeNull();
    expect((await call(s, 'DELETE', '/api/admin/maintainers/2001')).body.error.code).toBe('cannot-remove-self');
    expect((await call(s, 'DELETE', '/api/admin/maintainers/583231')).body).toEqual({ removed: 583231 });
    expect((await call(s, 'DELETE', '/api/admin/maintainers/2002')).status).toBe(200);
    expect((await list()).map((x) => x.githubId)).toEqual([2001]);
  });
  it('sync is rate limited with Retry-After', async () => {
    const s = createState('developer');
    expect((await call(s, 'POST', '/api/modules/demo.toolbox/sync', {})).status).toBe(202);
    const again = await call(s, 'POST', '/api/modules/demo.toolbox/sync', {});
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(again.body.error.code).toBe('rate-limited');
  });
  it('contract shapes: repos, preview markdown, status.json entries', async () => {
    const s = createState('maintainer');
    const repos = (await call(s, 'GET', '/api/repos')).body;
    expect(repos).toMatchObject({ truncated: false });
    expect(repos.repos.length).toBeGreaterThan(0);
    const pv = (await call(s, 'POST', '/api/preview', { repositoryId: 100001 })).body;
    expect(Object.keys(pv).sort()).toEqual(['ctx', 'markdown']);
    expect(pv.ctx).toMatchObject({ fullName: 'alice/toolbox', docPath: 'docs/README.md' });
    expect(pv.ctx.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof pv.markdown).toBe('string');
    const st = (await call(s, 'GET', '/api/admin/status')).body;
    expect(st.modules[0]).toHaveProperty('maxVersionCode');
    expect(st.modules[0].health).toMatch(/^(ok|stale|error)$/);
    expect(st).toHaveProperty('lastSuccessfulRun');
    const q = (await call(s, 'GET', '/api/admin/queue')).body as { id: string; check?: { submissionId: string } | null; request: { submissionId: string } }[];
    for (const it of q) if (it.check) expect(it.check.submissionId).toBe(it.request.submissionId);
    // open requests can be synced (re-check), records without one cannot
    expect((await call(s, 'POST', '/api/modules/pending.mod/sync', {})).status).toBe(202);
    expect((await call(s, 'POST', '/api/modules/spam.thing/sync', {})).status).toBe(409);
  });
  it('reject requires a reason for "other"', async () => {
    const s = createState('maintainer');
    expect((await call(s, 'POST', '/api/admin/requests/c00lm0dul3/reject', { reasonCode: 'other' })).status).toBe(400);
    expect((await call(s, 'POST', '/api/admin/requests/c00lm0dul3/reject', { reasonCode: 'spam' })).status).toBe(200);
  });
});
