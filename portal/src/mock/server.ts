/* MOCK-ONLY: in-browser implementation of the Worker JSON API. */
import type { BannedEntry, IdAvailability, Maintainer, MyModule, PrecheckResult, QueueItem, Repo, ReasonCode } from '../api/types.ts';
import {
  adminStatus,
  failingPrecheck,
  initialBanned,
  initialMaintainers,
  initialModules,
  initialQueue,
  initialRepos,
  MOCK_MARKER,
  noManifestPrecheck,
  okPrecheck,
  otherRecords,
  previewMarkdown,
  RESERVED_PREFIXES,
  syncStatus,
  runs,
  USERS,
} from './fixtures.ts';

export type Persona = 'signed-out' | 'developer' | 'maintainer';
export const PERSONA_KEY = 'kernelsu-mock-persona';
export const CSRF = 'mock-csrf-token';
const SYNC_WINDOW = 600;

export interface MockState {
  persona: Persona;
  repos: Repo[];
  modules: MyModule[];
  queue: QueueItem[];
  maintainers: Maintainer[];
  banned: BannedEntry[];
  syncAt: Map<string, number>;
  seq: number;
  /** Simulate /api/repos stopping at the Worker's subrequest budget (`?truncated` on the page URL in dev:mock). */
  reposTruncated: boolean;
}

export function createState(persona: Persona): MockState {
  const repos = initialRepos();
  const modules = initialModules(repos);
  return {
    persona,
    repos,
    modules,
    queue: initialQueue(repos, modules),
    maintainers: initialMaintainers(),
    banned: initialBanned(),
    // net.stale was "synced" a few minutes ago, so its Sync now button demonstrates the 429 path.
    syncAt: new Map([['net.stale', Date.now() - 3 * 60_000]]),
    seq: 0,
    reposTruncated: typeof location !== 'undefined' && new URLSearchParams(location.search).has('truncated'),
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const err = (status: number, code: string, message: string, headers: Record<string, string> = {}) => json(status, { error: { code, message } }, headers);
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function newSubmissionId(s: MockState): string {
  s.seq++;
  return (Math.random().toString(36).slice(2) + 'abcdefghij').slice(0, 9) + (s.seq % 10);
}

function user(s: MockState) {
  return s.persona === 'signed-out' ? null : s.persona === 'maintainer' ? USERS.maintainer : USERS.developer;
}

export function idAvailability(s: MockState, id: string): IdAvailability {
  const fold = id.toLowerCase();
  if (RESERVED_PREFIXES.some((p) => fold.startsWith(p))) return { id, available: false, reason: 'id-reserved: this prefix is reserved for official modules' };
  const mine = s.modules.find((m) => m.id.toLowerCase() === fold);
  const other = otherRecords.find((m) => m.id.toLowerCase() === fold);
  const rec = mine ?? other;
  if (!rec) return { id, available: true };
  if (rec.id !== id) return { id, available: false, reason: `id-collision: differs only in case from "${rec.id}"`, status: rec.status };
  if (rec.status === 'rejected') return { id, available: true, status: 'rejected' };
  const reasons: Record<string, string> = {
    listed: 'already listed',
    pending: 'a submission for this ID is pending review',
    suspended: 'ID is held by a suspended module',
    archived: 'ID is held by an archived module',
  };
  return { id, available: false, status: rec.status, reason: reasons[rec.status] ?? rec.status };
}

function precheckFor(s: MockState, repositoryId: number): PrecheckResult {
  const r = s.repos.find((x) => x.repositoryId === repositoryId);
  if (!r) return noManifestPrecheck;
  if (r.repositoryId === 100003) return failingPrecheck;
  if (r.repositoryId === 100005) return noManifestPrecheck;
  const id = r.registeredId ?? r.fullName.split('/')[1]!.replace(/-/g, '_');
  return okPrecheck(id, r.fullName);
}

/** Routes one request against the in-memory state. Exported for unit tests. */
export async function handle(s: MockState, method: string, url: URL, headers: Headers, body: unknown): Promise<Response> {
  const path = url.pathname;
  const me = user(s);
  if (method !== 'GET' && headers.get('X-CSRF-Token') !== CSRF) return err(403, 'csrf', 'Missing or invalid CSRF token');

  if (path === '/api/me') {
    return json(200, { user: me, isMaintainer: s.persona === 'maintainer', csrf: CSRF, installUrl: 'https://github.com/apps/kernelsu-modules/installations/new' });
  }
  if (path === '/auth/logout' && method === 'POST') {
    // CSRF is enforced above for every non-GET request (the real Worker also requires it on logout).
    s.persona = 'signed-out';
    try {
      localStorage.setItem(PERSONA_KEY, 'signed-out');
    } catch {
      /* ignore */
    }
    return json(200, { ok: true });
  }
  if (!me) return err(401, 'unauthorized', 'Sign in required');

  const b = (body ?? {}) as Record<string, unknown>;
  const repoById = (id: unknown) => s.repos.find((r) => r.repositoryId === id);
  let m: RegExpMatchArray | null;

  // ---------------------------------------------------------------- developer
  if (path === '/api/repos' && method === 'GET') return json(200, { repos: s.repos, truncated: s.reposTruncated });
  if (path === '/api/precheck' && method === 'POST') {
    if (!repoById(b.repositoryId)) return err(404, 'repo-not-found', 'Repository not found or App not installed');
    return json(200, precheckFor(s, b.repositoryId as number));
  }
  if ((m = path.match(/^\/api\/ids\/([^/]+)$/)) && method === 'GET') return json(200, idAvailability(s, decodeURIComponent(m[1]!)));
  if (path === '/api/submissions' && method === 'POST') {
    const r = repoById(b.repositoryId);
    const id = String(b.id ?? '');
    if (!r) return err(404, 'repo-not-found', 'Repository not found');
    if (!r.isAdmin) return err(403, 'not-admin', 'You must be an admin of the repository');
    if (r.registeredId) return err(409, 'repo-registered', `Repository is already bound to ${r.registeredId}`);
    if (s.banned.some((x) => x.githubId === me.id)) return err(403, 'banned', 'Your account is banned from submitting');
    const a = idAvailability(s, id);
    if (!a.available) return err(409, 'id-unavailable', a.reason ?? 'ID unavailable');
    const pre = precheckFor(s, r.repositoryId);
    if (!pre.ok) return err(422, 'precheck-failed', `Precheck failed: ${pre.issues.filter((i) => i.severity === 'error').map((i) => i.code).join(', ')}`);
    const submissionId = newSubmissionId(s);
    const source = { host: 'github' as const, repositoryId: r.repositoryId, ownerId: me.id, fullName: r.fullName, manifestPath: 'module.yaml' };
    const request = { submissionId, kind: 'submit' as const, source, submittedBy: me.id, submittedByLogin: me.login, submittedAt: now() };
    s.modules = s.modules.filter((x) => x.id !== id);
    s.modules.push({ id, status: 'pending', request });
    s.queue.push({ id, status: 'pending', request, precheck: { ok: true, issues: pre.issues } });
    r.registeredId = id;
    return json(201, { submissionId, status: 'pending' });
  }
  if (path === '/api/transfers' && method === 'POST') {
    const r = repoById(b.repositoryId);
    const mod = s.modules.find((x) => x.id === b.id);
    if (!r || !mod) return err(404, 'not-found', 'Module or repository not found');
    if (mod.status !== 'listed' && mod.status !== 'suspended') return err(409, 'bad-state', `Cannot transfer a ${mod.status} module`);
    if (mod.request) return err(409, 'request-open', 'This module already has an open request');
    if (!r.isAdmin) return err(403, 'not-admin', 'You must be an admin of the target repository');
    const source = { host: 'github' as const, repositoryId: r.repositoryId, ownerId: me.id, fullName: r.fullName, manifestPath: 'module.yaml' };
    if (mod.id !== 'net.stale') {
      const old = repoById(mod.source?.repositoryId);
      if (old) old.registeredId = null;
      mod.source = source;
      r.registeredId = mod.id;
      return json(200, { autoApproved: true });
    }
    const submissionId = newSubmissionId(s);
    mod.request = { submissionId, kind: 'transfer', source, submittedBy: me.id, submittedByLogin: me.login, submittedAt: now() };
    s.queue.push({ id: mod.id, status: mod.status, request: mod.request, source: mod.source! });
    return json(200, { submissionId, autoApproved: false });
  }
  if (path === '/api/modules' && method === 'GET') return json(200, s.modules);
  if ((m = path.match(/^\/api\/modules\/([^/]+)$/)) && method === 'GET') {
    const mod = s.modules.find((x) => x.id === decodeURIComponent(m![1]!));
    return mod ? json(200, mod) : err(404, 'not-found', 'Module not found');
  }
  if ((m = path.match(/^\/api\/modules\/([^/]+)\/sync$/)) && method === 'POST') {
    const id = decodeURIComponent(m[1]!);
    const mod = s.modules.find((x) => x.id === id);
    if (!mod) return err(404, 'not-found', 'Module not found');
    if (mod.status !== 'listed' && mod.status !== 'suspended' && !mod.request) return err(409, 'bad-state', `Module "${id}" is ${mod.status}.`);
    const last = s.syncAt.get(id);
    if (last && Date.now() - last < SYNC_WINDOW * 1000) {
      const wait = Math.ceil((SYNC_WINDOW * 1000 - (Date.now() - last)) / 1000);
      return err(429, 'rate-limited', 'Sync can be requested once every 10 minutes per module', { 'Retry-After': String(wait) });
    }
    s.syncAt.set(id, Date.now());
    return json(202, { ok: true });
  }
  if (path === '/api/preview' && method === 'POST') {
    // Maintainers may preview any repository with an open request (review from Telegram / queue).
    const queued = s.persona === 'maintainer' ? s.queue.find((q) => q.request.source.repositoryId === b.repositoryId) : undefined;
    const r = repoById(b.repositoryId) ?? (queued ? { repositoryId: queued.request.source.repositoryId, fullName: queued.request.source.fullName } : undefined);
    if (!r) return err(404, 'repo-not-found', 'Repository not found');
    if (r.repositoryId === 100005) return err(422, 'manifest-missing', 'module.yaml not found');
    return json(200, { markdown: previewMarkdown(r.fullName), ctx: { fullName: r.fullName, commit: 'c0ffee'.padEnd(40, '0'), docPath: 'docs/README.md' } });
  }

  // ------------------------------------------------------------------- admin
  if (path.startsWith('/api/admin/')) {
    if (s.persona !== 'maintainer') return err(403, 'forbidden', 'Maintainers only');
    if (path === '/api/admin/queue' && method === 'GET') return json(200, s.queue);
    if ((m = path.match(/^\/api\/admin\/requests\/([a-z0-9]{10})\/(approve|reject)$/)) && method === 'POST') {
      const sid = m[1]!;
      const item = s.queue.find((q) => q.request.submissionId === sid);
      if (!item) return err(409, 'precondition-failed', 'Request already decided or not found');
      if (m[2] === 'reject') {
        const code = b.reasonCode as ReasonCode | undefined;
        if (!code || !['spam', 'violation', 'bad-id', 'squatting', 'other'].includes(code)) return err(400, 'bad-request', 'reasonCode required');
        if (code === 'other' && !b.reason) return err(400, 'bad-request', 'reason required for "other"');
      }
      s.queue = s.queue.filter((q) => q !== item);
      const mod = s.modules.find((x) => x.id === item.id);
      const approved = m[2] === 'approve';
      if (mod) {
        const r = item.request;
        delete mod.request;
        if (mod.sync) mod.sync.request = null;
        mod.review = {
          submissionId: sid,
          kind: r.kind,
          submittedBy: r.submittedBy,
          submittedAt: r.submittedAt,
          decision: approved ? 'approved' : 'rejected',
          decidedBy: USERS.maintainer.id,
          decidedVia: 'portal',
          decidedAt: now(),
          ...(approved ? {} : { reasonCode: b.reasonCode as ReasonCode }),
          reason: approved ? null : ((b.reason as string | undefined) ?? null),
        };
        if (approved) {
          if (r.kind === 'transfer') {
            const old = repoById(mod.source?.repositoryId);
            if (old) old.registeredId = null;
            const nr = repoById(r.source.repositoryId);
            if (nr) nr.registeredId = mod.id;
          }
          mod.status = 'listed';
          mod.source = r.source;
          const nr = repoById(r.source.repositoryId);
          mod.sync = nr ? syncStatus(nr, 'ok', { message: 'Waiting for the first sync', lastSuccessAt: null, contentCommit: null, stable: mod.sync?.stable ?? null, maxVersionCode: mod.sync?.maxVersionCode ?? null }) : mod.sync;
        } else if (r.kind === 'submit') {
          mod.status = 'rejected';
          const rr = repoById(r.source.repositoryId);
          if (rr) rr.registeredId = null;
        }
      }
      return json(200, { ok: true });
    }
    if ((m = path.match(/^\/api\/admin\/modules\/([^/]+)\/(suspend|unsuspend|archive)$/)) && method === 'POST') {
      const id = decodeURIComponent(m[1]!);
      if (!b.reason) return err(400, 'bad-request', 'reason required');
      const mod = s.modules.find((x) => x.id === id);
      if (!mod) return err(404, 'not-found', `No record for "${id}" (mock only knows your modules)`);
      const action = m[2]!;
      const allowed: Record<string, string[]> = { suspend: ['listed'], unsuspend: ['suspended'], archive: ['listed', 'suspended'] };
      if (!allowed[action]!.includes(mod.status)) return err(409, 'precondition-failed', `Cannot ${action} a ${mod.status} module`);
      mod.status = action === 'suspend' ? 'suspended' : action === 'unsuspend' ? 'listed' : 'archived';
      if (action === 'unsuspend') delete mod.moderation;
      else mod.moderation = { action: action as 'suspend' | 'archive', by: USERS.maintainer.id, via: 'portal', at: now(), reason: String(b.reason) };
      return json(200, { ok: true, status: mod.status });
    }
    if (path === '/api/admin/maintainers') {
      if (method === 'GET') return json(200, { maintainers: s.maintainers });
      if (method === 'PUT') {
        const list = (b.maintainers as Maintainer[] | undefined) ?? [];
        if (!Array.isArray(list) || list.length === 0) return err(400, 'bad-request', 'At least one maintainer is required');
        s.maintainers = list;
        return json(200, { ok: true });
      }
    }
    if (path === '/api/admin/banned') {
      if (method === 'GET') return json(200, { banned: s.banned });
      if (method === 'POST') {
        const githubId = Number(b.githubId);
        if (s.banned.some((x) => x.githubId === githubId)) return err(409, 'exists', 'Already banned');
        s.banned.push({ githubId, reason: String(b.reason ?? ''), by: USERS.maintainer.id, at: now() });
        return json(201, { ok: true });
      }
    }
    if ((m = path.match(/^\/api\/admin\/banned\/(\d+)$/)) && method === 'DELETE') {
      const id = Number(m[1]);
      if (!s.banned.some((x) => x.githubId === id)) return err(404, 'not-found', 'Not banned');
      s.banned = s.banned.filter((x) => x.githubId !== id);
      return json(200, { ok: true });
    }
    if (path === '/api/admin/status' && method === 'GET') {
      const rs = runs();
      const modules = adminStatus(s.modules);
      const newest = modules.map((m) => m.lastSuccessAt).filter((x): x is string => !!x).sort().pop() ?? null;
      return json(200, {
        generatedAt: now(),
        dataCommit: 'f00dfacecafebeef0123456789abcdef01234567',
        invalidFiles: {},
        newestSuccessAt: newest,
        lastSuccessfulRun: rs.find((r) => r.conclusion === 'success') ?? null,
        modules,
        runs: rs,
      });
    }
  }
  return err(404, 'not-found', `No mock route for ${method} ${path} (${MOCK_MARKER})`);
}
