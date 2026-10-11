// External mode: publish to a separate (public) distribution repository.
//
//   preflight (read-only)  -> target repo readable, public, not archived, writable, immutability on, default branch
//   collectMetadata (local) -> module.yaml + description + icon + repository images the description references
//   diffAgainstTarget       -> only files whose git blob sha differs from the target tree
//   commitMetadata          -> ONE Git Data API commit (blobs -> tree(base_tree) -> commit -> non-force ref update)
//   ensureTag               -> refs/tags/<tag> at the synced commit; never moves an existing tag
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { GitHubError, isRefRace, type GitHubClient } from '@kernelsu-modules/github';
import { referencedImagePaths } from '@kernelsu-modules/render';
import type { ModuleManifest, Policy } from '@kernelsu-modules/schema';
import type { Logger } from './actions.ts';
import { ActionFailed } from './errors.ts';
import type { Issue } from './validator-api.ts';

export const REPOSITORY_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
export const APP_INSTALL_URL = 'https://github.com/apps/kernelsu-modules/installations/new';
export const EXPIRY_HEADER = 'github-authentication-token-expiration';
export const EXPIRY_WARN_DAYS = 30;
export const CLOSED_SOURCE_DOCS = 'https://developers.kernelsu.org/docs/closed-source';

export interface Repo {
  owner: string;
  repo: string;
}
export const fullName = (r: Repo) => `${r.owner}/${r.repo}`;
const repoPath = (r: Repo) => `/repos/${r.owner}/${r.repo}`;
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** Git blob object id: sha1("blob <len>\0" + bytes). */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Normalized repository-relative path (same rule as module.yaml paths). A leading "./" is accepted. */
export function normalizeRepoPath(p: string): string | null {
  const s = p.replace(/^(?:\.\/)+/, '');
  if (!s || s.length > 256 || s.startsWith('/') || s.includes('\\') || s.includes('://')) return null;
  if (s.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return s;
}

/** Parse "2026-12-01 00:00:00 UTC" (GitHub's PAT expiration header) into epoch ms. */
export function parseExpiry(value: string): number | null {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*(?:UTC|Z)?$/i);
  if (m) return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Warning text when the token expires within EXPIRY_WARN_DAYS, else null. */
export function expiryWarning(header: string | null, now: number): string | null {
  if (!header) return null;
  const t = parseExpiry(header);
  if (t === null) return null;
  const days = (t - now) / 86_400_000;
  if (days >= EXPIRY_WARN_DAYS) return null;
  const when = days <= 0 ? 'has expired' : `expires in ${Math.max(1, Math.floor(days))} day(s)`;
  return `The token ${when} (${header.trim()}). Create a new token and update the secret before it stops working; see ${CLOSED_SOURCE_DOCS}#token-rotation`;
}

/* ------------------------------------------------------------------ preflight */

export interface TargetState {
  defaultBranch: string;
  /** Default-branch HEAD at preflight time. */
  head: string;
}

interface ApiRepo {
  full_name: string;
  private: boolean;
  visibility?: string;
  archived?: boolean;
  default_branch: string;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

/** Read-only checks of the distribution repository (also run on dry runs). Throws ActionFailed. */
export async function preflight(gh: GitHubClient, target: Repo, log: Logger, now: number): Promise<TargetState> {
  const name = fullName(target);
  let res;
  try {
    res = await gh.get<ApiRepo>(repoPath(target), { allow: [404] });
  } catch (e) {
    if (e instanceof GitHubError && e.status === 401)
      throw new ActionFailed(`The token was rejected (HTTP 401) while reading ${name}: it is invalid, revoked or expired. Create a new token and update the secret.`);
    if (e instanceof GitHubError && e.forbidden)
      throw new ActionFailed(`The token cannot read ${name} (HTTP 403). Give it access to this repository (fine-grained token: Repository access + Contents: Read and write).`);
    throw e;
  }
  const exp = expiryWarning(res.headers.get(EXPIRY_HEADER), now);
  if (exp) log.warning(exp, { title: 'token-expiration' });
  if (res.status === 404 || !res.data)
    throw new ActionFailed(
      `Repository ${name} was not found, or the token cannot read it. Check the "repository" input and that the token's repository access includes ${name}.`,
    );
  const repo = res.data;
  if (repo.private || (repo.visibility && repo.visibility !== 'public'))
    throw new ActionFailed(
      `${name} is ${repo.visibility ?? 'private'}. The distribution repository must be public: KernelSU Modules and its users download release ZIPs anonymously. See ${CLOSED_SOURCE_DOCS}`,
    );
  if (repo.archived) throw new ActionFailed(`${name} is archived and cannot receive new commits, tags or releases.`);
  if (repo.permissions && repo.permissions.push === false)
    throw new ActionFailed(`The token has no write access to ${name} (permissions.push is false). It needs Contents: Read and write on ${name}.`);
  if (!repo.permissions) log.warning(`Could not verify that the token can write to ${name}; it needs Contents: Read and write.`);
  log.info(`Target repository ${repo.full_name}: public, default branch "${repo.default_branch}"`);

  // Release immutability: 200 {enabled} when readable; 404 = disabled (or, for non-admins, unreadable); 403 = no permission.
  const imm = await gh.get<{ enabled?: boolean }>(`${repoPath(target)}/immutable-releases`, { allow: [403, 404] });
  const immDocs = 'https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases';
  const enableHint = `Enable it in ${name}: Settings → General → Releases → "Enable release immutability" (${immDocs}).`;
  if (imm.status === 200 && imm.data?.enabled === true) log.info('Release immutability: enabled');
  else if (imm.status === 200) throw new ActionFailed(`Release immutability is disabled on ${name}; KernelSU Modules ignores mutable releases. ${enableHint}`);
  else if (imm.status === 404 && repo.permissions?.admin !== false)
    throw new ActionFailed(
      `Release immutability is not enabled on ${name} (GET /immutable-releases returned 404); KernelSU Modules ignores mutable releases. ${enableHint}`,
    );
  else
    log.warning(
      `Could not check whether release immutability is enabled on ${name} (HTTP ${imm.status}: the token lacks admin read access). Make sure it is on: ${enableHint} The action still verifies the published release.`,
    );

  const ref = await gh.get<{ object: { sha: string } }>(`${repoPath(target)}/git/ref/heads/${encPath(repo.default_branch)}`, { allow: [404, 409] });
  if (ref.status !== 200 || !ref.data?.object?.sha)
    throw new ActionFailed(
      `${name} has no commits on its default branch "${repo.default_branch}". Initialize it first (e.g. create it with a README), then run again.`,
    );

  log.notice(
    `Remember to install the KernelSU Modules GitHub App on ${name} (only on the distribution repository, not on your private source repository): ${APP_INSTALL_URL}`,
  );
  return { defaultBranch: repo.default_branch, head: ref.data.object.sha };
}

/* ------------------------------------------------------------------ local metadata */

export interface MetaFile {
  path: string;
  bytes: Uint8Array;
  sha: string;
}

export interface MetadataPlan {
  files: MetaFile[];
  issues: Issue[];
  /** Referenced images not synced (missing locally, not a regular file, over a limit). */
  skipped: string[];
}

/** Read a regular file (no symlink, not via a symlinked directory leaving the workspace). `rel` is normalized. */
function readRegular(workspace: string, rel: string): { bytes: Uint8Array } | { error: 'missing' | 'not-file' } {
  const abs = join(workspace, rel);
  if (!existsSync(abs)) return { error: 'missing' };
  if (!lstatSync(abs).isFile()) return { error: 'not-file' };
  const root = realpathSync(workspace);
  if (!realpathSync(abs).startsWith(root.endsWith(sep) ? root : root + sep)) return { error: 'not-file' };
  return { bytes: new Uint8Array(readFileSync(abs)) };
}

/**
 * The files to mirror into the distribution repository, read from the local checkout, with the same policy limits
 * KernelSU Modules applies (description / icon / referenced images).
 */
export function collectMetadata(
  workspace: string,
  manifestPath: string,
  manifest: ModuleManifest | undefined,
  limits: Policy['limits'],
  target: Repo,
  log: Logger,
): MetadataPlan {
  const files: MetaFile[] = [];
  const issues: Issue[] = [];
  const skipped: string[] = [];
  const add = (path: string, bytes: Uint8Array) => files.push({ path, bytes, sha: gitBlobSha(bytes) });

  const mp = normalizeRepoPath(manifestPath);
  if (!mp) {
    issues.push({ code: 'manifest-missing', severity: 'error', message: `"manifest" must be a repository-relative path to sync it to ${fullName(target)}, got "${manifestPath}".` });
    return { files, issues, skipped };
  }
  const m = readRegular(workspace, mp);
  if ('error' in m) {
    issues.push(
      m.error === 'missing'
        ? { code: 'manifest-missing', severity: 'error', message: `${mp} not found: sync-files needs module.yaml in the workspace (set sync-files: false to manage ${fullName(target)} yourself).`, path: mp }
        : { code: 'content-not-file', severity: 'error', message: `${mp} is not a regular file (symlink or directory).`, path: mp },
    );
    return { files, issues, skipped };
  }
  if (!manifest) return { files, issues, skipped }; // invalid module.yaml: already reported by the precheck
  add(mp, m.bytes);

  let docText: string | null = null;
  let docPath = '';
  for (const raw of [manifest.icon, manifest.description]) {
    if (!raw) continue;
    const path = normalizeRepoPath(raw);
    if (!path || files.some((f) => f.path === path)) continue;
    const r = readRegular(workspace, path);
    if ('error' in r) {
      // A missing file is already reported by the precheck (manifest-path-missing).
      if (r.error === 'not-file') issues.push({ code: 'content-not-file', severity: 'error', message: `${path} is not a regular file (symlink or directory).`, path });
      continue;
    }
    const limit = raw === manifest.icon ? limits.imageMaxBytes : limits.docMaxBytes;
    if (r.bytes.length > limit) {
      issues.push({ code: 'content-too-large', severity: 'error', message: `${path} is ${r.bytes.length} bytes; the limit is ${limit} bytes.`, path });
      continue;
    }
    add(path, r.bytes);
    if (raw === manifest.description) {
      docText = new TextDecoder().decode(r.bytes);
      docPath = path;
    }
  }

  if (docText !== null) {
    let count = 0;
    let total = 0;
    const refs = referencedImagePaths(docText, { fullName: fullName(target), commit: '0'.repeat(40), docPath });
    for (const ref of refs) {
      const path = normalizeRepoPath(ref);
      if (!path) {
        log.warning(`Skipped image "${ref}" referenced by ${manifest.description}: not a normalized repository path.`);
        continue;
      }
      if (files.some((f) => f.path === path)) continue;
      if (count >= limits.imagesMaxPerModule) {
        log.warning(`${manifest.description} references more than ${limits.imagesMaxPerModule} repository images; the rest are not synced (KernelSU Modules does not show them).`);
        break;
      }
      const r = readRegular(workspace, path);
      if ('error' in r) {
        skipped.push(path);
        log.warning(
          r.error === 'missing'
            ? `Image ${path} referenced by ${manifest.description} does not exist in the workspace; not synced.`
            : `Image ${path} referenced by ${manifest.description} is not a regular file (symlink or directory); not synced.`,
          { title: 'image-not-synced', file: manifest.description },
        );
        continue;
      }
      count++;
      if (r.bytes.length > limits.imageMaxBytes || total + r.bytes.length > limits.imagesMaxTotalBytes) {
        skipped.push(path);
        issues.push({
          code: 'content-too-large',
          severity: 'warning',
          message: `${path} is ${r.bytes.length} bytes; images over ${limits.imageMaxBytes} bytes (or beyond ${limits.imagesMaxTotalBytes} bytes in total) are not shown, so it is not synced.`,
          path,
        });
        continue;
      }
      total += r.bytes.length;
      add(path, r.bytes);
    }
  }
  return { files, issues, skipped };
}

/* ------------------------------------------------------------------ target tree */

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

/** Path lookup in a tree; one recursive request, walking only the needed directories when GitHub truncates it. */
class TreeLookup {
  private full: Map<string, TreeEntry> | null = null;
  private dirs = new Map<string, Map<string, TreeEntry>>();
  private loaded = false;

  constructor(
    private readonly gh: GitHubClient,
    private readonly target: Repo,
    private readonly treeSha: string,
  ) {}

  private async dir(sha: string): Promise<Map<string, TreeEntry>> {
    let d = this.dirs.get(sha);
    if (!d) {
      const r = await this.gh.get<{ tree: TreeEntry[] }>(`${repoPath(this.target)}/git/trees/${sha}`);
      d = new Map(r.data.tree.map((e) => [e.path, e]));
      this.dirs.set(sha, d);
    }
    return d;
  }

  async get(path: string): Promise<TreeEntry | null> {
    if (!this.loaded) {
      const r = await this.gh.get<{ tree: TreeEntry[]; truncated: boolean }>(`${repoPath(this.target)}/git/trees/${this.treeSha}`, { query: { recursive: 1 } });
      this.loaded = true;
      if (!r.data.truncated) this.full = new Map(r.data.tree.map((e) => [e.path, e]));
    }
    if (this.full) return this.full.get(path) ?? null;
    const segs = path.split('/');
    let cur = await this.dir(this.treeSha);
    for (let i = 0; i < segs.length; i++) {
      const e = cur.get(segs[i]!);
      if (!e) return null;
      if (i === segs.length - 1) return { ...e, path };
      if (e.type !== 'tree') return null;
      cur = await this.dir(e.sha);
    }
    return null;
  }
}

export interface Diff {
  baseCommit: string;
  baseTree: string;
  changed: MetaFile[];
}

/** Files whose content differs from (or is absent in) the tree of `commit`. Throws if a path is a directory/submodule there. */
export async function diffAgainstTarget(gh: GitHubClient, target: Repo, commit: string, files: MetaFile[], skipped: string[] = [], log?: Logger): Promise<Diff> {
  const c = await gh.get<{ tree: { sha: string } }>(`${repoPath(target)}/git/commits/${commit}`);
  const baseTree = c.data.tree.sha;
  const tree = new TreeLookup(gh, target, baseTree);
  const changed: MetaFile[] = [];
  for (const f of files) {
    const e = await tree.get(f.path);
    if (e && e.type !== 'blob')
      throw new ActionFailed(`${f.path} is a ${e.type === 'tree' ? 'directory' : 'submodule'} in ${fullName(target)}; cannot sync the file there.`);
    if (!e || e.sha !== f.sha) changed.push(f);
  }
  if (log) {
    for (const p of skipped) {
      if (await tree.get(p)) log.warning(`${p} was not synced, so ${fullName(target)} keeps its existing (possibly stale) copy.`);
    }
  }
  return { baseCommit: commit, baseTree, changed };
}

/* ------------------------------------------------------------------ commit */

export interface CommitOutcome {
  /** New commit sha, or null when nothing changed. */
  commit: string | null;
  /** The default-branch commit the tag should point at (the new commit, or the unchanged HEAD). */
  head: string;
  changed: string[];
}

/**
 * Sync the files to the default branch in one commit (non-force ref update). Retries from a fresh HEAD when the
 * branch moved concurrently; writes nothing when every file already matches.
 */
export async function commitMetadata(
  gh: GitHubClient,
  target: Repo,
  branch: string,
  files: MetaFile[],
  message: string,
  log: Logger,
  maxAttempts = 5,
): Promise<CommitOutcome> {
  const base = repoPath(target);
  for (let attempt = 1; ; attempt++) {
    const ref = await gh.get<{ object: { sha: string } }>(`${base}/git/ref/heads/${encPath(branch)}`);
    const head = ref.data.object.sha;
    const diff = await diffAgainstTarget(gh, target, head, files);
    if (diff.changed.length === 0) return { commit: null, head, changed: [] };
    const items = [];
    for (const f of diff.changed) {
      const blob = await gh.post<{ sha: string }>(`${base}/git/blobs`, { content: Buffer.from(f.bytes).toString('base64'), encoding: 'base64' });
      if (blob.data.sha !== f.sha) throw new ActionFailed(`GitHub stored ${f.path} as blob ${blob.data.sha}, expected ${f.sha}.`);
      items.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.data.sha });
    }
    const tree = await gh.post<{ sha: string }>(`${base}/git/trees`, { base_tree: diff.baseTree, tree: items });
    const commit = await gh.post<{ sha: string }>(`${base}/git/commits`, { message, tree: tree.data.sha, parents: [head] });
    try {
      await gh.patch(`${base}/git/refs/heads/${encPath(branch)}`, { sha: commit.data.sha, force: false });
      return { commit: commit.data.sha, head: commit.data.sha, changed: diff.changed.map((f) => f.path) };
    } catch (e) {
      if (e instanceof GitHubError && isRefRace(e) && attempt < maxAttempts) {
        log.info(`${branch} moved while committing; retrying (${attempt}/${maxAttempts}).`);
        continue;
      }
      if (e instanceof GitHubError && (e.status === 422 || e.status === 403))
        throw new ActionFailed(
          `Could not update ${branch} in ${fullName(target)} (${e.message}). If a branch protection rule or ruleset blocks it, allow the token to push to ${branch} or set sync-files: false and keep the metadata up to date yourself.`,
        );
      throw e;
    }
  }
}

/* ------------------------------------------------------------------ tag */

/** Commit a tag points at (annotated tags dereferenced), null when the tag does not exist. */
export async function tagCommit(gh: GitHubClient, target: Repo, tag: string): Promise<string | null> {
  const r = await gh.get<any>(`${repoPath(target)}/git/ref/tags/${encPath(tag)}`, { allow: [404] });
  if (r.status === 404 || !r.data || Array.isArray(r.data)) return null;
  let obj: { type: string; sha: string } = r.data.object;
  for (let i = 0; i < 5 && obj.type === 'tag'; i++) obj = (await gh.get<any>(`${repoPath(target)}/git/tags/${obj.sha}`)).data.object;
  return obj.sha;
}

export const tagCollision = (target: Repo, tag: string, existing: string, wanted: string | null) =>
  `Tag "${tag}" already exists in ${fullName(target)} at ${existing.slice(0, 7)}${wanted ? `, not at ${wanted.slice(0, 7)}` : ''}. Tags are never moved or reused: push a new tag (and bump versionCode), or delete the stale tag in ${fullName(target)} if no release uses it.`;

/** Create refs/tags/<tag> at `sha`; reuse it if it already points there; fail if it points elsewhere. */
export async function ensureTag(gh: GitHubClient, target: Repo, tag: string, sha: string, log: Logger): Promise<void> {
  const existing = await tagCommit(gh, target, tag);
  if (existing === sha) {
    log.info(`Tag ${tag} already points at ${sha.slice(0, 7)}; reusing it.`);
    return;
  }
  if (existing) throw new ActionFailed(tagCollision(target, tag, existing, sha));
  try {
    await gh.post(`${repoPath(target)}/git/refs`, { ref: `refs/tags/${tag}`, sha });
    log.info(`Created tag ${tag} at ${sha.slice(0, 7)} in ${fullName(target)}`);
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 422)) throw e;
    const now = await tagCommit(gh, target, tag);
    if (now === sha) return;
    throw new ActionFailed(now ? tagCollision(target, tag, now, sha) : `Creating tag ${tag} in ${fullName(target)} failed: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ release notes */

export type TagMessage = { ok: true; message: string } | { ok: false; reason: string };

/** Message of the annotated tag refs/tags/<tag> in the local checkout (signature stripped). No shell involved. */
export function readTagMessage(cwd: string, tag: string, git = 'git'): TagMessage {
  const ref = `refs/tags/${tag}`;
  let out: string;
  try {
    // %01 terminates each record; the pattern also matches refs below "refs/tags/<tag>/", hence the refname check.
    out = execFileSync(git, ['for-each-ref', '--format=%(refname)%00%(objecttype)%00%(contents)%00%(contents:signature)%01', ref], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, reason: `git failed (${(e as Error).message.split('\n')[0]})` };
  }
  const rec = out
    .split('\x01')
    .map((r) => r.replace(/^\n/, '').split('\0'))
    .find((f) => f[0] === ref);
  if (!rec) return { ok: false, reason: `tag ${tag} is not in the local checkout` };
  const [, type, contents = '', signature = ''] = rec;
  if (type !== 'tag') return { ok: false, reason: `${ref} is not an annotated tag object in the checkout (lightweight tag, or checked out without fetch-depth: 0)` };
  let msg = contents;
  if (signature && msg.endsWith(signature)) msg = msg.slice(0, -signature.length);
  return { ok: true, message: msg.trim() };
}
