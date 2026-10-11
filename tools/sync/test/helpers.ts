import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { GitHubApp } from '@kernelsu-modules/github';
import { DEFAULT_POLICY, type OpenRequest, type RegistryRecord, type RegistryStatus, type SourcesLock } from '@kernelsu-modules/schema';
import { memoryLogger } from '../src/log.ts';
import { runSync, type SyncOptions } from '../src/sync.ts';
import { FakeGitHub, testPrivateKey, type FakeRepo } from './fake-github.ts';

export const T0 = new Date('2026-10-10T00:00:00Z');

export function record(id: string, repo: { id: number; fullName: string; ownerId: number }, status: RegistryRecord['status'] = 'listed'): RegistryRecord {
  const source = { host: 'github' as const, repositoryId: repo.id, ownerId: repo.ownerId, fullName: repo.fullName, manifestPath: 'module.yaml' };
  const base = { id, status, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  if (status === 'pending')
    return { ...base, request: { submissionId: 'abcdefghij', kind: 'submit', source, submittedBy: 5, submittedAt: '2026-10-01T00:00:00Z' } };
  return { ...base, source };
}

type RepoRef = { id: number; fullName: string; ownerId: number };
const sourceOf = (repo: RepoRef) => ({ host: 'github' as const, repositoryId: repo.id, ownerId: repo.ownerId, fullName: repo.fullName, manifestPath: 'module.yaml' });

/** Add an open request (submit / transfer) for `repo` to a record. */
export function withRequest(r: RegistryRecord, kind: OpenRequest['kind'], repo: RepoRef, submissionId = 'reqabcdefg'): RegistryRecord {
  return { ...r, request: { submissionId, kind, source: sourceOf(repo), submittedBy: 5, submittedAt: '2026-10-01T00:00:00Z' } };
}

export async function makeDataDir(records: RegistryRecord[], extra: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kernelsu-sync-'));
  await mkdir(join(dir, 'modules'));
  await writeFile(join(dir, 'policy.yaml'), YAML.stringify(DEFAULT_POLICY, { lineWidth: 0 }));
  for (const r of records) await writeFile(join(dir, 'modules', `${r.id}.yaml`), YAML.stringify(r, { lineWidth: 0 }));
  for (const [p, c] of Object.entries(extra)) await writeFile(join(dir, p), c);
  return dir;
}

export async function readLock(dir: string): Promise<SourcesLock> {
  return JSON.parse(await readFile(join(dir, 'sources.lock.json'), 'utf8'));
}

export async function readStatus(dir: string): Promise<RegistryStatus> {
  return JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
}

export async function writeRecord(dir: string, r: RegistryRecord): Promise<void> {
  await writeFile(join(dir, 'modules', `${r.id}.yaml`), YAML.stringify(r, { lineWidth: 0 }));
}

export function manifestYaml(id: string, extra = ''): string {
  return `schemaVersion: 1
id: ${id}
name: Demo
summary: A demo module
description: README.md
icon: assets/icon.png
${extra}`;
}

export function goodContent(id: string): Record<string, string | Uint8Array> {
  return {
    'module.yaml': manifestYaml(id),
    'README.md': '# Demo\n\n![shot](docs/shot.png)\n',
    'docs/shot.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]),
    'assets/icon.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  };
}

/** A fake with one installed repo + content commit on main. */
export function setupRepo(gh: FakeGitHub, id: string, repoId = 101): { repo: FakeRepo; commit: string } {
  const repo = gh.addRepo({ id: repoId, fullName: `demo/${id}`, ownerId: 9, defaultBranch: 'main', branches: {}, commits: {} });
  gh.installations.set(repoId, 500 + repoId);
  const commit = gh.commit(repo, goodContent(id));
  return { repo, commit };
}

export async function run(gh: FakeGitHub, dataDir: string, o: Partial<SyncOptions> = {}, now = T0) {
  const log = memoryLogger();
  const key = testPrivateKey();
  const report = await runSync(
    { dataDir, mode: 'write', modulesAppId: 1, ...o },
    {
      fetch: gh.fetch,
      modulesApp: new GitHubApp({ appId: 1, privateKey: key }, { fetch: gh.fetch, sleep: async () => {} }),
      botApp: new GitHubApp({ appId: 2, privateKey: key }, { fetch: gh.fetch, sleep: async () => {} }),
      log,
      now: () => now,
    },
  );
  return { report, log };
}
