/* MOCK-ONLY: fixtures for `pnpm dev:mock`. Never imported by production builds. */
import type {
  AdminModuleStatus,
  BannedEntry,
  Maintainer,
  ModuleStatus,
  MyModule,
  PrecheckResult,
  QueueItem,
  Repo,
  RequestCheck,
  Source,
  SyncHealth,
  SyncStable,
  WorkflowRun,
} from '../api/types.ts';

export const MOCK_MARKER = '__KSU_PORTAL_MOCK_FIXTURES__';

export const USERS = {
  developer: { id: 1001, login: 'alice', avatarUrl: '' },
  maintainer: { id: 2001, login: 'kernelsu-maintainer', avatarUrl: '' },
};

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
const sha = (seed: string) => (seed.repeat(40) + '0'.repeat(64)).replace(/[^0-9a-f]/g, 'a').slice(0, 40);

export function repo(id: number, fullName: string, extra: Partial<Repo> = {}): Repo {
  return { repositoryId: id, fullName, private: false, defaultBranch: 'main', installationId: 5000 + (id % 7), isAdmin: true, registeredId: null, ...extra };
}

export const initialRepos = (): Repo[] => [
  repo(100001, 'alice/toolbox', { registeredId: 'demo.toolbox' }),
  repo(100002, 'alice/zygisk-assistant'),
  repo(100003, 'alice/battery-saver'),
  repo(100004, 'bob-org/shared-mod', { isAdmin: false }),
  repo(100005, 'alice/private-mod', { private: true }),
  repo(100006, 'alice/systemless-hosts'),
  repo(100007, 'alice/new-home'),
  repo(100008, 'alice/pending-mod', { registeredId: 'pending.mod' }),
  repo(100009, 'alice/old-mod', { registeredId: 'old.mod' }),
  repo(100010, 'alice/net-tools', { registeredId: 'net.stale', defaultBranch: 'master' }),
  repo(100011, 'alice/broken', { registeredId: 'broken.install' }),
  repo(100012, 'alice/spam-thing', { registeredId: 'spam.thing' }),
  repo(100013, 'alice/suspended', { registeredId: 'suspended.mod' }),
  repo(100014, 'alice/move-me', { registeredId: 'move.me' }),
];

export function src(r: Repo, ownerId = 1001): Source {
  return { host: 'github', repositoryId: r.repositoryId, ownerId, fullName: r.fullName, manifestPath: 'module.yaml' };
}

export function release(version: string, versionCode: number, minutes: number): SyncStable {
  return { tag: `v${version}`, version, versionCode, publishedAt: ago(minutes) };
}

/** status.json entry (what the sync job writes; the Portal never reads sources.lock.json). */
export function syncStatus(r: Repo, health: SyncHealth, opts: Partial<ModuleStatus> = {}): ModuleStatus {
  return {
    repositoryId: r.repositoryId,
    fullName: r.fullName,
    health,
    installation: 'present',
    lastSuccessAt: health === 'error' ? null : health === 'stale' ? ago(60 * 26) : ago(4),
    message: null,
    contentCommit: health === 'error' ? null : sha(String(r.repositoryId)),
    stable: null,
    maxVersionCode: opts.stable?.versionCode ?? null,
    request: null,
    ...opts,
  };
}

export function requestCheck(submissionId: string, repositoryId: number, ok: boolean, minutes = 5): RequestCheck {
  return {
    submissionId,
    repositoryId,
    ok,
    checkedAt: ago(minutes),
    latestTag: ok ? 'v1.0.0' : 'v0.3',
    issues: ok ? [] : [{ code: 'release-not-immutable', severity: 'error' }, { code: 'prop-syntax', severity: 'warning' }],
  };
}

export function initialModules(repos: Repo[]): MyModule[] {
  const r = (id: number) => repos.find((x) => x.repositoryId === id)!;
  return [
    {
      id: 'demo.toolbox',
      status: 'listed',
      source: src(r(100001)),
      review: { submissionId: 'k7q2m9x4ta', kind: 'submit', submittedBy: 1001, submittedAt: ago(60 * 24 * 40), decision: 'approved', decidedBy: 2001, decidedVia: 'telegram', decidedAt: ago(60 * 24 * 39), reason: null },
      sync: syncStatus(r(100001), 'ok', { stable: release('1.4.2', 142, 60 * 30) }),
    },
    {
      id: 'net.stale',
      status: 'listed',
      source: { ...src(r(100010)), ref: 'master' },
      sync: syncStatus(r(100010), 'stale', {
        stable: release('0.9.0', 90, 60 * 24 * 10),
        maxVersionCode: 95,
        message: 'GitHub API returned 502 while listing releases; serving last good data.',
      }),
    },
    {
      id: 'broken.install',
      status: 'listed',
      source: src(r(100011)),
      sync: syncStatus(r(100011), 'error', {
        installation: 'missing',
        message: 'KernelSU Modules App is not installed on alice/broken. Reinstall it to resume syncing.',
      }),
    },
    {
      id: 'pending.mod',
      status: 'pending',
      request: { submissionId: 'p3nd1ngm0d', kind: 'submit', source: src(r(100008)), submittedBy: 1001, submittedByLogin: 'alice', submittedAt: ago(90) },
      sync: syncStatus(r(100008), 'ok', { request: requestCheck('p3nd1ngm0d', 100008, false) }),
    },
    {
      id: 'spam.thing',
      status: 'rejected',
      review: { submissionId: 'r3j3ct3d01', kind: 'submit', submittedBy: 1001, submittedAt: ago(60 * 50), decision: 'rejected', decidedBy: 2001, decidedVia: 'portal', decidedAt: ago(60 * 48), reasonCode: 'bad-id', reason: 'The ID is too generic; please use a more specific name such as alice.spamthing.' },
    },
    {
      id: 'suspended.mod',
      status: 'suspended',
      source: src(r(100013)),
      moderation: { action: 'suspend', by: 2001, via: 'telegram', at: ago(60 * 5), reason: 'Release 2.0.0 bootloops on Android 15; suspended until fixed.' },
      sync: syncStatus(r(100013), 'ok', { stable: release('2.0.0', 200, 60 * 8) }),
    },
    {
      id: 'old.mod',
      status: 'archived',
      source: src(r(100009)),
      moderation: { action: 'archive', by: 1001, via: 'portal', at: ago(60 * 24 * 90), reason: 'No longer maintained by the author.' },
    },
    {
      id: 'move.me',
      status: 'listed',
      source: src(r(100014)),
      request: { submissionId: 'tr4nsf3r01', kind: 'transfer', source: src(r(100007)), submittedBy: 1001, submittedByLogin: 'alice', submittedAt: ago(30) },
      sync: syncStatus(r(100014), 'ok', { stable: release('3.1', 31, 60 * 24 * 3), request: requestCheck('tr4nsf3r01', 100007, true) }),
    },
  ];
}

/** Records owned by other people (ID lookups, admin views). */
export const otherRecords: { id: string; status: MyModule['status']; fullName: string }[] = [
  { id: 'zygisk_next', status: 'listed', fullName: 'someone/zygisk-next' },
  { id: 'cool.module', status: 'pending', fullName: 'dave/cool-module' },
  { id: 'lsposed', status: 'suspended', fullName: 'someone/lsposed' },
];

export const RESERVED_PREFIXES = ['ksu', 'kernelsu', 'official'];

export const okPrecheck = (id: string, fullName: string): PrecheckResult => ({
  ok: true,
  issues: [{ code: 'manifest-no-icon', severity: 'warning', message: 'module.yaml does not declare an icon; a placeholder will be shown.' }],
  manifest: {
    schemaVersion: 1,
    id,
    name: 'Zygisk Assistant',
    summary: 'Helps with Zygisk things.',
    description: 'docs/README.md',
    license: 'GPL-3.0-only',
    homepage: `https://github.com/${fullName}`,
    tags: ['zygisk', 'utility'],
    metamodule: false,
    authors: [{ name: 'Alice' }],
    release: { assetPattern: '*-release.zip' },
  },
  latestRelease: { tag: 'v1.0.0', immutable: true, asset: { name: 'zygisk-assistant-release.zip', size: 312_004 } },
});

export const failingPrecheck: PrecheckResult = {
  ok: false,
  issues: [
    { code: 'release-not-immutable', severity: 'error', message: 'Latest release v2.3 is not immutable. Enable release immutability in repository settings and publish a new release.' },
    { code: 'asset-multiple', severity: 'error', message: 'Release v2.3 has 2 .zip assets matching "*.zip"; set release.assetPattern in module.yaml.' },
    { code: 'manifest-path-missing', severity: 'error', message: 'description points to docs/README.md which does not exist.', path: 'description' },
    { code: 'manifest-tag-format', severity: 'warning', message: 'Tag "Battery Saver" is not lowercase kebab-case and will be ignored.', path: 'tags[1]' },
  ],
  manifest: {
    schemaVersion: 1,
    id: 'battery.saver',
    name: 'Battery Saver',
    summary: 'Saves battery.',
    description: 'docs/README.md',
    metamodule: false,
  },
  latestRelease: { tag: 'v2.3', immutable: false },
};

export const noManifestPrecheck: PrecheckResult = {
  ok: false,
  issues: [{ code: 'manifest-missing', severity: 'error', message: 'module.yaml was not found at the repository root on branch main.', path: 'module.yaml' }],
};

/** Raw Markdown returned by the mock /api/preview (rendered in the browser by @kernelsu-modules/render). */
export function previewMarkdown(fullName: string): string {
  return `# ${fullName}\n\nThis is a **sample** module description, rendered in the browser with the same renderer and sanitizer as the site build.\n\n## Features\n\n- Feature one\n- Feature two with [a link](https://kernelsu.org/) and a [relative link](USAGE.md)\n\n![Screenshot](screenshot.png)\n\n| Android | Status |\n| --- | --- |\n| 14 | OK |\n| 15 | OK |\n\n<script>alert('stripped by the sanitizer')</script>\n\n\`\`\`sh\nsu -c 'ksud module list'\n\`\`\`\n\n<details><summary>Changelog</summary>\n\n1.0.0 — initial release\n\n</details>\n`;
}

export function initialQueue(repos: Repo[], mods: MyModule[]): QueueItem[] {
  const pend = mods.find((m) => m.id === 'pending.mod')!;
  const move = mods.find((m) => m.id === 'move.me')!;
  return [
    {
      id: 'cool.module',
      status: 'pending',
      request: { submissionId: 'c00lm0dul3', kind: 'submit', source: { host: 'github', repositoryId: 300001, ownerId: 3001, fullName: 'dave/cool-module', manifestPath: 'module.yaml' }, submittedBy: 3001, submittedByLogin: 'dave', submittedAt: ago(15) },
      precheck: { ok: true, issues: [] },
      check: requestCheck('c00lm0dul3', 300001, true, 12),
    },
    { id: pend.id, status: 'pending', request: pend.request!, precheck: { ok: true, issues: okPrecheck('pending.mod', 'alice/pending-mod').issues }, check: pend.sync?.request ?? null },
    { id: move.id, status: 'listed', request: move.request!, source: move.source!, check: move.sync?.request ?? null },
  ].map((x) => ({ ...x, request: { ...x.request } })) as QueueItem[];
  void repos;
}

export const initialMaintainers = (): Maintainer[] => [
  { github: { id: 2001, login: 'kernelsu-maintainer' }, telegram: { id: 555000111 } },
  { github: { id: 2002, login: 'second-maintainer' } },
];

/** GitHub accounts the mock "resolves" (GET /users/{login}, GET /user/{id}). Avatars stay empty (offline initials). */
export interface MockGithubUser {
  id: number;
  login: string;
  name: string | null;
  type: 'User' | 'Organization' | 'Bot';
}
export const GITHUB_USERS: MockGithubUser[] = [
  { id: 2001, login: 'kernelsu-maintainer', name: 'KernelSU Maintainer', type: 'User' },
  { id: 2002, login: 'second-maintainer', name: null, type: 'User' },
  { id: 1001, login: 'alice', name: 'Alice Liddell', type: 'User' },
  { id: 583231, login: 'octocat', name: 'The Octocat', type: 'User' },
  { id: 666, login: 'spammer', name: null, type: 'User' },
  { id: 9919, login: 'github', name: 'GitHub', type: 'Organization' },
];

export const initialBanned = (): BannedEntry[] => [{ githubId: 666, login: 'spammer', reason: 'Repeated spam submissions', by: 2001, at: ago(60 * 24 * 7) }];

export function adminStatus(mods: MyModule[]): AdminModuleStatus[] {
  const mine: AdminModuleStatus[] = mods.filter((m) => m.sync).map((m) => ({ ...m.sync!, id: m.id, status: m.status }));
  const other = (id: number, fullName: string): Repo => repo(id, fullName);
  return [
    ...mine,
    { ...syncStatus(other(300010, 'someone/zygisk-next'), 'ok', { stable: release('1.2.9', 129, 60 * 50) }), id: 'zygisk_next', status: 'listed' },
    { ...syncStatus(other(300011, 'someone/lsposed'), 'ok', { stable: release('1.10.1', 7100, 60 * 70) }), id: 'lsposed', status: 'suspended' },
  ];
}

export const runs = (): WorkflowRun[] => [
  { id: 9001, status: 'in_progress', conclusion: null, event: 'workflow_dispatch', createdAt: ago(1), htmlUrl: 'https://github.com/KernelSU-Modules/tools/actions/runs/9001', displayTitle: 'sync: release demo.toolbox' },
  { id: 9000, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', createdAt: ago(16), htmlUrl: 'https://github.com/KernelSU-Modules/tools/actions/runs/9000', displayTitle: 'sync: cron' },
  { id: 8999, status: 'completed', conclusion: 'failure', event: 'workflow_dispatch', createdAt: ago(31), htmlUrl: 'https://github.com/KernelSU-Modules/tools/actions/runs/8999', displayTitle: 'sync: cron' },
  { id: 8998, status: 'completed', conclusion: 'cancelled', event: 'workflow_dispatch', createdAt: ago(46), htmlUrl: 'https://github.com/KernelSU-Modules/tools/actions/runs/8998', displayTitle: 'sync: cron' },
];
