import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@kernelsu-modules/schema';
import { checkModuleId } from '../src/index.ts';

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('checkModuleId', () => {
  it('accepts a normal id', () => {
    expect(checkModuleId('demo.toolbox', DEFAULT_POLICY, ['other', 'demo.toolbox'])).toEqual([]);
  });

  it.each(['a', '1abc', '_x', 'has space', 'a/b', 'a'.repeat(65), ''])('format: %j', (id) => {
    expect(codes(checkModuleId(id, DEFAULT_POLICY))).toEqual(['id-invalid']);
  });

  it.each(['ksu', 'KernelSU', 'MAGISK', 'org.kernelsu.foo', 'Org.KernelSU.Bar', 'me.weishu.x', 'org.kernelsu'])('reserved: %s', (id) => {
    expect(codes(checkModuleId(id, DEFAULT_POLICY))).toEqual(['id-reserved']);
  });

  it('reports reserved rules and collisions together', () => {
    expect(codes(checkModuleId('magisk', DEFAULT_POLICY, ['Magisk']))).toEqual(['id-reserved', 'id-collision']);
  });

  it('detects case-fold collisions but not identical ids', () => {
    expect(codes(checkModuleId('Demo.Toolbox', DEFAULT_POLICY, new Set(['demo.toolbox'])))).toEqual(['id-collision']);
    expect(checkModuleId('demo.toolbox', DEFAULT_POLICY, new Set(['demo.toolbox']))).toEqual([]);
  });

  it.each(['foo.json', 'Foo.JSON', 'a.html', 'a.htm', 'readme.md', 'x.xml', 'x.txt'])('reserved file suffix: %s', (id) => {
    expect(codes(checkModuleId(id, DEFAULT_POLICY, []))).toEqual(['id-reserved-suffix']);
  });

  it('a reserved prefix with a file suffix reports both', () => {
    expect(codes(checkModuleId('org.kernelsu.x.json', DEFAULT_POLICY))).toEqual(['id-reserved-suffix', 'id-reserved']);
  });

  it('file suffixes only count at the end', () => {
    expect(checkModuleId('json.tools', DEFAULT_POLICY)).toEqual([]);
    expect(checkModuleId('foo.jsonx', DEFAULT_POLICY)).toEqual([]);
    expect(checkModuleId('foo-json', DEFAULT_POLICY)).toEqual([]);
  });

  it('kernelsu-like but not reserved ids pass', () => {
    expect(checkModuleId('org.kernelsux', DEFAULT_POLICY)).toEqual([]);
    expect(checkModuleId('ksu_tools', DEFAULT_POLICY)).toEqual([]);
  });
});
