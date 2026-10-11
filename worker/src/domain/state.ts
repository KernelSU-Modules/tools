// Record state machine. Pure functions: (current record at base commit) -> next record.
//   submit:   (none | rejected | pending with an expired request) -> pending + request{submit}
//   transfer: listed | suspended -> source swapped (auto-approved) or + request{transfer}
//   approve:  pending -> listed; transfer -> source swapped
//   reject:   pending -> rejected; transfer -> unchanged
//   moderate: listed <-> suspended; listed | suspended -> archived
// Every transition throws PreconditionFailed when the current state does not allow it; callers run these
// inside commitWithRetry's mutate callback so the check is re-done against the latest commit on retry.
import { PreconditionFailed } from '@kernelsu-modules/github';
import type { OpenRequest, Policy, ReasonCode, RegistryRecord, Review, Source } from '@kernelsu-modules/schema';

export type Via = 'portal' | 'telegram' | 'auto';
export interface Actor {
  githubId: number;
  login?: string;
  via: Via | 'cron';
}

const DAY = 86400_000;

export function requestExpired(req: Pick<OpenRequest, 'submittedAt'>, policy: Policy, now: number): boolean {
  return now - Date.parse(req.submittedAt) > policy.pending.expireDays * DAY;
}

/** An ID is free when there is no record, it was rejected, or its pending submission expired. */
export function idIsFree(rec: RegistryRecord | undefined | null, policy: Policy, now: number): boolean {
  if (!rec) return true;
  if (rec.status === 'rejected') return true;
  if (rec.status === 'pending') return !rec.request || requestExpired(rec.request, policy, now);
  return false;
}

/**
 * Repository ids an existing record holds (so another ID cannot be bound to the same repo).
 * listed/suspended bind via `source`; a live pending submission or open transfer binds its request source.
 */
export function boundRepoIds(rec: RegistryRecord, policy: Policy, now: number): number[] {
  const out: number[] = [];
  if ((rec.status === 'listed' || rec.status === 'suspended') && rec.source) out.push(rec.source.repositoryId);
  if (rec.request && !requestExpired(rec.request, policy, now) && (rec.status !== 'rejected')) out.push(rec.request.source.repositoryId);
  return out;
}

export function findBinding(records: Iterable<RegistryRecord>, repositoryId: number, policy: Policy, now: number, exceptId?: string): RegistryRecord | null {
  for (const r of records) if (r.id !== exceptId && boundRepoIds(r, policy, now).includes(repositoryId)) return r;
  return null;
}

/**
 * Repository id -> module id for GitHub webhooks that should wake the sync: sources of listed/suspended records,
 * plus the source of every open request (submit / transfer; the sync validates those on every run and
 * writes their Check Run, so "Re-run" on a pending submission's repo must dispatch too).
 */
export function syncTargetsByRepo(records: Iterable<RegistryRecord>): Map<number, string> {
  const m = new Map<number, string>();
  const reqs: RegistryRecord[] = [];
  for (const r of records) {
    if ((r.status === 'listed' || r.status === 'suspended') && r.source) m.set(r.source.repositoryId, r.id);
    if (r.request) reqs.push(r);
  }
  for (const r of reqs) if (!m.has(r.request!.source.repositoryId)) m.set(r.request!.source.repositoryId, r.id);
  return m;
}

function openRequestGuard(rec: RegistryRecord, policy: Policy, now: number) {
  if (rec.request && !requestExpired(rec.request, policy, now))
    throw new PreconditionFailed(`module "${rec.id}" already has an open ${rec.request.kind} request`, 'request-open');
}

function reviewFrom(req: OpenRequest, decision: Review['decision'], actor: Actor | null, at: string, extra?: { reasonCode?: ReasonCode; reason?: string | null }): Review {
  return {
    submissionId: req.submissionId,
    kind: req.kind,
    submittedBy: req.submittedBy,
    submittedAt: req.submittedAt,
    decision,
    decidedBy: actor && actor.via !== 'auto' && actor.via !== 'cron' ? actor.githubId : null,
    decidedVia: actor && actor.via !== 'cron' ? actor.via : 'auto',
    decidedAt: at,
    ...(extra?.reasonCode ? { reasonCode: extra.reasonCode } : {}),
    reason: extra?.reason ?? null,
    ...(req.telegram ? { telegram: req.telegram } : {}),
  };
}

export interface NewRequest {
  id: string;
  submissionId: string;
  source: Source;
  submittedBy: number;
  submittedByLogin?: string;
  telegram?: { chatId: number; messageId: number };
}

function mkRequest(kind: OpenRequest['kind'], n: NewRequest, at: string): OpenRequest {
  return {
    submissionId: n.submissionId,
    kind,
    source: n.source,
    submittedBy: n.submittedBy,
    ...(n.submittedByLogin ? { submittedByLogin: n.submittedByLogin } : {}),
    submittedAt: at,
    ...(n.telegram ? { telegram: n.telegram } : {}),
  };
}

/** submit: no record | rejected | pending older than policy.pending.expireDays -> pending + request{submit}. */
export function applySubmit(cur: RegistryRecord | null, n: NewRequest, policy: Policy, now: number): RegistryRecord {
  const at = new Date(now).toISOString();
  if (cur && !idIsFree(cur, policy, now)) throw new PreconditionFailed(`module ID "${n.id}" is not available (status ${cur.status})`, 'id-taken');
  return {
    id: n.id,
    status: 'pending',
    request: mkRequest('submit', n, at),
    ...(cur?.review ? { review: cur.review } : {}),
    createdAt: cur?.createdAt ?? at,
    updatedAt: at,
  };
}

/** transfer: listed|suspended -> source swapped (auto, admin of both repos) or + request{transfer}. */
export function applyTransfer(cur: RegistryRecord | null, n: NewRequest, auto: boolean, policy: Policy, now: number): RegistryRecord {
  const at = new Date(now).toISOString();
  if (!cur || (cur.status !== 'listed' && cur.status !== 'suspended'))
    throw new PreconditionFailed(`module "${n.id}" is not listed or suspended`, 'not-transferable');
  openRequestGuard(cur, policy, now);
  const req = mkRequest('transfer', n, at);
  if (auto) {
    const { request: _r, ...rest } = cur;
    return { ...rest, source: n.source, review: reviewFrom(req, 'approved', { githubId: n.submittedBy, via: 'auto' }, at), updatedAt: at };
  }
  return { ...cur, request: req, updatedAt: at };
}

function requireRequest(cur: RegistryRecord | null, submissionId: string): asserts cur is RegistryRecord & { request: OpenRequest } {
  if (!cur || !cur.request || cur.request.submissionId !== submissionId)
    throw new PreconditionFailed(`request ${submissionId} is no longer open`, 'not-open');
}

/** approve(submissionId): submit -> listed, transfer -> swap source; clears request, writes review. */
export function applyApprove(cur: RegistryRecord | null, submissionId: string, actor: Actor, now: number): RegistryRecord {
  requireRequest(cur, submissionId);
  const at = new Date(now).toISOString();
  const { request: req, ...rest } = cur;
  const review = reviewFrom(req, 'approved', actor, at);
  if (req.kind === 'submit') {
    if (cur.status !== 'pending') throw new PreconditionFailed(`module "${cur.id}" is ${cur.status}, not pending`, 'not-open');
    const { moderation: _m, ...r2 } = rest;
    return { ...r2, status: 'listed', source: req.source, review, updatedAt: at };
  }
  if (cur.status !== 'listed' && cur.status !== 'suspended')
    throw new PreconditionFailed(`module "${cur.id}" is ${cur.status}; transfer no longer applies`, 'not-open');
  return { ...rest, source: req.source, review, updatedAt: at };
}

/** reject: submit -> rejected; transfer -> unchanged source. */
export function applyReject(cur: RegistryRecord | null, submissionId: string, reasonCode: ReasonCode, reason: string | null, actor: Actor, now: number): RegistryRecord {
  requireRequest(cur, submissionId);
  const at = new Date(now).toISOString();
  const { request: req, ...rest } = cur;
  const review = reviewFrom(req, 'rejected', actor, at, { reasonCode, reason });
  if (req.kind === 'submit') return { ...rest, status: 'rejected', review, updatedAt: at };
  return { ...rest, review, updatedAt: at };
}

/** Expire an open request older than policy.pending.expireDays (reasonCode other, reason "expired"). */
export function applyExpire(cur: RegistryRecord | null, submissionId: string, policy: Policy, now: number): RegistryRecord {
  requireRequest(cur, submissionId);
  if (!requestExpired(cur.request, policy, now)) throw new PreconditionFailed(`request ${submissionId} has not expired`, 'not-expired');
  return applyReject(cur, submissionId, 'other', 'expired', { githubId: 0, via: 'cron' }, now);
}

export type ModerationAction = 'suspend' | 'unsuspend' | 'archive';

export function applyModeration(cur: RegistryRecord | null, action: ModerationAction, reason: string, actor: Actor, now: number): RegistryRecord {
  const at = new Date(now).toISOString();
  if (!cur) throw new PreconditionFailed('module not found', 'not-found');
  const via = actor.via === 'cron' ? 'auto' : actor.via;
  if (action === 'suspend') {
    if (cur.status !== 'listed') throw new PreconditionFailed(`module "${cur.id}" is ${cur.status}, not listed`, 'bad-state');
    return { ...cur, status: 'suspended', moderation: { action: 'suspend', by: actor.githubId, via, at, reason }, updatedAt: at };
  }
  if (action === 'unsuspend') {
    if (cur.status !== 'suspended') throw new PreconditionFailed(`module "${cur.id}" is ${cur.status}, not suspended`, 'bad-state');
    const { moderation: _m, ...rest } = cur;
    return { ...rest, status: 'listed', updatedAt: at };
  }
  if (cur.status !== 'listed' && cur.status !== 'suspended')
    throw new PreconditionFailed(`module "${cur.id}" is ${cur.status}; cannot archive`, 'bad-state');
  const { request: _r, ...rest } = cur;
  return { ...rest, status: 'archived', moderation: { action: 'archive', by: actor.githubId, via, at, reason }, updatedAt: at };
}
