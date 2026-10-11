// Optimistic-concurrency commits through the Git Data API.
//
//   read base commit -> mutate(reader) -> blobs/tree/commit -> PATCH ref (force: false)
//   on non-fast-forward (422) or a stale read: re-read and re-run mutate (re-validating preconditions).
//
// mutate() MUST be pure with respect to the reader: it is re-invoked on every retry.
import { GitHubClient, GitHubError } from './client.ts';

export interface CommitReader {
  /** The base commit sha this attempt is built on. */
  readonly baseCommit: string;
  /** UTF-8 file content at the base commit, or null if absent. */
  read(path: string): Promise<string | null>;
  /** File paths under a directory prefix at the base commit (non-recursive listing of blobs, e.g. "modules/"). */
  list(prefix: string): Promise<string[]>;
}

export interface CommitPlan {
  /** path -> new content; null deletes the file. Empty map = nothing to commit. */
  files: Record<string, string | null>;
  /** Full commit message including trailers. */
  message: string;
}

/** Throw from mutate() to abort without retrying (e.g. precondition failed: "request is no longer pending"). */
export class PreconditionFailed extends Error {
  constructor(
    message: string,
    readonly code: string = 'precondition_failed',
  ) {
    super(message);
    this.name = 'PreconditionFailed';
  }
}

export interface CommitOptions {
  owner: string;
  repo: string;
  branch?: string; // default "main"
  maxAttempts?: number; // default 5
  author?: { name: string; email: string };
}

export interface CommitResult {
  commit: string | null; // null when plan.files was empty
  attempts: number;
}

export async function commitWithRetry(
  gh: GitHubClient,
  o: CommitOptions,
  mutate: (reader: CommitReader) => Promise<CommitPlan>,
): Promise<CommitResult> {
  const branch = o.branch ?? 'main';
  const base = `/repos/${o.owner}/${o.repo}`;
  const max = o.maxAttempts ?? 5;
  for (let attempt = 1; attempt <= max; attempt++) {
    const ref = await gh.get<{ object: { sha: string } }>(`${base}/git/ref/heads/${encodeURIComponent(branch)}`);
    const baseCommit = ref.data.object.sha;
    const commit = await gh.get<{ tree: { sha: string } }>(`${base}/git/commits/${baseCommit}`);
    const baseTree = commit.data.tree.sha;

    let treeCache: { path: string; type: string; sha: string }[] | null = null;
    const tree = async () => {
      if (!treeCache) {
        const t = await gh.get<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(
          `${base}/git/trees/${baseTree}`,
          { query: { recursive: 1 } },
        );
        if (t.data.truncated) throw new Error('data repository tree is truncated; too many files');
        treeCache = t.data.tree;
      }
      return treeCache;
    };
    const reader: CommitReader = {
      baseCommit,
      async read(path) {
        const entry = (await tree()).find((e) => e.path === path && e.type === 'blob');
        if (!entry) return null;
        const blob = await gh.get<{ content: string; encoding: string }>(`${base}/git/blobs/${entry.sha}`);
        return decodeBlob(blob.data.content, blob.data.encoding);
      },
      async list(prefix) {
        return (await tree()).filter((e) => e.type === 'blob' && e.path.startsWith(prefix)).map((e) => e.path);
      },
    };

    const plan = await mutate(reader); // PreconditionFailed propagates
    // Deleting a path that is not in the base tree makes POST /git/trees fail (422): drop such no-op deletions.
    const deletions = Object.entries(plan.files).filter(([, c]) => c === null);
    const present = deletions.length ? new Set((await tree()).map((e) => e.path)) : new Set<string>();
    const entries = Object.entries(plan.files).filter(([path, c]) => c !== null || present.has(path));
    if (entries.length === 0) return { commit: null, attempts: attempt };

    const treeItems = await Promise.all(
      entries.map(async ([path, content]) => {
        if (content === null) return { path, mode: '100644', type: 'blob', sha: null };
        const blob = await gh.post<{ sha: string }>(`${base}/git/blobs`, { content, encoding: 'utf-8' });
        return { path, mode: '100644', type: 'blob', sha: blob.data.sha };
      }),
    );
    const newTree = await gh.post<{ sha: string }>(`${base}/git/trees`, { base_tree: baseTree, tree: treeItems });
    const newCommit = await gh.post<{ sha: string }>(`${base}/git/commits`, {
      message: plan.message,
      tree: newTree.data.sha,
      parents: [baseCommit],
      ...(o.author ? { author: { ...o.author, date: new Date().toISOString() } } : {}),
    });
    try {
      await gh.patch(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: newCommit.data.sha, force: false });
      return { commit: newCommit.data.sha, attempts: attempt };
    } catch (e) {
      // Someone else committed first -> retry from fresh state. Other 422s (protected branch / ruleset violations,
      // validation errors) are permanent and must not be retried.
      if (e instanceof GitHubError && isRefRace(e) && attempt < max) {
        await new Promise((r) => setTimeout(r, 200 * attempt + Math.random() * 300));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`commitWithRetry: gave up after ${max} attempts`);
}

/** Non-fast-forward / concurrent ref update (retryable), as opposed to e.g. "Protected branch update failed". */
export function isRefRace(e: GitHubError): boolean {
  if (e.status === 409) return true;
  if (e.status !== 422) return false;
  const msg = typeof e.body === 'object' && e.body && 'message' in e.body ? String((e.body as { message: unknown }).message) : String(e.body ?? '');
  return /fast[- ]?forward|reference (cannot be updated|update failed)/i.test(msg);
}

function decodeBlob(content: string, encoding: string): string {
  if (encoding !== 'base64') return content;
  const bin = atob(content.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Build an audit trailer block: `Key: value` lines appended after a blank line. */
export function withTrailers(subject: string, trailers: Record<string, string | number | undefined | null>): string {
  const lines = Object.entries(trailers)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  return lines.length ? `${subject}\n\n${lines.join('\n')}\n` : `${subject}\n`;
}
