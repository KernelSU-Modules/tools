import { describe, expect, it } from 'vitest';
import { checkReleaseKind, SCRIPT_FORBIDDEN_DIRS, SCRIPT_FORBIDDEN_FILES, type ReleaseKindInput } from '../src/index.ts';

const codes = (is: { code: string }[]) => is.map((i) => i.code);
const PARAMS = '{"schemaVersion":1,"params":[{"key":"A","type":"bool","label":"a"}]}';
const script = (over: Partial<ReleaseKindInput> = {}, files = ['module.prop', 'action.sh']): ReleaseKindInput => ({
  kind: 'script',
  props: { id: 'x', oneshot: 'true' },
  zip: { files },
  ...over,
});

describe('checkReleaseKind', () => {
  it('a valid script entry (with or without params.json) passes', () => {
    expect(checkReleaseKind(script())).toEqual([]);
    expect(checkReleaseKind(script({ zip: { files: ['module.prop', 'action.sh', 'params.json', 'customize.sh', 'data/x'], paramsJson: { text: PARAMS } } }))).toEqual([]);
  });

  it('zip-unsupported-method: script entries are limited to stored, deflate and deflate64', () => {
    expect(checkReleaseKind(script({ zip: { files: ['module.prop', 'action.sh'], methods: [0, 8, 9] } }))).toEqual([]);
    const is = checkReleaseKind(script({ zip: { files: ['module.prop', 'action.sh'], methods: [8, 14, 95] } }));
    expect(is).toMatchObject([
      { code: 'zip-unsupported-method', severity: 'error', message: expect.stringContaining('method 14') },
      { code: 'zip-unsupported-method', severity: 'error', message: expect.stringContaining('method 95') },
    ]);
    // Modules are extracted by ksud, which handles LZMA and XZ.
    expect(checkReleaseKind({ kind: 'module', props: { id: 'x' }, zip: { files: ['module.prop'], methods: [14, 95] } })).toEqual([]);
  });

  it('a regular module passes', () => {
    expect(checkReleaseKind({ kind: 'module', props: { id: 'x' }, zip: { files: ['module.prop', 'service.sh', 'system/bin/x'] } })).toEqual([]);
  });

  it.each([
    ['script', { id: 'x' }],
    ['script', { id: 'x', oneshot: 'yes' }],
    ['module', { id: 'x', oneshot: ' TRUE ' }],
    ['module', { id: 'x', oneshot: '1' }],
  ] as const)('kind %s with module.prop %j is a manifest-kind-mismatch error', (kind, props) => {
    const is = checkReleaseKind({ kind, props, zip: { files: ['module.prop', 'action.sh'] } });
    expect(is).toMatchObject([{ code: 'manifest-kind-mismatch', severity: 'error', path: 'kind' }]);
  });

  it('without a known kind, module.prop oneshot decides which rules apply (no mismatch)', () => {
    expect(checkReleaseKind({ kind: undefined, props: { oneshot: '1' }, zip: { files: ['module.prop'] } }).map((i) => i.code)).toEqual(['script-missing-action']);
    expect(checkReleaseKind({ kind: undefined, props: {}, zip: { files: ['module.prop', 'service.sh'] } })).toEqual([]);
  });

  it('script-missing-action: no root action.sh (nested or directory does not count)', () => {
    expect(codes(checkReleaseKind(script({}, ['module.prop', 'bin/action.sh'])))).toEqual(['script-missing-action']);
    const dir = checkReleaseKind(script({}, ['module.prop', 'action.sh/', 'action.sh/x']));
    expect(dir).toMatchObject([{ code: 'script-missing-action', message: expect.stringContaining('is a directory') }]);
  });

  it('script-forbidden-file: every listed root file and directory, root level only', () => {
    const files = ['module.prop', 'action.sh', ...SCRIPT_FORBIDDEN_FILES, ...SCRIPT_FORBIDDEN_DIRS.map((d) => `${d}/x`)];
    const is = checkReleaseKind(script({}, files));
    expect(is.every((i) => i.code === 'script-forbidden-file' && i.severity === 'error')).toBe(true);
    expect(is.map((i) => i.path)).toEqual([...SCRIPT_FORBIDDEN_FILES, ...SCRIPT_FORBIDDEN_DIRS.map((d) => `${d}/`)]);
    // An empty directory entry also counts; nested paths and files named like a directory do not.
    expect(codes(checkReleaseKind(script({}, ['module.prop', 'action.sh', 'webroot/'])))).toEqual(['script-forbidden-file']);
    expect(checkReleaseKind(script({}, ['module.prop', 'action.sh', 'data/service.sh', 'lib/system/x', 'system', 'service.sh.txt']))).toEqual([]);
  });

  it('script-metamodule: module.prop metamodule=1/true', () => {
    expect(codes(checkReleaseKind(script({ props: { oneshot: '1', metamodule: 'True' } })))).toEqual(['script-metamodule']);
    expect(checkReleaseKind(script({ props: { oneshot: '1', metamodule: '0' } }))).toEqual([]);
  });

  it('script-params-invalid: unreadable or invalid params.json, path prefixed', () => {
    expect(checkReleaseKind(script({ zip: { files: ['module.prop', 'action.sh', 'params.json'], paramsJson: { error: 'params.json is not valid UTF-8.' } } }))).toEqual([
      { code: 'script-params-invalid', severity: 'error', message: 'params.json is not valid UTF-8.', path: 'params.json' },
    ]);
    const is = checkReleaseKind(script({ zip: { files: ['module.prop', 'action.sh', 'params.json'], paramsJson: { text: '{"schemaVersion":1,"params":[{"key":"a","type":"bool","label":"x"}],"x":1}' } } }));
    expect(is.map((i) => [i.code, i.severity, i.path])).toEqual([
      ['script-params-invalid', 'warning', 'params.json: x'],
      ['script-params-invalid', 'error', 'params.json: params[0].key'],
    ]);
  });

  it('params-ignored: a module with params.json (warning, not validated)', () => {
    const is = checkReleaseKind({ kind: 'module', props: {}, zip: { files: ['module.prop', 'params.json'], paramsJson: { text: 'not json' } } });
    expect(is).toEqual([{ code: 'params-ignored', severity: 'warning', message: expect.any(String), path: 'params.json' }]);
  });
});
