// Validation of an open request's repository (submit / transfer, any record status). Results go to the
// author's repository as Check Runs and to status.json `request`. Nothing is written to the lock.
import type { GitHubClient } from '@kernelsu-modules/github';
import type { ModuleLock, ModuleStatus, OpenRequest, RegistryRecord } from '@kernelsu-modules/schema';
import { createCheckOnce } from './checks.ts';
import { checkContentAt } from './content.ts';
import type { Logger } from './log.ts';
import { errMsg, problemFor, type ModuleSyncDeps } from './module-sync.ts';
import { processReleases, selectFirstSync, type ReleaseOutcome } from './releases.ts';
import { getRepo, listReleases, resolveCommit } from './repo-api.ts';
import { AppAuthError } from '@kernelsu-modules/github';
import { FatalError } from './data.ts';
import type { Issue } from './types.ts';

export type RequestStatus = NonNullable<ModuleStatus['request']>;

export interface RequestCheckResult {
  status: RequestStatus;
  installation: 'present' | 'missing';
  fullName: string;
  /** Re-validated in this run (false: previous result reused). */
  revalidated: boolean;
  outcomes: ReleaseOutcome[];
}

const issueOf = (i: Issue) => ({ code: i.code, severity: i.severity, message: i.message.slice(0, 300) });

/** Compare results ignoring checkedAt (and message wording). */
export function sameRequestResult(a: RequestStatus | null | undefined, b: RequestStatus | null | undefined): boolean {
  if (!a || !b) return a === b;
  const key = (s: RequestStatus) =>
    JSON.stringify([s.submissionId, s.repositoryId, s.ok, s.latestTag, s.commit ?? null, s.releaseId ?? null, s.issues.map((i) => [i.code, i.severity])]);
  return key(a) === key(b);
}

export async function checkRequest(
  record: RegistryRecord,
  request: OpenRequest,
  prev: RequestStatus | null,
  bound: ModuleLock | undefined,
  d: ModuleSyncDeps,
  opts: { force: boolean },
): Promise<RequestCheckResult> {
  const source = request.source;
  const log = d.log.child({ module: record.id, submission: request.submissionId, request: request.kind });
  const nowIso = d.now.toISOString();
  const issues: Issue[] = [];
  const outcomes: ReleaseOutcome[] = [];
  let fullName = source.fullName;
  let installation: 'present' | 'missing' = 'present';
  let commit: string | null = null;
  let releaseId: number | null = null;
  let latestTag: string | null = null;
  let revalidated = true;

  const result = (): RequestCheckResult => {
    const status: RequestStatus = {
      submissionId: request.submissionId,
      repositoryId: source.repositoryId,
      ok: !issues.some((i) => i.severity === 'error'),
      checkedAt: nowIso,
      latestTag,
      issues: issues.map(issueOf),
      commit,
      releaseId,
    };
    // Same result as before: keep the previous entry verbatim (no timestamp-only change).
    const keep = prev && sameRequestResult(prev, status) ? prev : status;
    log.log(keep.ok ? 'info' : 'warn', 'request checked', { ok: keep.ok, revalidated, issues: keep.issues.map((i) => i.code) });
    return { status: keep, installation, fullName, revalidated, outcomes };
  };
  const fatalIfApp = (e: unknown) => {
    if (e instanceof AppAuthError) throw new FatalError(`KernelSU Modules App authentication failed: ${e.message}`);
    if (e instanceof FatalError) throw e;
  };

  let inst: { id: number } | null;
  try {
    inst = await d.modulesApp.repoInstallationById(source.repositoryId);
  } catch (e) {
    fatalIfApp(e);
    log.log('warn', 'installation lookup failed', { error: errMsg(e) });
    issues.push({ code: 'repo-not-found', severity: 'error', message: problemFor(e, 'looking up the App installation') });
    return result();
  }
  if (!inst) {
    installation = 'missing';
    issues.push({ code: 'repo-not-found', severity: 'error', message: 'The KernelSU Modules App is not installed on the requested repository.' });
    return result();
  }
  const scope = { repositoryIds: [source.repositoryId] };
  const gh: GitHubClient = d.modulesApp.installationClient(inst.id, scope);
  const token = () => d.modulesApp.installationToken(inst!.id, scope);
  try {
    const repo = await getRepo(gh, source.repositoryId);
    if (!repo) {
      issues.push({ code: 'repo-not-found', severity: 'error', message: 'The requested repository cannot be read.' });
      return result();
    }
    fullName = repo.fullName;
    const refName = source.ref ?? repo.defaultBranch;
    commit = await resolveCommit(gh, repo.fullName, refName);
    const list = await listReleases(gh, source.repositoryId);
    const releases = list.notModified ? [] : list.releases;
    const sel = selectFirstSync(releases, repo.fullName, request.submittedAt);
    // The release that would become stable on approval: the newest eligible stable one (see selectFirstSync).
    const newest = sel.process[0] ?? null;
    releaseId = newest?.id ?? null;
    latestTag = newest?.tag_name ?? null;
    const state =
      repo.private ? { code: 'repo-private', message: 'The repository is private; only public repositories can be listed.' }
      : repo.ownerId !== source.ownerId ? { code: 'owner-changed', message: `The repository owner changed after the request was made (owner id ${source.ownerId} -> ${repo.ownerId}); submit a new request.` }
      : null;

    // Dedupe: same branch head and newest release as the last validation -> reuse it (no downloads, no checks).
    const prevState = prev?.issues.find((i) => i.code === 'repo-private' || i.code === 'owner-changed')?.code ?? null;
    if (!opts.force && prevState === (state?.code ?? null) && prev && prev.submissionId === request.submissionId && prev.repositoryId === source.repositoryId && (prev.commit ?? null) === commit && (prev.releaseId ?? null) === releaseId) {
      revalidated = false;
      log.log('debug', 'request unchanged since last check');
      return { status: prev, installation, fullName, revalidated, outcomes };
    }

    if (state) issues.push({ code: state.code, severity: 'error', message: state.message });
    if (!commit) {
      issues.push({ code: 'ref-not-found', severity: 'error', message: `Branch "${refName}" does not exist.` });
      return result();
    }
    const manifestPath = source.manifestPath ?? 'module.yaml';
    const content = await checkContentAt(gh, { fullName: repo.fullName, commit, manifestPath, id: record.id, limits: d.policy.limits });
    issues.push(...content.issues);
    if (d.checks) {
      try {
        await createCheckOnce(
          gh,
          repo.fullName,
          {
            headSha: commit,
            externalId: `content:${commit}`,
            conclusion: content.ok && !state ? 'success' : 'failure',
            title: state ? `Request blocked: ${state.code}` : content.ok ? 'module.yaml and documents are valid' : 'module.yaml or documents are invalid',
            lines: [
              `Checked \`${manifestPath}\` and the files it references at \`${commit}\` (branch \`${refName}\`) for the pending ${request.kind} request.`,
              content.ok && !state ? 'Maintainers see this result when reviewing the request.' : 'Fix the problems below; the request is re-checked automatically.',
            ],
            issues: state ? [{ code: state.code, severity: 'error', message: state.message }, ...content.issues] : content.issues,
          },
          { appId: d.modulesAppId, now: d.now, dedupe: !opts.force },
        );
      } catch (e) {
        fatalIfApp(e);
        log.log('warn', 'request content check run failed', { error: errMsg(e) });
      }
    }
    if (!newest) {
      issues.push({ code: 'release-none', severity: 'error', message: 'The repository has no published release yet.' });
      return result();
    }
    if (!content.manifest) return result(); // asset selection needs a valid module.yaml
    const r = await processReleases({
      gh,
      fetch: d.fetch,
      token,
      fullName: repo.fullName,
      id: record.id,
      policy: d.policy,
      // Transfers: the module's high-water mark applies to the new repository (warning only).
      maxVersionCode: request.kind === 'transfer' ? (bound?.maxVersionCode ?? null) : null,
      locked: request.kind === 'transfer' && bound && bound.repositoryId === source.repositoryId ? [...bound.releases] : [],
      seen: {},
      candidates: [newest],
      assetPattern: content.manifest.release?.assetPattern,
      metamodule: content.manifest.metamodule,
      kind: content.manifest.kind,
      now: d.now,
      checks: d.checks,
      appId: d.modulesAppId,
      mode: 'request',
      freshChecks: opts.force,
      log,
    });
    outcomes.push(...r.outcomes);
    for (const o of r.outcomes) issues.push(...o.issues);
    if (r.transient) {
      issues.push({ code: 'asset-download-failed', severity: 'error', message: 'The release could not be downloaded; it is retried on the next run.' });
      releaseId = null; // no dedupe match next run -> retried
    }
    return result();
  } catch (e) {
    fatalIfApp(e);
    log.log('warn', 'request check failed', { error: errMsg(e) });
    commit = null; // retried on the next run
    releaseId = null;
    issues.push({ code: 'repo-not-found', severity: 'error', message: problemFor(e, 'checking the requested repository') });
    return result();
  }
}
