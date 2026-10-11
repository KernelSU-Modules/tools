// Per-module sync of a bound source: installation -> repo -> content -> releases -> health. Never throws for
// per-module problems; only App-level authentication failures (AppAuthError) are fatal.
import { AppAuthError, GitHubError, GitHubNetworkError, type GitHubApp, type GitHubClient } from '@kernelsu-modules/github';
import { canonicalJson, type LockedRelease, type ModuleLock, type Policy, type RegistryRecord, type Source } from '@kernelsu-modules/schema';
import type { Issue, ModuleManifest } from './types.ts';
import { createCheckOnce, type CheckSpec } from './checks.ts';
import { checkContentAt, trackedUnchanged } from './content.ts';
import { FatalError } from './data.ts';
import type { Logger } from './log.ts';
import { pickCandidates, processReleases, recomputeReleases, selectFirstSync, type ReleaseOutcome } from './releases.ts';
import { STARS_REFRESH_MS, sameStars, starsAgeMs, starsEntry, starsIssue, starsNote, verifyStarsRepo, type StarsVerdict } from './stars.ts';
import { RELEASES_PAGE, TreeLookup, getRepo, listReleases, resolveCommit, resolveTagCommit, type GhRelease, type RepoInfo } from './repo-api.ts';

export interface ModuleSyncDeps {
  fetch: typeof fetch;
  modulesApp: Pick<GitHubApp, 'repoInstallationById' | 'installationClient' | 'installationToken'>;
  log: Logger;
  now: Date;
  policy: Policy;
  /** Create Check Runs (false in --dry-run). */
  checks: boolean;
  modulesAppId?: number;
}

export interface ModuleReport {
  id: string;
  recordStatus: RegistryRecord['status'];
  health: ModuleLock['health']['status'] | 'skipped';
  installation: 'present' | 'missing' | 'unknown';
  message: string | null;
  fullName: string;
  content: { commit: string | null; revalidated: boolean; ok: boolean; issues: Issue[]; check?: string } | null;
  releasesList: 'fetched' | 'skipped' | 'failed';
  releases: ReleaseOutcome[];
  stable: { tag: string; versionCode: number } | null;
  prerelease: { tag: string; versionCode: number } | null;
  /** Filled in by the orchestrator: whether the module's lock entry changed. */
  changed?: boolean;
}

/** The bound source synced into the lock (listed / suspended records). Requests are validated separately. */
export function sourceOf(record: RegistryRecord): Source | undefined {
  return record.source;
}

/** When the current binding was made (approval / auto-approval time); releases before it are not reported. */
export function bindTimeOf(record: RegistryRecord): string | null {
  return record.review?.decision === 'approved' ? record.review.decidedAt : (record.createdAt ?? null);
}

/** Lock entry for a new binding. The versionCode high-water marks survive repository transfers. */
export function freshLock(record: RegistryRecord, source: Source, prev?: ModuleLock): ModuleLock {
  return {
    id: record.id,
    repositoryId: source.repositoryId,
    fullName: source.fullName,
    installationId: null,
    content: null,
    stable: null,
    prerelease: null,
    maxVersionCode: prev?.maxVersionCode ?? null,
    maxStableVersionCode: prev?.maxStableVersionCode ?? null,
    releases: [],
    seen: {},
    health: { status: 'error', installation: 'present', lastAttemptAt: new Date(0).toISOString(), lastSuccessAt: null, message: null },
  };
}

const ref = (r: LockedRelease | null) => (r ? { tag: r.tag, versionCode: r.versionCode } : null);
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 300);

/**
 * Deterministic problem text for a GitHub failure (raw errors go to the log): health messages are committed, so
 * they must not vary between runs for the same condition.
 */
export function problemFor(e: unknown, what: string): string {
  if (e instanceof GitHubError) {
    if (e.rateLimited) return `rate-limited: GitHub API rate limit while ${what}; will retry`;
    if (e.status === 401) return `auth-failed: the installation token was rejected while ${what} (HTTP 401); is the KernelSU Modules App still installed?`;
    if (e.status === 403) return `permission-denied: the KernelSU Modules App may not access the repository while ${what} (HTTP 403); check the installation and its permissions`;
    if (e.status >= 500 || e.status === 408) return `github-unavailable: temporary GitHub error while ${what}; will retry`;
    return `github-error: HTTP ${e.status} while ${what}`;
  }
  if (e instanceof GitHubNetworkError) return `github-unavailable: network error or timeout while ${what}; will retry`;
  return `sync-failed: unexpected error while ${what}`;
}

/** Rethrow App-level auth failures as fatal (every installation is affected). */
function fatalIfApp(e: unknown): void {
  if (e instanceof AppAuthError) throw new FatalError(`KernelSU Modules App authentication failed: ${e.message}`);
  if (e instanceof FatalError) throw e;
}

export async function syncModule(
  record: RegistryRecord,
  prev: ModuleLock | undefined,
  d: ModuleSyncDeps,
  opts: { force: boolean },
): Promise<{ lock: ModuleLock; report: ModuleReport }> {
  const source = record.source!;
  const log = d.log.child({ module: record.id });
  // A different repositoryId means an approved transfer to another repository: start over (keeping the marks).
  const base: ModuleLock = prev && prev.repositoryId === source.repositoryId ? prev : freshLock(record, source, prev);
  const lock: ModuleLock = { ...base, health: { ...base.health } };
  const report: ModuleReport = {
    id: record.id,
    recordStatus: record.status,
    health: 'ok',
    installation: 'unknown',
    message: null,
    fullName: base.fullName,
    content: null,
    releasesList: 'skipped',
    releases: [],
    stable: ref(base.stable),
    prerelease: ref(base.prerelease),
  };
  const problems: string[] = [];
  const notes: string[] = [];
  const nowIso = d.now.toISOString();

  const finish = () => {
    const ok = problems.length === 0;
    const sn = starsNote(lock.stars);
    if (sn) notes.push(sn);
    lock.health = {
      status: ok ? 'ok' : base.health.lastSuccessAt ? 'stale' : 'error',
      installation: report.installation === 'unknown' ? base.health.installation : report.installation,
      lastAttemptAt: nowIso,
      lastSuccessAt: ok ? nowIso : base.health.lastSuccessAt,
      message: [...problems, ...notes].join('; ').slice(0, 1000) || null,
    };
    report.health = lock.health.status;
    report.message = lock.health.message;
    report.fullName = lock.fullName;
    report.stable = ref(lock.stable);
    report.prerelease = ref(lock.prerelease);
    log.log(ok ? 'info' : 'warn', 'module synced', { health: lock.health.status, message: lock.health.message });
    return { lock, report };
  };

  // 1. installation
  let inst: { id: number } | null;
  try {
    inst = await d.modulesApp.repoInstallationById(source.repositoryId);
  } catch (e) {
    fatalIfApp(e);
    log.log('warn', 'installation lookup failed', { error: errMsg(e) });
    problems.push(problemFor(e, 'looking up the App installation'));
    return finish();
  }
  if (!inst) {
    // No access at all: nothing can be reported on the repository; the Portal shows status.json.
    report.installation = 'missing';
    lock.installationId = null;
    problems.push('installation-missing: the KernelSU Modules App is not installed on the repository; using the last synced data');
    return finish();
  }
  report.installation = 'present';
  lock.installationId = inst.id;
  const scope = { repositoryIds: [source.repositoryId] };
  const gh: GitHubClient = d.modulesApp.installationClient(inst.id, scope);
  const token = () => d.modulesApp.installationToken(inst!.id, scope);
  let stage = 'reading the repository';

  try {
    // 2. repository
    const repo = await getRepo(gh, source.repositoryId);
    if (!repo) {
      problems.push('repo-not-found: the repository cannot be read');
      return finish();
    }
    lock.fullName = repo.fullName;
    const refName = source.ref ?? repo.defaultBranch;
    const state = repo.private
      ? { code: 'repo-private', text: 'the repository is private; only public repositories are listed' }
      : repo.ownerId !== source.ownerId
        ? { code: 'owner-changed', text: `the repository owner changed (bound owner id ${source.ownerId}, now ${repo.ownerId}); request a transfer in the Developer Portal` }
        : null;
    if (state) {
      problems.push(`${state.code}: ${state.text}`);
      await stateCheck(gh, repo, refName, state, d, opts.force, log);
      return finish();
    }

    // 3. content
    stage = 'reading module.yaml';
    const manifestPath = source.manifestPath ?? 'module.yaml';
    let manifest: ModuleManifest | undefined;
    /** starsRepository verdict of this run (verified with the content check, reused by the stars step). */
    let starsVerdict: { requested: string; verdict: StarsVerdict } | null = null;
    const verifyStars = async (requested: string) => {
      if (starsVerdict?.requested !== requested)
        starsVerdict = { requested, verdict: await verifyStarsRepo(gh, d.modulesApp, { repo, ownerId: source.ownerId }, requested, base.stars, log) };
      return starsVerdict.verdict;
    };
    const otherRepo = (requested: string | undefined) => (requested && requested.toLowerCase() !== repo.fullName.toLowerCase() ? requested : undefined);
    /**
     * Stars (display only; never health / validation). The bound repository's count comes with the repository
     * response above; module.yaml starsRepository is (re-)verified only when the stored entry is missing, ≥ 24 h old
     * or for another request, on forced runs, and when content / releases change — i.e. only when the result can be
     * persisted (see lockToPersist).
     */
    const stars = async () => {
      stage = 'reading stars';
      const prev = base.stars;
      // module.yaml at the locked content: the manifest read this run, else the request recorded with the stars.
      const requested = manifest ? manifest.starsRepository : prev?.requested;
      const other = otherRepo(requested);
      let next: ReturnType<typeof starsEntry>;
      if (!other) next = starsEntry(repo, requested, null, nowIso);
      else {
        const due = !prev || prev.requested !== requested || starsAgeMs(prev, d.now) >= STARS_REFRESH_MS || opts.force || dataView(base) !== dataView(lock) || starsVerdict !== null;
        next = due ? starsEntry(repo, requested, await verifyStars(other), nowIso) : null;
      }
      if (next && !sameStars(prev, next)) lock.stars = next;
    };
    const done = async () => {
      await stars();
      return finish();
    };
    const commit = await resolveCommit(gh, repo.fullName, refName);
    const prevContent = base.content && base.content.manifestPath === manifestPath && base.content.ref === refName ? base.content : null;
    if (!commit) {
      report.content = { commit: null, revalidated: true, ok: false, issues: [{ code: 'ref-not-found', severity: 'error', message: `Branch "${refName}" does not exist.` }] };
      problems.push(`ref-not-found: branch "${refName}" does not exist`);
    } else if (!opts.force && prevContent && prevContent.commit === commit) {
      report.content = { commit, revalidated: false, ok: true, issues: [] };
    } else {
      const tree = new TreeLookup(gh, repo.fullName, commit);
      // Unrelated pushes: when no tracked file changed (one tree listing), keep the locked commit — no lock churn.
      if (!opts.force && prevContent?.blobs && (await trackedUnchanged(tree, prevContent.blobs))) {
        report.content = { commit: prevContent.commit, revalidated: false, ok: true, issues: [] };
      } else {
        const res = await checkContentAt(gh, { fullName: repo.fullName, commit, manifestPath, id: record.id, limits: d.policy.limits, tree });
        report.content = { commit, revalidated: true, ok: res.ok, issues: res.issues };
        let changed = false;
        if (res.ok && res.files && res.blobs) {
          manifest = res.manifest;
          const other = otherRepo(manifest?.starsRepository);
          if (other) {
            const v = await verifyStars(other);
            if (v.kind === 'rejected') res.issues.push(starsIssue(other, v.problem, repo.fullName));
          }
          if (prevContent && sameMap(prevContent.files, res.files)) {
            // Same bytes at a newer commit: keep the locked commit; only fill in blob shas (older entries).
            lock.content = prevContent.blobs && sameMap(prevContent.blobs, res.blobs) ? prevContent : { ...prevContent, blobs: res.blobs };
          } else {
            lock.content = { ref: refName, commit, fetchedAt: nowIso, manifestPath, files: res.files, blobs: res.blobs };
            changed = true;
          }
        } else {
          const codes = [...new Set(res.issues.filter((i) => i.severity === 'error').map((i) => i.code))].join(', ');
          problems.push(`content-invalid: module.yaml or a referenced file is invalid on branch "${refName}" (${codes})`);
        }
        if (d.checks && (changed || !res.ok || opts.force)) {
          try {
            const r = await createCheckOnce(
              gh,
              repo.fullName,
              {
                headSha: commit,
                externalId: `content:${commit}`,
                conclusion: res.ok ? 'success' : 'failure',
                title: res.ok ? 'module.yaml and documents are valid' : 'module.yaml or documents are invalid',
                lines: [
                  `Checked \`${manifestPath}\` and the files it references at \`${commit}\` (branch \`${refName}\`).`,
                  res.ok
                    ? 'KernelSU Modules uses this content for the module page.'
                    : base.content
                      ? `KernelSU Modules keeps using the last valid content (\`${base.content.commit.slice(0, 7)}\`) until this is fixed.`
                      : 'The module cannot be published until this is fixed.',
                ],
                issues: res.issues,
              },
              { appId: d.modulesAppId, now: d.now, dedupe: !opts.force },
            );
            report.content.check = r.created ? 'created' : 'exists';
          } catch (e) {
            report.content.check = 'failed';
            log.log('warn', 'content check run failed', { error: errMsg(e) });
          }
        }
      }
    }

    // 4. releases (first page; no ETag: GitHub ETags are bound to the token and every run has a new one)
    stage = 'listing releases';
    let list: GhRelease[];
    try {
      const l = await listReleases(gh, source.repositoryId);
      list = l.notModified ? [] : l.releases;
    } catch (e) {
      fatalIfApp(e);
      report.releasesList = 'failed';
      log.log('warn', 'releases list failed', { error: errMsg(e) });
      problems.push(problemFor(e, 'listing releases'));
      return done();
    }
    report.releasesList = 'fetched';
    stage = 'checking releases';
    const firstSync = Object.keys(base.seen).length === 0;
    let candidates: GhRelease[];
    const seen = { ...lock.seen };
    if (firstSync) {
      const sel = selectFirstSync(list, repo.fullName, bindTimeOf(record));
      for (const r of sel.skip)
        seen[String(r.id)] = { ok: false, skipped: true, message: 'Not examined: published before the newest eligible release when the module was bound.', checkedAt: nowIso };
      candidates = sel.process;
    } else candidates = pickCandidates(list, seen, opts.force);
    lock.seen = seen;
    const pool = [...base.releases, base.stable, base.prerelease].filter((x): x is LockedRelease => !!x);
    let accepted: LockedRelease[] = [];
    if (candidates.length) {
      // Asset selection uses release.assetPattern from the last valid content.
      if (!manifest && lock.content) {
        const m = await checkContentAt(gh, {
          fullName: repo.fullName,
          commit: lock.content.commit,
          manifestPath: lock.content.manifestPath,
          id: record.id,
          limits: d.policy.limits,
          manifestOnly: true,
        });
        manifest = m.manifest;
      }
      if (!manifest) {
        problems.push('releases-pending: releases are checked once module.yaml is valid');
        lock.seen = base.seen; // first-sync skips are decided again once releases can be processed
        return done();
      }
      const r = await processReleases({
        gh,
        fetch: d.fetch,
        token,
        fullName: repo.fullName,
        id: record.id,
        policy: d.policy,
        maxVersionCode: lock.maxVersionCode,
        locked: pool,
        seen: lock.seen,
        candidates,
        assetPattern: manifest.release?.assetPattern,
        metamodule: manifest.metamodule,
        now: d.now,
        checks: d.checks,
        appId: d.modulesAppId,
        freshChecks: opts.force,
        log,
      });
      accepted = r.accepted;
      lock.seen = r.seen;
      report.releases = r.outcomes;
      if (r.transient) problems.push('release-retry: some releases could not be checked and will be retried');
    }
    const rc = recomputeReleases(lock, accepted, list, {
      keep: d.policy.history.keepReleases,
      listComplete: list.length < RELEASES_PAGE,
      changelogMaxBytes: d.policy.limits.changelogMaxBytes,
    });
    const { note, ...picked } = rc;
    Object.assign(lock, picked);
    if (note) notes.push(note);
    if (opts.force && d.checks) await reemitNewestRelease(gh, repo.fullName, list, lock, report.releases, d, log);
    return done();
  } catch (e) {
    fatalIfApp(e);
    log.log('warn', 'module sync failed', { error: errMsg(e), stage });
    problems.push(problemFor(e, stage));
    return finish();
  }
}

/** Repository state problem (private / owner changed) reported as a failing Check Run on the branch head. */
async function stateCheck(
  gh: GitHubClient,
  repo: RepoInfo,
  refName: string,
  state: { code: string; text: string },
  d: Pick<ModuleSyncDeps, 'checks' | 'modulesAppId' | 'now'>,
  force: boolean,
  log: Logger,
): Promise<void> {
  if (!d.checks) return;
  try {
    const head = await resolveCommit(gh, repo.fullName, refName);
    if (!head) return;
    await createCheckOnce(
      gh,
      repo.fullName,
      {
        headSha: head,
        externalId: `state:${state.code}`,
        conclusion: 'failure',
        title: `Sync paused: ${state.code}`,
        lines: ['KernelSU Modules stopped syncing this repository and keeps serving the last synced version (marked stale).'],
        issues: [{ code: state.code, severity: 'error', message: `${state.text[0]!.toUpperCase()}${state.text.slice(1)}.` }],
      },
      { appId: d.modulesAppId, now: d.now, dedupe: !force },
    );
  } catch (e) {
    fatalIfApp(e);
    log.log('warn', 'state check run failed', { error: errMsg(e) });
  }
}

/**
 * Sync now / Re-run: post a fresh Check Run for the newest release even when it was decided earlier (releases are
 * validated once; this re-reports the recorded result).
 */
async function reemitNewestRelease(
  gh: GitHubClient,
  fullName: string,
  list: GhRelease[],
  lock: ModuleLock,
  processed: ReleaseOutcome[],
  d: Pick<ModuleSyncDeps, 'modulesAppId' | 'now'>,
  log: Logger,
): Promise<void> {
  const newest = list.filter((r) => !r.draft).sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? '') || b.id - a.id)[0];
  if (!newest || processed.some((p) => p.releaseId === newest.id)) return;
  const seen = lock.seen[String(newest.id)];
  if (!seen) return;
  const lockedRel = [lock.stable, lock.prerelease, ...lock.releases].find((r) => r?.releaseId === newest.id) ?? null;
  try {
    const head = lockedRel?.tagCommit ?? (await resolveTagCommit(gh, fullName, newest.tag_name));
    if (!head) return;
    const failed = !seen.ok && !seen.skipped;
    const issues: Issue[] = failed && seen.code ? [{ code: seen.code, severity: 'error', message: seen.message ?? 'Rejected.' }] : [];
    const spec: CheckSpec = {
      headSha: head,
      externalId: `release:${newest.id}`,
      conclusion: failed ? 'failure' : 'success',
      title: lockedRel
        ? `${lockedRel.version} (${lockedRel.versionCode}) ${lock.stable?.releaseId === newest.id ? 'is the stable version' : 'accepted'}`
        : seen.skipped
          ? 'Release not examined'
          : failed
            ? `Release rejected: ${seen.code ?? 'error'}`
            : 'Release checked',
      lines: [
        `Release [${newest.tag_name}](${newest.html_url}) (id ${newest.id}).`,
        `Result recorded at ${seen.checkedAt}. Immutable releases are validated once; this run re-reports the result.`,
        ...(seen.skipped ? [seen.message ?? ''] : []),
      ],
      issues,
    };
    await createCheckOnce(gh, fullName, spec, { appId: d.modulesAppId, now: d.now, dedupe: false });
  } catch (e) {
    fatalIfApp(e);
    log.log('warn', 'release check re-report failed', { error: errMsg(e) });
  }
}

/** Lock data apart from health and stars: what decides whether the entry changes anyway. */
function dataView(m: ModuleLock): string {
  return canonicalJson({ ...m, health: undefined, stars: undefined });
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}
