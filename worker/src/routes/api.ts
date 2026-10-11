// Developer Portal JSON API (cookie session; mutating requests need X-CSRF-Token).
import { Hono, type Context } from 'hono';
import type { ModuleStatus, RegistryRecord, RegistryStatus } from '@kernelsu-modules/schema';
import { checkModuleId, parseManifest } from '@kernelsu-modules/validator';
import { getSecret, putSecret } from '../lib/cache.ts';
import { ApiError } from '../lib/errors.ts';
import { csrfToken, verifyCsrf } from '../lib/session.ts';
import { deferrer, type AppEnv } from '../types.ts';
import type { Snapshot } from '../domain/data.ts';
import { indexOf, recordsForRepo } from '../domain/index.ts';
import {
  activeIds,
  createSubmission,
  createTransfer,
  dispatchSync,
  maintainerByGithub,
  type UserCtx,
} from '../domain/ops.ts';
import { precheck } from '../domain/precheck.ts';
import { FileTooLarge, isRepoAdmin, readRepoFile, resolveCommit, userRepo } from '../domain/repo.ts';
import { idIsFree, requestExpired } from '../domain/state.ts';
import { admin } from './admin.ts';

export const api = new Hono<AppEnv>();

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Preview returns raw Markdown (the SPA renders it with @kernelsu-modules/render); cap the payload. */
export const PREVIEW_MAX_BYTES = 512 * 1024;
/**
 * GitHub requests /api/repos may spend (Workers Free: 50 subrequests per invocation; the rest of the request
 * needs a few for the data snapshot and tokens). Pages beyond this are dropped and the response says `truncated`.
 */
export const REPOS_MAX_REQUESTS = 30;
const SYNC_INTERVAL_S = 600;

api.use('*', async (c, next) => {
  if (!SAFE.has(c.req.method)) {
    const s = c.var.session;
    if (!s) throw new ApiError(401, 'unauthorized', 'Sign in first.');
    if (!(await verifyCsrf(c.env, s, c.req.header('x-csrf-token')))) throw new ApiError(403, 'csrf', 'Missing or invalid X-CSRF-Token.');
  }
  await next();
});

export function requireUser(c: Context<AppEnv>): UserCtx {
  const s = c.var.session;
  if (!s) throw new ApiError(401, 'unauthorized', 'Sign in first.');
  return { id: s.uid, login: s.login, gh: c.var.svc.userClient(s.at) };
}

export async function jsonBody<T = Record<string, unknown>>(c: Context<AppEnv>): Promise<T> {
  try {
    const b = await c.req.json();
    if (b && typeof b === 'object') return b as T;
  } catch {
    /* fallthrough */
  }
  throw new ApiError(400, 'bad-request', 'Expected a JSON object body.');
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);

api.get('/me', async (c) => {
  const s = c.var.session;
  const installUrl = `https://github.com/apps/${c.env.MODULES_APP_SLUG}/installations/new`;
  if (!s) return c.json({ user: null, isMaintainer: false, csrf: '', installUrl });
  const snap = await c.var.svc.data.snapshot().catch((e) => {
    console.error('snapshot failed', (e as Error).message);
    return null;
  });
  return c.json({
    user: { id: s.uid, login: s.login, avatarUrl: s.avatar },
    isMaintainer: !!snap && !!maintainerByGithub(snap, s.uid),
    csrf: await csrfToken(c.env, s),
    installUrl,
  });
});

interface RepoRow {
  repositoryId: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
  isAdmin: boolean;
  registeredId: string | null;
}

/** Record currently tied to a repository (any status except rejected), via source or a live request. */
function registeredIdFor(snap: Snapshot, repositoryId: number, now: number): string | null {
  for (const r of recordsForRepo(snap, repositoryId)) {
    if (r.status !== 'rejected' && r.source?.repositoryId === repositoryId) return r.id;
    if (r.request?.source.repositoryId === repositoryId && !requestExpired(r.request, snap.policy, now)) return r.id;
  }
  return null;
}

interface RepoList {
  rows: Omit<RepoRow, 'registeredId'>[];
  truncated: boolean;
}

const repoListKey = (c: Context<AppEnv>, user: UserCtx) => `repos/v2/${user.id}/${c.var.session!.sid}`;

/**
 * Repositories of the user's KernelSU Modules App installations (cached 60 s per session, sealed). Fetches at
 * most REPOS_MAX_REQUESTS pages (100 items each) in total; `truncated` reports that something was left out.
 */
async function listRepos(c: Context<AppEnv>, user: UserCtx): Promise<RepoList> {
  const svc = c.var.svc;
  const key = repoListKey(c, user);
  const cached = await getSecret<RepoList>(svc.deps.cache, c.env.SESSION_KEY, key);
  if (cached) return cached;
  let left = REPOS_MAX_REQUESTS;
  let truncated = false;
  /** One paginated listing within the remaining request budget. */
  const pages = async <T>(path: string, pick: (d: any) => T[], per: number): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      if (left <= 0) {
        truncated = true;
        break;
      }
      left--;
      const res = await user.gh.get<any>(path, { query: { per_page: per, page } });
      const items = pick(res.data) ?? [];
      out.push(...items);
      if (items.length < per || !/rel="next"/.test(res.headers.get('link') ?? '')) break;
    }
    return out;
  };
  const installs = await pages<{ id: number }>('/user/installations', (d) => d.installations, 100);
  const rows: Omit<RepoRow, 'registeredId'>[] = [];
  for (const inst of installs) {
    if (left <= 0) {
      truncated = true;
      break;
    }
    const repos = await pages<{ id: number; full_name: string; private: boolean; default_branch: string; permissions?: { admin?: boolean } }>(
      `/user/installations/${inst.id}/repositories`,
      (d) => d.repositories,
      100,
    );
    for (const r of repos)
      rows.push({
        repositoryId: r.id,
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        installationId: inst.id,
        isAdmin: r.permissions?.admin === true,
      });
  }
  const res = { rows, truncated };
  await putSecret(svc.deps.cache, c.env.SESSION_KEY, key, res, 60);
  return res;
}

api.get('/repos', async (c) => {
  const user = requireUser(c);
  const [list, snap] = await Promise.all([listRepos(c, user), c.var.svc.data.snapshot()]);
  const now = c.var.svc.now();
  return c.json({ repos: list.rows.map((r) => ({ ...r, registeredId: registeredIdFor(snap, r.repositoryId, now) })), truncated: list.truncated });
});

/** Modules App installation client for a repo the caller may inspect (visible to the user, or maintainer + open request). */
async function inspectableRepo(c: Context<AppEnv>, repositoryId: number) {
  const svc = c.var.svc;
  const user = requireUser(c);
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new ApiError(400, 'bad-request', 'repositoryId must be a positive integer');
  const snap = await svc.data.snapshot();
  let repo = await userRepo(user.gh, repositoryId);
  const inst = await svc.modules.installationForRepoId(repositoryId);
  if (!repo && maintainerByGithub(snap, user.id) && inst) {
    if (recordsForRepo(snap, repositoryId).length) repo = (await svc.modules.client(inst).get(`/repositories/${repositoryId}`)).data;
  }
  if (!repo) throw new ApiError(404, 'repo-not-found', 'Repository not found, or the KernelSU Modules App is not installed on it.');
  if (!inst) throw new ApiError(400, 'app-not-installed', `The KernelSU Modules App is not installed on ${repo.full_name}.`);
  const record = recordsForRepo(snap, repositoryId)[0];
  return { repo, gh: svc.modules.client(inst), snap, record };
}

api.post('/precheck', async (c) => {
  const body = await jsonBody<{ repositoryId: unknown; ref?: unknown; id?: unknown }>(c);
  const { repo, gh, snap, record } = await inspectableRepo(c, num(body.repositoryId));
  const ref = typeof body.ref === 'string' && body.ref ? body.ref : undefined;
  const src = record?.source?.repositoryId === repo.id ? record.source : record?.request?.source;
  const now = c.var.svc.now();
  const result = await precheck(gh, repo, snap.policy, {
    ref: ref ?? src?.ref,
    manifestPath: src?.manifestPath,
    expectedId: typeof body.id === 'string' ? body.id : undefined,
    ids: { existing: activeIds(snap, now), isRegistered: (id) => !!snap.records[id] },
  });
  return c.json(result);
});

api.post('/preview', async (c) => {
  const body = await jsonBody<{ repositoryId: unknown }>(c);
  const { repo, gh, snap, record } = await inspectableRepo(c, num(body.repositoryId));
  const src = record?.source?.repositoryId === repo.id ? record.source : record?.request?.source;
  const ref = src?.ref ?? repo.default_branch;
  const commit = await resolveCommit(gh, repo.full_name, ref);
  if (!commit) throw new ApiError(404, 'ref-not-found', `Branch ${ref} not found.`);
  const manifestPath = src?.manifestPath ?? 'module.yaml';
  const text = await readRepoFile(gh, repo.full_name, manifestPath, commit, snap.policy.limits.manifestMaxBytes).catch((e) => {
    if (e instanceof FileTooLarge) throw new ApiError(400, 'manifest-too-large', e.message);
    throw e;
  });
  if (text === null) throw new ApiError(404, 'manifest-missing', `${manifestPath} not found on ${ref}.`);
  const m = parseManifest(text, { maxBytes: snap.policy.limits.manifestMaxBytes });
  if (!m.value) throw new ApiError(400, 'manifest-schema', 'module.yaml is invalid; run the precheck for details.', { issues: m.issues });
  const docPath = m.value.description;
  const limit = Math.min(PREVIEW_MAX_BYTES, snap.policy.limits.docMaxBytes);
  const md = await readRepoFile(gh, repo.full_name, docPath, commit, limit).catch((e) => {
    if (e instanceof FileTooLarge) throw new ApiError(400, 'content-too-large', `${e.message}; preview is limited to ${limit} bytes.`);
    throw e;
  });
  if (md === null) throw new ApiError(404, 'manifest-path-missing', `${docPath} not found at ${commit.slice(0, 7)}.`);
  // Rendering (markdown-it + sanitizer) happens in the browser (the SPA renders with @kernelsu-modules/render into the
  // sandboxed iframe): it is too CPU-heavy for the 10 ms Workers Free budget. `ctx` is the site build's RenderContext.
  return c.json({ markdown: md, ctx: { fullName: repo.full_name, commit, docPath } });
});

api.get('/ids/:id', async (c) => {
  const id = c.req.param('id');
  const svc = c.var.svc;
  const snap = await svc.data.snapshot();
  const now = svc.now();
  const rec = snap.records[id];
  const errs = checkModuleId(id, snap.policy, activeIds(snap, now)).filter((i) => i.severity === 'error');
  if (rec && !idIsFree(rec, snap.policy, now)) return c.json({ id, available: false, reason: `taken (${rec.status})`, status: rec.status });
  if (errs.length) return c.json({ id, available: false, reason: errs[0]!.message, ...(rec ? { status: rec.status } : {}) });
  return c.json({ id, available: true, ...(rec ? { status: rec.status } : {}) });
});

api.post('/submissions', async (c) => {
  const body = await jsonBody<{ repositoryId: unknown; id: unknown }>(c);
  const res = await createSubmission(c.var.svc, requireUser(c), { repositoryId: num(body.repositoryId), id: body.id as string }, deferrer(c));
  return c.json({ submissionId: res.submissionId, status: res.status }, 201);
});

api.post('/transfers', async (c) => {
  const body = await jsonBody<{ repositoryId: unknown; id: unknown }>(c);
  const res = await createTransfer(c.var.svc, requireUser(c), { repositoryId: num(body.repositoryId), id: body.id as string }, deferrer(c));
  return c.json({ submissionId: res.submissionId, autoApproved: res.autoApproved }, 201);
});

/**
 * status.json entry of a record for the Portal. `request` (the sync's validation of an open request's source) is
 * only passed on while it belongs to the record's current open request.
 */
export function syncView(r: RegistryRecord, status: RegistryStatus): ModuleStatus | undefined {
  const st = status.modules[r.id];
  if (!st) return undefined;
  const req = st.request && r.request && st.request.submissionId === r.request.submissionId ? st.request : null;
  return { ...st, request: req };
}

function moduleView(r: RegistryRecord, status: RegistryStatus) {
  const sync = syncView(r, status);
  return {
    id: r.id,
    status: r.status,
    ...(r.source ? { source: r.source } : {}),
    ...(r.request ? { request: r.request } : {}),
    ...(r.review ? { review: r.review } : {}),
    ...(r.moderation ? { moderation: r.moderation } : {}),
    ...(sync ? { sync } : {}),
  };
}

api.get('/modules', async (c) => {
  const user = requireUser(c);
  const svc = c.var.svc;
  const [list, snap] = await Promise.all([listRepos(c, user), svc.data.snapshot()]);
  // Index lookups (per administered repository + the user's own open requests) instead of a scan over all records.
  const ix = indexOf(snap);
  const found = new Set<RegistryRecord>(ix.openBySubmitter.get(user.id));
  for (const row of list.rows) if (row.isAdmin) for (const r of ix.byRepo.get(row.repositoryId) ?? []) found.add(r);
  const recs = [...found].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const status = recs.length ? await svc.data.status(snap) : null;
  return c.json(recs.map((r) => moduleView(r, status!)));
});

/** The caller administers the module's repository (bound source or pending request source), or is a maintainer. */
async function moduleAccess(c: Context<AppEnv>, id: string) {
  const user = requireUser(c);
  const svc = c.var.svc;
  const snap = await svc.data.snapshot();
  const rec = snap.records[id];
  if (!rec) throw new ApiError(404, 'not-found', `Module "${id}" not found.`);
  if (maintainerByGithub(snap, user.id)) return { rec, snap };
  const repoIds = [rec.source?.repositoryId, rec.request?.source.repositoryId].filter((x): x is number => !!x);
  // The repository list cached by /api/modules (60 s) usually already says so: saves a GitHub request per page view.
  // Only a positive answer is trusted; anything else is re-checked live.
  const cached = await getSecret<RepoList>(svc.deps.cache, c.env.SESSION_KEY, repoListKey(c, user));
  if (cached?.rows.some((r) => r.isAdmin && repoIds.includes(r.repositoryId))) return { rec, snap };
  for (const rid of repoIds) if (await isRepoAdmin(user.gh, rid)) return { rec, snap };
  throw new ApiError(403, 'forbidden', `You are not an administrator of the repository bound to "${id}".`);
}

api.get('/modules/:id', async (c) => {
  const { rec, snap } = await moduleAccess(c, c.req.param('id'));
  return c.json(moduleView(rec, await c.var.svc.data.status(snap)));
});

api.post('/modules/:id/sync', async (c) => {
  const id = c.req.param('id');
  const svc = c.var.svc;
  const { rec } = await moduleAccess(c, id);
  // Listed/suspended modules, and any record with an open request (pending submit, transfer):
  // the sync validates every open request's source and writes its Check Run.
  if (!['listed', 'suspended'].includes(rec.status) && !rec.request) throw new ApiError(409, 'bad-state', `Module "${id}" is ${rec.status}.`);
  // Rate limit: 1 per 10 min per module (Cache API marker; per colo, which is enough for a courtesy limit).
  const key = `rl/sync/${id}`;
  const until = Number(await svc.deps.cache.get(key));
  if (until && until > svc.now()) {
    const retry = Math.ceil((until - svc.now()) / 1000);
    c.header('Retry-After', String(retry));
    return c.json({ error: { code: 'rate-limited', message: `Sync was requested recently; try again in ${retry}s.` }, nextAllowedAt: new Date(until).toISOString() }, 429);
  }
  const nextAllowed = svc.now() + SYNC_INTERVAL_S * 1000;
  await svc.deps.cache.put(key, String(nextAllowed), SYNC_INTERVAL_S);
  if (!(await dispatchSync(svc, { reason: 'portal', module: id }))) {
    await svc.deps.cache.delete(key);
    throw new ApiError(502, 'dispatch-failed', 'Could not start the sync workflow; try again later.');
  }
  return c.json({ ok: true, nextAllowedAt: new Date(nextAllowed).toISOString() }, 202);
});

api.route('/admin', admin);
