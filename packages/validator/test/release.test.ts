import { describe, expect, it } from 'vitest';
import { checkReleaseEligibility, compareWithLocked, globMatch, selectAsset, type ReleaseLike } from '../src/index.ts';

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);
const REPO = 'Demo-Org/toolbox';
const asset = (name: string, over: Partial<ReleaseLike['assets'][number]> = {}) => ({
  id: name.length,
  name,
  size: 100,
  digest: 'sha256:' + '0'.repeat(64),
  browser_download_url: `https://github.com/${REPO}/releases/download/v1.0/${encodeURIComponent(name)}`,
  state: 'uploaded',
  ...over,
});
const release = (over: Partial<ReleaseLike> = {}): ReleaseLike => ({
  id: 1,
  tag_name: 'v1.0',
  draft: false,
  prerelease: false,
  immutable: true,
  published_at: '2026-10-01T00:00:00Z',
  assets: [asset('demo.toolbox-1.zip')],
  ...over,
});

describe('globMatch', () => {
  it.each([
    ['*.zip', 'a.zip', true],
    ['*.zip', '.zip', true],
    ['*.zip', 'a.zip.sha256', false],
    ['*.zip', 'A.ZIP', false],
    ['demo-*-?.zip', 'demo-1.0-a.zip', true],
    ['demo-*-?.zip', 'demo-1.0-ab.zip', false],
    ['demo-?.zip', 'demo-é.zip', true],
    ['*', '', true],
    ['', '', true],
    ['', 'a', false],
    ['a*b*c', 'axxbyyc', true],
    ['a*b*c', 'axxbyycd', false],
    ['[ab].zip', '[ab].zip', true],
    ['[ab].zip', 'a.zip', false],
    ['a.zip', 'abzip', false],
    ['**a', 'bbba', true],
  ])('%j vs %j -> %s', (p, n, want) => {
    expect(globMatch(p, n)).toBe(want);
  });

  it('is not catastrophically slow', () => {
    const t = Date.now();
    expect(globMatch('*a*a*a*a*a*a*a*a*b', 'a'.repeat(2000))).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe('selectAsset', () => {
  it('picks the only .zip without a pattern (case-insensitive extension)', () => {
    const r = selectAsset(release({ assets: [asset('notes.txt'), asset('Module.ZIP')] }));
    expect(r.ok).toBe(true);
    expect(r.value?.name).toBe('Module.ZIP');
  });

  it('zero assets', () => {
    expect(codes(selectAsset(release({ assets: [] })).issues)).toEqual(['asset-none']);
    expect(codes(selectAsset(release({ assets: [asset('a.tar.gz')] })).issues)).toEqual(['asset-none']);
  });

  it('multiple zips', () => {
    const r = selectAsset(release({ assets: [asset('a.zip'), asset('b.zip')] }));
    expect(codes(r.issues)).toEqual(['asset-multiple']);
    expect(r.issues[0]!.message).toContain('a.zip, b.zip');
  });

  it('assetPattern selects one of many', () => {
    const r = selectAsset(release({ assets: [asset('demo-1.zip'), asset('demo-debug-1.zip'), asset('demo-1.zip.sha256')] }), 'demo-?.zip');
    expect(r.value?.name).toBe('demo-1.zip');
  });

  it('assetPattern with no / several matches', () => {
    expect(codes(selectAsset(release(), 'other-*.zip').issues)).toEqual(['asset-none']);
    expect(codes(selectAsset(release({ assets: [asset('d-1.zip'), asset('d-2.zip')] }), 'd-*.zip').issues)).toEqual(['asset-multiple']);
  });

  it('invalid assetPattern', () => {
    expect(codes(selectAsset(release(), 'dir/*.zip').issues)).toEqual(['asset-pattern-invalid']);
    expect(codes(selectAsset(release(), '').issues)).toEqual(['asset-pattern-invalid']);
  });
});

describe('checkReleaseEligibility', () => {
  it('accepts an immutable published release', () => {
    expect(checkReleaseEligibility(release(), REPO)).toEqual([]);
  });

  it('owner/repo comparison is case-insensitive', () => {
    expect(checkReleaseEligibility(release(), 'demo-org/TOOLBOX')).toEqual([]);
  });

  it('draft', () => {
    expect(codes(checkReleaseEligibility(release({ draft: true, published_at: null }), REPO))).toEqual(['release-draft']);
  });

  it('unpublished', () => {
    expect(codes(checkReleaseEligibility(release({ published_at: null }), REPO))).toEqual(['release-not-published']);
  });

  it.each([false, undefined])('immutable=%s', (immutable) => {
    expect(codes(checkReleaseEligibility(release({ immutable }), REPO))).toEqual(['release-not-immutable']);
  });

  it('asset not uploaded', () => {
    expect(codes(checkReleaseEligibility(release({ assets: [asset('a.zip', { state: 'starter' })] }), REPO))).toEqual(['asset-not-uploaded']);
  });

  it.each([
    'https://github.com/evil/toolbox/releases/download/v1.0/a.zip',
    'https://github.com/Demo-Org/toolbox2/releases/download/v1.0/a.zip',
    'http://github.com/Demo-Org/toolbox/releases/download/v1.0/a.zip',
    'https://github.com.evil.com/Demo-Org/toolbox/releases/download/v1.0/a.zip',
    'https://evil.com/Demo-Org/toolbox/releases/download/v1.0/a.zip',
    'https://objects.githubusercontent.com/Demo-Org/toolbox/releases/download/v1.0/a.zip',
    'https://github.com/Demo-Org/toolbox/archive/v1.0.zip',
    'https://github.com/Demo-Org/toolbox/releases/download/a.zip',
    'https://github.com/Demo-Org/toolbox/releases/download/v1.0/a.zip?x=1',
    'https://user@github.com/Demo-Org/toolbox/releases/download/v1.0/a.zip',
    'https://github.com:8443/Demo-Org/toolbox/releases/download/v1.0/a.zip',
    'not a url',
  ])('bad url %s', (url) => {
    expect(codes(checkReleaseEligibility(release({ assets: [asset('a.zip', { browser_download_url: url })] }), REPO))).toEqual([
      'asset-url-invalid',
    ]);
  });
});

describe('compareWithLocked', () => {
  it('orders by versionCode only', () => {
    expect(compareWithLocked(5, null)).toBe('newer');
    expect(compareWithLocked(5, { versionCode: 4 })).toBe('newer');
    expect(compareWithLocked(5, { versionCode: 5 })).toBe('same');
    expect(compareWithLocked(5, { versionCode: 6 })).toBe('older');
  });
});
