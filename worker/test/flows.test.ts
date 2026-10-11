import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { DEFAULT_POLICY } from '@kernelsu-modules/schema';
import { callback, login, MAINTAINER, setup, signedTelegram, type H } from './harness.ts';

async function world1(opts: { telegram?: boolean } = {}) {
  const h = await setup(opts);
  const alice = h.world.addUser(1, 'alice', '2014-05-06T00:00:00Z');
  const bob = h.world.addUser(2, 'bob');
  const maint = h.world.users.get(MAINTAINER.id)!;
  const demo = h.world.addRepo({ id: 501, full_name: 'alice/demo', owner: { id: 1, login: 'alice' }, members: [2] });
  const other = h.world.addRepo({ id: 502, full_name: 'alice/other', owner: { id: 1, login: 'alice' } });
  const bobs = h.world.addRepo({ id: 601, full_name: 'bob/thing', owner: { id: 2, login: 'bob' } });
  h.world.install(10, { id: 1, login: 'alice' }, [501, 502]);
  h.world.install(20, { id: 2, login: 'bob' }, [601]);
  h.world.publishModule(demo, 'demo.toolbox');
  h.world.publishModule(other, 'other.mod');
  h.world.publishModule(bobs, 'demo.toolbox');
  return { h, alice, bob, maint, demo, other, bobs };
}

/** Dispatches other than the automatic `submit` sync that follows every recorded request. */
const decisionDispatches = (h: H) => h.world.dispatches.filter((d) => d.inputs.reason !== 'submit');

async function submit(h: H, user: any, repositoryId: number, id: string) {
  const c = await login(h, user);
  const r = await c.post('/api/submissions', { repositoryId, id });
  return { c, r, body: (await r.json()) as any };
}

describe('submission', () => {
  it('creates a pending record, pushes Telegram first and stores the message ref', async () => {
    const { h, alice } = await world1();
    const before = h.world.ref;
    const { r, body } = await submit(h, alice, 501, 'demo.toolbox');
    expect(r.status).toBe(201);
    expect(body.status).toBe('pending');
    expect(body.submissionId).toMatch(/^[a-z0-9]{10}$/);
    expect(h.world.ref).not.toBe(before);
    const rec = h.world.record('demo.toolbox');
    expect(rec.status).toBe('pending');
    expect(rec.request).toMatchObject({
      submissionId: body.submissionId,
      kind: 'submit',
      submittedBy: 1,
      submittedByLogin: 'alice',
      source: { host: 'github', repositoryId: 501, ownerId: 1, fullName: 'alice/demo', manifestPath: 'module.yaml' },
      telegram: { chatId: -1001234, messageId: 101 },
    });
    const msg = h.world.telegram.find((t) => t.method === 'sendMessage')!;
    expect(msg.body.parse_mode).toBe('HTML');
    expect(msg.body.text).toContain('New module');
    expect(msg.body.text).toContain('demo.toolbox');
    expect(msg.body.text).toContain('2014-05-06');
    expect(msg.body.text).toContain('Latest release: v1.0.0 · demo.toolbox-100.zip');
    expect(msg.body.text).not.toContain('versionCode');
    expect(msg.body.text).toContain('all checks passed');
    // the Portal never downloads the ZIP; the recorded request triggers a module sync (full validation + Check Run)
    expect(h.world.requests.filter((x) => x.includes('/releases/download/'))).toHaveLength(0);
    expect(h.world.dispatches).toEqual([{ workflow: 'sync-build-deploy.yml', ref: 'main', inputs: { reason: 'submit', module: 'demo.toolbox' } }]);
    const kb = msg.body.reply_markup.inline_keyboard.flat();
    expect(kb.map((b: any) => b.callback_data).filter(Boolean)).toEqual(['ap', 'rs', 'rv', 'ri', 'rq'].map((a) => `v1:${a}:${body.submissionId}`));
    expect(kb.at(-1).url).toBe(`https://developers.kernelsu.org/admin/requests/${body.submissionId}`);
    const commit = h.world.commitMessages()[0]!;
    expect(commit).toContain('Action: submit');
    expect(commit).toContain('Module: demo.toolbox');
    expect(commit).toContain(`Submission: ${body.submissionId}`);
    expect(commit).toContain('Submitted-by: github:1');
  });

  it('a Telegram outage does not block the submission', async () => {
    const { h, alice } = await world1();
    h.world.failTelegram = true;
    const { r } = await submit(h, alice, 501, 'demo.toolbox');
    expect(r.status).toBe(201);
    expect(h.world.record('demo.toolbox').status).toBe('pending');
    expect(h.world.record('demo.toolbox').request.telegram).toBeUndefined();
  });

  it('works without Telegram configured', async () => {
    const { h, alice } = await world1({ telegram: false });
    const { r } = await submit(h, alice, 501, 'demo.toolbox');
    expect(r.status).toBe(201);
    expect(h.world.record('demo.toolbox').request.telegram).toBeUndefined();
  });

  it('enforces ID availability, repo binding, admin, ban and ID rules', async () => {
    const { h, alice, bob } = await world1();
    await submit(h, alice, 501, 'demo.toolbox');
    const c = await login(h, alice);
    expect((await c.post('/api/submissions', { repositoryId: 502, id: 'demo.toolbox' })).status).toBe(409); // id taken
    expect((await c.post('/api/submissions', { repositoryId: 502, id: 'Demo.Toolbox' })).status).toBe(400); // case-fold collision
    const bound = await c.post('/api/submissions', { repositoryId: 501, id: 'another.id' });
    expect(bound.status).toBe(409);
    expect(((await bound.json()) as any).error.code).toBe('repo-bound');
    const reserved = await c.post('/api/submissions', { repositoryId: 502, id: 'ksu' });
    expect(((await reserved.json()) as any).error.code).toBe('id-reserved');
    const mismatch = await c.post('/api/submissions', { repositoryId: 502, id: 'wrong.id' });
    expect(((await mismatch.json()) as any).error.code).toBe('manifest-id-mismatch');
    const b = await login(h, bob);
    const notAdmin = await b.post('/api/submissions', { repositoryId: 502, id: 'other.mod' });
    expect(((await notAdmin.json()) as any).error.code).toBe('not-admin'); // public repo is visible, but bob is not admin
    const member = await b.post('/api/submissions', { repositoryId: 501, id: 'x.y' });
    expect(((await member.json()) as any).error.code).toBe('not-admin');
    await h.world.writeData({ 'banned.yaml': YAML.stringify({ banned: [{ githubId: 2, reason: 'spam', by: 9000, at: '2026-01-01T00:00:00Z' }] }) });
    h.world.now += 61_000;
    const banned = await b.post('/api/submissions', { repositoryId: 601, id: 'bob.thing' });
    expect(((await banned.json()) as any).error.code).toBe('banned');
  });

  it('GET /api/ids and /api/repos reflect the data repo', async () => {
    const { h, alice } = await world1();
    const { c, body } = await submit(h, alice, 501, 'demo.toolbox');
    expect(await (await c.get('/api/ids/demo.toolbox')).json()).toMatchObject({ available: false, status: 'pending' });
    expect(await (await c.get('/api/ids/fresh.id')).json()).toMatchObject({ available: true });
    expect(await (await c.get('/api/ids/ksu')).json()).toMatchObject({ available: false });
    const list = (await (await c.get('/api/repos')).json()) as any;
    expect(list.truncated).toBe(false);
    const repos = list.repos as any[];
    expect(repos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repositoryId: 501, fullName: 'alice/demo', isAdmin: true, installationId: 10, registeredId: 'demo.toolbox' }),
        expect.objectContaining({ repositoryId: 502, registeredId: null }),
      ]),
    );
    const mods = (await (await c.get('/api/modules')).json()) as any[];
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({ id: 'demo.toolbox', status: 'pending', request: { submissionId: body.submissionId } });
  });
});

describe('decisions', () => {
  it('Telegram approve by a maintainer lists the module, edits the message and dispatches sync', async () => {
    const { h, alice } = await world1();
    const { body } = await submit(h, alice, 501, 'demo.toolbox');
    const r = await signedTelegram(h, callback(`v1:ap:${body.submissionId}`, MAINTAINER.tg));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ answer: { text: 'Approved demo.toolbox', show_alert: false } });
    const rec = h.world.record('demo.toolbox');
    expect(rec.status).toBe('listed');
    expect(rec.request).toBeUndefined();
    expect(rec.source.repositoryId).toBe(501);
    expect(rec.review).toMatchObject({ decision: 'approved', decidedBy: MAINTAINER.id, decidedVia: 'telegram', submissionId: body.submissionId });
    const edit = h.world.telegram.find((t) => t.method === 'editMessageText')!;
    expect(edit.body).toMatchObject({ chat_id: -1001234, message_id: 101 });
    expect(edit.body.reply_markup).toBeUndefined();
    expect(edit.body.text).toContain('APPROVED');
    expect(edit.body.text).toContain('@maint');
    expect(h.world.dispatches).toEqual([
      { workflow: 'sync-build-deploy.yml', ref: 'main', inputs: { reason: 'submit', module: 'demo.toolbox' } },
      { workflow: 'sync-build-deploy.yml', ref: 'main', inputs: { reason: 'approve', module: 'demo.toolbox' } },
    ]);
    expect(h.world.commitMessages()[0]).toContain(`Approved-by: github:${MAINTAINER.id} via telegram`);
  });

  it('non-maintainer Telegram clicks write nothing', async () => {
    const { h, alice } = await world1();
    const { body } = await submit(h, alice, 501, 'demo.toolbox');
    const ref = h.world.ref;
    const edits = h.world.telegram.length;
    const r = await signedTelegram(h, callback(`v1:ap:${body.submissionId}`, 777));
    expect(await r.json()).toEqual({ answer: { text: 'Not authorized', show_alert: true } });
    expect(h.world.ref).toBe(ref);
    expect(h.world.telegram.length).toBe(edits);
    expect(decisionDispatches(h)).toHaveLength(0);
  });

  it('rejects bad forwarder signatures and bad direct-webhook secrets', async () => {
    const { h, alice } = await world1();
    const { body } = await submit(h, alice, 501, 'demo.toolbox');
    const ref = h.world.ref;
    expect((await signedTelegram(h, callback(`v1:ap:${body.submissionId}`, MAINTAINER.tg), 'wrong')).status).toBe(401);
    const raw = JSON.stringify(callback(`v1:ap:${body.submissionId}`, MAINTAINER.tg));
    expect((await h.request('/internal/telegram', { method: 'POST', body: raw })).status).toBe(401);
    expect(
      (await h.request('/webhooks/telegram', { method: 'POST', body: raw, headers: { 'x-telegram-bot-api-secret-token': 'nope' } })).status,
    ).toBe(401);
    expect(h.world.ref).toBe(ref);
    // the direct webhook with the right secret works and answers the callback itself
    const ok = await h.request('/webhooks/telegram', { method: 'POST', body: raw, headers: { 'x-telegram-bot-api-secret-token': 'tg-direct-secret' } });
    expect(ok.status).toBe(200);
    expect(h.world.record('demo.toolbox').status).toBe('listed');
    expect(h.world.telegram.find((t) => t.method === 'answerCallbackQuery')!.body).toMatchObject({ callback_query_id: 'cq1', text: 'Approved demo.toolbox' });
  });

  it('concurrent approvals: exactly one wins, the other gets 409', async () => {
    const { h, alice } = await world1();
    const { body } = await submit(h, alice, 501, 'demo.toolbox');
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    h.world.patchBarrier = 2; // both decisions are built on the same base commit before either ref update lands
    const [a, b] = await Promise.all([
      m.post(`/api/admin/requests/${body.submissionId}/approve`),
      m.post(`/api/admin/requests/${body.submissionId}/reject`, { reasonCode: 'spam' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(h.world.patchConflicts).toBe(1); // the loser hit non-fast-forward, re-read, and failed its precondition
    const rec = h.world.record('demo.toolbox');
    expect(['listed', 'rejected']).toContain(rec.status);
    const decisions = h.world.commitMessages().filter((x) => /Action: (approve|reject)/.test(x));
    expect(decisions).toHaveLength(1);
    // a Telegram click after the decision is answered as already handled
    const t = await signedTelegram(h, callback(`v1:ap:${body.submissionId}`, MAINTAINER.tg));
    expect(((await t.json()) as any).answer.show_alert).toBe(true);
  });

  it('portal reject -> rejected, Telegram edited, ID free again', async () => {
    const { h, alice, bob } = await world1();
    const { body } = await submit(h, alice, 501, 'demo.toolbox');
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    const r = await m.post(`/api/admin/requests/${body.submissionId}/reject`, { reasonCode: 'squatting', reason: 'name <b>grab</b>' });
    expect(r.status).toBe(200);
    const rec = h.world.record('demo.toolbox');
    expect(rec.status).toBe('rejected');
    expect(rec.review).toMatchObject({ decision: 'rejected', reasonCode: 'squatting', reason: 'name <b>grab</b>', decidedVia: 'portal' });
    const edit = h.world.telegram.find((t) => t.method === 'editMessageText')!;
    expect(edit.body.text).toContain('name &lt;b&gt;grab&lt;/b&gt;');
    expect(h.world.commitMessages()[0]).toContain(`Rejected-by: github:${MAINTAINER.id} via portal`);
    expect(decisionDispatches(h)).toHaveLength(0);
    // ID is free again (bob's repo also declares demo.toolbox)
    const again = await submit(h, bob, 601, 'demo.toolbox');
    expect(again.r.status).toBe(201);
  });

  it('admin API requires a maintainer', async () => {
    const { h, alice } = await world1();
    const c = await login(h, alice);
    expect((await c.get('/api/admin/queue')).status).toBe(403);
    expect((await h.request('/api/admin/queue')).status).toBe(401);
  });

  it('queue lists open requests', async () => {
    const { h, alice } = await world1();
    const { body } = await submit(h, alice, 501, 'demo.toolbox');
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    const q = (await (await m.get('/api/admin/queue')).json()) as any[];
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ id: 'demo.toolbox', status: 'pending', request: { submissionId: body.submissionId, kind: 'submit' } });
    expect(q[0].check).toBeUndefined();
  });

  it('status.json drives "my modules", the queue check and admin status (missing file = empty)', async () => {
    const { h, alice } = await world1();
    const { c, body } = await submit(h, alice, 501, 'demo.toolbox');
    // before the sync wrote status.json
    expect((((await (await c.get('/api/modules')).json()) as any[])[0]).sync).toBeUndefined();
    const check = (sid: string) => ({
      submissionId: sid,
      repositoryId: 501,
      ok: false,
      checkedAt: '2026-10-10T00:01:00Z',
      latestTag: 'v1.0.0',
      issues: [{ code: 'release-not-immutable', severity: 'error' }],
    });
    const entry = (sid: string) => ({
      repositoryId: 501,
      fullName: 'alice/demo',
      health: 'ok',
      installation: 'present',
      lastSuccessAt: '2026-10-10T00:01:00Z',
      message: null,
      contentCommit: null,
      stable: null,
      maxVersionCode: 7,
      request: check(sid),
    });
    await h.world.writeData({ 'status.json': JSON.stringify({ schemaVersion: 1, modules: { 'demo.toolbox': entry(body.submissionId) } }) });
    h.world.now += 61_000; // data head cache
    const mods = (await (await c.get('/api/modules')).json()) as any[];
    expect(mods[0].sync).toMatchObject({ health: 'ok', maxVersionCode: 7, request: check(body.submissionId) });
    expect(mods[0].lock).toBeUndefined();
    const one = (await (await c.get('/api/modules/demo.toolbox')).json()) as any;
    expect(one.sync.request.issues[0].code).toBe('release-not-immutable');
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    const q = (await (await m.get('/api/admin/queue')).json()) as any[];
    expect(q[0].check).toEqual(check(body.submissionId));
    h.world.workflowRuns = [
      { id: 2, status: 'completed', conclusion: 'failure', event: 'workflow_dispatch', created_at: '2026-10-10T00:30:00Z', updated_at: '2026-10-10T00:31:00Z', html_url: 'u2' },
      { id: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:02:00Z', html_url: 'u1' },
    ];
    const st = (await (await m.get('/api/admin/status')).json()) as any;
    expect(st.modules).toEqual([expect.objectContaining({ id: 'demo.toolbox', status: 'pending', health: 'ok', maxVersionCode: 7, request: check(body.submissionId) })]);
    expect(st.newestSuccessAt).toBe('2026-10-10T00:01:00Z');
    expect(st.lastSuccessfulRun).toMatchObject({ id: 1, conclusion: 'success', updatedAt: '2026-10-10T00:02:00Z' });
    expect(st.runs).toHaveLength(2);
    // a check that belongs to an older request is not shown
    await h.world.writeData({ 'status.json': JSON.stringify({ schemaVersion: 1, modules: { 'demo.toolbox': entry('zzzzzzzzzz') } }) });
    h.world.now += 61_000;
    expect((((await (await c.get('/api/modules')).json()) as any[])[0]).sync.request).toBeNull();
    expect(((await (await m.get('/api/admin/queue')).json()) as any[])[0].check).toBeUndefined();
  });

  it('every KernelSU Modules Bot token is scoped (contents on the data repo, actions on the tools repo)', async () => {
    const { h, alice } = await world1();
    const { body } = await submit(h, alice, 501, 'demo.toolbox');
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    await m.post(`/api/admin/requests/${body.submissionId}/approve`);
    await m.get('/api/admin/status');
    const bot = [...h.world.tokenScopes.values()].filter((s) => s.app === 'bot');
    expect(bot.length).toBeGreaterThanOrEqual(2);
    const kinds = new Set(bot.map((sc) => `${sc.repositories?.join(',')}:${JSON.stringify(sc.permissions)}`));
    expect(kinds).toEqual(new Set(['repo:{"contents":"write"}', 'tools:{"actions":"write"}']));
  });
});

describe('request replacement and transfers', () => {
  it('a new submit over an expired pending request edits the old Telegram message to "expired"', async () => {
    const { h, alice, bob } = await world1();
    const { body: old } = await submit(h, alice, 501, 'demo.toolbox');
    const oldMsg = h.world.telegram.find((t) => t.method === 'sendMessage')!;
    expect(oldMsg).toBeTruthy();
    h.world.now += 31 * 86400_000; // past policy.pending.expireDays, before the cron expired it
    const { r, body } = await submit(h, bob, 601, 'demo.toolbox');
    expect(r.status).toBe(201);
    expect(body.submissionId).not.toBe(old.submissionId);
    const edit = h.world.telegram.find((t) => t.method === 'editMessageText')!;
    expect(edit.body.text).toContain('EXPIRED');
    expect(edit.body.text).toContain(old.submissionId);
    expect(h.world.commitMessages()[0]).toContain(`Expired: ${old.submissionId}`);
  });

  async function listed(h: H, id: string, repoId: number, full: string, ownerId: number) {
    await h.world.writeData({
      [`modules/${id}.yaml`]: YAML.stringify({
        id,
        status: 'listed',
        source: { host: 'github', repositoryId: repoId, ownerId, fullName: full, manifestPath: 'module.yaml' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    });
  }

  it('transfer: admin of both repos is automatic', async () => {
    const { h, alice } = await world1();
    await listed(h, 'other.mod', 501, 'alice/demo', 1);
    const c = await login(h, alice);
    const r = await c.post('/api/transfers', { id: 'other.mod', repositoryId: 502 });
    expect(await r.json()).toMatchObject({ autoApproved: true });
    expect(h.world.record('other.mod').source).toMatchObject({ repositoryId: 502, fullName: 'alice/other' });
    expect(h.world.record('other.mod').review).toMatchObject({ kind: 'transfer', decidedVia: 'auto' });
    expect(h.world.dispatches.map((d) => d.inputs)).toEqual([{ reason: 'transfer', module: 'other.mod' }]);
  });

  it('transfer: admin of new repo only needs review; approve swaps the source', async () => {
    const { h, bob } = await world1();
    await listed(h, 'demo.toolbox', 501, 'alice/demo', 1);
    const c = await login(h, bob);
    const body = (await (await c.post('/api/transfers', { id: 'demo.toolbox', repositoryId: 601 })).json()) as any;
    expect(body.autoApproved).toBe(false);
    expect(h.world.record('demo.toolbox')).toMatchObject({ status: 'listed', source: { repositoryId: 501 }, request: { kind: 'transfer' } });
    expect(h.world.telegram[0]!.body.text).toContain('Previous repo');
    expect(h.world.dispatches.map((d) => d.inputs)).toEqual([{ reason: 'submit', module: 'demo.toolbox' }]);
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    expect((await m.post(`/api/admin/requests/${body.submissionId}/approve`)).status).toBe(200);
    expect(h.world.record('demo.toolbox')).toMatchObject({ status: 'listed', source: { repositoryId: 601, ownerId: 2 } });
  });
});

describe('moderation', () => {
  it('suspend / unsuspend / archive with preconditions', async () => {
    const { h, alice } = await world1();
    const { body } = await submit(h, alice, 501, 'demo.toolbox');
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    expect((await m.post('/api/admin/modules/demo.toolbox/suspend', { reason: 'x' })).status).toBe(409); // pending
    await m.post(`/api/admin/requests/${body.submissionId}/approve`);
    expect((await m.post('/api/admin/modules/demo.toolbox/suspend', { reason: 'malware' })).status).toBe(200);
    expect(h.world.record('demo.toolbox')).toMatchObject({ status: 'suspended', moderation: { action: 'suspend', by: MAINTAINER.id, via: 'portal', reason: 'malware' } });
    expect(h.world.commitMessages()[0]).toContain(`Actor: github:${MAINTAINER.id} via portal`);
    expect((await m.post('/api/admin/modules/demo.toolbox/suspend', { reason: 'again' })).status).toBe(409);
    expect((await m.post('/api/admin/modules/demo.toolbox/unsuspend', { reason: 'ok' })).status).toBe(200);
    expect(h.world.record('demo.toolbox').status).toBe('listed');
    expect((await m.post('/api/admin/modules/demo.toolbox/archive', { reason: 'abandoned' })).status).toBe(200);
    expect(h.world.record('demo.toolbox').status).toBe('archived');
    expect(h.world.dispatches.map((d) => d.inputs.reason)).toEqual(['submit', 'approve', 'suspend', 'unsuspend', 'archive']);
  });

  it('/suspend command from a maintainer in Telegram', async () => {
    const { h, alice } = await world1();
    const { body } = await submit(h, alice, 501, 'demo.toolbox');
    await signedTelegram(h, callback(`v1:ap:${body.submissionId}`, MAINTAINER.tg));
    const msg = (from: number, text: string) => ({ update_id: 2, message: { message_id: 9, from: { id: from }, chat: { id: -1001234 }, text } });
    const r1 = await signedTelegram(h, msg(777, '/suspend demo.toolbox bad'));
    expect(await r1.json()).toEqual({ answer: null });
    expect(h.world.record('demo.toolbox').status).toBe('listed');
    await signedTelegram(h, msg(MAINTAINER.tg, '/suspend@KsuBot demo.toolbox contains malware'));
    expect(h.world.record('demo.toolbox')).toMatchObject({ status: 'suspended', moderation: { via: 'telegram', reason: 'contains malware' } });
    const replies = h.world.telegram.filter((t) => t.method === 'sendMessage').map((t) => t.body.text);
    expect(replies.some((t) => t.includes('Not authorized'))).toBe(true);
    expect(replies.some((t) => t.includes('suspended by @maint'))).toBe(true);
  });

  it('banned list is edited through the Bot', async () => {
    const { h } = await world1();
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    expect((await m.post('/api/admin/banned', { githubId: 2, reason: 'spam' })).status).toBe(201);
    expect(YAML.parse(h.world.readData('banned.yaml')!).banned[0]).toMatchObject({ githubId: 2, login: 'bob', by: MAINTAINER.id });
    expect((await m.post('/api/admin/banned', { githubId: 2, reason: 'spam' })).status).toBe(409);
    expect((await m.call('DELETE', '/api/admin/banned/2')).status).toBe(200);
    expect(YAML.parse(h.world.readData('banned.yaml')!).banned).toEqual([]);
  });
});

describe('maintainers', () => {
  const doc = (h: H) => YAML.parse(h.world.readData('maintainers.yaml')!).maintainers;
  const err = async (r: Response) => [r.status, ((await r.json()) as any).error?.code];

  it('lists maintainers with GitHub profiles (cached per id) and falls back when GitHub fails', async () => {
    const { h } = await world1();
    h.world.users.get(MAINTAINER.id)!.name = 'Maint Ainer';
    await h.world.writeData({
      'maintainers.yaml': YAML.stringify({ maintainers: [{ github: { id: MAINTAINER.id, login: 'maint' }, telegram: { id: MAINTAINER.tg } }, { github: { id: 4242, login: 'gone' } }] }),
    });
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    const n = h.world.requests.length;
    const r = await m.get('/api/admin/maintainers');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      maintainers: [
        { githubId: MAINTAINER.id, login: 'maint', name: 'Maint Ainer', avatarUrl: `https://avatars.githubusercontent.com/u/${MAINTAINER.id}?v=4&s=64`, telegramId: MAINTAINER.tg },
        // unknown to GitHub (404): stored login + id-based avatar
        { githubId: 4242, login: 'gone', name: null, avatarUrl: 'https://avatars.githubusercontent.com/u/4242?s=64', telegramId: null },
      ],
    });
    expect(h.world.requests.slice(n).filter((x) => /\/user\/\d+$/.test(x)).sort()).toEqual([`GET api.github.com/user/4242`, `GET api.github.com/user/${MAINTAINER.id}`]);
    // second load: the found profile is cached, only the missing one is retried
    const n2 = h.world.requests.length;
    await m.get('/api/admin/maintainers');
    expect(h.world.requests.slice(n2).filter((x) => /\/user\/\d+$/.test(x))).toEqual(['GET api.github.com/user/4242']);
  });

  it('adds a maintainer by GitHub login: users only, no duplicates, no banned accounts; one Bot commit with trailers', async () => {
    const { h } = await world1();
    const carol = h.world.addUser(3, 'Carol', '2016-01-01T00:00:00Z');
    carol.name = 'Carol C';
    h.world.addUser(77, 'some-org').type = 'Organization';
    h.world.addUser(78, 'helper').type = 'Bot';
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    const before = h.world.commitMessages().length;
    expect(await err(await m.post('/api/admin/maintainers', { login: 'not a login' }))).toEqual([400, 'bad-login']);
    expect(await err(await m.post('/api/admin/maintainers', { login: 'nobody-here' }))).toEqual([404, 'user-not-found']);
    expect(await err(await m.post('/api/admin/maintainers', { login: 'some-org' }))).toEqual([400, 'not-a-user']);
    expect(await err(await m.post('/api/admin/maintainers', { login: 'helper' }))).toEqual([400, 'not-a-user']);
    expect(await err(await m.post('/api/admin/maintainers', { login: 'maint' }))).toEqual([409, 'already-maintainer']);
    expect(h.world.commitMessages().length).toBe(before);

    const r = await m.post('/api/admin/maintainers', { login: '@carol' });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ githubId: 3, login: 'Carol', name: 'Carol C', avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4&s=64', telegramId: null });
    expect(doc(h)).toEqual([{ github: { id: MAINTAINER.id, login: 'maint' }, telegram: { id: MAINTAINER.tg } }, { github: { id: 3, login: 'Carol' } }]);
    const text = h.world.readData('maintainers.yaml')!;
    expect(text).toMatch(/^# KernelSU Modules maintainers/);
    const msg = h.world.commitMessages()[0]!;
    expect(msg).toContain('Add maintainer @Carol');
    expect(msg).toContain('Action: maintainers');
    expect(msg).toContain('Target: github:3');
    expect(msg).toContain(`Actor: github:${MAINTAINER.id} via portal`);
    expect(await err(await m.post('/api/admin/maintainers', { login: 'carol' }))).toEqual([409, 'already-maintainer']);

    // banned (re-checked against banned.yaml at the base commit, even when the snapshot is stale)
    h.world.addUser(5, 'eve');
    await h.world.writeData({ 'banned.yaml': YAML.stringify({ banned: [{ githubId: 5, reason: 'spam', by: MAINTAINER.id, at: '2026-01-01T00:00:00Z' }] }) });
    expect(await err(await m.post('/api/admin/maintainers', { login: 'eve' }))).toEqual([409, 'banned']);
    expect(doc(h).map((x: any) => x.github.id)).toEqual([MAINTAINER.id, 3]);
  });

  it('binds / clears a numeric Telegram id: positive integers, unique across maintainers, preconditions at the base commit', async () => {
    const { h } = await world1();
    h.world.addUser(3, 'carol');
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    expect((await m.post('/api/admin/maintainers', { login: 'carol' })).status).toBe(201);
    for (const bad of [0, -1, 1.5, '123', 'abc', Number.MAX_SAFE_INTEGER + 2]) expect(await err(await m.call('PATCH', '/api/admin/maintainers/3', { telegramId: bad }))).toEqual([400, 'bad-telegram-id']);
    expect(await err(await m.call('PATCH', '/api/admin/maintainers/3', {}))).toEqual([400, 'bad-request']);
    expect(await err(await m.call('PATCH', '/api/admin/maintainers/3', { telegramId: MAINTAINER.tg }))).toEqual([409, 'telegram-taken']);
    expect(await err(await m.call('PATCH', '/api/admin/maintainers/999', { telegramId: 1 }))).toEqual([404, 'not-maintainer']);

    const r = await m.call('PATCH', '/api/admin/maintainers/3', { telegramId: 4242 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ githubId: 3, login: 'carol', telegramId: 4242 });
    expect(doc(h)[1]).toEqual({ github: { id: 3, login: 'carol' }, telegram: { id: 4242 } });
    expect(h.world.commitMessages()[0]).toContain('Bind Telegram to maintainer github:3');
    // same value again: nothing to commit
    const n = h.world.commitMessages().length;
    expect((await m.call('PATCH', '/api/admin/maintainers/3', { telegramId: 4242 })).status).toBe(200);
    expect(h.world.commitMessages().length).toBe(n);
    // the new binding authorizes Telegram actions at once
    const who = await signedTelegram(h, { update_id: 5, message: { message_id: 3, from: { id: 4242 }, chat: { id: -1001234 }, text: '/whoami' } });
    expect(who.status).toBe(200);
    expect(h.world.telegram.at(-1)!.body.text).toContain('Bound to maintainer @carol');

    // another writer bound 9999 to the first maintainer meanwhile: the check runs against the base commit
    await h.world.writeData({
      'maintainers.yaml': YAML.stringify({ maintainers: [{ github: { id: MAINTAINER.id, login: 'maint' }, telegram: { id: 9999 } }, { github: { id: 3, login: 'carol' }, telegram: { id: 4242 } }] }),
    });
    expect(await err(await m.call('PATCH', '/api/admin/maintainers/3', { telegramId: 9999 }))).toEqual([409, 'telegram-taken']);

    expect((await m.call('PATCH', '/api/admin/maintainers/3', { telegramId: null })).status).toBe(200);
    expect(doc(h)[1]).toEqual({ github: { id: 3, login: 'carol' } });
    expect(h.world.commitMessages()[0]).toContain('Unbind Telegram from maintainer github:3');
  });

  it('removes maintainers: never yourself, never the last one; a legacy telegram.username is dropped on the next save', async () => {
    const { h } = await world1();
    h.world.addUser(3, 'carol');
    await h.world.writeData({
      'maintainers.yaml':
        '# hand-written\n' +
        YAML.stringify({ maintainers: [{ github: { id: MAINTAINER.id, login: 'maint' }, telegram: { id: MAINTAINER.tg, username: 'Maint' } }, { github: { id: 3, login: 'carol' } }] }),
    });
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    // the legacy key still parses (admin access keeps working)
    expect((await m.get('/api/admin/maintainers')).status).toBe(200);
    expect(await err(await m.call('DELETE', `/api/admin/maintainers/${MAINTAINER.id}`))).toEqual([400, 'cannot-remove-self']);
    expect(await err(await m.call('DELETE', '/api/admin/maintainers/999'))).toEqual([404, 'not-maintainer']);
    const r = await m.call('DELETE', '/api/admin/maintainers/3');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ removed: 3 });
    expect(doc(h)).toEqual([{ github: { id: MAINTAINER.id, login: 'maint' }, telegram: { id: MAINTAINER.tg } }]);
    expect(h.world.readData('maintainers.yaml')).not.toContain('username');
    expect(h.world.commitMessages()[0]).toMatch(/Remove maintainer github:3[\s\S]*Action: maintainers[\s\S]*Actor: github:9000 via portal/);

    // carol is a maintainer in a stale snapshot only; another writer left a single maintainer: last-maintainer guard
    h.world.addUser(4, 'dan');
    expect((await m.post('/api/admin/maintainers', { login: 'dan' })).status).toBe(201);
    await h.world.writeData({ 'maintainers.yaml': YAML.stringify({ maintainers: [{ github: { id: 4, login: 'dan' } }] }) });
    expect(await err(await m.call('DELETE', '/api/admin/maintainers/4'))).toEqual([409, 'last-maintainer']);
    expect(doc(h)).toEqual([{ github: { id: 4, login: 'dan' } }]);
  });

  it('refreshes a renamed login on the next save; the bulk PUT is gone; developers get 403', async () => {
    const { h, alice } = await world1();
    h.world.addUser(3, 'carol');
    const m = await login(h, h.world.users.get(MAINTAINER.id)!);
    expect((await m.post('/api/admin/maintainers', { login: 'carol' })).status).toBe(201);
    h.world.users.get(MAINTAINER.id)!.login = 'maint-renamed';
    await h.svc.deps.cache.delete(`ghuser/${MAINTAINER.id}`);
    const list = (await (await m.get('/api/admin/maintainers')).json()) as any;
    expect(list.maintainers[0].login).toBe('maint-renamed');
    expect(doc(h)[0].github.login).toBe('maint');
    expect((await m.call('PATCH', '/api/admin/maintainers/3', { telegramId: 31 })).status).toBe(200);
    expect(doc(h)[0].github.login).toBe('maint-renamed');
    expect((await m.call('PUT', '/api/admin/maintainers', { maintainers: [] })).status).toBe(404);
    const a = await login(h, alice);
    expect((await a.get('/api/admin/maintainers')).status).toBe(403);
    expect((await a.post('/api/admin/maintainers', { login: 'alice' })).status).toBe(403);
  });
});

describe('telegram /whoami', () => {
  const msg = (from: number | null, text: string, chat = -1001234, extra: object = {}) => ({
    update_id: 7,
    message: { message_id: 12, ...(from === null ? {} : { from: { id: from } }), chat: { id: chat }, text, ...extra },
  });
  const replies = (h: H) => h.world.telegram.filter((t) => t.method === 'sendMessage').map((t) => t.body);

  it('replies with the numeric id and the binding, in the review group only', async () => {
    const { h } = await world1();
    const before = h.world.commitMessages().length;
    expect(await (await signedTelegram(h, msg(MAINTAINER.tg, '/whoami@ksudevbot'))).json()).toEqual({ answer: null });
    expect(await (await signedTelegram(h, msg(777, '/whoami'))).json()).toEqual({ answer: null });
    await signedTelegram(h, msg(777, '/whoami@AnyBot extra words'));
    await signedTelegram(h, msg(777, '/whoamix'));
    await signedTelegram(h, msg(777, '/whoami', 42)); // other chat (e.g. a private chat with the bot): ignored
    await signedTelegram(h, msg(1087968824, '/whoami', -1001234, { sender_chat: { id: -1001234 } }));
    const r = replies(h);
    expect(r).toHaveLength(4);
    expect(r[0]).toMatchObject({ chat_id: -1001234, reply_parameters: { message_id: 12 }, parse_mode: 'HTML' });
    expect(r[0]!.text).toBe(`Your Telegram user id: <code>${MAINTAINER.tg}</code>\nBound to maintainer @maint (GitHub #${MAINTAINER.id}).`);
    expect(r[1]!.text).toContain('<code>777</code>');
    expect(r[1]!.text).toContain('Not bound to a maintainer');
    expect(r[2]!.text).toContain('<code>777</code>');
    expect(r[3]!.text).toContain('anonymously');
    expect(h.world.commitMessages().length).toBe(before);
  });
});

describe('precheck / preview / sync', () => {
  it('precheck is API-only: module.yaml, referenced paths, ID rules, latest release + asset; never the ZIP', async () => {
    const { h, alice, demo } = await world1();
    const c = await login(h, alice);
    const n = h.world.requests.length;
    const r = (await (await c.post('/api/precheck', { repositoryId: 501 })).json()) as any;
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.manifest.id).toBe('demo.toolbox');
    expect(r.latestRelease).toEqual({
      tag: 'v1.0.0',
      immutable: true,
      url: 'https://github.com/alice/demo/releases/tag/v1.0.0',
      asset: { name: 'demo.toolbox-100.zip', size: expect.any(Number), digest: null, url: expect.stringContaining('/releases/download/') },
    });
    const reqs = h.world.requests.slice(n);
    expect(reqs.filter((x) => x.includes('/releases/download/'))).toHaveLength(0);
    expect(reqs.filter((x) => x.includes('/repos/alice/demo/contents'))).toEqual(['GET api.github.com/repos/alice/demo/contents/module.yaml', 'GET api.github.com/repos/alice/demo/contents']);

    // not immutable; a referenced doc and the icon are missing; reserved/colliding IDs
    h.world.publishModule(demo, 'demo.toolbox', { immutable: false });
    const y = YAML.parse(demo.files['module.yaml']!);
    y.icon = 'assets/icon.png';
    y.description = 'docs/README.md';
    demo.files['module.yaml'] = YAML.stringify(y);
    demo.files['docs/other.md'] = 'x';
    const r2 = (await (await c.post('/api/precheck', { repositoryId: 501 })).json()) as any;
    expect(r2.ok).toBe(false);
    const codes = r2.issues.map((i: any) => i.code);
    expect(codes).toContain('release-not-immutable');
    expect(r2.issues.filter((i: any) => i.code === 'manifest-path-missing').map((i: any) => i.message)).toEqual([
      'assets/icon.png does not exist at main.',
      'docs/README.md does not exist at main.',
    ]);
    expect(r2.latestRelease).not.toHaveProperty('version');
    expect(r2.latestRelease).not.toHaveProperty('versionCode');

    await submit(h, alice, 502, 'other.mod');
    y.id = 'Other.Mod';
    delete y.icon;
    y.description = 'README.md';
    demo.files['module.yaml'] = YAML.stringify(y);
    const r3 = (await (await c.post('/api/precheck', { repositoryId: 501 })).json()) as any;
    expect(r3.issues.map((i: any) => i.code)).toContain('id-collision');
    y.id = 'ksu';
    demo.files['module.yaml'] = YAML.stringify(y);
    const r4 = (await (await c.post('/api/precheck', { repositoryId: 501 })).json()) as any;
    expect(r4.issues.map((i: any) => i.code)).toContain('id-reserved');
  });

  it('preview returns raw Markdown + render context (rendered client-side)', async () => {
    const { h, alice } = await world1();
    const c = await login(h, alice);
    const r = (await (await c.post('/api/preview', { repositoryId: 501 })).json()) as any;
    expect(Object.keys(r).sort()).toEqual(['ctx', 'markdown']);
    expect(r.markdown).toContain('**world**');
    expect(r.ctx).toEqual({ fullName: 'alice/demo', commit: 'a'.repeat(40), docPath: 'README.md' });
    // the SPA renders it with the site renderer
    const { renderMarkdown } = await import('@kernelsu-modules/render');
    const { html } = renderMarkdown(r.markdown, r.ctx);
    expect(html).toContain('<strong>world</strong>');
    expect(html).not.toContain('<script');
    expect(html).toContain(`https://raw.githubusercontent.com/alice/demo/${'a'.repeat(40)}/docs/a.png`);
  });

  it('preview caps the Markdown at 512 KiB', async () => {
    const { h, alice } = await world1();
    const repo = h.world.repos.get(501)!;
    repo.files['README.md'] = 'x'.repeat(512 * 1024 + 1);
    await h.world.writeData({ 'policy.yaml': YAML.stringify({ ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, docMaxBytes: 4 * 1024 * 1024 } }) });
    const c = await login(h, alice);
    const r = await c.post('/api/preview', { repositoryId: 501 });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe('content-too-large');
    repo.files['README.md'] = 'y'.repeat(512 * 1024);
    expect((await c.post('/api/preview', { repositoryId: 501 })).status).toBe(200);
  });

  it('module sync is rate limited per module', async () => {
    const { h, alice } = await world1();
    const { c } = await submit(h, alice, 501, 'demo.toolbox');
    const r1 = await c.post('/api/modules/demo.toolbox/sync');
    expect(r1.status).toBe(202);
    const r2 = await c.post('/api/modules/demo.toolbox/sync');
    expect(r2.status).toBe(429);
    expect(Number(r2.headers.get('retry-after'))).toBeGreaterThan(500);
    h.world.now += 601_000;
    expect((await c.post('/api/modules/demo.toolbox/sync')).status).toBe(202);
    expect(h.world.dispatches.map((d) => d.inputs)).toEqual([
      { reason: 'submit', module: 'demo.toolbox' },
      { reason: 'portal', module: 'demo.toolbox' },
      { reason: 'portal', module: 'demo.toolbox' },
    ]);
    const bob = await login(h, h.world.users.get(2)!);
    expect((await bob.post('/api/modules/demo.toolbox/sync')).status).toBe(403);
  });
});
