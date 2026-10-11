// Regenerates the binary fixture images, data/sources.lock.json and the pre-seeded cache.
// Run after editing any fixture repo file:  pnpm exec tsx test/fixtures/regen.ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const repo = (r: string, p: string) => path.join(here, 'repos', r, p);

export const COMMITS = {
  toolbox: '1'.repeat(40),
  toolboxTag120: 'a'.repeat(40),
  toolboxTag110: 'b'.repeat(40),
  toolboxTag130: 'c'.repeat(40),
  metaOld: '2'.repeat(40),
  metaNew: '3'.repeat(40),
  metaTag: 'e'.repeat(40),
  suspended: '4'.repeat(40),
  nostable: '5'.repeat(40),
  collide: '6'.repeat(40),
  noauthor: '7'.repeat(40),
};

/** Fixture repositories served by fake-net at their locked content commit. */
export const REPO_COMMITS: Record<string, string> = {
  'demo/toolbox': COMMITS.toolbox,
  'demo/collide': COMMITS.collide,
  'demo/noauthor': COMMITS.noauthor,
};

/** path -> sha256 of fixture repository files (content.files). */
export function repoFiles(r: string, list: string[]): Record<string, string> {
  return Object.fromEntries(list.map((p) => [p, sha(readFileSync(repo(r, p)))]));
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

function main(): void {
  writeFileSync(repo('demo/toolbox', 'assets/icon.png'), PNG);
  writeFileSync(repo('demo/toolbox', 'assets/shot.png'), Buffer.concat([PNG, Buffer.from('shot')]));
  writeFileSync(path.join(here, 'web/img.example.com/photo.jpg'), JPG);

  const toolboxFiles = repoFiles('demo/toolbox', ['module.yaml', 'README.md', 'assets/icon.png', 'assets/shot.png']);
  const metaFiles = repoFiles('demo/meta', ['module.yaml', 'README.md', 'icon.svg']);

  const asset = (id: number, name: string, full: string, tag: string) => ({
    id,
    name,
    url: `https://github.com/${full}/releases/download/${tag}/${name}`,
    size: 12345 + id,
    sha256: sha(`${full}:${name}`),
    digest: `sha256:${sha(`${full}:${name}`)}`,
  });
  const rel = (o: {
    id: number; full: string; tag: string; commit: string; version: string; vc: number; pre: boolean; at: string; body: string | null;
  }) => ({
    releaseId: o.id,
    tag: o.tag,
    tagCommit: o.commit,
    name: o.tag,
    body: o.body,
    prerelease: o.pre,
    publishedAt: o.at,
    htmlUrl: `https://github.com/${o.full}/releases/tag/${o.tag}`,
    immutable: true as const,
    asset: asset(o.id + 100, `${o.full.split('/')[1]}-${o.version}.zip`, o.full, o.tag),
    version: o.version,
    versionCode: o.vc,
    prop: { id: o.full, version: o.version, versionCode: String(o.vc) },
  });
  const health = (status: 'ok' | 'stale' | 'error', at: string) => ({
    status,
    installation: 'present' as const,
    lastAttemptAt: at,
    lastSuccessAt: status === 'error' ? null : at,
    message: null,
  });

  const t120 = rel({
    id: 120, full: 'demo/toolbox', tag: 'v1.2.0', commit: COMMITS.toolboxTag120, version: '1.2.0', vc: 120, pre: false,
    at: '2026-10-01T10:00:00Z',
    body: '### Changes\n- Fixed <img src=x onerror=alert(1)>\n- New [docs](docs/zh-CN.md)\n\n![shot](https://img.example.com/photo.jpg)\n![gone](https://gone.example.com/x.png)',
  });
  const t110 = rel({ id: 110, full: 'demo/toolbox', tag: 'v1.1.0', commit: COMMITS.toolboxTag110, version: '1.1.0', vc: 110, pre: false, at: '2026-09-01T10:00:00Z', body: null });
  const t130 = rel({ id: 130, full: 'demo/toolbox', tag: 'v1.3.0-beta', commit: COMMITS.toolboxTag130, version: '1.3.0-beta', vc: 130, pre: true, at: '2026-10-05T10:00:00Z', body: 'Beta notes' });
  const m1 = rel({ id: 210, full: 'demo/meta', tag: 'v2.0', commit: COMMITS.metaTag, version: '2.0', vc: 200, pre: false, at: '2026-09-15T00:00:00Z', body: 'Meta release' });
  const s1 = rel({ id: 310, full: 'demo/suspended', tag: 'v1', commit: COMMITS.suspended, version: '1', vc: 1, pre: false, at: '2026-08-15T00:00:00Z', body: null });

  const lock = {
    schemaVersion: 1,
    modules: {
      'demo.meta': {
        id: 'demo.meta', repositoryId: 1002, fullName: 'demo/meta', installationId: 7002,
        // The new content commit is not fetchable in the tests -> stale fallback to the cached last good commit.
        content: { ref: 'main', commit: COMMITS.metaNew, fetchedAt: '2026-10-08T00:00:00Z', manifestPath: 'module.yaml', files: { ...metaFiles, 'README.md': sha('new readme') } },
        stable: m1, prerelease: null, maxVersionCode: 200, maxStableVersionCode: 200, releases: [m1], seen: { '210': { ok: true, checkedAt: '2026-09-15T00:10:00Z' } },
        health: health('ok', '2026-10-09T12:00:00Z'),
      },
      'demo.nostable': {
        id: 'demo.nostable', repositoryId: 1003, fullName: 'demo/nostable', installationId: 7003,
        // Stable release deleted: maxStableVersionCode stays, stable is null -> module hidden.
        content: null, stable: null, prerelease: null, maxVersionCode: 50, maxStableVersionCode: 50, releases: [], seen: {}, health: health('error', '2026-10-09T12:00:00Z'),
      },
      'demo.suspended': {
        id: 'demo.suspended', repositoryId: 1004, fullName: 'demo/suspended', installationId: 7004,
        content: { ref: 'main', commit: COMMITS.suspended, fetchedAt: '2026-08-15T00:00:00Z', manifestPath: 'module.yaml', files: {} },
        stable: s1, prerelease: null, maxVersionCode: 1, maxStableVersionCode: 1, releases: [s1], seen: {}, health: health('ok', '2026-09-19T00:00:00Z'),
      },
      'demo.toolbox': {
        id: 'demo.toolbox', repositoryId: 1001, fullName: 'demo/toolbox', installationId: 7001,
        content: { ref: 'main', commit: COMMITS.toolbox, fetchedAt: '2026-10-02T00:00:00Z', manifestPath: 'module.yaml', files: toolboxFiles },
        stable: t120, prerelease: t130, maxVersionCode: 130, maxStableVersionCode: 120, releases: [t130, t120, t110],
        seen: { '110': { ok: true, checkedAt: '2026-09-01T10:05:00Z' }, '120': { ok: true, checkedAt: '2026-10-01T10:05:00Z' }, '130': { ok: true, checkedAt: '2026-10-05T10:05:00Z' } },
        health: health('ok', '2026-10-09T12:00:00Z'),
        stars: { count: 1234, fetchedAt: '2026-10-09T12:00:00Z', repositoryId: 1001, fullName: 'demo/toolbox', verified: 'self' },
      },
    },
  };
  writeFileSync(path.join(here, 'data/sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');

  // Pre-seeded cache: last good content of demo.meta (old commit) with its blobs.
  const cache = path.join(here, 'cache');
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(path.join(cache, 'blobs'), { recursive: true });
  mkdirSync(path.join(cache, 'modules'), { recursive: true });
  for (const p of Object.keys(metaFiles)) writeFileSync(path.join(cache, 'blobs', metaFiles[p]!), readFileSync(repo('demo/meta', p)));
  writeFileSync(
    path.join(cache, 'modules', 'demo.meta.json'),
    JSON.stringify({ repositoryId: 1002, fullName: 'demo/meta', commit: COMMITS.metaOld, manifestPath: 'module.yaml', files: metaFiles }, null, 2) + '\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
