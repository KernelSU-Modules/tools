// Thin, typed wrappers over the GitHub REST endpoints sync needs (Modules App installation client).
import { GitHubError, type GitHubClient } from '@kernelsu-modules/github';
import type { ReleaseLike } from '@kernelsu-modules/validator';

export interface RepoInfo {
  id: number;
  fullName: string;
  defaultBranch: string;
  ownerId: number;
  private: boolean;
  archived: boolean;
  /** stargazers_count (display only); null when the response has none. */
  stars: number | null;
}

function repoInfo(d: any): RepoInfo {
  return {
    id: d.id,
    fullName: d.full_name,
    defaultBranch: d.default_branch,
    ownerId: d.owner?.id,
    private: !!d.private,
    archived: !!d.archived,
    stars: Number.isSafeInteger(d.stargazers_count) && d.stargazers_count >= 0 ? d.stargazers_count : null,
  };
}

export async function getRepo(gh: GitHubClient, repositoryId: number): Promise<RepoInfo | null> {
  const r = await gh.get<any>(`/repositories/${repositoryId}`, { allow: [404] });
  return r.status === 404 ? null : repoInfo(r.data);
}

/** GET /repos/{owner}/{name} (GitHub redirects renamed repositories); null when missing or not visible. */
export async function getRepoByName(gh: GitHubClient, fullName: string): Promise<RepoInfo | null> {
  const r = await gh.get<any>(`/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`, { allow: [404] });
  return r.status === 404 ? null : repoInfo(r.data);
}

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** Resolve a branch / tag / sha to a commit sha; null when the ref does not exist. */
export async function resolveCommit(gh: GitHubClient, fullName: string, ref: string): Promise<string | null> {
  const r = await gh.get<any>(`/repos/${fullName}/commits/${encPath(ref)}`, {
    allow: [404, 422, 409],
    // Plain-text sha instead of the full commit JSON (which embeds the diff).
    headers: { accept: 'application/vnd.github.sha' },
  });
  if (r.status !== 200) return null;
  const sha = typeof r.data === 'string' ? r.data : r.data?.sha;
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

/**
 * Path lookup in the tree of `commit`. Uses one recursive request; when GitHub truncates it (huge repos)
 * falls back to walking only the directories along the requested paths.
 */
export class TreeLookup {
  private full: Map<string, TreeEntry> | null = null;
  private truncated = false;
  private dirs = new Map<string, Map<string, TreeEntry>>();
  private loaded = false;

  constructor(
    private readonly gh: GitHubClient,
    private readonly fullName: string,
    private readonly commit: string,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    const r = await this.gh.get<{ sha: string; tree: TreeEntry[]; truncated: boolean }>(`/repos/${this.fullName}/git/trees/${this.commit}`, {
      query: { recursive: 1 },
    });
    this.loaded = true;
    if (r.data.truncated) {
      this.truncated = true;
      this.dirs.set('', new Map());
      return;
    }
    this.full = new Map(r.data.tree.map((e) => [e.path, e]));
  }

  private async dir(path: string, sha: string): Promise<Map<string, TreeEntry>> {
    let d = this.dirs.get(path);
    if (!d) {
      const r = await this.gh.get<{ tree: TreeEntry[] }>(`/repos/${this.fullName}/git/trees/${sha}`);
      d = new Map(r.data.tree.map((e) => [e.path, e]));
      this.dirs.set(path, d);
    }
    return d;
  }

  async get(path: string): Promise<TreeEntry | null> {
    await this.load();
    if (!this.truncated) return this.full!.get(path) ?? null;
    const segs = path.split('/');
    let cur = await this.dir('', this.commit);
    let prefix = '';
    for (let i = 0; i < segs.length; i++) {
      const e = cur.get(segs[i]!);
      if (!e) return null;
      if (i === segs.length - 1) return { ...e, path };
      if (e.type !== 'tree') return null;
      prefix = prefix ? `${prefix}/${segs[i]}` : segs[i]!;
      cur = await this.dir(prefix, e.sha);
    }
    return null;
  }
}

export async function getBlob(gh: GitHubClient, fullName: string, sha: string): Promise<Uint8Array> {
  const r = await gh.get<{ content: string; encoding: string }>(`/repos/${fullName}/git/blobs/${sha}`);
  if (r.data.encoding === 'base64') return new Uint8Array(Buffer.from(r.data.content, 'base64'));
  return new TextEncoder().encode(r.data.content);
}

export const RELEASES_PAGE = 30;

export interface GhRelease extends ReleaseLike {
  name: string | null;
  body: string | null;
  html_url: string;
}

/** A 2xx response whose body is not what the endpoint documents (empty, truncated, wrong shape). Retried next run. */
export class MalformedResponseError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`GitHub GET ${path} -> ${status}: malformed response (${detail})`);
    this.name = 'MalformedResponseError';
  }
}

/** What a releases-list read looked like on the wire (sync report / logs). */
export interface ReleasesListInfo {
  status: number;
  count: number | null;
  contentLength: number | null;
}

const shapeOf = (d: unknown) => (d === null ? 'empty body' : Array.isArray(d) ? 'array' : typeof d === 'object' ? `object with keys ${Object.keys(d).slice(0, 5).join(',') || '(none)'}` : typeof d);

/**
 * First page of the releases list. `etag` is optional and only useful within one token's lifetime: GitHub ETags
 * depend on the exact Authorization header, so an ETag from a previous run (previous installation token) never
 * matches. Sync therefore does not persist ETags.
 *
 * Fails closed: a 2xx response that is not a JSON array (empty or non-JSON body, object) throws
 * MalformedResponseError instead of reading as "no releases". The list is never proof of deletion on its own
 * either — see getRelease.
 */
export async function listReleases(
  gh: GitHubClient,
  repositoryId: number,
  etag: string | null = null,
): Promise<
  | { notModified: true; etag: string | null; info: ReleasesListInfo }
  | { notModified: false; etag: string | null; releases: GhRelease[]; info: ReleasesListInfo }
> {
  const path = `/repositories/${repositoryId}/releases`;
  const r = await gh.get<GhRelease[]>(path, { query: { per_page: RELEASES_PAGE }, etag });
  const len = Number(r.headers.get('content-length'));
  const info: ReleasesListInfo = { status: r.status, count: Array.isArray(r.data) ? r.data.length : null, contentLength: r.headers.has('content-length') && Number.isFinite(len) ? len : null };
  if (r.status === 304) return { notModified: true, etag, info };
  if (!Array.isArray(r.data)) throw new MalformedResponseError(path, r.status, shapeOf(r.data));
  return { notModified: false, etag: r.etag, releases: r.data, info };
}

/**
 * One release by id: null only on 404 (the release is gone). The only proof of deletion sync accepts — a release
 * missing from the list may be a short or stale read. A 200 that is not the requested release throws.
 */
export async function getRelease(gh: GitHubClient, repositoryId: number, releaseId: number): Promise<GhRelease | null> {
  const path = `/repositories/${repositoryId}/releases/${releaseId}`;
  const r = await gh.get<GhRelease>(path, { allow: [404] });
  if (r.status === 404) return null;
  const d = r.data as unknown;
  if (!d || typeof d !== 'object' || Array.isArray(d) || (d as GhRelease).id !== releaseId) throw new MalformedResponseError(path, r.status, shapeOf(d));
  return d as GhRelease;
}

/** Tag -> commit sha (dereferencing annotated tags); null when the tag does not exist. */
export async function resolveTagCommit(gh: GitHubClient, fullName: string, tag: string): Promise<string | null> {
  const r = await gh.get<any>(`/repos/${fullName}/git/ref/tags/${encPath(tag)}`, { allow: [404] });
  if (r.status === 404 || Array.isArray(r.data)) return null;
  let obj: { type: string; sha: string } = r.data.object;
  for (let i = 0; i < 5 && obj.type === 'tag'; i++) {
    const t = await gh.get<any>(`/repos/${fullName}/git/tags/${obj.sha}`);
    obj = t.data.object;
  }
  return obj.type === 'commit' ? obj.sha : null;
}

export interface ExistingCheckRun {
  id: number;
  external_id: string | null;
  conclusion: string | null;
  status: string;
}

export async function listCheckRuns(gh: GitHubClient, fullName: string, sha: string, name: string, appId?: number): Promise<ExistingCheckRun[]> {
  const r = await gh.get<{ check_runs: ExistingCheckRun[] }>(`/repos/${fullName}/commits/${sha}/check-runs`, {
    query: { check_name: name, filter: 'all', per_page: 100, app_id: appId },
  });
  return r.data.check_runs ?? [];
}

export async function createCheckRun(gh: GitHubClient, fullName: string, body: Record<string, unknown>): Promise<number> {
  const r = await gh.post<{ id: number }>(`/repos/${fullName}/check-runs`, body);
  return r.data.id;
}

/**
 * Errors worth retrying on the next run (network/timeouts, 5xx, rate limits — the client already retried with
 * backoff) vs. permanent ones (permission 403, 404, 422, ...), which are recorded.
 */
export function isTransient(e: unknown): boolean {
  if (e instanceof GitHubError) return e.status >= 500 || e.status === 408 || e.rateLimited;
  return true;
}
