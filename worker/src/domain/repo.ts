// Author-repository reads: user-token admin checks and Modules-App installation-token content reads.
import { GitHubError, type GitHubClient } from '@kernelsu-modules/github';

export interface RepoInfo {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  owner: { id: number; login: string };
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
  html_url: string;
}

/**
 * GET /repositories/{id} with the user's token. A user-to-server token only sees repositories that are both
 * visible to the user and covered by an installation of the KernelSU Modules App, so null also means
 * "App not installed there (for this user)". permissions.admin is the user's real role on the repo.
 */
export async function userRepo(user: GitHubClient, repositoryId: number): Promise<RepoInfo | null> {
  const res = await user.get<RepoInfo>(`/repositories/${repositoryId}`, { allow: [403, 404] });
  return res.status === 200 ? res.data : null;
}

export async function isRepoAdmin(user: GitHubClient, repositoryId: number): Promise<boolean> {
  return (await userRepo(user, repositoryId))?.permissions?.admin === true;
}

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** File text at ref via the contents API (≤ 1 MB). null if missing. Throws on size > maxBytes. */
export async function readRepoFile(gh: GitHubClient, fullName: string, path: string, ref: string, maxBytes: number): Promise<string | null> {
  const encPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await gh.get<{ type: string; size: number; content?: string; encoding?: string }>(`/repos/${fullName}/contents/${encPath}`, {
    query: { ref },
    allow: [404],
  });
  if (res.status === 404 || res.data.type !== 'file') return null;
  if (res.data.size > maxBytes) throw new FileTooLarge(path, res.data.size, maxBytes);
  if (res.data.encoding === 'base64' && res.data.content !== undefined) return decodeBase64Utf8(res.data.content);
  return res.data.content ?? '';
}

export class FileTooLarge extends Error {
  constructor(
    readonly path: string,
    readonly size: number,
    readonly max: number,
  ) {
    super(`${path} is ${size} bytes (limit ${max})`);
  }
}

/** Resolve a branch/ref to a commit sha. */
export async function resolveCommit(gh: GitHubClient, fullName: string, ref: string): Promise<string | null> {
  try {
    const res = await gh.get<{ sha: string }>(`/repos/${fullName}/commits/${encodeURIComponent(ref)}`);
    return res.data.sha;
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 404 || e.status === 422)) return null;
    throw e;
  }
}
