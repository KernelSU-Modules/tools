// External mode: publishing to a public distribution repository from a private source repository.
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@kernelsu-modules/schema';
import { expiryWarning, gitBlobSha, parseExpiry, readTagMessage, WRITE_PROBE } from '../src/external.ts';
import { ActionFailed, run } from '../src/main.ts';
import { FakeGitHub, MANIFEST, fakeValidator, memoryLogger, moduleZip, readOutputs, tempDir, workspace } from './helpers.ts';

const DOC = '# Demo\n\n![shot](docs/shot.png)\n\n![remote](https://example.com/x.png)\n\n![root](/assets/banner.png)\n';
const FILES = { 'README.md': DOC, 'assets/icon.png': 'ICON', 'docs/shot.png': 'SHOT', 'assets/banner.png': 'BANNER' };
const MAN = { ...MANIFEST, icon: 'assets/icon.png' };
const NOW = Date.UTC(2026, 9, 11);

function setup(
  opts: { manifest?: Record<string, unknown> | null; files?: Record<string, string>; inputs?: Record<string, string>; seed?: Record<string, string> | null } = {},
) {
  const ws = workspace(opts.manifest === undefined ? MAN : opts.manifest, opts.files ?? FILES);
  writeFileSync(join(ws, 'module.zip'), moduleZip());
  const env: Record<string, string> = {
    GITHUB_WORKSPACE: ws,
    GITHUB_REPOSITORY: 'demo/private',
    GITHUB_REF: 'refs/tags/v1.0',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_OUTPUT: join(ws, 'out.txt'),
    GITHUB_STEP_SUMMARY: join(ws, 'summary.md'),
    RUNNER_TEMP: join(ws, 'tmp'),
    INPUT_TOKEN: 'pat',
    'INPUT_WORKFLOW-TOKEN': 'ghs_workflow',
    INPUT_ZIP: 'module.zip',
    INPUT_REPOSITORY: 'dist/mod',
    ...opts.inputs,
  };
  const gh = new FakeGitHub('dist/mod');
  const initial = opts.seed === null ? '' : gh.commitFiles(opts.seed ?? { 'README.md': '# old readme\n' });
  const { log, lines } = memoryLogger();
  const go = () => run({ env, log, validator: fakeValidator, fetch: gh.fetch, sleep: async () => {}, now: () => NOW });
  const fail = async () => {
    const e = await go().then(
      () => null,
      (x: unknown) => x,
    );
    expect(e, lines.join('\n')).toBeInstanceOf(ActionFailed);
    return e as ActionFailed;
  };
  return { ws, env, gh, lines, go, fail, initial };
}

const gitWrites = (gh: FakeGitHub) => gh.writes().filter((w) => w.includes('/git/'));
const committedPaths = (gh: FakeGitHub) =>
  gh.calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/git/trees')).flatMap((c) => (c.body as { tree: { path: string }[] }).tree.map((t) => t.path));

describe('external mode: publish', () => {
  it('syncs metadata in one commit, tags it, then draft -> upload -> publish in the target repository', async () => {
    const t = setup();
    const res = await t.go();
    expect(res.published).toBe(true);
    const head = t.gh.refs.get('heads/main')!;
    expect(head).not.toBe(t.initial);
    expect(t.gh.commits.get(head)).toMatchObject({ parents: [t.initial], message: 'Sync module metadata for v1.0' });
    expect(t.gh.refs.get('tags/v1.0')).toBe(head);
    expect(committedPaths(t.gh).sort()).toEqual(['README.md', 'assets/banner.png', 'assets/icon.png', 'docs/shot.png', 'module.yaml']);
    expect(t.gh.fileAt('docs/shot.png')).toBe('SHOT');
    expect(t.gh.fileAt('README.md')).toBe(DOC);
    expect(JSON.parse(t.gh.fileAt('module.yaml')!)).toEqual(MAN);
    const w = t.gh.writes().map((x) => x.replace(/\d+$/, 'N'));
    expect(w.filter((x) => !x.endsWith('/git/blobs'))).toEqual([
      'POST /repos/dist/mod/git/trees',
      'POST /repos/dist/mod/git/commits',
      'PATCH /repos/dist/mod/git/refs/heads/main',
      'POST /repos/dist/mod/git/refs',
      'POST /repos/dist/mod/releases',
      'POST upload',
      'PATCH /repos/dist/mod/releases/N',
    ]);
    const create = t.gh.calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/releases'))!;
    expect(create.body).toMatchObject({ tag_name: 'v1.0', target_commitish: head, generate_release_notes: false });
    expect(t.gh.calls.every((c) => c.headers.get('authorization') === 'Bearer pat')).toBe(true);
    const out = readOutputs(t.env.GITHUB_OUTPUT!);
    expect(out).toMatchObject({ repository: 'dist/mod', 'metadata-commit': head, 'release-url': 'https://github.com/dist/mod/releases/tag/v1.0' });
    expect(t.lines.join('\n')).toMatch(/install the KernelSU Modules GitHub App on dist\/mod.*installations\/new/);
  });

  it('commits only changed files', async () => {
    const t = setup({ seed: { 'module.yaml': JSON.stringify(MAN, null, 2), 'assets/icon.png': 'ICON', 'docs/shot.png': 'OLD', 'unrelated.txt': 'keep' } });
    const res = await t.go();
    expect(committedPaths(t.gh).sort()).toEqual(['README.md', 'assets/banner.png', 'docs/shot.png']);
    expect(t.gh.writes().filter((w) => w.endsWith('/git/blobs'))).toHaveLength(3);
    expect(t.gh.fileAt('unrelated.txt')).toBe('keep'); // never deletes
    expect(res.syncedFiles.sort()).toEqual(['README.md', 'assets/banner.png', 'docs/shot.png']);
  });

  it('creates no commit when the metadata is unchanged and tags the current HEAD', async () => {
    const t = setup({ seed: { 'module.yaml': JSON.stringify(MAN, null, 2), ...FILES } });
    const res = await t.go();
    expect(res.metadataCommit).toBe('');
    expect(gitWrites(t.gh)).toEqual(['POST /repos/dist/mod/git/refs']);
    expect(t.gh.refs.get('tags/v1.0')).toBe(t.initial);
    expect(readOutputs(t.env.GITHUB_OUTPUT!)['metadata-commit']).toBe('');
  });

  it('sync-files: false only tags the default branch HEAD', async () => {
    const t = setup({ inputs: { 'INPUT_SYNC-FILES': 'false' } });
    await t.go();
    expect(gitWrites(t.gh)).toEqual(['POST /repos/dist/mod/git/refs']);
    expect(t.gh.refs.get('tags/v1.0')).toBe(t.initial);
  });

  it('retries the metadata commit when the branch moved concurrently', async () => {
    const t = setup();
    t.gh.raceNextRefUpdate = true;
    await t.go();
    const head = t.gh.refs.get('heads/main')!;
    expect(t.gh.fileAt('CONCURRENT.md')).toBe('someone else');
    expect(t.gh.fileAt('README.md')).toBe(DOC);
    expect(t.gh.refs.get('tags/v1.0')).toBe(head);
    expect(t.gh.writes().filter((w) => w.includes('/git/refs/heads/'))).toHaveLength(2);
  });

  it('is a no-op for "repository" equal to the current repository', async () => {
    const t = setup({ inputs: { GITHUB_REPOSITORY: 'dist/mod' } });
    const res = await t.go();
    expect(res.external).toBe(false);
    expect(gitWrites(t.gh)).toEqual([]);
    const create = t.gh.calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/releases'))!;
    expect(create.body).toMatchObject({ target_commitish: 'a'.repeat(40) });
  });
});

describe('external mode: metadata limits', () => {
  it('fails when the description exceeds docMaxBytes', async () => {
    const t = setup({ files: { ...FILES, 'README.md': 'x'.repeat(DEFAULT_POLICY.limits.docMaxBytes + 1) } });
    const e = await t.fail();
    expect(e.issues.map((i) => `${i.severity}:${i.code}`)).toContain('error:content-too-large');
    expect(t.gh.writes()).toEqual([]);
  });

  it('skips oversized and missing images with a warning but syncs the rest', async () => {
    const big = 'x'.repeat(DEFAULT_POLICY.limits.imageMaxBytes + 1);
    const t = setup({ files: { ...FILES, 'README.md': `${DOC}![big](big.png)\n![gone](gone.png)\n`, 'big.png': big } });
    const res = await t.go();
    expect(committedPaths(t.gh)).not.toContain('big.png');
    expect(committedPaths(t.gh)).not.toContain('gone.png');
    expect(committedPaths(t.gh)).toContain('docs/shot.png');
    expect(res.issues.map((i) => `${i.severity}:${i.code}`)).toContain('warning:content-too-large');
    expect(t.lines.join('\n')).toMatch(/gone\.png .*does not exist/);
  });

  it('syncs at most imagesMaxPerModule images', async () => {
    const n = DEFAULT_POLICY.limits.imagesMaxPerModule + 2;
    const files: Record<string, string> = { 'README.md': Array.from({ length: n }, (_, i) => `![i](img/${i}.png)`).join('\n\n') };
    for (let i = 0; i < n; i++) files[`img/${i}.png`] = `img${i}`;
    const t = setup({ manifest: MANIFEST, files });
    await t.go();
    expect(committedPaths(t.gh).filter((p) => p.startsWith('img/'))).toHaveLength(DEFAULT_POLICY.limits.imagesMaxPerModule);
    expect(t.lines.join('\n')).toMatch(/more than \d+ repository images/);
  });

  it('never follows symlinks out of the workspace', async () => {
    const outside = tempDir();
    writeFileSync(join(outside, 'secret.png'), 'SECRET');
    const t = setup({ files: { ...FILES, 'README.md': `${DOC}![l](linked/secret.png)\n` } });
    symlinkSync(outside, join(t.ws, 'linked'));
    await t.go();
    expect(committedPaths(t.gh)).not.toContain('linked/secret.png');
    expect([...t.gh.blobs.values()].some((b) => new TextDecoder().decode(b) === 'SECRET')).toBe(false);
  });

  it('rejects a symlinked icon', async () => {
    const t = setup({ files: { 'README.md': DOC, 'docs/shot.png': 'SHOT', 'assets/banner.png': 'B', 'real.png': 'ICON' } });
    mkdirSync(join(t.ws, 'assets'), { recursive: true });
    symlinkSync(join(t.ws, 'real.png'), join(t.ws, 'assets/icon.png'));
    const e = await t.fail();
    expect(e.issues.map((i) => i.code)).toContain('content-not-file');
    expect(t.gh.writes()).toEqual([]);
  });

  it('requires module.yaml in the workspace when sync-files is on', async () => {
    const t = setup({ manifest: null });
    const e = await t.fail();
    expect(e.issues.map((i) => i.code)).toContain('manifest-missing');
    expect(t.gh.writes()).toEqual([]);
  });
});

describe('external mode: preflight', () => {
  it('fails without a token before calling GitHub', async () => {
    const t = setup({ inputs: { INPUT_TOKEN: '' } });
    await expect(t.go()).rejects.toThrow(/needs a token/);
    expect(t.gh.calls).toEqual([]);
  });

  it('fails when token is the workflow GITHUB_TOKEN', async () => {
    const t = setup({ inputs: { INPUT_TOKEN: 'ghs_workflow' } });
    await expect(t.go()).rejects.toThrow(/GITHUB_TOKEN, which cannot write to another repository/);
    expect(t.gh.calls).toEqual([]);
  });

  it('rejects a malformed repository input', async () => {
    const t = setup({ inputs: { INPUT_REPOSITORY: 'dist' } });
    await expect(t.go()).rejects.toThrow(/owner\/name/);
  });

  it.each([
    ['a private target', (gh: FakeGitHub) => (gh.repoInfo = { ...gh.repoInfo, private: true, visibility: 'private' }), /must be public/],
    ['an internal target', (gh: FakeGitHub) => (gh.repoInfo = { ...gh.repoInfo, private: false, visibility: 'internal' }), /must be public/],
    ['a missing target', (gh: FakeGitHub) => (gh.repoInfo = null), /not found, or the token cannot read it/],
    ['an archived target', (gh: FakeGitHub) => (gh.repoInfo = { ...gh.repoInfo, archived: true }), /archived/],
    ['no write permission', (gh: FakeGitHub) => (gh.repoInfo = { ...gh.repoInfo, permissions: { admin: false, push: false, pull: true } }), /no write access/],
    ['immutability disabled', (gh: FakeGitHub) => (gh.immutableEnabled = false), /immutability is disabled/],
    ['immutability 404 for an admin', (gh: FakeGitHub) => (gh.immutableStatus = 404), /immutability is not enabled/],
    ['an empty repository', (gh: FakeGitHub) => gh.refs.clear(), /no commits on its default branch/],
  ])('fails for %s (also on dry run) and writes nothing', async (_n, arrange, msg) => {
    for (const dry of ['false', 'true']) {
      const t = setup({ inputs: { 'INPUT_DRY-RUN': dry } });
      arrange(t.gh);
      await expect(t.go()).rejects.toThrow(msg);
      expect(t.gh.writes()).toEqual([]);
    }
  });

  it('only warns when the immutability setting cannot be read', async () => {
    for (const [status, perms] of [
      [403, { admin: true, push: true }],
      [404, { admin: false, push: true }],
    ] as const) {
      const t = setup();
      t.gh.immutableStatus = status;
      t.gh.repoInfo = { ...t.gh.repoInfo, permissions: perms };
      const res = await t.go();
      expect(res.published).toBe(true);
      expect(t.lines.join('\n')).toMatch(/Could not check whether release immutability is enabled/);
    }
  });

  it('proves write access with an unreferenced probe blob', async () => {
    const t = setup();
    const { permissions: _p, ...info } = t.gh.repoInfo!;
    t.gh.repoInfo = info;
    await t.go();
    expect(t.gh.calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/git/blobs') && (c.body as { content?: string }).content === WRITE_PROBE)).toHaveLength(1);
  });

  it('fails before writing anything when the token cannot write to the target (e.g. scoped to the wrong repository)', async () => {
    const t = setup();
    t.gh.probeStatus = 403;
    const e = await t.fail();
    expect(e.message).toMatch(/cannot write to dist\/mod \(HTTP 403/);
    expect(e.message).toMatch(/Repository access must include dist\/mod/);
    expect(t.gh.writes()).toEqual([]);
  });

  it('detects a read-only token in a dry run too', async () => {
    const t = setup({ inputs: { 'INPUT_DRY-RUN': 'true' } });
    t.gh.probeStatus = 403;
    await expect(t.fail()).resolves.toBeTruthy();
    expect(t.gh.writes()).toEqual([]);
  });
});

describe('external mode: tags', () => {
  it('fails before writing anything when the tag exists elsewhere', async () => {
    const t = setup();
    const other = t.gh.commitFiles({ 'x.txt': 'x' }, 'other');
    t.gh.refs.set('tags/v1.0', other);
    const e = await t.fail();
    expect(e.message).toMatch(/Precheck failed/);
    expect(t.lines.join('\n')).toMatch(/Tag "v1.0" already exists in dist\/mod/);
    expect(t.gh.writes()).toEqual([]);
  });

  it('fails when the tag exists at HEAD but metadata still has to be committed', async () => {
    const t = setup();
    t.gh.refs.set('tags/v1.0', t.initial);
    await t.fail();
    expect(t.gh.writes()).toEqual([]);
  });

  it('reuses a tag that already points at the unchanged HEAD (re-run after a failed upload)', async () => {
    const t = setup({ seed: { 'module.yaml': JSON.stringify(MAN, null, 2), ...FILES } });
    t.gh.refs.set('tags/v1.0', t.initial);
    const res = await t.go();
    expect(res.published).toBe(true);
    expect(gitWrites(t.gh)).toEqual([]);
  });

  it('refuses when a published release for the tag exists in the target', async () => {
    const t = setup();
    t.gh.addRelease({ tag: 'v1.0', assets: { 'demo_mod-1-v0.9.zip': moduleZip() } });
    const e = await t.fail();
    expect(e.issues.map((i) => i.code)).toContain('release-exists');
    expect(t.gh.writes()).toEqual([]);
  });
});

describe('external mode: release notes', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'tag.gpgSign=false', '-c', 'commit.gpgSign=false', ...args], { cwd, stdio: 'pipe' });
  const repoWithTag = (t: ReturnType<typeof setup>, annotated: string | null) => {
    git(t.ws, 'init', '-q');
    git(t.ws, 'add', 'README.md');
    git(t.ws, 'commit', '-q', '-m', 'init');
    if (annotated === null) git(t.ws, 'tag', 'v1.0');
    else git(t.ws, 'tag', '-a', 'v1.0', '-m', annotated);
  };
  const body = (t: ReturnType<typeof setup>) => (t.gh.calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/releases'))!.body as { body: string }).body;

  it('defaults to the annotated tag message', async () => {
    const t = setup();
    repoWithTag(t, 'v1.0\n\n- Fixed the thing\n- Added `$(whoami)` literally');
    await t.go();
    expect(body(t)).toBe('v1.0\n\n- Fixed the thing\n- Added `$(whoami)` literally');
  });

  it('warns and uses empty notes for a lightweight tag', async () => {
    const t = setup();
    repoWithTag(t, null);
    await t.go();
    expect(body(t)).toBe('');
    expect(t.lines.join('\n')).toMatch(/WARN\[release-notes\].*not an annotated tag/);
  });

  it('warns when the workspace is not a git checkout', async () => {
    const t = setup();
    await t.go();
    expect(body(t)).toBe('');
    expect(t.lines.some((l) => l.startsWith('WARN[release-notes]'))).toBe(true);
  });

  it('prefers release-notes and ignores generate-release-notes', async () => {
    const t = setup({ inputs: { 'INPUT_RELEASE-NOTES': 'explicit', 'INPUT_GENERATE-RELEASE-NOTES': 'true' } });
    repoWithTag(t, 'from tag');
    await t.go();
    expect(body(t)).toBe('explicit');
    const create = t.gh.calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/releases'))!;
    expect(create.body).toMatchObject({ generate_release_notes: false });
    expect(t.lines.join('\n')).toMatch(/generate-release-notes is ignored/);
  });

  it('readTagMessage only matches the exact tag', () => {
    const t = setup();
    git(t.ws, 'init', '-q');
    git(t.ws, 'add', 'README.md');
    git(t.ws, 'commit', '-q', '-m', 'init');
    git(t.ws, 'tag', '-a', 'v1.0/x', '-m', 'nested');
    expect(readTagMessage(t.ws, 'v1.0')).toMatchObject({ ok: false });
    expect(readTagMessage(t.ws, 'v1.0/x')).toEqual({ ok: true, message: 'nested' });
  });
});

describe('external mode: dry run', () => {
  it('runs preflight and the comparison but writes nothing', async () => {
    const t = setup({ inputs: { 'INPUT_DRY-RUN': 'true' } });
    const res = await t.go();
    expect(res.published).toBe(false);
    expect(t.gh.writes()).toEqual([]);
    expect(res.syncedFiles.sort()).toEqual(['README.md', 'assets/banner.png', 'assets/icon.png', 'docs/shot.png', 'module.yaml']);
    expect(t.lines.join('\n')).toMatch(/Metadata to sync to main: /);
    expect(readOutputs(t.env.GITHUB_OUTPUT!)).toMatchObject({ 'metadata-commit': '', repository: 'dist/mod', 'release-url': '' });
  });
});

describe('token expiration', () => {
  it('parses the header format', () => {
    expect(parseExpiry('2026-12-01 00:00:00 UTC')).toBe(Date.UTC(2026, 11, 1));
    expect(parseExpiry('2026-12-01 00:00:00 -0700')).toBe(Date.UTC(2026, 11, 1, 7));
    expect(parseExpiry('nonsense')).toBeNull();
  });

  it('warns only within 14 days', () => {
    expect(expiryWarning(null, NOW)).toBeNull();
    expect(expiryWarning('2026-12-01 00:00:00 UTC', NOW)).toBeNull();
    expect(expiryWarning(new Date(NOW + 20 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC', NOW)).toBeNull();
    expect(expiryWarning('2026-10-21 00:00:00 UTC', NOW)).toMatch(/expires in 10 day/);
    expect(expiryWarning('2026-10-01 00:00:00 UTC', NOW)).toMatch(/has expired/);
  });

  it('emits a warning annotation from the preflight response', async () => {
    const t = setup();
    t.gh.responseHeaders = { 'github-authentication-token-expiration': '2026-10-21 00:00:00 UTC' };
    await t.go();
    expect(t.lines.some((l) => l.startsWith('WARN[token-expiration]') && /expires in 10 day/.test(l))).toBe(true);
  });
});

describe('gitBlobSha', () => {
  it('matches git hash-object', () => {
    expect(gitBlobSha(new Uint8Array())).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(gitBlobSha(new TextEncoder().encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});
