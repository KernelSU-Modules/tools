// Maintainer views and input checks shared by the cookie API (routes/admin.ts) and the MCP endpoint (routes/mcp.ts).
import { splitFullName, type GitHubClient } from '@kernelsu-modules/github';
import { ReasonCode } from '@kernelsu-modules/schema';
import { ApiError } from '../lib/errors.ts';
import type { Services } from '../services.ts';
import { lastSuccessfulSync } from './actions.ts';
import { newestSuccessAt } from './data.ts';
import { indexOf } from './index.ts';
import { dispatchSync } from './ops.ts';
import { requestExpired } from './state.ts';

/** GET /api/admin/queue: open requests, oldest first. */
export async function queueView(svc: Services) {
  const snap = await svc.data.snapshot();
  const now = svc.now();
  const open = indexOf(snap).open;
  const status = open.length ? await svc.data.status(snap) : null;
  return open.map((r) => {
    const entry = status?.modules[r.id];
    // The sync's validation of this request's source (status.json), only when it belongs to this request.
    const check = entry?.request;
    return {
      id: r.id,
      status: r.status,
      request: r.request!,
      ...(r.source ? { source: r.source } : {}),
      // Current name of the repository the sync follows by id (renames); the record keeps the name at submit time.
      ...(entry ? { sync: { repositoryId: entry.repositoryId, fullName: entry.fullName } } : {}),
      ...(check && check.submissionId === r.request!.submissionId ? { check } : {}),
      expired: requestExpired(r.request!, snap.policy, now),
    };
  });
}

/** Single request (open or already decided) by submissionId. */
export async function requestView(svc: Services, submissionId: string) {
  const snap = await svc.data.snapshot();
  const ix = indexOf(snap);
  const r = ix.openBySubmission.get(submissionId) ?? ix.reviewedBySubmission.get(submissionId);
  if (!r) throw new ApiError(404, 'not-found', `Request ${submissionId} not found.`);
  return { ...r, open: r.request?.submissionId === submissionId };
}

/** Any record by module id with its status.json entry (maintainer view, no repository-admin check). */
export async function moduleAdminView(svc: Services, id: string) {
  const snap = await svc.data.snapshot();
  const rec = snap.records[id];
  if (!rec) throw new ApiError(404, 'not-found', `Module "${id}" not found.`);
  const st = (await svc.data.status(snap)).modules[id];
  const req = st?.request && rec.request?.submissionId === st.request.submissionId ? st.request : null;
  return { ...rec, ...(st ? { sync: { ...st, request: req } } : {}) };
}

/** GET /api/admin/status: status.json per module + the newest sync workflow runs. `only` narrows the module list. */
export async function statusView(svc: Services, only?: ReadonlySet<string>) {
  const snap = await svc.data.snapshot();
  const status = await svc.data.status(snap);
  const modules = Object.entries(status.modules)
    .filter(([id]) => !only || only.has(id))
    .map(([id, m]) => {
      const rec = snap.records[id];
      const req = m.request && rec?.request?.submissionId === m.request.submissionId ? m.request : null;
      return { id, status: rec?.status, ...m, request: req };
    });
  const run = (r: any) => ({
    id: r.id,
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    htmlUrl: r.html_url,
    displayTitle: r.display_title,
  });
  let runs: unknown[] = [];
  let lastSuccessfulRun: unknown = null;
  try {
    const { owner, repo } = splitFullName(svc.env.TOOLS_REPO);
    const gh = await svc.toolsClient();
    const [res, ok] = await Promise.all([
      gh.get<{ workflow_runs: any[] }>(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(svc.env.SYNC_WORKFLOW)}/runs`, {
        query: { per_page: 10 },
      }),
      lastSuccessfulSync(svc),
    ]);
    runs = res.data.workflow_runs.map(run);
    lastSuccessfulRun = ok ? run(ok) : null;
  } catch (e) {
    console.error('workflow runs failed', (e as Error).message);
  }
  return {
    generatedAt: new Date(svc.now()).toISOString(),
    dataCommit: snap.commit,
    newestSuccessAt: newestSuccessAt(status),
    lastSuccessfulRun,
    invalidFiles: snap.invalid,
    modules,
    runs,
  };
}

/** Body of a reject decision: a known reasonCode; free text (≤500) required for "other". */
export function parseReject(b: Record<string, unknown>): { reasonCode: ReasonCode; reason: string | null } {
  const rc = ReasonCode.safeParse(b.reasonCode);
  if (!rc.success) throw new ApiError(400, 'bad-request', `reasonCode must be one of ${ReasonCode.options.join(', ')}`);
  const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : null;
  if (rc.data === 'other' && !reason) throw new ApiError(400, 'bad-request', 'reason is required for reasonCode "other"');
  return { reasonCode: rc.data, reason };
}

/** Reason of a request-changes decision: required, ≤500 characters. */
export function parseChangesReason(v: unknown): string {
  const reason = typeof v === 'string' ? v.trim() : '';
  if (!reason) throw new ApiError(400, 'bad-request', 'reason is required: tell the submitter what to change');
  if (reason.length > 500) throw new ApiError(400, 'bad-request', 'reason must be at most 500 characters');
  return reason;
}

/** Login of a GitHub user id for the banned list (best effort; null when unknown). */
export async function loginOf(gh: GitHubClient, githubId: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(githubId) || githubId <= 0) return undefined;
  const u = await gh.get<{ login: string }>(`/user/${githubId}`, { allow: [404] }).catch(() => null);
  return u?.status === 200 ? u.data.login : undefined;
}

export const SYNC_INTERVAL_S = 600;

/**
 * Dispatch the sync for one module, rate-limited to 1 per SYNC_INTERVAL_S per module (Cache API marker; per colo,
 * enough for a courtesy limit). Throws 429 rate-limited (details.nextAllowedAt, retryAfter) or 502 dispatch-failed.
 */
export async function requestModuleSync(svc: Services, id: string): Promise<{ nextAllowedAt: string }> {
  const key = `rl/sync/${id}`;
  const until = Number(await svc.deps.cache.get(key));
  if (until && until > svc.now()) {
    const retryAfter = Math.ceil((until - svc.now()) / 1000);
    throw new ApiError(429, 'rate-limited', `Sync was requested recently; try again in ${retryAfter}s.`, {
      nextAllowedAt: new Date(until).toISOString(),
      retryAfter,
    });
  }
  const nextAllowed = svc.now() + SYNC_INTERVAL_S * 1000;
  await svc.deps.cache.put(key, String(nextAllowed), SYNC_INTERVAL_S);
  if (!(await dispatchSync(svc, { reason: 'portal', module: id }))) {
    await svc.deps.cache.delete(key);
    throw new ApiError(502, 'dispatch-failed', 'Could not start the sync workflow; try again later.');
  }
  return { nextAllowedAt: new Date(nextAllowed).toISOString() };
}
