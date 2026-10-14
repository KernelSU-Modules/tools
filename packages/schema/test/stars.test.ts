import { describe, expect, it } from 'vitest';
import { ApiModuleSummary, MANIFEST_KNOWN_KEYS, ModuleLock, ModuleManifest } from '../src/index.ts';

describe('stars', () => {
  const lock = {
    id: 'x.y', repositoryId: 1, fullName: 'a/b', installationId: null, content: null, stable: null, prerelease: null, releases: [], seen: {},
    maxVersionCode: null, maxStableVersionCode: null,
    health: { status: 'error', installation: 'present', lastAttemptAt: '2026-10-10T00:00:00Z', lastSuccessAt: null, message: null },
  };
  const stars = { count: 12, fetchedAt: '2026-10-10T00:00:00Z', repositoryId: 1, fullName: 'a/b', verified: 'self' };

  it('lock: stars is optional and strict', () => {
    expect(ModuleLock.safeParse(lock).success).toBe(true);
    expect(ModuleLock.parse({ ...lock, stars }).stars).toEqual(stars);
    const other = { ...stars, repositoryId: 2, fullName: 'a/old', verified: 'owner', requested: 'a/old' };
    expect(ModuleLock.parse({ ...lock, stars: other }).stars).toEqual(other);
    const rejected = { ...stars, requested: 'x/popular', problem: 'is private' };
    expect(ModuleLock.parse({ ...lock, stars: rejected }).stars).toEqual(rejected);
    expect(ModuleLock.safeParse({ ...lock, stars: { ...stars, count: -1 } }).success).toBe(false);
    expect(ModuleLock.safeParse({ ...lock, stars: { ...stars, verified: 'trust-me' } }).success).toBe(false);
    expect(ModuleLock.safeParse({ ...lock, stars: { count: 1, fetchedAt: '2026-10-10T00:00:00Z' } }).success).toBe(false);
    expect(ModuleLock.safeParse({ ...lock, stars: { ...stars, x: 1 } }).success).toBe(false);
    expect(ModuleLock.safeParse({ ...lock, stars: null }).success).toBe(false);
  });

  it('api: stars / starsRepository are optional and nullable', () => {
    const summary = {
      id: 'x.y', name: 'X', summary: '', authors: [{ name: 'a', url: 'https://github.com/a' }], tags: [], metamodule: false, kind: 'module', icon: null,
      stable: { version: '1', versionCode: 1, publishedAt: '2026-10-10T00:00:00Z' }, detail: 'api/v1/modules/x.y.json', updatedAt: '2026-10-10T00:00:00Z',
    };
    expect(ApiModuleSummary.safeParse(summary).success).toBe(true);
    expect(ApiModuleSummary.parse({ ...summary, stars: null, starsRepository: null }).stars).toBeNull();
    expect(ApiModuleSummary.parse({ ...summary, stars: 1200, starsRepository: 'a/b' })).toMatchObject({ stars: 1200, starsRepository: 'a/b' });
    expect(ApiModuleSummary.safeParse({ ...summary, stars: 1.5 }).success).toBe(false);
    expect(ApiModuleSummary.safeParse({ ...summary, stars: -3 }).success).toBe(false);
  });

  it('manifest: starsRepository is "owner/name"', () => {
    const base = { schemaVersion: 1, id: 'x.y', name: 'X', summary: 'S', description: 'README.md' };
    expect(MANIFEST_KNOWN_KEYS.root).toContain('starsRepository');
    expect(ModuleManifest.parse({ ...base, starsRepository: ' LSPosed/LSPosed ' }).starsRepository).toBe('LSPosed/LSPosed');
    for (const ok of ['a/b', 'a-b/c.d_e-f', 'A1/x.github.io']) expect(ModuleManifest.safeParse({ ...base, starsRepository: ok }).success, ok).toBe(true);
    for (const bad of ['a', 'a/b/c', '-a/b', 'a/', '/b', 'a/..', 'a/.', 'https://github.com/a/b', 'a b/c', 'a_b/c'])
      expect(ModuleManifest.safeParse({ ...base, starsRepository: bad }).success, bad).toBe(false);
  });
});
