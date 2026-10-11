import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FatalError, serializeLock } from '../src/data.ts';
import { FakeGitHub, moduleZip, sha256 } from './fake-github.ts';
import { T0, goodContent, makeDataDir, manifestYaml, readLock, readStatus, record, run, setupRepo, withRequest, writeRecord } from './helpers.ts';

const later = (ms: number) => new Date(T0.getTime() + ms);

describe('sync: happy path', () => {
  it('locks content + a new immutable release, writes check runs, health ok', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    const zip = moduleZip('demo.mod', 10, '1.0');
    const rel = gh.addRelease(repo, { tag: 'v1.0', zip, commit, annotated: true });
    const dir = await makeDataDir([record('demo.mod', repo)]);

    const { report } = await run(gh, dir);
    const lock = await readLock(dir);
    const m = lock.modules['demo.mod']!;
    expect(m.health).toMatchObject({ status: 'ok', installation: 'present', lastSuccessAt: T0.toISOString(), message: null });
    expect(m.installationId).toBe(601);
    expect(m.content).toMatchObject({ ref: 'main', commit, manifestPath: 'module.yaml' });
    // Manifest, description, icon and the repository image referenced by the description.
    expect(Object.keys(m.content!.files).sort()).toEqual(['README.md', 'assets/icon.png', 'docs/shot.png', 'module.yaml']);
    expect(Object.keys(m.content!.blobs!).sort()).toEqual(['README.md', 'assets/icon.png', 'docs/shot.png', 'module.yaml']);
    expect(m.content!.files['README.md']).toBe(sha256('# Demo\n\n![shot](docs/shot.png)\n'));
    expect(m.maxVersionCode).toBe(10);
    expect(m.maxStableVersionCode).toBe(10);
    expect(m.stable).toMatchObject({ releaseId: rel.id, tag: 'v1.0', tagCommit: commit, version: '1.0', versionCode: 10, immutable: true, prerelease: false });
    expect(m.stable!.asset).toMatchObject({ sha256: sha256(zip), size: zip.length, digest: `sha256:${sha256(zip)}` });
    expect(m.stable!.prop.id).toBe('demo.mod');
    expect(m.releases.map((r) => r.releaseId)).toEqual([rel.id]);
    expect(m.prerelease).toBeNull();
    expect(m.seen[String(rel.id)]).toMatchObject({ ok: true });
    expect(report.changed).toEqual(['demo.mod']);
    expect(report.modules[0]!.releases[0]).toMatchObject({ result: 'accepted', check: 'created' });

    // Check runs: content + release, both success, with the Sync now action.
    expect(gh.checkRuns.map((c) => [c.external_id, c.conclusion])).toEqual([
      [`content:${commit}`, 'success'],
      [`release:${rel.id}`, 'success'],
    ]);
    expect(gh.checkRuns[1]!.head_sha).toBe(commit);
    expect(gh.checkRuns[1]!.actions).toEqual([{ label: 'Sync now', identifier: 'sync', description: 'Re-run sync' }]);

    // Token only sent to api.github.com, never to the asset CDN.
    const cdn = gh.requests.filter((r) => r.url.startsWith('https://objects.githubusercontent.com/'));
    expect(cdn).toHaveLength(1);
    expect(cdn[0]!.auth).toBeNull();
    expect(gh.requests.find((r) => r.url.includes('/releases/assets/'))!.auth).toBe('Bearer tok-601');
  });

  it('second run: nothing changed -> no downloads, no blob reads, no checks, lock and status files unchanged (no heartbeat)', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    const before = await readFile(join(dir, 'sources.lock.json'), 'utf8');
    const beforeStatus = await readFile(join(dir, 'status.json'), 'utf8');
    const checks = gh.checkRuns.length;
    gh.requests = [];

    const { report } = await run(gh, dir, {}, later(15 * 60_000));
    // No conditional request: ETags are bound to the (per-run) installation token.
    expect(gh.requests.find((r) => r.url.includes('/releases?'))!.ifNoneMatch).toBeNull();
    expect(report.modules[0]).toMatchObject({ health: 'ok', releasesList: 'fetched', changed: false });
    expect(gh.count((r) => r.url.includes('objects.githubusercontent.com'))).toBe(0);
    expect(gh.count((r) => r.url.includes('/git/blobs/') || r.url.includes('/git/trees/'))).toBe(0); // same commit -> nothing read
    expect(gh.checkRuns.length).toBe(checks);
    expect(report.changed).toEqual([]);
    expect(report.statusChanged).toEqual([]);
    expect(report.lockWritten).toBe(false);

    // Hours later: still nothing to persist (the old 6-hour heartbeat is gone).
    const r3 = await run(gh, dir, {}, later(7 * 3600_000));
    expect(r3.report.changed).toEqual([]);
    expect(await readFile(join(dir, 'sources.lock.json'), 'utf8')).toBe(before);
    expect(await readFile(join(dir, 'status.json'), 'utf8')).toBe(beforeStatus);
    expect((await readLock(dir)).modules['demo.mod']!.health.lastSuccessAt).toBe(T0.toISOString());
  });
});

describe('sync: release rejections', () => {
  it('rejects a non-immutable release and records it as seen (downloaded at most once)', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    const rel = gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit, immutable: false });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    const { report } = await run(gh, dir);
    const m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.stable).toBeNull();
    expect(m.seen[String(rel.id)]).toMatchObject({ ok: false, code: 'release-not-immutable' });
    expect(m.health.status).toBe('ok'); // author-side release problems don't make the module stale
    expect(report.modules[0]!.releases[0]!.result).toBe('rejected');
    const check = gh.checkRuns.find((c) => c.external_id === `release:${rel.id}`)!;
    expect(check.conclusion).toBe('failure');
    expect(check.output.summary).toContain('https://developers.kernelsu.org/docs/checks#release-not-immutable');
    expect(gh.downloads.size).toBe(0);

    // A new, unrelated release changes the ETag; the rejected one is not re-examined.
    gh.addRelease(repo, { tag: 'v2', zip: moduleZip('demo.mod', 2), commit });
    const r2 = await run(gh, dir, {}, later(60_000));
    expect(r2.report.modules[0]!.releases.map((r) => r.tag)).toEqual(['v2']);
    expect((await readLock(dir)).modules['demo.mod']!.stable!.tag).toBe('v2');
  });

  it('rejects a digest mismatch', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    const rel = gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit, digest: `sha256:${'0'.repeat(64)}` });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    const m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.stable).toBeNull();
    expect(m.seen[String(rel.id)]).toMatchObject({ ok: false, code: 'asset-digest-mismatch' });
  });

  it('accepts a release without a digest (sha256 computed locally)', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    const zip = moduleZip('demo.mod', 3);
    gh.addRelease(repo, { tag: 'v3', zip, commit, digest: null });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    const m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.stable!.asset).toMatchObject({ sha256: sha256(zip), digest: null });
  });

  it('applies versionCode rules: older rejected, same ignored, newer accepted', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v5', zip: moduleZip('demo.mod', 5), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);

    const older = gh.addRelease(repo, { tag: 'v4-late', zip: moduleZip('demo.mod', 4), commit });
    const same = gh.addRelease(repo, { tag: 'v5-again', zip: moduleZip('demo.mod', 5), commit });
    const newer = gh.addRelease(repo, { tag: 'v6', zip: moduleZip('demo.mod', 6), commit });
    const { report } = await run(gh, dir, {}, later(60_000));
    const m = (await readLock(dir)).modules['demo.mod']!;
    expect(report.modules[0]!.releases.map((r) => [r.tag, r.result])).toEqual([
      ['v4-late', 'rejected'],
      ['v5-again', 'same'],
      ['v6', 'accepted'],
    ]);
    expect(m.seen[String(older.id)]).toMatchObject({ ok: false, code: 'version-not-newer' });
    expect(m.seen[String(same.id)]).toMatchObject({ ok: true });
    expect(m.seen[String(newer.id)]).toMatchObject({ ok: true });
    expect(m.stable!.tag).toBe('v6');
    expect(m.releases.map((r) => r.versionCode)).toEqual([6, 5]);
    expect(gh.checkRuns.find((c) => c.external_id === `release:${older.id}`)!.output.summary).toContain('#version-not-newer');
  });

  it('rejects a module.prop id mismatch and a release with two zips', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    const a = gh.addRelease(repo, { tag: 'v2', zip: moduleZip('other.mod', 2), commit });
    const b = gh.addRelease(repo, {
      tag: 'v3',
      zip: moduleZip('demo.mod', 3),
      commit,
      extraAssets: [{ id: 99999, name: 'extra.zip', size: 10, browser_download_url: `https://github.com/${repo.fullName}/releases/download/v3/extra.zip`, state: 'uploaded' }],
    });
    await run(gh, dir, {}, later(60_000));
    const m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.seen[String(a.id)]).toMatchObject({ ok: false, code: 'prop-id-mismatch' });
    expect(m.seen[String(b.id)]).toMatchObject({ ok: false, code: 'asset-multiple' });
    expect(m.stable!.tag).toBe('v1');
  });

  // Audit B8: module.yaml metamodule vs module.prop metamodule (ksud is_metamodule semantics).
  it.each([
    ['module.prop says metamodule, module.yaml does not', '', 'metamodule= TRUE \n', /module\.yaml has metamodule: false/],
    ['module.yaml says metamodule, module.prop does not', 'metamodule: true\n', 'metamodule=yes\n', /does not set metamodule=1 or true/],
  ])('warns when %s', async (_l, yamlExtra, propExtra, msg) => {
    const gh = new FakeGitHub();
    const repo = gh.addRepo({ id: 101, fullName: 'demo/demo.mod', ownerId: 9, defaultBranch: 'main', branches: {}, commits: {} });
    gh.installations.set(101, 601);
    const commit = gh.commit(repo, { ...goodContent('demo.mod'), 'module.yaml': manifestYaml('demo.mod', yamlExtra) });
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1, 'v1', propExtra), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    const { report } = await run(gh, dir);
    const out = report.modules[0]!.releases[0]!;
    expect(out.result).toBe('accepted');
    expect(out.issues).toMatchObject([{ code: 'manifest-metamodule-mismatch', severity: 'warning', message: expect.stringMatching(msg) }]);
    const check = gh.checkRuns.find((c) => c.external_id.startsWith('release:'))!;
    expect(check.conclusion).toBe('success');
    expect(check.output.summary).toContain('manifest-metamodule-mismatch');
  });

  it('no metamodule warning when both agree', async () => {
    const gh = new FakeGitHub();
    const repo = gh.addRepo({ id: 101, fullName: 'demo/demo.mod', ownerId: 9, defaultBranch: 'main', branches: {}, commits: {} });
    gh.installations.set(101, 601);
    const commit = gh.commit(repo, { ...goodContent('demo.mod'), 'module.yaml': manifestYaml('demo.mod', 'metamodule: true\n') });
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1, 'v1', 'metamodule=1\n'), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    const { report } = await run(gh, dir);
    expect(report.modules[0]!.releases[0]).toMatchObject({ result: 'accepted', issues: [] });
  });

  it('enforces the download size cap before downloading', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    const rel = gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    rel.assets[0]!.size = 200 * 1024 * 1024;
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    expect((await readLock(dir)).modules['demo.mod']!.seen[String(rel.id)]).toMatchObject({ ok: false, code: 'zip-too-large' });
    expect(gh.downloads.size).toBe(0);
  });

  it('retries transient download failures on the next run without recording them', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    const rel = gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    gh.failingAssets.add(rel.assets[0]!.id);
    const dir = await makeDataDir([record('demo.mod', repo)]);
    const r1 = await run(gh, dir);
    let m = (await readLock(dir)).modules['demo.mod']!;
    expect(r1.report.modules[0]!.releases[0]!.result).toBe('retry');
    expect(m.seen[String(rel.id)]).toBeUndefined();
    expect(m.health.status).toBe('error'); // never succeeded yet

    gh.failingAssets.clear();
    await run(gh, dir, {}, later(60_000));
    m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.stable!.tag).toBe('v1');
    expect(m.health.status).toBe('ok');
  });
});

describe('sync: mutable fields and channels', () => {
  it('refreshes name/body/prerelease and recomputes stable/prerelease', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    const r1 = gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const r2 = gh.addRelease(repo, { tag: 'v2-beta', zip: moduleZip('demo.mod', 2), commit, prerelease: true });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    let m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.stable!.tag).toBe('v1');
    expect(m.prerelease!.tag).toBe('v2-beta');

    // Author promotes the beta and edits the notes of v1.
    r2.prerelease = false;
    r1.body = 'edited notes';
    r1.name = 'Renamed';
    await run(gh, dir, {}, later(60_000));
    m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.stable!.tag).toBe('v2-beta');
    expect(m.prerelease).toBeNull();
    expect(m.releases.find((r) => r.tag === 'v1')).toMatchObject({ body: 'edited notes', name: 'Renamed' });
    expect(gh.downloads.size).toBe(2); // nothing re-downloaded
  });

  it('drops deleted releases; deleting the stable one never falls back to an older release', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    gh.addRelease(repo, { tag: 'v2', zip: moduleZip('demo.mod', 2), commit });
    await run(gh, dir, {}, later(30_000));
    expect((await readLock(dir)).modules['demo.mod']!.stable!.tag).toBe('v2');

    repo.releases.shift(); // delete v2 (the stable release)
    await run(gh, dir, {}, later(60_000));
    let m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.stable).toBeNull(); // hidden, not downgraded to v1
    expect(m.releases.map((r) => r.tag)).toEqual(['v1']);
    expect([m.maxVersionCode, m.maxStableVersionCode]).toEqual([2, 2]);
    expect(m.health.status).toBe('ok');
    expect(m.health.message).toMatch(/^stable-unavailable:/);
    expect((await readStatus(dir)).modules['demo.mod']).toMatchObject({ stable: null, maxVersionCode: 2 });

    // Re-using the deleted versionCode is rejected; a higher one becomes stable again.
    const reuse = gh.addRelease(repo, { tag: 'v2b', zip: moduleZip('demo.mod', 2, 'other build'), commit });
    await run(gh, dir, {}, later(90_000));
    m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.seen[String(reuse.id)]).toMatchObject({ ok: false, code: 'version-not-newer' });
    expect(m.stable).toBeNull();
    gh.addRelease(repo, { tag: 'v3', zip: moduleZip('demo.mod', 3), commit });
    await run(gh, dir, {}, later(120_000));
    m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.stable!.tag).toBe('v3');
    expect(m.health.message).toBeNull();
  });

  it('prereleases raise the high-water mark; a final release must exceed it (or the beta is promoted)', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v5', zip: moduleZip('demo.mod', 5), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    const beta = gh.addRelease(repo, { tag: 'v7-beta', zip: moduleZip('demo.mod', 7), commit, prerelease: true });
    await run(gh, dir, {}, later(30_000));
    const six = gh.addRelease(repo, { tag: 'v6', zip: moduleZip('demo.mod', 6), commit });
    const seven = gh.addRelease(repo, { tag: 'v7', zip: moduleZip('demo.mod', 7), commit });
    const { report } = await run(gh, dir, {}, later(60_000));
    let m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.seen[String(six.id)]).toMatchObject({ ok: false, code: 'version-not-newer' });
    expect(m.seen[String(seven.id)]).toMatchObject({ ok: false, code: 'version-not-newer' });
    expect(report.modules[0]!.releases.find((r) => r.tag === 'v7')!.issues[0]!.message).toMatch(/prerelease v7-beta/);
    expect([m.stable!.tag, m.prerelease!.tag, m.maxVersionCode]).toEqual(['v5', 'v7-beta', 7]);
    beta.prerelease = false; // promote
    await run(gh, dir, {}, later(90_000));
    m = (await readLock(dir)).modules['demo.mod']!;
    expect([m.stable!.tag, m.prerelease, m.maxStableVersionCode]).toEqual(['v7-beta', null, 7]);
  });
});

describe('sync: installation and content failures', () => {
  it('missing installation keeps the last lock and marks it stale', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);
    const before = (await readLock(dir)).modules['demo.mod']!;

    gh.installations.delete(repo.id);
    const { report } = await run(gh, dir, {}, later(60_000));
    const m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.health).toMatchObject({ status: 'stale', installation: 'missing', lastSuccessAt: T0.toISOString() });
    expect(m.installationId).toBeNull();
    expect(m.stable).toEqual(before.stable);
    expect(m.content).toEqual(before.content);
    expect(report.modules[0]).toMatchObject({ health: 'stale', installation: 'missing', changed: true });

    gh.installations.set(repo.id, 777);
    await run(gh, dir, {}, later(120_000));
    expect((await readLock(dir)).modules['demo.mod']!.health).toMatchObject({ status: 'ok', installation: 'present' });
  });

  it('content failure keeps previous good content (stale) and checks the bad commit once', async () => {
    const gh = new FakeGitHub();
    const { repo, commit: good } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit: good });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await run(gh, dir);

    const bad = gh.commit(repo, { ...goodContent('demo.mod'), 'README.md': undefined as never, 'module.yaml': manifestYaml('demo.mod') });
    delete repo.commits[bad]!['README.md'];
    const r = await run(gh, dir, {}, later(60_000));
    let m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.content!.commit).toBe(good);
    expect(m.health.status).toBe('stale');
    expect(m.health.message).toContain('manifest-path-missing');
    expect(m.stable!.tag).toBe('v1');
    expect(r.report.modules[0]!.content).toMatchObject({ commit: bad, ok: false, check: 'created' });
    const runs = gh.checkRuns.filter((c) => c.external_id === `content:${bad}`);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.conclusion).toBe('failure');
    expect(runs[0]!.output.summary).toContain('#manifest-path-missing');

    // Same bad commit on the next run: no duplicate check run.
    const r2 = await run(gh, dir, {}, later(120_000));
    expect(r2.report.modules[0]!.content!.check).toBe('exists');
    expect(gh.checkRuns.filter((c) => c.external_id === `content:${bad}`)).toHaveLength(1);

    // New releases still use the last valid manifest.
    gh.addRelease(repo, { tag: 'v2', zip: moduleZip('demo.mod', 2), commit: bad });
    await run(gh, dir, {}, later(180_000));
    m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.stable!.tag).toBe('v2');
    expect(m.health.status).toBe('stale');
  });

  it('rejects a manifest whose id differs from the record', async () => {
    const gh = new FakeGitHub();
    const { repo } = setupRepo(gh, 'demo.mod');
    gh.commit(repo, { ...goodContent('demo.mod'), 'module.yaml': manifestYaml('other.mod') });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    const { report } = await run(gh, dir);
    const m = (await readLock(dir)).modules['demo.mod']!;
    expect(m.content).toBeNull();
    expect(m.health.status).toBe('error');
    expect(report.modules[0]!.content!.issues.map((i) => i.code)).toContain('manifest-id-mismatch');
  });

  it('owner change freezes the module', async () => {
    const gh = new FakeGitHub();
    const { repo } = setupRepo(gh, 'demo.mod');
    repo.ownerId = 12345;
    const dir = await makeDataDir([record('demo.mod', { ...repo, ownerId: 9 })]);
    await run(gh, dir);
    expect((await readLock(dir)).modules['demo.mod']!.health.message).toContain('owner-changed');
  });
});

describe('sync: data dir handling', () => {
  it('skips broken records; pending records get no lock entry but a validated request in status.json', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const p = setupRepo(gh, 'pend.mod', 202);
    const old = gh.addRelease(p.repo, { tag: 'v0', zip: moduleZip('pend.mod', 1), commit: p.commit, immutable: false, publishedAt: '2026-01-01T00:00:00Z' });
    const pr = gh.addRelease(p.repo, { tag: 'v1', zip: moduleZip('pend.mod', 2), commit: p.commit });
    const dir = await makeDataDir([record('demo.mod', repo), record('pend.mod', p.repo, 'pending')]);
    await writeFile(join(dir, 'modules', 'broken.yaml'), 'id: broken\nstatus: nope\n');
    await writeFile(join(dir, 'modules', 'bad-yaml.yaml'), 'id: [\n');

    const r1 = await run(gh, dir);
    expect(r1.report.invalidRecords.map((r) => r.file).sort()).toEqual(['modules/bad-yaml.yaml', 'modules/broken.yaml']);
    expect(r1.report.modules.map((m) => m.id)).toEqual(['demo.mod']);
    expect(r1.report.requests).toMatchObject([{ id: 'pend.mod', kind: 'submit', ok: true, revalidated: true }]);
    expect((await readLock(dir)).modules['pend.mod']).toBeUndefined();
    const st = (await readStatus(dir)).modules['pend.mod']!;
    expect(st).toMatchObject({ repositoryId: 202, fullName: 'demo/pend.mod', health: 'ok', installation: 'present', lastSuccessAt: null, stable: null, contentCommit: p.commit });
    expect(st.request).toMatchObject({ submissionId: 'abcdefghij', repositoryId: 202, ok: true, latestTag: 'v1', issues: [], checkedAt: T0.toISOString(), releaseId: pr.id });
    // Check Runs on the requested repository: content + the release that would become stable (not the old one).
    expect(gh.checkRuns.filter((c) => c.repo === 'demo/pend.mod').map((c) => [c.external_id, c.conclusion])).toEqual([
      [`content:${p.commit}`, 'success'],
      [`release:${pr.id}`, 'success'],
    ]);
    expect(gh.checkRuns.find((c) => c.external_id === `release:${old.id}`)).toBeUndefined();

    // Unchanged: deduped (no download, no checks, status file untouched).
    const downloads = gh.downloads.size;
    const checks = gh.checkRuns.length;
    const r2 = await run(gh, dir, {}, later(60_000));
    expect(r2.report.requests[0]!.revalidated).toBe(false);
    expect(r2.report.statusChanged).toEqual([]);
    expect([gh.downloads.size, gh.checkRuns.length]).toEqual([downloads, checks]);

    // Sync now (--module): forced re-check with fresh Check Runs; same result keeps checkedAt.
    const r3 = await run(gh, dir, { module: 'pend.mod' }, later(120_000));
    expect(r3.report.requests[0]!.revalidated).toBe(true);
    expect(gh.checkRuns.length).toBe(checks + 2);
    expect((await readStatus(dir)).modules['pend.mod']!.request!.checkedAt).toBe(T0.toISOString());

    // A new commit that breaks module.yaml -> request not ok, status changes.
    gh.commit(p.repo, { ...goodContent('pend.mod'), 'module.yaml': 'schemaVersion: 1\nid: pend.mod\n' });
    const r4 = await run(gh, dir, {}, later(180_000));
    expect(r4.report.statusChanged).toEqual(['pend.mod']);
    const st4 = (await readStatus(dir)).modules['pend.mod']!;
    expect(st4).toMatchObject({ health: 'error', request: { ok: false, checkedAt: later(180_000).toISOString() } });
    expect(st4.request!.issues.map((i) => i.code)).toContain('manifest-schema');
  });

  it('fails globally on a bad policy', async () => {
    const gh = new FakeGitHub();
    const dir = await makeDataDir([], { 'policy.yaml': 'schemaVersion: 2\n' });
    await expect(run(gh, dir)).rejects.toBeInstanceOf(FatalError);
  });

  it('fails globally on an auth failure', async () => {
    const gh = new FakeGitHub();
    const { repo } = setupRepo(gh, 'demo.mod');
    gh.tokenStatus = 401;
    const dir = await makeDataDir([record('demo.mod', repo)]);
    await expect(run(gh, dir)).rejects.toBeInstanceOf(FatalError);
  });

  it('dry-run creates no check runs and writes no lock', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);
    const { report } = await run(gh, dir, { mode: 'dry-run' });
    expect(gh.checkRuns).toHaveLength(0);
    expect(report.lockWritten).toBe(false);
    expect(report.modules[0]!.stable).toEqual({ tag: 'v1', versionCode: 1 });
    await expect(readFile(join(dir, 'sources.lock.json'))).rejects.toThrow();
  });
});

describe('sync: commit to the data repo', () => {
  it('merges only touched modules into the remote lock, preserves concurrent Portal commits', async () => {
    const gh = new FakeGitHub();
    const { repo, commit } = setupRepo(gh, 'demo.mod');
    gh.addRelease(repo, { tag: 'v1', zip: moduleZip('demo.mod', 1), commit });
    const dir = await makeDataDir([record('demo.mod', repo)]);

    // Remote already has an entry for another module that this run does not sync.
    const otherEntry = { marker: 'kept verbatim' };
    gh.seedData({ 'sources.lock.json': JSON.stringify({ schemaVersion: 1, modules: { 'zzz.other': otherEntry } }), 'modules/demo.mod.yaml': 'x' });
    // A Portal commit lands between our read and our ref update (first attempt fails, second succeeds).
    let raced = false;
    gh.beforeRefUpdate = () => {
      if (raced) return false;
      raced = true;
      gh.pushData({ 'modules/new.mod.yaml': 'portal wrote this' });
      return true;
    };

    const { report } = await run(gh, dir, { mode: 'commit' });
    expect(report.commit).toBe(gh.dataRepo.head);
    const remote = JSON.parse(gh.dataFile('sources.lock.json')!);
    expect(remote.modules['zzz.other']).toEqual(otherEntry);
    expect(remote.modules['demo.mod'].stable.tag).toBe('v1');
    expect(gh.dataFile('modules/new.mod.yaml')).toBe('portal wrote this');
    expect(gh.dataFile('modules/demo.mod.yaml')).toBe('x');
    const msg = gh.dataRepo.commits.get(gh.dataRepo.head)!.message;
    expect(msg).toMatch(/^sync: demo\.mod\n\n/);
    expect(msg).toContain('Action: sync\n');
    // Canonical serialization: sorted keys, 2-space indent, trailing newline.
    expect(gh.dataFile('sources.lock.json')!.endsWith('}\n')).toBe(true);

    // Unchanged second run: no commit.
    const head = gh.dataRepo.head;
    const r2 = await run(gh, dir, { mode: 'commit' }, later(60_000));
    expect(r2.report.commit).toBeNull();
    expect(gh.dataRepo.head).toBe(head);
  });

  it('serializeLock is stable regardless of key order', () => {
    const a = serializeLock({ schemaVersion: 1, modules: {} });
    expect(a).toBe('{\n  "modules": {},\n  "schemaVersion": 1\n}\n');
  });
});
