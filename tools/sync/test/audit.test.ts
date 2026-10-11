// Audit fixes: content churn (M2), status.json + request checks (M3), first sync (m4), forced re-checks (m5),
// per-module auth errors (m3), GC (m9), commit trailer (n1).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FatalError } from '../src/data.ts';
import { FakeGitHub, moduleZip } from './fake-github.ts';
import { T0, goodContent, makeDataDir, readLock, readStatus, record, run, setupRepo, withRequest, writeRecord } from './helpers.ts';

const later = (ms: number) => new Date(T0.getTime() + ms);

describe('content churn (M2)', () => {
  it('unrelated pushes keep the locked commit (no lock change, no check run); tracked image changes advance it', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    const lockText = await readFile(join(dir, 'sources.lock.json'), 'utf8');
    const checks = gh.checkRuns.length;

    gh.commit(repo, { ...goodContent('demo.mod'), 'src/main.c': 'int main(){}' });
    gh.requests = [];
    const r = await run(gh, dir, {}, later(15 * 60_000));
    expect(r.report.changed).toEqual([]);
    expect(await readFile(join(dir, 'sources.lock.json'), 'utf8')).toBe(lockText);
    expect(gh.checkRuns.length).toBe(checks);
    expect(gh.count((q) => q.url.includes('/git/blobs/'))).toBe(0); // one tree listing, no blob downloads

    const c3 = gh.commit(repo, { ...goodContent('demo.mod'), 'docs/shot.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]) });
    const r3 = await run(gh, dir, {}, later(30 * 60_000));
    expect(r3.report.changed).toEqual(['demo.mod']);
    const m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.content!.commit).toBe(c3);
    expect(m.content!.fetchedAt).toBe(later(30 * 60_000).toISOString());
    expect(gh.checkRuns.at(-1)).toMatchObject({ external_id: `content:${c3}`, conclusion: 'success' });
  });
});

describe('first sync of a binding (m4)', () => {
  it('examines only the newest eligible release (and newer ones); older ones are recorded silently', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    const old1 = gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit, immutable: false });
    const old2 = gh.addRelease(repo, { tag: 'v2', zip: moduleZip('other', 2), commit });
    const cur = gh.addRelease(repo, { tag: 'v3', zip: moduleZip('demo.mod', 3), commit });
    const pre = gh.addRelease(repo, { tag: 'v4-rc', zip: moduleZip('demo.mod', 4), commit, prerelease: true });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    const { report } = await run(gh, dir);
    expect(report.modules[0]!.releases.map((r) => [r.tag, r.result])).toEqual([['v3', 'accepted'], ['v4-rc', 'accepted']]);
    const m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.seen[String(old1.id)]).toMatchObject({ ok: false, skipped: true });
    expect(m.seen[String(old2.id)]).toMatchObject({ ok: false, skipped: true });
    expect(gh.checkRuns.map((c) => c.external_id)).not.toContain(`release:${old1.id}`);
    expect(gh.downloads.size).toBe(2);
    expect([m.stable!.releaseId, m.prerelease!.releaseId]).toEqual([cur.id, pre.id]);
  });
});

describe('forced re-check and repository states (m5)', () => {
  it('--module posts fresh content and release Check Runs even when nothing changed', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    const rel = gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    const before = gh.checkRuns.length;
    const { report } = await run(gh, dir, { module: 'demo.mod' }, later(60_000));
    expect(gh.checkRuns.slice(before).map((c) => [c.external_id, c.conclusion])).toEqual([
      [`content:${commit}`, 'success'],
      [`release:${rel.id}`, 'success'],
    ]);
    expect(gh.checkRuns.at(-1)!.output.title).toMatch(/is the stable version/);
    expect(report.changed).toEqual([]); // nothing substantive
  });

  it('owner change is reported as a failing Check Run on the branch head (once per commit)', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    repo.ownerId = 12345;
    const dir = await makeDataDir([record('demo.mod', { ...repo, ownerId: 9 })]);
    await run(gh, dir);
    expect((await readLock(dir)).modules['demo.mod']!.health.message).toMatch(/^owner-changed:/);
    expect(gh.checkRuns).toMatchObject([{ head_sha: commit, external_id: 'state:owner-changed', conclusion: 'failure' }]);
    await run(gh, dir, {}, later(60_000));
    expect(gh.checkRuns).toHaveLength(1);
  });

  it('a missing installation is only reported in status.json (no repository access)', async () => {
    const gh = new FakeGitHub();
    const { repo } = setupRepo(gh, 'demo.mod');
    gh.installations.delete(repo.id);
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    expect((await readStatus(dir)).modules['demo.mod']).toMatchObject({ health: 'error', installation: 'missing', message: expect.stringMatching(/^installation-missing:/) });
    expect(gh.checkRuns).toHaveLength(0);
  });
});

describe('auth and permission errors (m3)', () => {
  it('a per-installation 401 / permission 403 is recorded for that module only; App JWT failures stay fatal', async () => {
    const gh = new FakeGitHub();
    const a = setupRepo(gh, 'a.mod', 101);
    const b = setupRepo(gh, 'b.mod', 102);
    gh.addRelease(b.repo, { tag: 'v1', zip: moduleZip('b.mod', 1), commit: b.commit });
    gh.failures.push({ match: /^\/repositories\/101$/, status: 401, body: { message: 'Bad credentials' } });
    gh.failures.push({ match: /^\/repositories\/102\/releases$/, status: 403, body: { message: 'Resource not accessible by integration' } });
    const dir = await makeDataDir([record('a.mod', a.repo), record('b.mod', b.repo)]);
    const { report } = await run(gh, dir);
    const msg = Object.fromEntries(report.modules.map((m) => [m.id, m.message]));
    expect(msg['a.mod']).toMatch(/^auth-failed:/);
    expect(msg['b.mod']).toMatch(/^permission-denied:/);
    // Permission errors are not retried within the run.
    expect(gh.count((r) => r.url.includes('/repositories/102/releases'))).toBe(1);

    gh.failures = [{ method: 'POST', match: /^\/app\/installations\/\d+\/access_tokens$/, status: 401, body: { message: 'A JSON web token could not be decoded' } }];
    await expect(run(gh, dir, {}, later(60_000))).rejects.toBeInstanceOf(FatalError);
  });

  it('secondary rate limits are retried with backoff', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    gh.failures.push({ match: /^\/repositories\/101\/releases$/, status: 403, body: { message: 'You have exceeded a secondary rate limit' }, headers: { 'retry-after': '1' }, times: 1 });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    const { report } = await run(gh, dir);
    expect(report.modules[0]).toMatchObject({ health: 'ok', stable: { tag: 'v1' } });
  });
});

describe('transfer requests on listed records (M3)', () => {
  it('validate the NEW repository separately from the current binding; versionCode not above the mark is a warning', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v5', zip: moduleZip('demo.mod', 5), commit });
    const n = setupRepo(gh, 'demo.mod', 303);
    const nrel = gh.addRelease(n.repo, { tag: 'v5', zip: moduleZip('demo.mod', 5), commit: n.commit });
    const rec = withRequest(record('demo.mod', repo), 'transfer', n.repo);
    const dir = await makeDataDir([rec]);
    const { report } = await run(gh, dir);
    expect(report.modules.map((m) => [m.id, m.fullName])).toEqual([['demo.mod', 'demo/demo.mod']]);
    const st = (await readStatus(dir)).modules['demo.mod']!;
    expect(st).toMatchObject({ repositoryId: 101, health: 'ok', stable: { tag: 'v5', versionCode: 5 }, maxVersionCode: 5 });
    expect(st.request).toMatchObject({ submissionId: 'reqabcdefg', repositoryId: 303, ok: true, latestTag: 'v5', releaseId: nrel.id });
    expect(st.request!.issues).toMatchObject([{ code: 'version-not-newer', severity: 'warning' }]);
    expect(gh.checkRuns.find((c) => c.external_id === `release:${nrel.id}`)).toMatchObject({ conclusion: 'success' });

    // After approval (source swapped): the old marks carry over, the same versionCode is not accepted again.
    await writeRecord(dir, { ...record('demo.mod', n.repo), review: { submissionId: 'reqabcdefg', kind: 'transfer', submittedBy: 5, submittedAt: '2026-10-01T00:00:00Z', decision: 'approved', decidedBy: 1, decidedVia: 'portal', decidedAt: '2026-09-01T00:00:00Z', reason: null } });
    await run(gh, dir, {}, later(60_000));
    const m = (await readLock(dir)).modules['demo.mod']!;
    expect([m.repositoryId, m.stable, m.maxVersionCode]).toEqual([303, null, 5]);
    expect(m.seen[String(nrel.id)]).toMatchObject({ ok: false, code: 'version-not-newer' });
    expect((await readStatus(dir)).modules['demo.mod']!.request).toBeNull();
  });
});

describe('GC and commit (m9, n1)', () => {
  it('removes lock/status entries of deleted or rejected records and commits lock + status in one commit', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const gone = setupRepo(gh, 'gone.mod', 404);
    const dir = await makeDataDir([record('demo.mod', repo), record('gone.mod', gone.repo)]);
    await run(gh, dir, { mode: 'commit' });
    let msg = gh.dataRepo.commits.get(gh.dataRepo.head)!.message;
    expect(msg).toContain('Action: sync\n');
    expect(msg).toContain('Actor: app:kernelsu-modules-bot via sync\n');
    expect(JSON.parse(gh.dataFile('status.json')!).modules).toHaveProperty('gone.mod');

    // gone.mod is rejected locally; the remote record is gone too -> both entries removed in one commit.
    await writeRecord(dir, { ...record('gone.mod', gone.repo, 'pending'), status: 'rejected', request: undefined });
    const head = gh.dataRepo.head;
    const r = await run(gh, dir, { mode: 'commit' }, later(60_000));
    expect(r.report.removed).toEqual(['gone.mod']);
    expect(gh.dataRepo.commits.get(gh.dataRepo.head)!.parent).toBe(head);
    expect(Object.keys(JSON.parse(gh.dataFile('sources.lock.json')!).modules)).toEqual(['demo.mod']);
    expect(Object.keys(JSON.parse(gh.dataFile('status.json')!).modules)).toEqual(['demo.mod']);
    msg = gh.dataRepo.commits.get(gh.dataRepo.head)!.message;
    expect(msg).toMatch(/^sync: gone\.mod\n/);
    expect(gh.dataFile('status.json')).toBe(await readFile(join(dir, 'status.json'), 'utf8'));
  });

  it('does not remove an entry whose record was re-created remotely in the meantime', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir, { mode: 'commit' });
    await writeRecord(dir, { ...record('demo.mod', repo, 'pending'), status: 'rejected', request: undefined });
    gh.pushData({ 'modules/demo.mod.yaml': 'id: demo.mod\nstatus: listed\nsource: {host: github, repositoryId: 101, ownerId: 9, fullName: demo/demo.mod}\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\n' });
    await run(gh, dir, { mode: 'commit' }, later(60_000));
    expect(JSON.parse(gh.dataFile('sources.lock.json')!).modules).toHaveProperty('demo.mod');
  });

  it('keeps lock entries of archived records (high-water marks)', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    await writeRecord(dir, { ...record('demo.mod', repo), status: 'archived' });
    const r = await run(gh, dir, {}, later(60_000));
    expect(r.report.invalidRecords).toEqual([]);
    expect((await readLock(dir)).modules['demo.mod']!.maxVersionCode).toBe(1);
    expect((await readStatus(dir)).modules).toEqual({});
  });
});
