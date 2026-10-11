// GitHub stars shown for a module (display only: never affects health, validation, releases or listing).
import { AppAuthError, type GitHubApp, type GitHubClient } from '@kernelsu-modules/github';
import { canonicalJson, type LockedStars } from '@kernelsu-modules/schema';
import type { Issue } from './types.ts';
import { FatalError } from './data.ts';
import type { Logger } from './log.ts';
import { getRepo, getRepoByName, type RepoInfo } from './repo-api.ts';

/** Stored stars are refreshed (and starsRepository re-verified) at most this often unless the lock changes anyway. */
export const STARS_REFRESH_MS = 24 * 3600_000;

export const STARS_ISSUE = 'stars-repo-unverified';

/** Equal apart from the observation time. */
export function sameStars(a: LockedStars | undefined, b: LockedStars | undefined): boolean {
  const view = (s: LockedStars | undefined) => (s ? canonicalJson({ ...s, fetchedAt: undefined }) : null);
  return view(a) === view(b);
}

export function starsAgeMs(s: LockedStars, now: Date): number {
  return now.getTime() - Date.parse(s.fetchedAt);
}

export type StarsVerdict =
  | { kind: 'ok'; repo: RepoInfo; via: LockedStars['verified'] }
  | { kind: 'rejected'; problem: string }
  /** Transient / unexpected failure: keep the stored entry. */
  | { kind: 'error' };

/**
 * Verify module.yaml `starsRepository` against the bound repository: accepted only when it is public and has the
 * same owner (account id) as the bound repository, or the KernelSU Modules App is installed on it (installing an
 * App needs admin rights there, which proves control). Looked up by the stored repository id while module.yaml
 * still names the same repository (survives renames; a new repository at an old name is never picked up silently),
 * else by name. Nothing is ever written to the stars repository.
 */
export async function verifyStarsRepo(
  gh: GitHubClient,
  app: Pick<GitHubApp, 'repoInstallationById'>,
  bound: { repo: RepoInfo; ownerId: number },
  requested: string,
  prev: LockedStars | undefined,
  log: Logger,
): Promise<StarsVerdict> {
  try {
    const knownId = prev && prev.requested === requested && prev.verified !== 'self' ? prev.repositoryId : null;
    const t = (knownId !== null ? await getRepo(gh, knownId) : null) ?? (await getRepoByName(gh, requested));
    if (!t) return { kind: 'rejected', problem: 'was not found or is not public' };
    if (t.id === bound.repo.id) return { kind: 'ok', repo: bound.repo, via: 'self' };
    if (t.private) return { kind: 'rejected', problem: 'is private' };
    if (t.ownerId === bound.ownerId) return { kind: 'ok', repo: t, via: 'owner' };
    const inst = await app.repoInstallationById(t.id);
    return inst
      ? { kind: 'ok', repo: t, via: 'app' }
      : { kind: 'rejected', problem: 'belongs to another account and the KernelSU Modules App is not installed on it' };
  } catch (e) {
    if (e instanceof AppAuthError) throw new FatalError(`KernelSU Modules App authentication failed: ${e.message}`);
    if (e instanceof FatalError) throw e;
    log.log('warn', 'stars repository lookup failed', { requested, error: (e instanceof Error ? e.message : String(e)).split('\n')[0] });
    return { kind: 'error' };
  }
}

/** Content Check Run warning for a rejected starsRepository. */
export function starsIssue(requested: string, problem: string, boundFullName: string): Issue {
  return {
    code: STARS_ISSUE,
    severity: 'warning',
    message: `starsRepository "${requested}" ${problem}; the stars of ${boundFullName} are shown instead.`,
    path: 'starsRepository',
  };
}

/** Health note (status.json message) derived from the stored entry, so it only changes with the entry. */
export function starsNote(s: LockedStars | undefined): string | null {
  return s?.problem && s.requested ? `${STARS_ISSUE}: starsRepository "${s.requested}" ${s.problem}; showing the stars of the module repository` : null;
}

/** Entry for a verdict (or the bound repository's own count). Null: keep the stored entry. */
export function starsEntry(
  bound: RepoInfo,
  requested: string | undefined,
  verdict: StarsVerdict | null,
  nowIso: string,
): LockedStars | null {
  const base = (r: RepoInfo, via: LockedStars['verified']): LockedStars | null =>
    r.stars === null ? null : { count: r.stars, fetchedAt: nowIso, repositoryId: r.id, fullName: r.fullName, verified: via, ...(requested ? { requested } : {}) };
  if (!verdict) return base(bound, 'self');
  if (verdict.kind === 'error') return null;
  if (verdict.kind === 'ok') return base(verdict.repo, verdict.via);
  const self = base(bound, 'self');
  return self && { ...self, problem: verdict.problem };
}
