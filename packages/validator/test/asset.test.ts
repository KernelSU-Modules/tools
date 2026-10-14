import { describe, expect, it } from 'vitest';
import { ISSUE_CODES, ISSUE_DEFS, rangeReaderFromBytes, validateReleaseAsset, zipLimitsFromPolicy } from '../src/index.ts';
import { buildZip, VALID_PROP } from './zipwriter.ts';

const limits = zipLimitsFromPolicy();
const run = async (prop: string, expectedId = 'demo.toolbox') =>
  validateReleaseAsset({ reader: rangeReaderFromBytes(await buildZip([{ name: 'module.prop', data: prop }, { name: 'service.sh', data: 'sleep 1' }])), expectedId, limits });

describe('validateReleaseAsset', () => {
  it('returns props, version and versionCode', async () => {
    const r = await run(VALID_PROP);
    expect(r.issues).toEqual([]);
    expect(r.value).toMatchObject({ version: 'v1.2.3', versionCode: 123, entries: 2 });
    expect(r.value?.props.id).toBe('demo.toolbox');
  });

  it('id mismatch (case-sensitive)', async () => {
    const r = await run(VALID_PROP, 'Demo.Toolbox');
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(['prop-id-mismatch']);
    expect(r.value).toBeUndefined();
  });

  it('versionCode overflow', async () => {
    const r = await run(VALID_PROP.replace('versionCode=123', 'versionCode=2147483648'));
    expect(r.issues.map((i) => i.code)).toEqual(['prop-versioncode-range']);
  });

  it('missing fields', async () => {
    const r = await run('id=demo.toolbox\nversionCode=1\n');
    expect(r.ok).toBe(false);
    expect(new Set(r.issues.map((i) => i.code))).toEqual(new Set(['prop-missing-field']));
  });

  it('zip-level failure stops early', async () => {
    const r = await validateReleaseAsset({ reader: rangeReaderFromBytes(new Uint8Array(100)), expectedId: 'x', limits });
    expect(r.issues.map((i) => i.code)).toEqual(['zip-not-zip']);
  });
});

describe('validateReleaseAsset: entry kind', () => {
  const ONESHOT = VALID_PROP + 'oneshot=true\n';
  const runZip = async (entries: { name: string; data: string }[], kind?: 'module' | 'script') =>
    validateReleaseAsset({ reader: rangeReaderFromBytes(await buildZip(entries)), expectedId: 'demo.toolbox', limits, kind });

  it('accepts a script entry', async () => {
    const r = await runZip(
      [{ name: 'module.prop', data: ONESHOT }, { name: 'action.sh', data: 'echo hi' }, { name: 'params.json', data: '{"schemaVersion":1,"params":[]}' }],
      'script',
    );
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('runs the kind rules (module.yaml kind, else module.prop oneshot)', async () => {
    const bad = [{ name: 'module.prop', data: ONESHOT }, { name: 'service.sh', data: 'x' }, { name: 'params.json', data: '{' }];
    expect((await runZip(bad, 'script')).issues.map((i) => i.code)).toEqual(['script-missing-action', 'script-forbidden-file', 'script-params-invalid']);
    expect((await runZip(bad)).issues.map((i) => i.code)).toEqual(['script-missing-action', 'script-forbidden-file', 'script-params-invalid']);
    const mismatch = await runZip(bad, 'module');
    expect(mismatch.ok).toBe(false);
    expect(mismatch.issues.map((i) => i.code)).toEqual(['manifest-kind-mismatch', 'params-ignored']);
    const notOneshot = await runZip([{ name: 'module.prop', data: VALID_PROP }, { name: 'action.sh', data: 'x' }], 'script');
    expect(notOneshot.issues.map((i) => i.code)).toEqual(['manifest-kind-mismatch']);
  });
});

describe('ISSUE_CODES', () => {
  it('every code is kebab-case and documented', () => {
    for (const [code, text] of Object.entries(ISSUE_CODES)) {
      expect(code).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(text).toContain('Fix:');
    }
    expect(Object.keys(ISSUE_CODES)).toEqual(Object.keys(ISSUE_DEFS));
  });
});
