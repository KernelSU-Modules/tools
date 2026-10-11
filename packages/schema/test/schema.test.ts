import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY, ModuleId, ModuleLock, ModuleManifest, Policy, RegistryRecord, RegistryStatus, RelativePath, canonicalJson, foldId,
} from '../src/index.ts';

describe('schema', () => {
  it('DEFAULT_POLICY is a valid Policy', () => {
    expect(Policy.safeParse(DEFAULT_POLICY).success).toBe(true);
  });

  it('module id follows the ksud rule', () => {
    for (const ok of ['zygisksu', 'demo.toolbox', 'a_b-c.d', 'Ab']) expect(ModuleId.safeParse(ok).success).toBe(true);
    for (const bad of ['1abc', 'a', '-x', 'a b', 'a/b', '']) expect(ModuleId.safeParse(bad).success).toBe(false);
    expect(foldId('Demo.Toolbox')).toBe('demo.toolbox');
  });

  it('relative paths reject traversal and absolute forms', () => {
    for (const ok of ['README.md', 'docs/zh-CN.md', 'assets/icon.png']) expect(RelativePath.safeParse(ok).success).toBe(true);
    for (const bad of ['/etc/passwd', '../x', 'a/../b', 'a\\b', 'https://x/y', 'a//b', './a']) expect(RelativePath.safeParse(bad).success).toBe(false);
  });

  it('manifest: single language, normalized, lenient about unknown fields', () => {
    const base = { schemaVersion: 1, id: 'demo.toolbox', name: 'n', summary: 's', description: 'README.md' };
    expect(ModuleManifest.safeParse(base).success).toBe(true);
    expect(ModuleManifest.safeParse({ ...base, summary: undefined }).success).toBe(false);
    expect(ModuleManifest.safeParse({ ...base, name: 'x'.repeat(100), summary: 'y'.repeat(500) }).success).toBe(true);
    expect(ModuleManifest.safeParse({ ...base, name: 'x'.repeat(101) }).success).toBe(false);
    const r = ModuleManifest.parse({ ...base, description: './docs/a.md', icon: './icon.png', tags: [' Root ', 'System-Tools'], version: '1.0', locales: {} });
    expect(r).toMatchObject({ description: 'docs/a.md', icon: 'icon.png', tags: ['root', 'system-tools'] });
    expect('version' in r).toBe(false);
    expect(ModuleManifest.safeParse({ ...base, description: '../x.md' }).success).toBe(false);
    expect(ModuleManifest.safeParse({ ...base, homepage: 'http://example.org' }).success).toBe(true);
    expect(ModuleManifest.safeParse({ ...base, homepage: 'ftp://example.org' }).success).toBe(false);
    expect(ModuleManifest.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
  });

  it('record status requires source / request', () => {
    const now = '2026-10-10T00:00:00Z';
    const source = { host: 'github', repositoryId: 1, ownerId: 2, fullName: 'a/b' };
    expect(RegistryRecord.safeParse({ id: 'x.y', status: 'listed', createdAt: now, updatedAt: now }).success).toBe(false);
    expect(RegistryRecord.safeParse({ id: 'x.y', status: 'listed', source, createdAt: now, updatedAt: now }).success).toBe(true);
    expect(RegistryRecord.safeParse({ id: 'x.y', status: 'archived', createdAt: now, updatedAt: now }).success).toBe(false);
    expect(RegistryRecord.safeParse({ id: 'x.y', status: 'unknown', createdAt: now, updatedAt: now }).success).toBe(false);
    expect(RegistryRecord.safeParse({ id: 'x.y', status: 'pending', createdAt: now, updatedAt: now }).success).toBe(false);
  });

  it('lock entries require the high-water marks (nullable) and reject unknown fields', () => {
    const base = {
      id: 'x.y', repositoryId: 1, fullName: 'a/b', installationId: null, content: null, stable: null, prerelease: null, releases: [], seen: {},
      health: { status: 'error', installation: 'present', lastAttemptAt: '2026-10-10T00:00:00Z', lastSuccessAt: null, message: null },
    };
    expect(ModuleLock.safeParse(base).success).toBe(false);
    const m = ModuleLock.parse({ ...base, maxVersionCode: null, maxStableVersionCode: null });
    expect(m.maxVersionCode).toBeNull();
    expect(m.maxStableVersionCode).toBeNull();
    expect(ModuleLock.safeParse({ ...base, maxVersionCode: 5, maxStableVersionCode: null, unknownField: null }).success).toBe(false);
  });

  it('status + canonical JSON', () => {
    expect(RegistryStatus.safeParse({ schemaVersion: 1, modules: {} }).success).toBe(true);
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: undefined, x: 2 }], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      {\n        "x": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });
});
