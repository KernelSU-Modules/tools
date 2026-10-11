import { describe, expect, it } from 'vitest';
import { isMetamoduleProp, parseJavaProperties, parseModuleProp } from '../src/index.ts';
import { VALID_PROP } from './zipwriter.ts';

import { JAVA_PROPERTIES_CORPUS as CORPUS } from './fixtures/java-properties-corpus.ts';

const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);
const withVc = (vc: string) => VALID_PROP.replace('versionCode=123', `versionCode=${vc}`);

describe('parseModuleProp', () => {
  it('parses a valid module.prop', () => {
    const r = parseModuleProp(VALID_PROP);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ id: 'demo.toolbox', name: 'Demo Toolbox', version: 'v1.2.3', versionCode: 123, author: 'Demo' });
    expect(r.value?.props.description).toBe('Utilities for rooted devices');
  });

  it('handles CRLF, comments, blank lines, whitespace and first "=" split', () => {
    const text =
      '# comment\r\nid = demo.toolbox \r\n\r\nname=A=B\r\n  # indented comment\r\nversion=1.0\r\nversionCode=7\r\nauthor=x\r\ndescription=desc = with equals\r\nupdateJson=https://e.org/u.json';
    const r = parseModuleProp(text);
    expect(r.issues).toEqual([]);
    expect(r.value?.id).toBe('demo.toolbox');
    expect(r.value?.name).toBe('A=B');
    expect(r.value?.description).toBe('desc = with equals');
    expect(r.value?.props.updateJson).toBe('https://e.org/u.json');
    expect(r.value?.versionCode).toBe(7);
  });

  it('supports bare CR line endings', () => {
    expect(parseModuleProp(VALID_PROP.replace(/\n/g, '\r')).ok).toBe(true);
  });

  it('reports missing / empty required fields', () => {
    const r = parseModuleProp('id=demo.toolbox\nname=\nversion=1\nversionCode=1\n');
    expect(r.ok).toBe(false);
    expect(r.issues.filter((i) => i.code === 'prop-missing-field').map((i) => i.path)).toEqual(['name', 'author', 'description']);
    expect(r.value).toBeUndefined();
  });

  it('warns on lines without "=" and reads them like ksud (whitespace / ":" separators)', () => {
    const r = parseModuleProp(VALID_PROP + 'garbage line\nupdateJson: https://e.org/u.json\n');
    expect(r.ok).toBe(true);
    expect(r.issues).toMatchObject([
      { code: 'prop-line-invalid', severity: 'warning' },
      { code: 'prop-line-invalid', severity: 'warning' },
    ]);
    expect(r.value?.props.garbage).toBe('line');
    expect(r.value?.props.updateJson).toBe('https://e.org/u.json');
  });

  it('duplicate required key is an error, other keys a warning; the last one wins (ksud HashMap)', () => {
    const r1 = parseModuleProp(VALID_PROP + 'versionCode=999\n');
    expect(r1.issues).toMatchObject([{ code: 'prop-duplicate-key', severity: 'error' }]);
    expect(r1.ok).toBe(false);
    const r2 = parseModuleProp(VALID_PROP + 'foo=1\nfoo=2\n');
    expect(r2.ok).toBe(true);
    expect(r2.issues).toMatchObject([{ code: 'prop-duplicate-key', severity: 'warning' }]);
    expect(r2.value?.props.foo).toBe('2');
  });

  // Audit B1 reproductions: spoofing through java-properties syntax the old key=value parser ignored.
  it.each([
    ['escaped key', 'i\\u0064=evil\n'],
    ['colon separator', 'id:evil\n'],
    ['whitespace separator', 'id evil\n'],
    ['leading whitespace', '   id=evil\n'],
    ['line continuation', 'i\\\n  d=evil\n'],
  ])('a spoofed duplicate id via %s is an error and resolves like ksud', (_label, extra) => {
    const r = parseModuleProp(VALID_PROP + extra);
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === 'prop-duplicate-key')).toMatchObject({ severity: 'error' });
  });

  it('continuation hides the following line inside the previous value (as ksud does)', () => {
    const r = parseModuleProp(VALID_PROP.replace('description=Utilities for rooted devices', 'description=d \\') + 'id=evil\n');
    expect(r.issues.map((i) => i.code)).toEqual([]);
    expect(r.value?.description).toBe('d id=evil');
    expect(r.value?.id).toBe('demo.toolbox');
  });

  it('a malformed \\u escape (ksud aborts) is an error, also inside comments', () => {
    expect(codes(parseModuleProp(VALID_PROP + 'x=\\u12\n'))).toEqual(['prop-syntax']);
    expect(codes(parseModuleProp(VALID_PROP + '# see \\uZZZZ\n'))).toEqual(['prop-syntax']);
    expect(codes(parseModuleProp(VALID_PROP + 'x=\\uD800\n'))).toEqual(['prop-syntax']);
  });

  it('decodes escapes in keys and values', () => {
    const r = parseModuleProp(VALID_PROP.replace('name=Demo Toolbox', 'n\\u0061me=Caf\\u00e9\\tX'));
    expect(r.ok).toBe(true);
    expect(r.value?.name).toBe('Caf\u00e9\tX');
  });

  it('warns when a trailing continuation at EOF drops the last line', () => {
    const r = parseModuleProp(VALID_PROP + 'foo=bar\\');
    expect(r.issues).toMatchObject([{ code: 'prop-line-invalid', severity: 'warning' }]);
    expect(r.value?.props.foo).toBeUndefined();
  });

  it(`matches the Rust java-properties crate on ${CORPUS.length} corpus inputs`, () => {
    const mismatches: string[] = [];
    for (const c of CORPUS) {
      const r = parseJavaProperties(c.input);
      const got = { pairs: r.pairs.map((p) => [p.key, p.value]), errorLine: r.error?.line ?? null };
      if (JSON.stringify(got) !== JSON.stringify({ pairs: c.pairs, errorLine: c.errorLine })) mismatches.push(JSON.stringify(c.input));
    }
    expect(mismatches).toEqual([]);
  });

  it.each([
    ['1', true],
    [' TRUE \t', true],
    ['True', true],
    ['0', false],
    ['yes', false],
    ['', false],
  ])('metamodule=%j -> %s (ksud is_metamodule)', (v, want) => {
    expect(isMetamoduleProp({ metamodule: v })).toBe(want);
  });

  it.each(['1', '2147483647', '0042'])('versionCode %s is valid', (vc) => {
    const r = parseModuleProp(withVc(vc));
    expect(r.ok).toBe(true);
    expect(r.value?.versionCode).toBe(Number(vc));
  });

  it.each(['0', '-1', '2147483648', '99999999999999999999999', '-0'])('versionCode %s is out of range', (vc) => {
    expect(codes(parseModuleProp(withVc(vc)))).toEqual(['prop-versioncode-range']);
  });

  it.each(['1.0', '0x10', '1e3', 'abc', '+5', '12a'])('versionCode %s is invalid', (vc) => {
    expect(codes(parseModuleProp(withVc(vc)))).toEqual(['prop-versioncode-invalid']);
  });

  it.each(['1abc', 'a', 'bad id', 'x/y', 'a'.repeat(65)])('id %j is invalid', (id) => {
    expect(codes(parseModuleProp(VALID_PROP.replace('id=demo.toolbox', `id=${id}`)))).toEqual(['prop-id-invalid']);
  });

  it('does not use prototype keys', () => {
    const r = parseModuleProp(VALID_PROP + '__proto__=x\nconstructor=y\n');
    expect(r.ok).toBe(true);
    expect(r.value?.props.__proto__).toBe('x');
    expect(Object.getPrototypeOf(r.value!.props)).toBe(Object.prototype);
  });
});
