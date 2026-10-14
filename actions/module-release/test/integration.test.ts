// Runs the publish flow against the real @kernelsu-modules/validator (skipped until it exists).
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ActionFailed, run } from '../src/main.ts';
import type { Validator } from '../src/validator-api.ts';
import { FakeGitHub, MANIFEST, PROP, memoryLogger, moduleZip, workspace } from './helpers.ts';

const validatorEntry = fileURLToPath(new URL('../../../packages/validator/src/index.ts', import.meta.url));
const available = existsSync(validatorEntry);

async function realValidator(): Promise<Validator> {
  return (await import(/* @vite-ignore */ validatorEntry)) as Validator;
}

describe.skipIf(!available)('with the real validator', () => {
  const go = async (opts: { yaml: string; zip: Uint8Array; prev?: Uint8Array }) => {
    const ws = workspace(null);
    writeFileSync(join(ws, 'module.yaml'), opts.yaml);
    writeFileSync(join(ws, 'module.zip'), opts.zip);
    const gh = new FakeGitHub();
    if (opts.prev) gh.addRelease({ tag: 'v0.9', assets: { 'demo_mod-1-v0.9.zip': opts.prev } });
    const { log, lines } = memoryLogger();
    const env = {
      GITHUB_WORKSPACE: ws,
      GITHUB_REPOSITORY: 'demo/mod',
      GITHUB_REF: 'refs/tags/v1.0',
      INPUT_TOKEN: 't',
      INPUT_ZIP: 'module.zip',
      RUNNER_TEMP: join(ws, 'tmp'),
    };
    const res = await run({ env, log, validator: await realValidator(), fetch: gh.fetch, sleep: async () => {} }).catch((e: unknown) => e);
    return { res, gh, lines };
  };

  it('publishes a valid module and reads the previous versionCode via HTTP Range', async () => {
    const { res, gh, lines } = await go({ yaml: JSON.stringify(MANIFEST), zip: moduleZip(), prev: moduleZip({ ...PROP, versionCode: 1 }) });
    expect(res, lines.join('\n')).toMatchObject({ published: true, assetName: 'demo_mod-2-v1.0.zip' });
    expect(gh.calls.some((c) => c.headers.get('range'))).toBe(true);
  });

  it('rejects a lower versionCode', async () => {
    const { res, gh } = await go({ yaml: JSON.stringify(MANIFEST), zip: moduleZip(), prev: moduleZip({ ...PROP, versionCode: 7 }) });
    expect(res).toBeInstanceOf(ActionFailed);
    expect((res as ActionFailed).issues.map((i) => i.code)).toContain('version-not-newer');
    expect(gh.writes()).toEqual([]);
  });

  it('rejects path traversal entries', async () => {
    const { res } = await go({ yaml: JSON.stringify(MANIFEST), zip: moduleZip(PROP, { '../evil.sh': 'x' }) });
    expect(res).toBeInstanceOf(ActionFailed);
    expect((res as ActionFailed).issues.map((i) => i.code)).toContain('zip-path-traversal');
  });

  it('publishes a script entry (kind: script, oneshot, action.sh, params.json)', async () => {
    const params = JSON.stringify({ schemaVersion: 1, params: [{ key: 'COUNT', type: 'int', label: 'Count', min: 1, max: 3 }] });
    const zip = moduleZip({ ...PROP, oneshot: 'true' }, { 'action.sh': 'echo $KSU_PARAM_COUNT', 'params.json': params });
    const { res, lines } = await go({ yaml: JSON.stringify({ ...MANIFEST, kind: 'script' }), zip });
    expect(res, lines.join('\n')).toMatchObject({ published: true });
  });

  it('rejects script entry problems before publishing', async () => {
    const params = JSON.stringify({ schemaVersion: 1, params: [{ key: 'MODE', type: 'string', label: 'Mode', pattern: '(' }] });
    const zip = moduleZip({ ...PROP, oneshot: 'true' }, { 'service.sh': 'x', 'params.json': params });
    const { res, gh } = await go({ yaml: JSON.stringify({ ...MANIFEST, kind: 'script' }), zip });
    expect(res).toBeInstanceOf(ActionFailed);
    expect((res as ActionFailed).issues.map((i) => i.code)).toEqual(['script-missing-action', 'script-forbidden-file', 'script-params-invalid']);
    expect(gh.writes()).toEqual([]);
    const mismatch = await go({ yaml: JSON.stringify(MANIFEST), zip: moduleZip({ ...PROP, oneshot: '1' }, { 'action.sh': 'x' }) });
    expect((mismatch.res as ActionFailed).issues.map((i) => i.code)).toEqual(['manifest-kind-mismatch']);
  });

  it('rejects invalid module.yaml', async () => {
    const { res } = await go({ yaml: 'schemaVersion: 1\nid: demo_mod\n', zip: moduleZip() });
    expect(res).toBeInstanceOf(ActionFailed);
  });
});
