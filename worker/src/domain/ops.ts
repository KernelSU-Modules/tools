// Write operations (submit / transfer / decide / moderate / expire / maintainers / banned).
// All writes go through the KernelSU Modules Bot + commitWithRetry; preconditions are evaluated inside the mutate
// callback against the record at reader.baseCommit, so concurrent decisions resolve to exactly one winner.
import { dispatchWorkflow, PreconditionFailed, splitFullName, withTrailers, type GitHubClient } from '@kernelsu-modules/github';
import { Banned, Maintainers, type OpenRequest, type ReasonCode, type RegistryRecord, type Source } from '@kernelsu-modules/schema';
import { checkModuleId, type Issue } from '@kernelsu-modules/validator';
import { ApiError } from '../lib/errors.ts';
import { randomId } from '../lib/crypto.ts';
import type { Services } from '../services.ts';
import type { Snapshot } from './data.ts';
import { indexOf, recordsForRepo } from './index.ts';
import { h } from './telegram.ts';
import { decidedMessage, reviewKeyboard, reviewMessage, type DecisionNote } from './messages.ts';
import { precheck, type PrecheckResult } from './precheck.ts';
import { isRepoAdmin, userRepo, type RepoInfo } from './repo.ts';
import {
  applyApprove,
  applyExpire,
  applyModeration,
  applyReject,
  applySubmit,
  applyTransfer,
  findBinding,
  idIsFree,
  requestExpired,
  type Actor,
  type ModerationAction,
} from './state.ts';
import { parseBanned, parseRecord, recordPath, serializeRecord, stringifyYaml } from './yaml.ts';

export interface UserCtx {
  id: number;
  login: string;
  gh: GitHubClient;
}

/* ------------------------------------------------------------------ helpers */

export function activeIds(snap: Snapshot, now: number): string[] {
  return Object.values(snap.records)
    .filter((r) => !idIsFree(r, snap.policy, now))
    .map((r) => r.id);
}

export function isBanned(snap: Snapshot, githubId: number): boolean {
  return snap.banned.banned.some((b) => b.githubId === githubId);
}

export function maintainerByGithub(snap: Snapshot, githubId: number) {
  return indexOf(snap).maintainersByGithub.get(githubId) ?? null;
}
export function maintainerByTelegram(snap: Snapshot, telegramId: number) {
  return indexOf(snap).maintainersByTelegram.get(telegramId) ?? null;
}

const errorsOf = (issues: Issue[]) => issues.filter((i) => i.severity === 'error');

function rethrow(e: unknown): never {
  if (e instanceof PreconditionFailed) throw new ApiError(409, e.code, e.message);
  throw e;
}

function sourceFrom(repo: RepoInfo): Source {
  return { host: 'github', repositoryId: repo.id, ownerId: repo.owner.id, fullName: repo.full_name, manifestPath: 'module.yaml' };
}

/** Admin on the target repo (user token), public, Modules App installed. */
export async function verifyTargetRepo(svc: Services, user: UserCtx, repositoryId: number): Promise<RepoInfo> {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new ApiError(400, 'bad-request', 'repositoryId must be a positive integer');
  const repo = await userRepo(user.gh, repositoryId);
  if (!repo)
    throw new ApiError(404, 'repo-not-found', 'Repository not found, or the KernelSU Modules App is not installed on it for your account.');
  if (repo.permissions?.admin !== true) throw new ApiError(403, 'not-admin', `You are not an administrator of ${repo.full_name}.`);
  if (repo.private) throw new ApiError(400, 'repo-private', `${repo.full_name} is private; only public repositories can be listed.`);
  const inst = await svc.modules.installationForRepoId(repo.id);
  if (!inst) throw new ApiError(400, 'app-not-installed', `The KernelSU Modules App is not installed on ${repo.full_name}.`);
  return repo;
}

async function safePrecheck(svc: Services, repo: RepoInfo, snap: Snapshot, expectedId: string): Promise<PrecheckResult | null> {
  try {
    const inst = await svc.modules.installationForRepoId(repo.id);
    if (!inst) return null;
    return await precheck(svc.modules.client(inst), repo, snap.policy, { expectedId });
  } catch (e) {
    console.error('precheck failed', (e as Error).message);
    return null;
  }
}

async function accountCreatedAt(user: UserCtx): Promise<string | null> {
  try {
    const r = await user.gh.get<{ created_at?: string }>(`/user/${user.id}`);
    return r.data.created_at ?? null;
  } catch {
    return null;
  }
}

/**
 * workflow_dispatch of the sync workflow on TOOLS_REPO via the KernelSU Modules Bot. Never throws; alerts on failure
 * unless `opts.alert` is false (the cron Worker gates its alerts by schedule, see cron.ts).
 */
export async function dispatchSync(svc: Services, inputs: { reason: string; module?: string }, opts: { alert?: boolean } = {}): Promise<boolean> {
  try {
    const { owner, repo } = splitFullName(svc.env.TOOLS_REPO);
    const gh = await svc.toolsClient();
    const clean: Record<string, string> = { reason: inputs.reason.slice(0, 100) };
    if (inputs.module) clean.module = inputs.module;
    await dispatchWorkflow(gh, { owner, repo, workflow: svc.env.SYNC_WORKFLOW, ref: 'main', inputs: clean });
    return true;
  } catch (e) {
    console.error('dispatch failed', (e as Error).message);
    if (opts.alert !== false)
      await alert(svc, `⚠️ Sync dispatch failed (${inputs.reason}): ${(e as Error).message}`, 'dispatch-failed', 3600);
    return false;
  }
}

/** Ops alert to the maintainers chat, de-duplicated by key for ttl seconds. */
export async function alert(svc: Services, text: string, dedupeKey: string, ttlSec: number): Promise<void> {
  const key = `alert/${dedupeKey}`;
  if (await svc.deps.cache.get(key)) return;
  const ref = await svc.telegram.send(h(text));
  if (ref) await svc.deps.cache.put(key, '1', ttlSec);
}

async function editDecided(svc: Services, id: string, req: OpenRequest | undefined, note: DecisionNote) {
  if (!req?.telegram) return;
  await svc.telegram.edit(req.telegram, decidedMessage(id, req, note, svc.env.PORTAL_URL));
}

async function readRecord(reader: { read(p: string): Promise<string | null> }, id: string): Promise<RegistryRecord | null> {
  const text = await reader.read(recordPath(id));
  return text === null ? null : parseRecord(text);
}

/* ------------------------------------------------------------------ requests */

export interface RequestCtx {
  svc: Services;
  user: UserCtx;
}

async function commonChecks(svc: Services, user: UserCtx, snap: Snapshot) {
  if (isBanned(snap, user.id)) throw new ApiError(403, 'banned', 'Your account is banned from submitting modules.');
}

function idCheck(snap: Snapshot, id: string, now: number) {
  if (typeof id !== 'string') throw new ApiError(400, 'bad-request', 'id is required');
  const errs = errorsOf(checkModuleId(id, snap.policy, activeIds(snap, now)));
  if (errs.length) throw new ApiError(400, errs[0]!.code, errs[0]!.message, { issues: errs });
}

/** Rejects the commit when another ID meanwhile bound the repository (re-checked at the base commit). */
async function bindingGuard(svc: Services, baseCommit: string, repositoryId: number, id: string) {
  const s2 = await svc.data.snapshot(baseCommit);
  const b = findBinding(recordsForRepo(s2, repositoryId), repositoryId, s2.policy, svc.now(), id);
  if (b) throw new PreconditionFailed(`repository is already bound to module "${b.id}"`, 'repo-bound');
  return s2;
}

export async function createSubmission(svc: Services, user: UserCtx, body: { repositoryId: number; id: string }, defer?: Defer) {
  const now = svc.now();
  const snap = await svc.data.snapshot();
  await commonChecks(svc, user, snap);
  idCheck(snap, body.id, now);
  const id = body.id;
  if (!idIsFree(snap.records[id], snap.policy, now)) throw new ApiError(409, 'id-taken', `Module ID "${id}" is not available.`);
  const repo = await verifyTargetRepo(svc, user, body.repositoryId);
  const bound = findBinding(recordsForRepo(snap, repo.id), repo.id, snap.policy, now, id);
  if (bound) throw new ApiError(409, 'repo-bound', `${repo.full_name} is already bound to module "${bound.id}".`);
  const pre = await safePrecheck(svc, repo, snap, id);
  if (pre?.manifest && pre.manifest.id !== id)
    throw new ApiError(400, 'manifest-id-mismatch', `module.yaml declares id "${pre.manifest.id}", not "${id}".`);
  return openRequest(svc, user, { kind: 'submit', id, repo, pre }, defer);
}

export async function createTransfer(svc: Services, user: UserCtx, body: { repositoryId: number; id: string }, defer?: Defer) {
  const now = svc.now();
  const snap = await svc.data.snapshot();
  await commonChecks(svc, user, snap);
  const cur = typeof body.id === 'string' ? snap.records[body.id] : undefined;
  if (!cur) throw new ApiError(404, 'not-found', `Module ID "${body.id}" is not registered.`);
  if ((cur.status !== 'listed' && cur.status !== 'suspended') || !cur.source)
    throw new ApiError(409, 'not-transferable', `Module "${cur.id}" is ${cur.status}; only listed or suspended modules can be transferred.`);
  if (cur.request && !requestExpired(cur.request, snap.policy, now)) throw new ApiError(409, 'request-open', 'A request for this module is already under review.');
  const repo = await verifyTargetRepo(svc, user, body.repositoryId);
  const bound = findBinding(recordsForRepo(snap, repo.id), repo.id, snap.policy, now, cur.id);
  if (bound) throw new ApiError(409, 'repo-bound', `${repo.full_name} is already bound to module "${bound.id}".`);
  const oldAdmin = cur.source.repositoryId === repo.id ? true : await isRepoAdmin(user.gh, cur.source.repositoryId);
  const pre = await safePrecheck(svc, repo, snap, cur.id);
  return openRequest(
    svc,
    user,
    { kind: 'transfer', id: cur.id, repo, pre, auto: oldAdmin, previousFullName: cur.source.fullName, previousRepositoryId: cur.source.repositoryId },
    defer,
  );
}

async function openRequest(
  svc: Services,
  user: UserCtx,
  o: { kind: OpenRequest['kind']; id: string; repo: RepoInfo; pre: PrecheckResult | null; auto?: boolean; previousFullName?: string; previousRepositoryId?: number },
  defer?: Defer,
) {
  const submissionId = randomId(10);
  const source = sourceFrom(o.repo);
  let telegram: { chatId: number; messageId: number } | null = null;
  if (!o.auto && svc.telegram.enabled) {
    const createdAt = await accountCreatedAt(user);
    telegram = await svc.telegram.send(
      reviewMessage({
        kind: o.kind,
        id: o.id,
        submissionId,
        fullName: o.repo.full_name,
        previousFullName: o.previousFullName ?? null,
        submitter: { id: user.id, login: user.login, createdAt },
        precheck: o.pre,
        portalUrl: svc.env.PORTAL_URL,
      }),
      reviewKeyboard(svc.env.PORTAL_URL, submissionId),
    );
  }
  const n = {
    id: o.id,
    submissionId,
    source,
    submittedBy: user.id,
    submittedByLogin: user.login,
    ...(telegram ? { telegram } : {}),
  };
  let next: RegistryRecord | null = null;
  /** Expired request (any kind) this one replaces; open requests block new ones (see applySubmit / applyTransfer). */
  let replaced: OpenRequest | null = null;
  try {
    await svc.data.commit(async (reader) => {
      const s2 = await bindingGuard(svc, reader.baseCommit, source.repositoryId, o.id);
      if (isBanned(s2, user.id)) throw new PreconditionFailed('account is banned', 'banned');
      const now = svc.now();
      const cur = await readRecord(reader, o.id);
      replaced = cur?.request ?? null;
      if (o.kind === 'submit') {
        const errs = errorsOf(checkModuleId(o.id, s2.policy, activeIds(s2, now)));
        if (errs.length) throw new PreconditionFailed(errs[0]!.message, errs[0]!.code);
        next = applySubmit(cur, n, s2.policy, now);
      } else {
        if (o.auto && cur?.source && cur.source.repositoryId !== o.previousRepositoryId) {
          // The source changed after we verified admin rights on the old repo: that check no longer applies.
          throw new PreconditionFailed('the module source changed; please retry', 'source-changed');
        }
        next = applyTransfer(cur, n, !!o.auto, s2.policy, now);
      }
      const trailers: Record<string, string> = {
        Action: o.kind,
        Module: o.id,
        Submission: submissionId,
        'Submitted-by': `github:${user.id}`,
      };
      if (o.auto) trailers['Approved-by'] = `github:${user.id} via auto`;
      if (replaced) trailers.Expired = replaced.submissionId;
      const verb = o.kind === 'submit' ? 'Submit' : o.auto ? 'Transfer (auto-approved)' : 'Transfer request';
      return { files: { [recordPath(o.id)]: serializeRecord(next) }, message: withTrailers(`${verb}: ${o.id} <- ${source.fullName}`, trailers) };
    });
  } catch (e) {
    if (telegram)
      await svc.telegram.edit(
        telegram,
        decidedMessage(o.id, { submissionId, kind: o.kind, source, submittedBy: user.id, submittedByLogin: user.login, submittedAt: new Date(svc.now()).toISOString() }, {
          outcome: 'closed',
          by: 'portal',
          via: 'portal',
          at: new Date(svc.now()).toISOString(),
          reason: `submission aborted: ${(e as Error).message}`,
        }, svc.env.PORTAL_URL),
      );
    rethrow(e);
  }
  const rec = next as RegistryRecord | null;
  const old = replaced as OpenRequest | null;
  // Auto-approved bindings sync as usual; requests awaiting review get a `submit` sync of that module so Actions
  // runs the full ZIP validation (the Portal precheck never downloads the ZIP) and writes a Check Run.
  await sideEffects(defer, async () => {
    if (old && old.submissionId !== submissionId)
      await editDecided(svc, o.id, old, {
        outcome: 'expired',
        by: 'cron',
        via: 'cron',
        at: new Date(svc.now()).toISOString(),
        reason: 'expired; replaced by a new request',
      });
    await dispatchSync(svc, { reason: o.auto ? o.kind : 'submit', module: o.id });
  });
  return {
    submissionId,
    status: rec?.status ?? 'pending',
    autoApproved: !!o.auto,
  };
}

/* ------------------------------------------------------------------ decisions */

export type Decision = { kind: 'approve' } | { kind: 'reject'; reasonCode: ReasonCode; reason?: string | null };

async function findRequest(svc: Services, submissionId: string): Promise<RegistryRecord> {
  if (!/^[a-z0-9]{10}$/.test(submissionId)) throw new ApiError(400, 'bad-request', 'invalid submissionId');
  const find = (s: Snapshot) => indexOf(s).openBySubmission.get(submissionId);
  let snap = await svc.data.snapshot();
  let rec = find(snap);
  if (!rec) {
    snap = await svc.data.snapshot(await svc.data.head(true));
    rec = find(snap);
  }
  if (!rec) {
    if (indexOf(snap).reviewedBySubmission.has(submissionId))
      throw new ApiError(409, 'not-open', `Request ${submissionId} has already been decided.`);
    throw new ApiError(404, 'not-found', `Request ${submissionId} not found.`);
  }
  return rec;
}

/** Runs post-commit side effects (Telegram edit, dispatch) after the response when the runtime allows it. */
export type Defer = ((p: Promise<unknown>) => void) | undefined;
async function sideEffects(defer: Defer, fn: () => Promise<unknown>) {
  const p = fn().catch((e) => console.error('side effect failed', (e as Error).message));
  if (defer) defer(p);
  else await p;
}

export async function decide(svc: Services, actor: Actor & { login: string }, submissionId: string, d: Decision, defer?: Defer) {
  const target = await findRequest(svc, submissionId);
  const id = target.id;
  let before: OpenRequest | undefined;
  let next: RegistryRecord | null = null;
  try {
    await svc.data.commit(async (reader) => {
      const now = svc.now();
      const cur = await readRecord(reader, id);
      before = cur?.request;
      if (d.kind === 'approve') {
        next = applyApprove(cur, submissionId, actor, now);
        if (next.source) await bindingGuard(svc, reader.baseCommit, next.source.repositoryId, id);
      } else {
        next = applyReject(cur, submissionId, d.reasonCode, d.reason ?? null, actor, now);
      }
      const by = `github:${actor.githubId} via ${actor.via}`;
      return {
        files: { [recordPath(id)]: serializeRecord(next) },
        message: withTrailers(`${d.kind === 'approve' ? 'Approve' : 'Reject'} ${before!.kind}: ${id}`, {
          Action: d.kind,
          Module: id,
          Submission: submissionId,
          'Submitted-by': `github:${before!.submittedBy}`,
          [d.kind === 'approve' ? 'Approved-by' : 'Rejected-by']: by,
          Reason: d.kind === 'reject' ? `${d.reasonCode}${d.reason ? `: ${d.reason.replace(/\s+/g, ' ').slice(0, 200)}` : ''}` : undefined,
        }),
      };
    });
  } catch (e) {
    rethrow(e);
  }
  const rec = next as unknown as RegistryRecord;
  const decidedAt = new Date(svc.now()).toISOString();
  await sideEffects(defer, async () => {
    await editDecided(svc, id, before, {
      outcome: d.kind === 'approve' ? 'approved' : 'rejected',
      by: `@${actor.login}`,
      via: actor.via,
      at: decidedAt,
      reason: d.kind === 'reject' ? `${d.reasonCode}${d.reason ? ` — ${d.reason}` : ''}` : null,
    });
    if (d.kind === 'approve') await dispatchSync(svc, { reason: `approve`, module: id });
  });
  return { id, submissionId, status: rec.status, decision: d.kind === 'approve' ? 'approved' : 'rejected' };
}

export async function moderate(svc: Services, actor: Actor & { login: string }, id: string, action: ModerationAction, reason: string, defer?: Defer) {
  if (typeof reason !== 'string' || !reason.trim()) throw new ApiError(400, 'bad-request', 'reason is required');
  reason = reason.trim().slice(0, 500);
  let before: RegistryRecord | null = null;
  let next: RegistryRecord | null = null;
  try {
    await svc.data.commit(async (reader) => {
      before = await readRecord(reader, id);
      next = applyModeration(before, action, reason, actor, svc.now());
      return {
        files: { [recordPath(id)]: serializeRecord(next) },
        message: withTrailers(`${action[0]!.toUpperCase()}${action.slice(1)}: ${id}`, {
          Action: action,
          Module: id,
          Actor: `github:${actor.githubId} via ${actor.via}`,
          Reason: reason.replace(/\s+/g, ' ').slice(0, 200),
        }),
      };
    });
  } catch (e) {
    rethrow(e);
  }
  const b = before as RegistryRecord | null;
  const at = new Date(svc.now()).toISOString();
  await sideEffects(defer, async () => {
    if (action === 'archive' && b?.request) await editDecided(svc, id, b.request, { outcome: 'closed', by: `@${actor.login}`, via: actor.via, at, reason: 'module archived' });
    await dispatchSync(svc, { reason: action, module: id });
  });
  return { id, status: (next as unknown as RegistryRecord).status };
}

/**
 * Expire open requests older than policy.pending.expireDays. At most `max` commits per invocation, each started
 * only while `canAfford()` (subrequest budget) and limited to 2 commit attempts; the rest waits for the next run.
 */
export async function expireRequests(svc: Services, max: number, canAfford: () => boolean = () => true): Promise<string[]> {
  const scan = await svc.data.openRequests(await svc.data.head(true));
  const now = svc.now();
  const due = scan.records
    .filter((r) => r.request && requestExpired(r.request, scan.policy, now))
    .sort((a, b) => Date.parse(a.request!.submittedAt) - Date.parse(b.request!.submittedAt))
    .slice(0, max);
  const done: string[] = [];
  for (const r of due) {
    if (!canAfford()) break;
    const sid = r.request!.submissionId;
    let before: OpenRequest | undefined;
    try {
      await svc.data.commit(
        async (reader) => {
          const cur = await readRecord(reader, r.id);
          before = cur?.request;
          // policy at the scanned commit (expiry is not time critical; avoids a snapshot build in the cron Worker)
          const next = applyExpire(cur, sid, scan.policy, svc.now());
          return {
            files: { [recordPath(r.id)]: serializeRecord(next) },
            message: withTrailers(`Expire ${before!.kind}: ${r.id}`, {
              Action: 'expire',
              Module: r.id,
              Submission: sid,
              'Submitted-by': `github:${before!.submittedBy}`,
              Actor: 'cron',
            }),
          };
        },
        { maxAttempts: 2 },
      );
      done.push(r.id);
      await editDecided(svc, r.id, before, { outcome: 'expired', by: 'cron', via: 'cron', at: new Date(svc.now()).toISOString(), reason: 'expired' });
    } catch (e) {
      if (!(e instanceof PreconditionFailed)) console.error('expire failed', r.id, (e as Error).message);
    }
  }
  return done;
}

/* ------------------------------------------------------------------ maintainers / banned */

export async function setMaintainers(svc: Services, actor: Actor, body: unknown) {
  const parsed = Maintainers.safeParse(body);
  if (!parsed.success) throw new ApiError(400, 'bad-request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const m = parsed.data;
  if (!m.maintainers.length) throw new ApiError(400, 'bad-request', 'at least one maintainer is required');
  const ids = m.maintainers.map((x) => x.github.id);
  if (new Set(ids).size !== ids.length) throw new ApiError(400, 'bad-request', 'duplicate GitHub id');
  const tg = m.maintainers.flatMap((x) => (x.telegram ? [x.telegram.id] : []));
  if (new Set(tg).size !== tg.length) throw new ApiError(400, 'bad-request', 'duplicate Telegram id');
  await svc.data
    .commit(async () => ({
      files: { 'maintainers.yaml': stringifyYaml(m) },
      message: withTrailers('Update maintainers', { Action: 'maintainers', Actor: `github:${actor.githubId} via ${actor.via}` }),
    }))
    .catch(rethrow);
  return m;
}

export async function ban(svc: Services, actor: Actor, body: { githubId: number; reason: string; login?: string }) {
  if (!Number.isSafeInteger(body?.githubId) || body.githubId <= 0) throw new ApiError(400, 'bad-request', 'githubId must be a positive integer');
  if (typeof body.reason !== 'string' || !body.reason.trim()) throw new ApiError(400, 'bad-request', 'reason is required');
  const entry = {
    githubId: body.githubId,
    ...(body.login ? { login: String(body.login).slice(0, 64) } : {}),
    reason: body.reason.trim().slice(0, 500),
    by: actor.githubId,
    at: new Date(svc.now()).toISOString(),
  };
  let out: Banned | null = null;
  await svc.data
    .commit(async (reader) => {
      const text = await reader.read('banned.yaml');
      const cur = text ? parseBanned(text) : { banned: [] };
      if (cur.banned.some((b) => b.githubId === entry.githubId)) throw new PreconditionFailed('already banned', 'already-banned');
      out = Banned.parse({ banned: [...cur.banned, entry] });
      return {
        files: { 'banned.yaml': stringifyYaml(out) },
        message: withTrailers(`Ban github:${entry.githubId}`, { Action: 'ban', Target: `github:${entry.githubId}`, Actor: `github:${actor.githubId} via ${actor.via}` }),
      };
    })
    .catch(rethrow);
  return out!;
}

export async function unban(svc: Services, actor: Actor, githubId: number) {
  let out: Banned | null = null;
  await svc.data
    .commit(async (reader) => {
      const text = await reader.read('banned.yaml');
      const cur = text ? parseBanned(text) : { banned: [] };
      if (!cur.banned.some((b) => b.githubId === githubId)) throw new PreconditionFailed('not banned', 'not-banned');
      out = { banned: cur.banned.filter((b) => b.githubId !== githubId) };
      return {
        files: { 'banned.yaml': stringifyYaml(out) },
        message: withTrailers(`Unban github:${githubId}`, { Action: 'unban', Target: `github:${githubId}`, Actor: `github:${actor.githubId} via ${actor.via}` }),
      };
    })
    .catch(rethrow);
  return out!;
}
