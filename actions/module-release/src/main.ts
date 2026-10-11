// KernelSU module release action: precheck a module ZIP with the KernelSU Modules validator and
// publish it as draft -> upload asset -> publish, so release immutability covers the full release.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_POLICY } from '@kernelsu-modules/schema';
import type { ModuleManifest } from '@kernelsu-modules/schema';
import { GitHubClient, GitHubError } from '@kernelsu-modules/github';
import { appendSummary, getBooleanInput, getInput, setOutput, type Env, type Logger } from './actions.ts';
import { ActionFailed } from './errors.ts';
import {
  CLOSED_SOURCE_DOCS,
  REPOSITORY_RE,
  collectMetadata,
  commitMetadata,
  diffAgainstTarget,
  ensureTag,
  fullName,
  preflight,
  readTagMessage,
  tagCollision,
  tagCommit,
  type MetadataPlan,
  type TargetState,
} from './external.ts';
import { collectDir, createZip } from './zip.ts';
import type { Issue, ModuleProp, ReleaseLike, Validator, ZipLimits } from './validator-api.ts';

export const DOCS_BASE = 'https://developers.kernelsu.org/docs';
export const IMMUTABILITY_DOCS =
  'https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases';
/** Codes emitted only by this action (not part of the KernelSU Modules Check Run). */
export const LOCAL_CODES = new Set(['release-exists', 'previous-release-unreadable']);
/** Download the previous release asset completely only when it is at most this big. */
const FULL_DOWNLOAD_MAX = 32 * 1024 * 1024;

export { ActionFailed };

export interface RunContext {
  env: Env;
  log: Logger;
  validator: Validator;
  fetch?: typeof fetch;
  cwd?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Clock for the token expiry warning (tests). */
  now?: () => number;
}

export interface RunResult {
  published: boolean;
  dryRun: boolean;
  id: string;
  version: string;
  versionCode: number;
  assetName: string;
  sha256: string;
  zipPath: string;
  releaseId?: number;
  releaseUrl?: string;
  immutable?: boolean;
  /** Repository the release is published in ("owner/name"; empty when unknown). */
  repository: string;
  /** Published to another repository than GITHUB_REPOSITORY (`repository` input). */
  external: boolean;
  /** External mode: the metadata commit created in the distribution repository (empty when none). */
  metadataCommit: string;
  /** External mode: files that were (or, on a dry run, would be) synced. */
  syncedFiles: string[];
  issues: Issue[];
}

interface Config {
  workspace: string;
  zip?: string;
  moduleDir?: string;
  manifestPath: string;
  tag?: string;
  releaseName?: string;
  token?: string;
  prerelease: boolean;
  notes?: string;
  generateNotes: boolean;
  assetPattern?: string;
  dryRun: boolean;
  requireImmutable: boolean;
  /** Release repository: GITHUB_REPOSITORY, or the `repository` input in external mode. */
  repo?: { owner: string; repo: string };
  /** `repository` is set and differs from GITHUB_REPOSITORY. */
  external: boolean;
  syncFiles: boolean;
  /** The workflow's GITHUB_TOKEN (internal input), only to detect a `token` left at its default. */
  workflowToken?: string;
  apiUrl: string;
  sha?: string;
  tempDir: string;
}

interface ApiRelease extends ReleaseLike {
  html_url: string;
  upload_url: string;
}

export function parseConfig(env: Env, cwd: string): Config {
  const workspace = env.GITHUB_WORKSPACE || cwd;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(workspace, p));
  const zip = getInput(env, 'zip');
  const moduleDir = getInput(env, 'module-dir');
  if (!zip === !moduleDir) throw new ActionFailed('Set exactly one of the inputs "zip" or "module-dir".');
  const ref = env.GITHUB_REF ?? '';
  const tag = getInput(env, 'tag') || (ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : '');
  const notesInput = getInput(env, 'release-notes');
  const notesFile = getInput(env, 'release-notes-file');
  if (notesInput && notesFile) throw new ActionFailed('Set at most one of "release-notes" and "release-notes-file".');
  let notes: string | undefined = notesInput || undefined;
  if (notesFile) {
    const p = abs(notesFile);
    if (!existsSync(p)) throw new ActionFailed(`release-notes-file not found: ${notesFile}`);
    notes = readFileSync(p, 'utf8');
  }
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? '').split('/');
  const target = getInput(env, 'repository');
  if (target && !REPOSITORY_RE.test(target)) throw new ActionFailed(`Input "repository" must be "owner/name", got "${target}".`);
  const external = !!target && target.toLowerCase() !== (env.GITHUB_REPOSITORY ?? '').toLowerCase();
  const [tOwner, tRepo] = target.split('/');
  return {
    workspace,
    zip: zip ? abs(zip) : undefined,
    moduleDir: moduleDir ? abs(moduleDir) : undefined,
    manifestPath: getInput(env, 'manifest') || 'module.yaml',
    tag: tag || undefined,
    releaseName: getInput(env, 'name') || undefined,
    token: getInput(env, 'token') || env.GITHUB_TOKEN || undefined,
    prerelease: getBooleanInput(env, 'prerelease'),
    notes,
    generateNotes: getBooleanInput(env, 'generate-release-notes'),
    assetPattern: getInput(env, 'asset-pattern') || undefined,
    dryRun: getBooleanInput(env, 'dry-run'),
    requireImmutable: getBooleanInput(env, 'require-immutable', true),
    repo: external ? { owner: tOwner!, repo: tRepo! } : owner && repo ? { owner, repo } : undefined,
    external,
    syncFiles: getBooleanInput(env, 'sync-files', true),
    workflowToken: getInput(env, 'workflow-token') || undefined,
    apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    sha: env.GITHUB_SHA || undefined,
    tempDir: env.RUNNER_TEMP || tmpdir(),
  };
}

/** Restrict a module.prop version to characters that survive as a GitHub asset name. */
export function sanitizeVersion(version: string): string {
  const s = version
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64);
  return s || 'unknown';
}

export function assetNameFor(prop: Pick<ModuleProp, 'id' | 'versionCode' | 'version'>): string {
  return `${prop.id}-${prop.versionCode}-${sanitizeVersion(prop.version)}.zip`;
}

export function zipLimits(): ZipLimits {
  const l = DEFAULT_POLICY.limits;
  return {
    zipMaxBytes: l.zipMaxBytes,
    uncompressedMaxBytes: l.uncompressedMaxBytes,
    maxCompressionRatio: l.maxCompressionRatio,
    maxEntries: l.maxEntries,
    modulePropMaxBytes: l.modulePropMaxBytes,
  };
}

export function docsLink(code: string): string | null {
  return LOCAL_CODES.has(code) ? null : `${DOCS_BASE}/checks#${code}`;
}

function report(log: Logger, issues: Issue[]): void {
  for (const i of issues) {
    const link = docsLink(i.code);
    const msg = `${i.message}${link ? ` (see ${link})` : ''}`;
    const props = { title: `${i.code}${i.path ? ` @ ${i.path}` : ''}` };
    if (i.severity === 'error') log.error(msg, props);
    else log.warning(msg, props);
  }
}

const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === 'error');

/** Precheck the ZIP: structure/limits, root module.prop. */
async function precheckZip(v: Validator, bytes: Uint8Array): Promise<{ issues: Issue[]; prop?: ModuleProp }> {
  const zipRes = await v.inspectZip(v.rangeReaderFromBytes(bytes), zipLimits());
  const issues = [...zipRes.issues];
  if (!zipRes.ok || !zipRes.value) return { issues };
  const propRes = v.parseModuleProp(zipRes.value.moduleProp);
  issues.push(...propRes.issues);
  return { issues, prop: propRes.ok ? propRes.value : undefined };
}

/** Parse module.yaml and check referenced files exist in the workspace. */
function precheckManifest(v: Validator, cfg: Config, log: Logger): { issues: Issue[]; manifest?: ModuleManifest } {
  const p = resolve(cfg.workspace, cfg.manifestPath);
  if (!existsSync(p)) {
    if (cfg.external && cfg.syncFiles) return { issues: [] }; // reported as an error by collectMetadata
    log.warning(
      `${cfg.manifestPath} not found. The release can still be published, but KernelSU Modules needs a module.yaml on ${cfg.external ? `the default branch of ${fullName(cfg.repo!)}` : 'your default branch'} before the module can be listed. See ${DOCS_BASE}/module-yaml`,
      { title: 'manifest-missing' },
    );
    return { issues: [] };
  }
  const res = v.parseManifest(readFileSync(p, 'utf8'), { maxBytes: DEFAULT_POLICY.limits.manifestMaxBytes });
  const issues = res.issues.map((i) => ({ ...i, path: i.path ? `${cfg.manifestPath}: ${i.path}` : cfg.manifestPath }));
  if (!res.ok || !res.value) return { issues };
  for (const rel of v.manifestReferencedPaths(res.value)) {
    const abs = join(cfg.workspace, rel);
    if (!existsSync(abs) || !statSync(abs).isFile())
      issues.push({ code: 'manifest-path-missing', severity: 'error', message: `module.yaml references "${rel}", which does not exist.`, path: cfg.manifestPath });
  }
  return { issues, manifest: res.value };
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const { env, log, validator: v } = ctx;
  const doFetch = ctx.fetch ?? fetch;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cfg = parseConfig(env, ctx.cwd ?? process.cwd());
  const now = ctx.now ?? Date.now;

  if (cfg.external) {
    const target = fullName(cfg.repo!);
    if (!cfg.token)
      throw new ActionFailed(
        `Publishing to ${target} needs a token with Contents: Read and write on it: set the "token" input (e.g. token: \${{ secrets.DIST_REPO_TOKEN }}). See ${CLOSED_SOURCE_DOCS}`,
      );
    if (cfg.workflowToken && cfg.token === cfg.workflowToken)
      throw new ActionFailed(
        `"token" is the workflow's GITHUB_TOKEN, which cannot write to another repository (${target}). Pass a fine-grained personal access token or GitHub App token for ${target} (e.g. token: \${{ secrets.DIST_REPO_TOKEN }}). See ${CLOSED_SOURCE_DOCS}`,
      );
    log.info(`External mode: publishing to ${target}${cfg.syncFiles ? ' (metadata synced from this workspace)' : ''}.`);
  } else if (getInput(env, 'repository')) {
    log.info('"repository" is the current repository; publishing here as usual.');
  }

  if (!cfg.dryRun) {
    if (!cfg.tag) throw new ActionFailed('No tag: run on a tag push or set the "tag" input.');
    if (!cfg.token) throw new ActionFailed('No token: set the "token" input (defaults to github.token).');
    if (!cfg.repo) throw new ActionFailed('GITHUB_REPOSITORY is not set.');
  }

  const gh = cfg.token && cfg.repo ? new GitHubClient(cfg.token, { baseUrl: cfg.apiUrl, fetch: doFetch, userAgent: 'kernelsu-module-release' }) : null;
  const repoPath = cfg.repo ? `/repos/${cfg.repo.owner}/${cfg.repo.repo}` : '';

  // 0. External mode: read-only checks of the distribution repository (dry runs too).
  let targetState: TargetState | undefined;
  if (cfg.external) {
    targetState = await log.group(`Preflight checks for ${fullName(cfg.repo!)}`, () => preflight(gh!, cfg.repo!, log, now()));
    if (cfg.generateNotes) {
      log.warning('generate-release-notes is ignored when publishing to another repository (it has no source history there); without release-notes / release-notes-file the annotated tag message is used.');
      cfg.generateNotes = false;
    }
  }

  // 1. Obtain ZIP bytes.
  let bytes: Uint8Array;
  if (cfg.zip) {
    if (!existsSync(cfg.zip) || !statSync(cfg.zip).isFile()) throw new ActionFailed(`ZIP not found: ${cfg.zip}`);
    bytes = new Uint8Array(readFileSync(cfg.zip));
    log.info(`Using ZIP ${cfg.zip} (${bytes.length} bytes)`);
  } else {
    const dir = cfg.moduleDir!;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ActionFailed(`module-dir not found: ${dir}`);
    const { entries, skipped } = collectDir(dir);
    for (const s of skipped) log.warning(`Skipped non-regular file (symlink?) ${s}; build the ZIP yourself and use the "zip" input if you need it.`);
    bytes = createZip(entries);
    log.info(`Zipped ${dir}: ${entries.length} entries, ${bytes.length} bytes`);
  }

  // 2. Local precheck with the shared validator.
  const issues: Issue[] = [];
  const { issues: zipIssues, prop } = await log.group('Precheck ZIP and module.prop', () => precheckZip(v, bytes));
  issues.push(...zipIssues);
  const { issues: manIssues, manifest } = precheckManifest(v, cfg, log);
  issues.push(...manIssues);
  let meta: MetadataPlan | undefined;
  if (cfg.external && cfg.syncFiles) {
    meta = collectMetadata(cfg.workspace, cfg.manifestPath, manifest, DEFAULT_POLICY.limits, cfg.repo!, log);
    issues.push(...meta.issues);
  }

  if (prop) {
    if (manifest && manifest.id !== prop.id) {
      issues.push({
        code: 'prop-id-mismatch',
        severity: 'error',
        message: `module.prop id "${prop.id}" differs from module.yaml id "${manifest.id}" (case-sensitive).`,
      });
    }
    for (const i of v.checkModuleId(prop.id, DEFAULT_POLICY)) {
      // Only a warning: the action checks against the built-in default policy, while KernelSU Modules applies its own
      // policy when the ID is submitted (and never re-judges an ID that is already registered).
      issues.push(i.code === 'id-reserved' ? { ...i, severity: 'warning', message: `${i.message} KernelSU Modules refuses new submissions of reserved IDs.` } : i);
    }
  }

  const assetPattern = cfg.assetPattern ?? manifest?.release?.assetPattern;
  const assetName = prop ? assetNameFor(prop) : '';
  if (prop) {
    if (assetName !== `${prop.id}-${prop.versionCode}-${prop.version}.zip`)
      log.info(`Version "${prop.version}" sanitized for the asset file name.`);
    if (assetPattern && !v.globMatch(assetPattern, assetName)) {
      issues.push({
        code: 'asset-none',
        severity: 'error',
        message: `Asset name "${assetName}" does not match release.assetPattern "${assetPattern}"; KernelSU Modules would not find the ZIP. Fix assetPattern (e.g. "${prop.id}-*.zip").`,
      });
    }
  }

  // 3. Remote checks against existing releases (read-only).
  const blockers: string[] = [];
  let leftoverDrafts: ApiRelease[] = [];
  let pendingSync: string[] = [];
  if (gh && cfg.tag && prop) {
    await log.group('Check existing releases', async () => {
      const byTag = await gh.get<ApiRelease>(`${repoPath}/releases/tags/${encodeURIComponent(cfg.tag!)}`, { allow: [404] });
      const list = (await gh.get<ApiRelease[]>(`${repoPath}/releases`, { query: { per_page: 30 } })).data;
      if (byTag.status === 200 && byTag.data && !byTag.data.draft) {
        issues.push({
          code: 'release-exists',
          severity: 'error',
          message: `A published release for tag "${cfg.tag}" already exists (${byTag.data.html_url}). Releases are immutable: bump versionCode and push a new tag.`,
        });
      }
      leftoverDrafts = list.filter((r) => r.draft && r.tag_name === cfg.tag);
      issues.push(...(await checkPreviousVersions(ctx, v, cfg, list, prop, assetPattern, doFetch)));
    });
  } else if (prop) {
    log.info('No token, tag or repository: skipping checks against existing releases.');
  }
  if (cfg.external && gh && targetState) {
    await log.group(`Compare metadata and tag with ${fullName(cfg.repo!)}`, async () => {
      if (meta && manifest && !hasErrors(meta.issues)) {
        const diff = await diffAgainstTarget(gh, cfg.repo!, targetState!.head, meta.files, meta.skipped, log);
        pendingSync = diff.changed.map((f) => f.path);
        log.info(
          pendingSync.length
            ? `Metadata to sync to ${targetState!.defaultBranch}: ${pendingSync.join(', ')}`
            : `Metadata on ${targetState!.defaultBranch} is up to date (${meta.files.map((f) => f.path).join(', ')}).`,
        );
      }
      if (cfg.tag) {
        const existing = await tagCommit(gh, cfg.repo!, cfg.tag);
        // An existing tag is only reusable when nothing has to be committed and it already points at HEAD
        // (e.g. a re-run after a failed upload).
        if (existing && (pendingSync.length > 0 || existing !== targetState!.head))
          blockers.push(tagCollision(cfg.repo!, cfg.tag, existing, pendingSync.length ? null : targetState!.head));
      }
    });
  }

  report(log, issues);
  for (const b of blockers) log.error(b);
  const base: Omit<RunResult, 'published' | 'sha256' | 'zipPath'> = {
    dryRun: cfg.dryRun,
    id: prop?.id ?? '',
    version: prop?.version ?? '',
    versionCode: prop?.versionCode ?? 0,
    assetName,
    repository: cfg.repo ? fullName(cfg.repo) : '',
    external: cfg.external,
    metadataCommit: '',
    syncedFiles: pendingSync,
    issues,
  };
  if (hasErrors(issues) || blockers.length || !prop) {
    throw new ActionFailed(
      'Precheck failed; nothing was published. Fix the errors above. Each published release is immutable, so failing here saves your version number.',
      issues,
    );
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let zipPath = cfg.zip ?? '';
  if (!cfg.zip) {
    mkdirSync(cfg.tempDir, { recursive: true });
    zipPath = join(cfg.tempDir, assetName);
    writeFileSync(zipPath, bytes);
  }
  log.info(`Asset: ${assetName}\nsha256: ${sha256}\nid=${prop.id} version=${prop.version} versionCode=${prop.versionCode}`);

  if (cfg.external && cfg.notes === undefined && cfg.tag) {
    // GitHub's generated notes are useless in the distribution repository (no source history): use the tag message.
    const tm = readTagMessage(cfg.workspace, cfg.tag);
    if (tm.ok) {
      cfg.notes = tm.message;
      log.info(`Release notes: message of the annotated tag ${cfg.tag} (${tm.message.length} characters).`);
    } else {
      log.warning(
        `No release notes: ${tm.reason}. Push an annotated tag (git tag -a) and check out with fetch-depth: 0, or set release-notes / release-notes-file.`,
        { title: 'release-notes' },
      );
    }
  }

  if (cfg.dryRun) {
    log.notice(`Dry run: precheck passed for ${assetName}; nothing was published${cfg.external ? ` and nothing was written to ${fullName(cfg.repo!)}` : ''}.`);
    const res: RunResult = { ...base, published: false, sha256, zipPath };
    writeOutputs(env, res, log);
    return res;
  }

  log.notice(
    `KernelSU Modules only accepts immutable releases. Make sure "Enable release immutability" is on in ${cfg.external ? `${fullName(cfg.repo!)}: ` : ''}Settings → General → Releases (${IMMUTABILITY_DOCS}).`,
  );

  const client = gh!;
  // 4a. External mode: sync metadata to the default branch (one commit), then tag that commit.
  let targetCommitish = cfg.sha;
  if (cfg.external) {
    const target = cfg.repo!;
    const branch = targetState!.defaultBranch;
    let tagAt: string;
    if (meta) {
      const out = await log.group(`Sync metadata to ${fullName(target)}@${branch}`, () =>
        commitMetadata(client, target, branch, meta!.files, `Sync module metadata for ${cfg.tag}`, log),
      );
      if (out.commit) log.info(`Committed ${out.changed.join(', ')} as ${out.commit}`);
      else log.info('Metadata already up to date; no commit.');
      base.metadataCommit = out.commit ?? '';
      base.syncedFiles = out.changed;
      tagAt = out.head;
    } else {
      tagAt = (await client.get<{ object: { sha: string } }>(`${repoPath}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`)).data.object.sha;
    }
    await ensureTag(client, target, cfg.tag!, tagAt, log);
    targetCommitish = tagAt;
  }

  // 4b. Publish: (delete leftover drafts) -> draft -> upload -> verify -> publish.
  for (const d of leftoverDrafts) {
    log.warning(`Deleting leftover draft release ${d.id} for tag ${cfg.tag} (probably from an earlier failed run).`);
    await client.delete(`${repoPath}/releases/${d.id}`, { allow: [404] });
  }

  const draft = (
    await client.post<ApiRelease>(`${repoPath}/releases`, {
      tag_name: cfg.tag,
      target_commitish: targetCommitish,
      name: cfg.releaseName ?? cfg.tag,
      body: cfg.notes ?? '',
      draft: true,
      prerelease: cfg.prerelease,
      generate_release_notes: !cfg.notes && cfg.generateNotes,
    })
  ).data;
  log.info(`Created draft release ${draft.id}`);

  let published: ApiRelease;
  try {
    const asset = await uploadAsset(doFetch, cfg, draft.upload_url, assetName, bytes);
    if (asset.name !== assetName) throw new ActionFailed(`GitHub stored the asset as "${asset.name}" instead of "${assetName}".`);
    if (asset.digest && asset.digest !== `sha256:${sha256}`)
      throw new ActionFailed(`Uploaded asset digest ${asset.digest} does not match local sha256:${sha256}.`, [
        { code: 'asset-digest-mismatch', severity: 'error', message: 'digest mismatch after upload' },
      ]);
    log.info(`Uploaded ${asset.name} (${asset.size} bytes)`);
    published = (await client.patch<ApiRelease>(`${repoPath}/releases/${draft.id}`, { draft: false })).data;
  } catch (e) {
    // The PATCH may have succeeded on GitHub's side even though we saw an error (timeout, 5xx after
    // commit). Deleting a published immutable release would burn its tag forever, so only delete
    // the release if GitHub still reports it as a draft.
    let current: ApiRelease | null = null;
    try {
      current = (await client.get<ApiRelease>(`${repoPath}/releases/${draft.id}`)).data;
    } catch (ge) {
      log.warning(`Publishing failed and release ${draft.id} could not be re-read (${(ge as Error).message}); not deleting it. Check the repository's releases.`);
      throw e;
    }
    if (current.draft === true) {
      log.warning(`Publishing failed; deleting draft release ${draft.id}.`);
      await client.delete(`${repoPath}/releases/${draft.id}`, { allow: [404] }).catch(() => undefined);
    } else {
      log.warning(
        `Publishing reported an error, but release ${draft.id} is already published (${current.html_url}); it was not deleted. Check it before running again.`,
      );
    }
    throw e;
  }
  log.info(`Published ${published.html_url}`);

  // 5. Verify immutability (the flag may take a moment to show up).
  let immutable = published.immutable === true;
  for (let attempt = 0; !immutable && attempt < 3; attempt++) {
    await sleep(2000);
    const r = await client.get<ApiRelease>(`${repoPath}/releases/${published.id}`);
    immutable = r.data.immutable === true;
  }
  const res: RunResult = {
    ...base,
    published: true,
    sha256,
    zipPath,
    releaseId: published.id,
    releaseUrl: published.html_url,
    immutable,
  };
  writeOutputs(env, res, log);
  if (!immutable) {
    const msg = `Release ${published.html_url} is NOT immutable, so KernelSU Modules will ignore it. Enable release immutability (${IMMUTABILITY_DOCS}), then delete this release and run again, or publish a new version.`;
    if (cfg.requireImmutable) throw new ActionFailed(msg, [{ code: 'release-not-immutable', severity: 'error', message: msg }]);
    log.warning(msg, { title: 'release-not-immutable' });
  }
  return res;
}

async function uploadAsset(
  doFetch: typeof fetch,
  cfg: Config,
  uploadUrlTemplate: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ id: number; name: string; size: number; digest?: string | null; state?: string }> {
  const url = new URL(uploadUrlTemplate.replace(/\{.*$/, ''));
  url.searchParams.set('name', name);
  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'kernelsu-module-release',
      'content-type': 'application/zip',
      'content-length': String(bytes.length),
    },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  const text = await res.text();
  if (res.status !== 201) throw new ActionFailed(`Uploading ${name} failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

/**
 * Compare the new versionCode with the newest published stable release (and, for prereleases,
 * the newest prerelease). Reads only the ZIP central directory + module.prop via HTTP Range.
 */
async function checkPreviousVersions(
  ctx: RunContext,
  v: Validator,
  cfg: Config,
  list: ApiRelease[],
  prop: ModuleProp,
  assetPattern: string | undefined,
  doFetch: typeof fetch,
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const published = list
    .filter((r) => !r.draft && r.published_at)
    .sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!));
  const latest = published[0];
  if (!latest) {
    ctx.log.info('No published releases yet.');
    return issues;
  }
  if (latest.immutable !== true) {
    issues.push({
      code: 'release-not-immutable',
      severity: 'warning',
      message: `The latest release ${latest.tag_name} is not immutable. If release immutability is still disabled, the new release will be ignored by KernelSU Modules too. Enable it first: ${IMMUTABILITY_DOCS}`,
    });
  }
  const stable = published.find((r) => !r.prerelease);
  const pre = published.find((r) => r.prerelease);
  const targets: { rel: ApiRelease; strict: boolean }[] = [];
  if (stable) targets.push({ rel: stable, strict: true });
  if (pre && (!stable || Date.parse(pre.published_at!) > Date.parse(stable.published_at!))) targets.push({ rel: pre, strict: cfg.prerelease });

  for (const { rel, strict } of targets) {
    const prev = await readReleaseVersionCode(ctx, v, cfg, rel, assetPattern, doFetch);
    if (prev === null) {
      issues.push({
        code: 'previous-release-unreadable',
        severity: 'warning',
        message: `Could not read module.prop from release ${rel.tag_name}; skipped the versionCode comparison with it.`,
      });
      continue;
    }
    ctx.log.info(`${rel.prerelease ? 'Prerelease' : 'Stable'} ${rel.tag_name}: versionCode ${prev}`);
    if (prop.versionCode <= prev) {
      issues.push({
        code: 'version-not-newer',
        severity: strict ? 'error' : 'warning',
        message: `versionCode ${prop.versionCode} is not greater than ${prev} of ${rel.prerelease ? 'prerelease' : 'release'} ${rel.tag_name}. Bump versionCode in module.prop.`,
      });
    }
  }
  return issues;
}

async function readReleaseVersionCode(
  ctx: RunContext,
  v: Validator,
  cfg: Config,
  rel: ApiRelease,
  assetPattern: string | undefined,
  doFetch: typeof fetch,
): Promise<number | null> {
  let sel = v.selectAsset(rel, assetPattern);
  if (!sel.ok && assetPattern) sel = v.selectAsset(rel); // older releases may predate the pattern
  if (!sel.ok || !sel.value) return null;
  const asset = sel.value;
  const url = `${cfg.apiUrl}/repos/${cfg.repo!.owner}/${cfg.repo!.repo}/releases/assets/${asset.id}`;
  const headers = { accept: 'application/octet-stream', authorization: `Bearer ${cfg.token}`, 'user-agent': 'kernelsu-module-release' };
  const limits = zipLimits();
  const tryRead = async (reader: Awaited<ReturnType<Validator['rangeReaderFromUrl']>>) => {
    const z = await v.inspectZip(reader, limits);
    if (!z.ok || !z.value) return null;
    const p = v.parseModuleProp(z.value.moduleProp);
    return p.value?.versionCode ?? null;
  };
  try {
    return await tryRead(await v.rangeReaderFromUrl(url, { fetch: doFetch, headers, size: asset.size }));
  } catch (e) {
    ctx.log.info(`Range read of ${asset.name} failed (${(e as Error).message}).`);
  }
  if (asset.size > FULL_DOWNLOAD_MAX) return null;
  try {
    const res = await doFetch(url, { headers });
    if (!res.ok) return null;
    return await tryRead(v.rangeReaderFromBytes(new Uint8Array(await res.arrayBuffer())));
  } catch {
    return null;
  }
}

function writeOutputs(env: Env, r: RunResult, log: Logger): void {
  const out = (k: string, val: string) => setOutput(env, k, val, (l) => log.info(l));
  out('release-id', r.releaseId ? String(r.releaseId) : '');
  out('release-url', r.releaseUrl ?? '');
  out('asset-name', r.assetName);
  out('sha256', r.sha256);
  out('zip-path', r.zipPath);
  out('module-id', r.id);
  out('version', r.version);
  out('version-code', String(r.versionCode));
  out('repository', r.repository);
  out('metadata-commit', r.metadataCommit);
  appendSummary(
    env,
    [
      `### KernelSU module release${r.dryRun ? ' (dry run)' : ''}`,
      '',
      '| | |',
      '| --- | --- |',
      `| Module | \`${r.id}\` |`,
      ...(r.external ? [`| Repository | ${r.repository} |`] : []),
      `| Version | ${r.version} (${r.versionCode}) |`,
      `| Asset | \`${r.assetName}\` |`,
      `| sha256 | \`${r.sha256}\` |`,
      ...(r.metadataCommit ? [`| Metadata commit | \`${r.metadataCommit}\` (${r.syncedFiles.join(', ')}) |`] : []),
      ...(r.dryRun && r.syncedFiles.length ? [`| Metadata to sync | ${r.syncedFiles.join(', ')} |`] : []),
      ...(r.releaseUrl ? [`| Release | ${r.releaseUrl} |`, `| Immutable | ${r.immutable ? 'yes' : '**no**'} |`] : []),
      '',
      ...(r.issues.length ? ['Warnings:', '', ...r.issues.map((i) => `- \`${i.code}\`: ${i.message}`), ''] : []),
    ].join('\n'),
  );
}

export { GitHubError };
