import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { CRON_SUBREQUEST_LIMIT, runScheduled } from '../src/cron.ts';
import { SubrequestBudget } from '../src/lib/budget.ts';
import { Services } from '../src/services.ts';
import { githubHook, login, MAINTAINER, setup } from './harness.ts';

const rec = (id: string, status: string, repoId: number, extra: Record<string, unknown> = {}) =>
  YAML.stringify({
    id,
    status,
    ...(status === 'pending'
      ? {}
      : { source: { host: 'github', repositoryId: repoId, ownerId: 1, fullName: `alice/${id}`, manifestPath: 'module.yaml' } }),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  });

const pendingReq = (sid: string, repoId: number, submittedAt: string, telegram = true) => ({
  request: {
    submissionId: sid,
    kind: 'submit',
    source: { host: 'github', repositoryId: repoId, ownerId: 1, fullName: 'alice/p', manifestPath: 'module.yaml' },
    submittedBy: 1,
    submittedByLogin: 'alice',
    submittedAt,
    ...(telegram ? { telegram: { chatId: -1001234, messageId: 77 } } : {}),
  },
});

async function seeded() {
  const h = await setup();
  await h.world.writeData({
    'modules/listed.mod.yaml': rec('listed.mod', 'listed', 700),
    'modules/susp.mod.yaml': rec('susp.mod', 'suspended', 701),
    'modules/pend.mod.yaml': rec('pend.mod', 'pending', 0, pendingReq('aaaaaaaaaa', 702, '2026-10-01T00:00:00Z')),
    'modules/old.mod.yaml': rec('old.mod', 'pending', 0, pendingReq('bbbbbbbbbb', 703, '2026-08-01T00:00:00Z')),
  });
  return h;
}

describe('GitHub webhooks', () => {
  it('release events for listed/suspended repos dispatch the sync', async () => {
    const h = await seeded();
    const r = await githubHook(h, 'release', { action: 'published', repository: { id: 700 } });
    expect(r.status).toBe(202);
    expect(h.world.dispatches).toEqual([
      { workflow: 'sync-build-deploy.yml', ref: 'main', inputs: { reason: 'release.published', module: 'listed.mod' } },
    ]);
    expect((await githubHook(h, 'release', { action: 'edited', repository: { id: 701 } })).status).toBe(202);
    expect(h.world.dispatches[1]!.inputs).toEqual({ reason: 'release.edited', module: 'susp.mod' });
  });

  it('open requests (pending submissions etc.) dispatch too: the sync validates their source', async () => {
    const h = await seeded();
    expect((await githubHook(h, 'release', { action: 'published', repository: { id: 702 } })).status).toBe(202);
    await githubHook(h, 'check_run', { action: 'rerequested', check_run: { name: 'KernelSU Modules' }, repository: { id: 702 } });
    await githubHook(h, 'check_run', { action: 'requested_action', requested_action: { identifier: 'sync' }, check_run: { name: 'KernelSU Modules' }, repository: { id: 702 } });
    expect(h.world.dispatches.map((d) => d.inputs)).toEqual([
      { reason: 'release.published', module: 'pend.mod' },
      { reason: 'check_run.rerequested', module: 'pend.mod' },
      { reason: 'check_run.requested_action', module: 'pend.mod' },
    ]);
    // an open transfer request: the target repository dispatches the sync of the module being transferred
    await h.world.writeData({
      'modules/xfer.mod.yaml': rec('xfer.mod', 'listed', 705, { request: { ...pendingReq('cccccccccc', 704, '2026-10-05T00:00:00Z').request, kind: 'transfer' } }),
    });
    h.world.now += 61_000; // data head cache
    await githubHook(h, 'release', { action: 'published', repository: { id: 704 } });
    expect(h.world.dispatches.at(-1)!.inputs).toEqual({ reason: 'release.published', module: 'xfer.mod' });
  });

  it('refuses webhooks (503) while the webhook secret is not configured', async () => {
    const h = await seeded();
    h.env.MODULES_APP_WEBHOOK_SECRET = '';
    const forged = await h.request('/webhooks/github', {
      method: 'POST',
      body: '{"action":"published","repository":{"id":700}}',
      // HMAC with an empty key would be forgeable
      headers: { 'x-github-event': 'release', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
    });
    expect(forged.status).toBe(503);
    expect(h.world.dispatches).toHaveLength(0);
  });

  it('ignores repos that are not bound to a module and other events', async () => {
    const h = await seeded();
    expect((await githubHook(h, 'release', { action: 'published', repository: { id: 999 } })).status).toBe(204);
    expect((await githubHook(h, 'release', { action: 'created', repository: { id: 700 } })).status).toBe(204);
    expect((await githubHook(h, 'push', { repository: { id: 700 } })).status).toBe(204);
    expect((await githubHook(h, 'check_run', { action: 'completed', check_run: { name: 'KernelSU Modules' }, repository: { id: 700 } })).status).toBe(204);
    expect(h.world.dispatches).toHaveLength(0);
  });

  it('rejects bad signatures', async () => {
    const h = await seeded();
    expect((await githubHook(h, 'release', { action: 'published', repository: { id: 700 } }, 'wrong')).status).toBe(401);
    const unsigned = await h.request('/webhooks/github', { method: 'POST', body: '{}', headers: { 'x-github-event': 'release' } });
    expect(unsigned.status).toBe(401);
    expect(h.world.dispatches).toHaveLength(0);
  });

  it('check_run rerequested / requested_action(sync) and installation events', async () => {
    const h = await seeded();
    await githubHook(h, 'check_run', { action: 'rerequested', check_run: { name: 'KernelSU Modules' }, repository: { id: 700 } });
    await githubHook(h, 'check_run', { action: 'requested_action', requested_action: { identifier: 'sync' }, check_run: { name: 'KernelSU Modules' }, repository: { id: 700 } });
    await githubHook(h, 'check_run', { action: 'requested_action', requested_action: { identifier: 'other' }, repository: { id: 700 } });
    await githubHook(h, 'installation_repositories', { action: 'added', repositories_added: [{ id: 700 }, { id: 999 }], repositories_removed: [] });
    await githubHook(h, 'installation', { action: 'deleted', installation: { account: { id: 1 } } }); // "all repositories": no list -> by owner
    expect(h.world.dispatches.map((d) => d.inputs)).toEqual([
      { reason: 'check_run.rerequested', module: 'listed.mod' },
      { reason: 'check_run.requested_action', module: 'listed.mod' },
      { reason: 'installation_repositories.added', module: 'listed.mod' },
      { reason: 'installation.deleted' },
    ]);
  });

  it('ping', async () => {
    const h = await seeded();
    expect((await githubHook(h, 'ping', { zen: 'x' })).status).toBe(200);
  });
});

describe('cron', () => {
  it('daily run dispatches the sync and alerts on dispatch failure', async () => {
    const h = await seeded();
    h.world.now = Date.parse('2026-10-10T03:20:00Z');
    await runScheduled(h.svc, '17 3 * * *', Date.parse('2026-10-10T03:17:00Z'));
    expect(h.world.dispatches[0]!.inputs).toEqual({ reason: 'cron' });
    h.world.failDispatch = true;
    const alerts = () => h.world.telegram.filter((t) => t.method === 'sendMessage' && t.body.text.includes('dispatch failed'));
    await runScheduled(h.svc, '17 3 * * *', Date.parse('2026-10-11T03:17:00Z'));
    expect(alerts()).toHaveLength(1);
  });

  it('daily expires pending requests older than policy.pending.expireDays', async () => {
    const h = await seeded();
    const res = await runScheduled(h.svc, '17 3 * * *', h.world.now);
    expect(res.expired).toEqual(['old.mod']);
    const old = h.world.record('old.mod');
    expect(old.status).toBe('rejected');
    expect(old.request).toBeUndefined();
    expect(old.review).toMatchObject({ decision: 'rejected', reasonCode: 'other', reason: 'expired', decidedBy: null, decidedVia: 'auto' });
    expect(h.world.record('pend.mod').status).toBe('pending');
    expect(h.world.commitMessages()[0]).toContain('Action: expire');
    expect(h.world.commitMessages()[0]).toContain('Actor: cron');
    const edit = h.world.telegram.find((t) => t.method === 'editMessageText')!;
    expect(edit.body).toMatchObject({ message_id: 77 });
    expect(edit.body.text).toContain('EXPIRED');
    // expired ID is free; the submission API agrees
    const alice = h.world.addUser(1, 'alice');
    const c = await login(h, alice);
    expect(((await (await c.get('/api/ids/pend.mod')).json()) as any).available).toBe(false);
    expect(((await (await c.get('/api/ids/old.mod')).json()) as any).available).toBe(true);
  });

  it('prunes old Pages deployments of both projects but keeps the newest 5 production, < 30 days and the canonical one', async () => {
    const h = await seeded();
    const day = 86400_000;
    const at = (d: number) => new Date(h.world.now - d * day).toISOString();
    h.world.deployments = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, environment: 'production' as const, created_on: at(40 + i) })),
      { id: 'recent-preview', environment: 'preview', created_on: at(3) },
      { id: 'old-preview', environment: 'preview', created_on: at(60) },
      { id: 'canon', environment: 'production', created_on: at(90) },
    ];
    h.world.canonical = 'canon';
    h.world.pages.set('kernelsu-developer-portal', {
      canonical: 'q0',
      deployments: Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, environment: 'production' as const, created_on: at(31 + i) })),
    });
    const res = (await runScheduled(h.svc, '17 3 * * *', h.world.now)) as any;
    expect(res.pruned['kernelsu-modules-repo'].deleted.sort()).toEqual(['old-preview', 'p5', 'p6', 'p7']);
    expect(res.pruned['kernelsu-developer-portal'].deleted.sort()).toEqual(['q5', 'q6']);
    expect(h.world.deployments.map((d) => d.id).sort()).toEqual(['canon', 'p0', 'p1', 'p2', 'p3', 'p4', 'recent-preview']);
    expect(h.world.pages.get('kernelsu-developer-portal')!.deployments.map((d) => d.id).sort()).toEqual(['q0', 'q1', 'q2', 'q3', 'q4']);
  });

  it('pruning shares one deletion budget across projects', async () => {
    const h = await seeded();
    const at = (d: number) => new Date(h.world.now - d * 86400_000).toISOString();
    const many = (p: string) => Array.from({ length: 12 }, (_, i) => ({ id: `${p}${i}`, environment: 'production' as const, created_on: at(40 + i) }));
    h.world.deployments = many('p');
    h.world.canonical = 'p0';
    h.world.pages.set('kernelsu-developer-portal', { canonical: 'q0', deployments: many('q') });
    // day 11 -> budget 10, starting with the second project
    const res = (await runScheduled(h.svc, '17 3 * * *', Date.parse('2026-10-11T03:17:00Z'))) as any;
    expect(res.pruned['kernelsu-developer-portal'].deleted).toHaveLength(7);
    expect(res.pruned['kernelsu-modules-repo'].deleted).toHaveLength(3);
  });

  it('alerts when the last successful sync run (Actions API) is older than 26 h', async () => {
    const h = await seeded();
    const run = (id: number, conclusion: string, at: string) => ({ id, status: 'completed', conclusion, created_at: at, updated_at: at, html_url: `https://github.com/r/${id}` });
    h.world.workflowRuns = [run(3, 'failure', '2026-10-10T00:10:00Z'), run(2, 'success', '2026-10-09T00:50:00Z')];
    h.world.now = Date.parse('2026-10-10T03:20:00Z');
    const stale = () => h.world.telegram.filter((t) => t.method === 'sendMessage' && t.body.text.includes('stale'));
    const r1 = (await runScheduled(h.svc, '17 3 * * *', Date.parse('2026-10-10T03:17:00Z'))) as any;
    expect(r1.health).toEqual({ lastSuccessAt: '2026-10-09T00:50:00Z', stale: true });
    expect(stale()).toHaveLength(1);
    expect(stale()[0]!.body.text).toContain('https://github.com/r/2');
    // a success within the last 26 h clears it
    h.world.workflowRuns.unshift(run(4, 'success', '2026-10-09T05:00:00Z'));
    const r2 = (await runScheduled(h.svc, '17 3 * * *', Date.parse('2026-10-10T03:17:00Z'))) as any;
    expect(r2.health).toEqual({ lastSuccessAt: '2026-10-09T05:00:00Z', stale: false });
    // never succeeded -> stale
    h.world.workflowRuns = [];
    expect(((await runScheduled(h.svc, '17 3 * * *', h.world.now)) as any).health).toEqual({ lastSuccessAt: null, stale: true });
  });

  it('stays under the subrequest cap with a large backlog; the rest waits for later runs', async () => {
    const h = await seeded();
    const at = (d: number) => new Date(h.world.now - d * 86400_000).toISOString();
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`modules/exp${i}.mod.yaml`] = rec(`exp${i}.mod`, 'pending', 0, pendingReq(`e${i}eeeeeeee`, 900 + i, '2026-08-01T00:00:00Z'));
    await h.world.writeData(files);
    const many = (p: string) => Array.from({ length: 30 }, (_, i) => ({ id: `${p}${i}`, environment: 'preview' as const, created_on: at(40 + i) }));
    h.world.deployments = many('p');
    h.world.canonical = 'x';
    h.world.pages.set('kernelsu-developer-portal', { canonical: 'y', deployments: many('q') });
    h.world.workflowRuns = [{ id: 1, status: 'completed', conclusion: 'success', created_at: at(0), updated_at: at(0), html_url: 'u' }];
    let total = 0;
    for (const cron of ['17 3 * * *', '17 3 * * *']) {
      const budget = new SubrequestBudget(CRON_SUBREQUEST_LIMIT, h.world.fetch);
      // fresh isolate per invocation (cold caches: worst case)
      const svc = new Services(h.env, { fetch: budget.fetch, cache: new (h.cache.constructor as any)(new Map(), () => h.world.now), now: () => h.world.now });
      const before = h.world.requests.length;
      const res = (await runScheduled(svc, cron, Date.parse('2026-10-10T03:00:00Z'), budget)) as any;
      const used = h.world.requests.length - before;
      expect(used).toBe(res.subrequests);
      expect(used).toBeLessThanOrEqual(CRON_SUBREQUEST_LIMIT);
      expect(JSON.stringify(res)).not.toContain('budget of');
      total += (res.expired as string[]).length;
    }
    expect(total).toBeGreaterThanOrEqual(2);
    // even when every commit attempt conflicts (another writer each time -> retries) the cap holds
    let n = 0;
    const conflicting: typeof fetch = async (input, init) => {
      const req = new Request(input as any, init);
      if (req.method === 'PATCH' && req.url.endsWith('/git/refs/heads/main')) await h.world.writeData({ 'README.md': `x${n++}` });
      return h.world.fetch(req);
    };
    const budget = new SubrequestBudget(CRON_SUBREQUEST_LIMIT, conflicting);
    const svc = new Services(h.env, { fetch: budget.fetch, cache: new (h.cache.constructor as any)(new Map(), () => h.world.now), now: () => h.world.now });
    const res = (await runScheduled(svc, '17 3 * * *', h.world.now, budget)) as any;
    expect(n).toBeGreaterThanOrEqual(2); // retried
    expect(res.subrequests).toBeLessThanOrEqual(CRON_SUBREQUEST_LIMIT);
    expect(JSON.stringify(res)).not.toContain('budget of');
  });
});

describe('snapshot cache', () => {
  it('builds incrementally from the previous snapshot (only changed blobs fetched)', async () => {
    const h = await seeded();
    await h.svc.data.snapshot(await h.svc.data.head(true));
    const n = h.world.requests.length;
    await h.world.writeData({ 'modules/new.mod.yaml': rec('new.mod', 'listed', 800) });
    const snap = await h.svc.data.snapshot(await h.svc.data.head(true));
    expect(snap.records['new.mod']?.status).toBe('listed');
    expect(Object.keys(snap.records).sort()).toEqual(['listed.mod', 'new.mod', 'old.mod', 'pend.mod', 'susp.mod']);
    const reqs = h.world.requests.slice(n);
    expect(reqs.filter((r) => r.includes('/graphql'))).toHaveLength(0);
    expect(reqs.filter((r) => r.includes('/git/blobs/'))).toHaveLength(1);
  });
});
