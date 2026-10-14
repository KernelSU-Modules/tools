import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionFailed, assetNameFor, run, sanitizeVersion } from '../src/main.ts';
import type { Validator } from '../src/validator-api.ts';
import { FakeGitHub, MANIFEST, PROP, fakeValidator, memoryLogger, moduleZip, readOutputs, workspace } from './helpers.ts';

function setup(opts: { manifest?: Record<string, unknown> | null; zip?: Uint8Array; inputs?: Record<string, string>; validator?: Validator } = {}) {
  const ws = workspace(opts.manifest === undefined ? MANIFEST : opts.manifest);
  const zip = opts.zip ?? moduleZip();
  writeFileSync(join(ws, 'module.zip'), zip);
  const env: Record<string, string> = {
    GITHUB_WORKSPACE: ws,
    GITHUB_REPOSITORY: 'demo/mod',
    GITHUB_REF: 'refs/tags/v1.0',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_OUTPUT: join(ws, 'out.txt'),
    GITHUB_STEP_SUMMARY: join(ws, 'summary.md'),
    RUNNER_TEMP: join(ws, 'tmp'),
    INPUT_TOKEN: 'tkn',
    INPUT_ZIP: 'module.zip',
    ...opts.inputs,
  };
  const gh = new FakeGitHub();
  const { log, lines } = memoryLogger();
  const go = () => run({ env, log, validator: opts.validator ?? fakeValidator, fetch: gh.fetch, sleep: async () => {} });
  return { ws, zip, env, gh, log, lines, go };
}

describe('asset naming', () => {
  it('sanitizes versions for file names', () => {
    expect(sanitizeVersion('v1.0')).toBe('v1.0');
    expect(sanitizeVersion('1.2 (beta)')).toBe('1.2_beta');
    expect(sanitizeVersion('v2.0+git/abc')).toBe('v2.0_git_abc');
    expect(sanitizeVersion('...')).toBe('unknown');
    expect(assetNameFor({ id: 'a_b', versionCode: 12, version: 'v1 rc' })).toBe('a_b-12-v1_rc.zip');
  });
});

describe('publish flow', () => {
  it('creates a draft, uploads, then publishes; writes outputs', async () => {
    const t = setup();
    t.gh.addRelease({ tag: 'v0.9', assets: { 'demo_mod-1-v0.9.zip': moduleZip({ ...PROP, versionCode: 1, version: 'v0.9' }) } });
    const res = await t.go();
    expect(res.published).toBe(true);
    expect(res.immutable).toBe(true);
    expect(t.gh.writes()).toEqual(['POST /repos/demo/mod/releases', 'POST upload', expect.stringMatching(/^PATCH \/repos\/demo\/mod\/releases\/\d+$/)]);
    const create = t.gh.calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/releases'))!;
    expect(create.body).toMatchObject({ tag_name: 'v1.0', draft: true, prerelease: false, target_commitish: 'a'.repeat(40) });
    const upload = t.gh.calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/assets'))!;
    expect(upload.url.searchParams.get('name')).toBe('demo_mod-2-v1.0.zip');
    expect(upload.headers.get('content-type')).toBe('application/zip');
    const sha = createHash('sha256').update(t.zip).digest('hex');
    const out = readOutputs(t.env.GITHUB_OUTPUT!);
    expect(out).toMatchObject({ 'asset-name': 'demo_mod-2-v1.0.zip', sha256: sha, 'release-id': String(res.releaseId), 'version-code': '2', 'module-id': 'demo_mod' });
    expect(out['release-url']).toBe('https://github.com/demo/mod/releases/tag/v1.0');
  });

  it('builds the ZIP from module-dir, excluding VCS files', async () => {
    const t = setup({ inputs: { INPUT_ZIP: '', 'INPUT_MODULE-DIR': 'mod' } });
    mkdirSync(join(t.ws, 'mod/.git'), { recursive: true });
    mkdirSync(join(t.ws, 'mod/system/bin'), { recursive: true });
    writeFileSync(join(t.ws, 'mod/module.prop'), 'id=demo_mod\nname=Demo\nversion=1.0 beta\nversionCode=3\nauthor=me\ndescription=d\n');
    writeFileSync(join(t.ws, 'mod/.git/HEAD'), 'ref');
    writeFileSync(join(t.ws, 'mod/system/bin/tool'), 'x');
    const res = await t.go();
    expect(res.assetName).toBe('demo_mod-3-1.0_beta.zip');
    expect(res.zipPath).toBe(join(t.ws, 'tmp', 'demo_mod-3-1.0_beta.zip'));
    expect(existsSync(res.zipPath)).toBe(true);
  });

  it('dry run publishes nothing and works without a token', async () => {
    const t = setup({ inputs: { 'INPUT_DRY-RUN': 'true', INPUT_TOKEN: '' } });
    const res = await t.go();
    expect(res.published).toBe(false);
    expect(t.gh.calls).toEqual([]);
    expect(readOutputs(t.env.GITHUB_OUTPUT!)['release-id']).toBe('');
  });

  it('dry run with a token still performs read-only release checks', async () => {
    const t = setup({ inputs: { 'INPUT_DRY-RUN': 'true' } });
    t.gh.addRelease({ tag: 'v0.9', assets: { 'demo_mod-5-v0.9.zip': moduleZip({ ...PROP, versionCode: 5 }) } });
    await expect(t.go()).rejects.toBeInstanceOf(ActionFailed);
    expect(t.gh.writes()).toEqual([]);
  });

  it('passes prerelease and release notes', async () => {
    const t = setup({ inputs: { INPUT_PRERELEASE: 'true', 'INPUT_RELEASE-NOTES': '- fixed things' } });
    await t.go();
    const create = t.gh.calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/releases'))!;
    expect(create.body).toMatchObject({ prerelease: true, body: '- fixed things', generate_release_notes: false });
  });

  it('deletes leftover drafts for the same tag before creating a new one', async () => {
    const t = setup();
    const leftover = t.gh.addRelease({ tag: 'v1.0', draft: true });
    await t.go();
    expect(t.gh.writes()[0]).toBe(`DELETE /repos/demo/mod/releases/${leftover}`);
  });
});

describe('refuses to publish', () => {
  const expectFail = async (t: ReturnType<typeof setup>, code: string) => {
    const err = await t.go().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ActionFailed);
    expect((err as ActionFailed).issues.map((i) => i.code)).toContain(code);
    expect(t.gh.writes()).toEqual([]);
    expect(t.lines.some((l) => l.startsWith(`ERR[${code}`))).toBe(true);
  };

  it('when versionCode is not newer than the latest stable release', async () => {
    const t = setup();
    t.gh.addRelease({ tag: 'v0.9', assets: { 'demo_mod-2-v0.9.zip': moduleZip({ ...PROP, versionCode: 2 }) } });
    await expectFail(t, 'version-not-newer');
  });

  it('when a published release for the tag exists', async () => {
    const t = setup();
    t.gh.addRelease({ tag: 'v1.0', assets: { 'x.zip': moduleZip({ ...PROP, versionCode: 1 }) } });
    await expectFail(t, 'release-exists');
  });

  it('when module.yaml id differs from module.prop id', async () => {
    const t = setup({ manifest: { ...MANIFEST, id: 'other_mod' } });
    await expectFail(t, 'prop-id-mismatch');
  });

  it('when the asset name does not match assetPattern', async () => {
    const t = setup({ manifest: { ...MANIFEST, release: { assetPattern: 'something-*.zip' } } });
    await expectFail(t, 'asset-none');
  });

  it('when module.yaml references a missing file', async () => {
    const t = setup({ manifest: { ...MANIFEST, icon: 'assets/icon.png' } });
    await expectFail(t, 'manifest-path-missing');
  });

  it('when module.yaml is invalid', async () => {
    const t = setup({ manifest: { ...MANIFEST, name: '' } });
    await expectFail(t, 'manifest-schema');
  });

  it('when module.yaml kind disagrees with module.prop oneshot', async () => {
    await expectFail(setup({ manifest: { ...MANIFEST, kind: 'script' } }), 'manifest-kind-mismatch');
    await expectFail(setup({ zip: moduleZip({ ...PROP, oneshot: 'true' }) }), 'manifest-kind-mismatch');
  });

  it('when module.prop lacks fields', async () => {
    const t = setup({ zip: moduleZip({ id: 'demo_mod', versionCode: 3 }) });
    await expectFail(t, 'prop-missing-field');
  });
});

describe('warnings', () => {
  it('missing module.yaml only warns', async () => {
    const t = setup({ manifest: null });
    const res = await t.go();
    expect(res.published).toBe(true);
    expect(t.lines.some((l) => l.startsWith('WARN[manifest-missing]'))).toBe(true);
  });

  it('a newer prerelease with a higher versionCode only warns for a stable publish', async () => {
    const t = setup();
    t.gh.addRelease({ tag: 'v0.9', publishedAt: '2026-01-01T00:00:00Z', assets: { 'a.zip': moduleZip({ ...PROP, versionCode: 1 }) } });
    t.gh.addRelease({ tag: 'v1.1-rc', prerelease: true, publishedAt: '2026-02-01T00:00:00Z', assets: { 'b.zip': moduleZip({ ...PROP, versionCode: 9 }) } });
    const res = await t.go();
    expect(res.published).toBe(true);
    expect(res.issues.find((i) => i.code === 'version-not-newer')?.severity).toBe('warning');
  });

  it('the same situation is an error when publishing a prerelease', async () => {
    const t = setup({ inputs: { INPUT_PRERELEASE: 'true' } });
    t.gh.addRelease({ tag: 'v1.1-rc', prerelease: true, assets: { 'b.zip': moduleZip({ ...PROP, versionCode: 9 }) } });
    await expect(t.go()).rejects.toBeInstanceOf(ActionFailed);
  });

  it('warns when the latest existing release is not immutable', async () => {
    const t = setup();
    t.gh.addRelease({ tag: 'v0.9', immutable: false, assets: { 'a.zip': moduleZip({ ...PROP, versionCode: 1 }) } });
    const res = await t.go();
    expect(res.issues.map((i) => `${i.severity}:${i.code}`)).toContain('warning:release-not-immutable');
  });

  it('reserved IDs are only a warning', async () => {
    const t = setup({ zip: moduleZip({ ...PROP, id: 'magisk' }), manifest: { ...MANIFEST, id: 'magisk' } });
    const res = await t.go();
    expect(res.issues.find((i) => i.code === 'id-reserved')?.severity).toBe('warning');
  });
});

describe('after publishing', () => {
  it('fails if the published release is not immutable (require-immutable default)', async () => {
    const t = setup();
    t.gh.immutableOnPublish = false;
    const err = await t.go().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionFailed);
    expect((err as ActionFailed).message).toMatch(/NOT immutable/);
    expect(readOutputs(t.env.GITHUB_OUTPUT!)['release-url']).toMatch(/v1\.0$/);
  });

  it('only warns when require-immutable is false', async () => {
    const t = setup({ inputs: { 'INPUT_REQUIRE-IMMUTABLE': 'false' } });
    t.gh.immutableOnPublish = false;
    const res = await t.go();
    expect(res.immutable).toBe(false);
  });

  it('deletes the draft when the upload fails', async () => {
    const t = setup();
    t.gh.failUpload = true;
    await expect(t.go()).rejects.toThrow(/Uploading/);
    expect(t.gh.writes().at(-1)).toMatch(/^DELETE /);
    expect(t.gh.releases).toEqual([]);
  });

  // Audit B6: never delete a release that GitHub already published (its tag would be burnt).
  it('does not delete the release when the publish PATCH fails but GitHub published it', async () => {
    const t = setup();
    t.gh.publishResponseStatus = 502;
    await expect(t.go()).rejects.toThrow();
    expect(t.gh.writes().some((w) => w.startsWith('DELETE'))).toBe(false);
    expect(t.gh.releases).toHaveLength(1);
    expect(t.gh.releases[0]!.draft).toBe(false);
    expect(t.lines.join('\n')).toMatch(/already published/);
  });

  it('does not delete anything when the release cannot be re-read after a failure', async () => {
    const t = setup();
    t.gh.failUpload = true;
    t.gh.releaseGetStatus = 500;
    await expect(t.go()).rejects.toThrow(/Uploading/);
    expect(t.gh.writes().some((w) => w.startsWith('DELETE'))).toBe(false);
    expect(t.lines.join('\n')).toMatch(/could not be re-read/);
  });

  it('deletes the draft when GitHub renames the asset', async () => {
    const t = setup();
    t.gh.renameUploadTo = 'renamed.zip';
    await expect(t.go()).rejects.toThrow(/renamed\.zip/);
    expect(t.gh.releases).toEqual([]);
  });
});

describe('inputs', () => {
  it('requires exactly one of zip and module-dir', async () => {
    const t = setup({ inputs: { 'INPUT_MODULE-DIR': 'x' } });
    await expect(t.go()).rejects.toThrow(/exactly one/);
  });

  it('requires a tag unless dry-run', async () => {
    const t = setup({ inputs: { GITHUB_REF: 'refs/heads/main' } });
    await expect(t.go()).rejects.toThrow(/No tag/);
  });
});
