// Orchestrator: load data dir -> sync bound modules (≤4 in parallel) -> validate open requests -> GC -> write
// sources.lock.json + status.json -> optional commit of both (one commit) via the KernelSU Modules Bot.
import { commitWithRetry, splitFullName, withTrailers, type CommitPlan, type GitHubApp } from '@kernelsu-modules/github';
import { RegistryRecord, canonicalJson, type ModuleLock, type ModuleStatus, type RegistryStatus, type SourcesLock } from '@kernelsu-modules/schema';
import YAML from 'yaml';
import { FatalError, LOCK_FILE, STATUS_FILE, loadDataDir, mergeModules, parseStatus, serializeLock, serializeStatus, writeLock, writeStatus, type InvalidRecord } from './data.ts';
import type { Logger } from './log.ts';
import { syncModule, type ModuleReport, type ModuleSyncDeps } from './module-sync.ts';
import { mapLimit } from './pool.ts';
import { STARS_REFRESH_MS, sameStars, starsAgeMs } from './stars.ts';
import { checkRequest, type RequestCheckResult } from './request-check.ts';
import { moduleStatus, wantsStatus } from './status-file.ts';

export type SyncMode = 'write' | 'dry-run' | 'commit';

/** Default commit actor: the KernelSU Modules Bot App (commit trailer format in CONTRACTS.md). */
export const DEFAULT_ACTOR = 'app:kernelsu-modules-bot via sync';

export interface SyncOptions {
  dataDir: string;
  /**
   * Forced re-check of this module and its open request ("Sync now" / "Re-run"): bypasses dedupe, posts fresh
   * Check Runs, retries retryable release failures.
   */
  module?: string;
  /** write: local files + check runs; dry-run: no side effects; commit: write + commit to the data repo. */
  mode: SyncMode;
  dataRepo?: string;
  dataBranch?: string;
  concurrency?: number;
  modulesAppId?: number;
  /** Extra commit trailers (Actor, Run URL, ...). */
  trailers?: Record<string, string | undefined>;
}

export interface SyncDeps {
  fetch: typeof fetch;
  modulesApp: ModuleSyncDeps['modulesApp'];
  botApp?: Pick<GitHubApp, 'repoInstallation' | 'installationClient'>;
  log: Logger;
  now?: () => Date;
}

export interface RequestReport {
  id: string;
  submissionId: string;
  kind: string;
  repositoryId: number;
  ok: boolean;
  revalidated: boolean;
  issues: string[];
}

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  mode: SyncMode;
  module: string | null;
  invalidRecords: InvalidRecord[];
  invalidLockEntries: InvalidRecord[];
  modules: ModuleReport[];
  requests: RequestReport[];
  /** Module ids whose lock entry changed (incl. removals) in this run. */
  changed: string[];
  /** Module ids whose status.json entry changed (incl. removals). */
  statusChanged: string[];
  /** Lock / status entries removed because their record is gone, rejected or pending. */
  removed: string[];
  lockWritten: boolean;
  commit: string | null;
  error?: string;
}

const SYNCED = new Set(['listed', 'suspended']);
/** Lock entries are kept for these statuses (archived keeps the versionCode high-water marks). */
const KEEP_LOCK = new Set(['listed', 'suspended', 'archived']);

/** Lock entry without fields that only carry wall-clock time (attempt / success timestamps) or display-only stars. */
function stableView(m: ModuleLock): string {
  const { health, stars: _stars, ...rest } = m;
  const { lastAttemptAt: _a, lastSuccessAt: _s, ...h } = health;
  return canonicalJson({ ...rest, health: h });
}

/**
 * The stars entry alone (count, counted repository, verification) is persisted only when the stored one is missing
 * or at least STARS_REFRESH_MS old, or on a forced run of the module ("Sync now").
 */
function starsDue(prev: ModuleLock, next: ModuleLock, now: Date, force: boolean): boolean {
  if (!next.stars || sameStars(prev.stars, next.stars)) return false;
  return force || !prev.stars || starsAgeMs(prev.stars, now) >= STARS_REFRESH_MS;
}

/**
 * The lock entry to persist, or null when nothing needs persisting. An entry is persisted only when something
 * substantive changed (content, releases, seen, marks, health status / installation / message). There is no
 * heartbeat: timestamp-only or ETag-only changes are dropped, and lastSuccessAt / lastAttemptAt only move together
 * with a substantive change or a health transition. The stars entry rides along with any such change; on its own
 * it is persisted only when the stored entry is missing or >= 24 h old (or on a forced run), and then ONLY `stars`
 * changes (health timestamps stay), so webhook-triggered runs never commit just for stars and status.json is
 * untouched. A starsRepository verification change also changes the health note (status message) and is then
 * persisted like any other change; verification itself only runs when the entry is due (see module-sync).
 */
export function lockToPersist(prev: ModuleLock | undefined, next: ModuleLock, now: Date, force = false): ModuleLock | null {
  if (!prev || stableView(prev) !== stableView(next)) return next;
  return starsDue(prev, next, now, force) ? { ...prev, stars: next.stars } : null;
}

const sameJson = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

export async function runSync(o: SyncOptions, d: SyncDeps): Promise<SyncReport> {
  const now = (d.now ?? (() => new Date()))();
  const log = d.log;
  const data = await loadDataDir(o.dataDir);
  for (const r of data.invalidRecords) log.log('error', 'invalid record skipped', { ...r });
  for (const r of data.invalidLockEntries) log.log('warn', 'invalid lock entry dropped', { ...r });

  const selected = data.records.filter((r) => SYNCED.has(r.status) && r.source);
  const withRequest = data.records.filter((r) => r.request);
  if (o.module && !selected.some((r) => r.id === o.module) && !withRequest.some((r) => r.id === o.module))
    log.log('warn', 'requested module has no bound source and no open request', { module: o.module });
  log.log('info', 'sync started', { modules: selected.length, requests: withRequest.length, mode: o.mode, module: o.module });

  const deps: ModuleSyncDeps = {
    fetch: d.fetch,
    modulesApp: d.modulesApp,
    log,
    now,
    policy: data.policy,
    checks: o.mode !== 'dry-run',
    modulesAppId: o.modulesAppId,
  };
  const results = await mapLimit(selected, o.concurrency ?? 4, (rec) => syncModule(rec, data.lock.modules[rec.id], deps, { force: rec.id === o.module }));

  // 1. lock
  const next: SourcesLock = { schemaVersion: 1, modules: { ...data.lock.modules } };
  const changed = new Set<string>();
  for (const { lock, report } of results) {
    const persist = lockToPersist(data.lock.modules[lock.id], lock, now, lock.id === o.module);
    report.changed = persist !== null;
    if (persist) {
      next.modules[lock.id] = persist;
      changed.add(lock.id);
    }
  }
  // GC: entries whose record is gone or can no longer have a binding (rejected / pending).
  const byId = new Map(data.records.map((r) => [r.id, r]));
  const invalidFiles = new Set(data.invalidRecords.map((r) => r.file));
  const removed = new Set<string>();
  for (const id of Object.keys(next.modules)) {
    const rec = byId.get(id);
    if (rec ? KEEP_LOCK.has(rec.status) : invalidFiles.has(`modules/${id}.yaml`)) continue;
    delete next.modules[id];
    changed.add(id);
    removed.add(id);
  }

  // 2. open requests (every run; deduped by branch head + newest release unless forced)
  const reqResults = new Map<string, RequestCheckResult>();
  await mapLimit(withRequest, o.concurrency ?? 4, async (rec) => {
    const r = await checkRequest(rec, rec.request!, data.status.modules[rec.id]?.request ?? null, next.modules[rec.id], deps, { force: rec.id === o.module });
    reqResults.set(rec.id, r);
  });

  // 3. status.json
  const nextStatus: RegistryStatus = { schemaVersion: 1, modules: { ...data.status.modules } };
  const statusChanged = new Set<string>();
  for (const rec of data.records) {
    if (!wantsStatus(rec)) continue;
    const prev = data.status.modules[rec.id];
    const rq = reqResults.get(rec.id);
    const entry = moduleStatus(rec, next.modules[rec.id], rq ? { status: rq.status, check: rq } : null, prev);
    if (!sameJson(prev, entry)) {
      nextStatus.modules[rec.id] = entry;
      statusChanged.add(rec.id);
    }
  }
  for (const id of Object.keys(nextStatus.modules)) {
    const rec = byId.get(id);
    if (rec && wantsStatus(rec)) continue;
    if (!rec && invalidFiles.has(`modules/${id}.yaml`)) continue;
    delete nextStatus.modules[id];
    statusChanged.add(id);
    removed.add(id);
  }

  const report: SyncReport = {
    startedAt: now.toISOString(),
    finishedAt: '',
    mode: o.mode,
    module: o.module ?? null,
    invalidRecords: data.invalidRecords,
    invalidLockEntries: data.invalidLockEntries,
    modules: results.map((r) => r.report),
    requests: withRequest.map((rec) => {
      const r = reqResults.get(rec.id)!;
      return {
        id: rec.id,
        submissionId: rec.request!.submissionId,
        kind: rec.request!.kind,
        repositoryId: rec.request!.source.repositoryId,
        ok: r.status.ok,
        revalidated: r.revalidated,
        issues: r.status.issues.map((i) => i.code),
      };
    }),
    changed: [...changed].sort(),
    statusChanged: [...statusChanged].sort(),
    removed: [...removed].sort(),
    lockWritten: false,
    commit: null,
  };

  if (o.mode !== 'dry-run' && (changed.size || statusChanged.size || data.invalidLockEntries.length)) {
    await writeLock(o.dataDir, next);
    await writeStatus(o.dataDir, nextStatus);
    report.lockWritten = true;
  }
  if (o.mode === 'commit' && (changed.size || statusChanged.size)) {
    report.commit = await commitData(o, d, { lock: next, status: nextStatus, lockTouched: [...changed], statusTouched: [...statusChanged], removed: [...removed] });
  }
  report.finishedAt = new Date().toISOString();
  log.log('info', 'sync finished', { changed: changed.size, statusChanged: statusChanged.size, removed: removed.size, commit: report.commit });
  return report;
}

/** Statuses for which a remote record still justifies keeping a lock / status entry this run wanted to remove. */
async function remoteKeeps(read: (p: string) => Promise<string | null>, id: string): Promise<{ lock: boolean; status: boolean }> {
  const text = await read(`modules/${id}.yaml`);
  if (text === null) return { lock: false, status: false };
  const r = RegistryRecord.safeParse((() => { try { return YAML.parse(text); } catch { return null; } })());
  if (!r.success) return { lock: true, status: true }; // unreadable: never delete on a guess
  return { lock: KEEP_LOCK.has(r.data.status), status: wantsStatus(r.data) };
}

/**
 * Commit sources.lock.json and status.json to the data repo in ONE commit through the KernelSU Modules Bot. Remote files are
 * re-read inside the mutate callback and only the module ids this run touched are replaced; removals are
 * re-validated against the remote records (a concurrent Portal write may have re-created the record).
 */
export async function commitData(
  o: SyncOptions,
  d: SyncDeps,
  x: { lock: SourcesLock; status: RegistryStatus; lockTouched: string[]; statusTouched: string[]; removed: string[] },
): Promise<string | null> {
  if (!d.botApp) throw new FatalError('--commit requires BOT_APP_ID and BOT_APP_PRIVATE_KEY');
  const { owner, repo } = splitFullName(o.dataRepo ?? 'KernelSU-Modules/repo');
  const inst = await d.botApp.repoInstallation(owner, repo);
  if (!inst) throw new FatalError(`KernelSU Modules Bot is not installed on ${owner}/${repo}`);
  const gh = d.botApp.installationClient(inst.id);
  const res = await commitWithRetry(gh, { owner, repo, branch: o.dataBranch ?? 'main' }, async (reader): Promise<CommitPlan> => {
    const lockText = await reader.read(LOCK_FILE);
    let remoteLock: { schemaVersion: 1; modules: Record<string, unknown> } = { schemaVersion: 1, modules: {} };
    if (lockText) {
      try {
        const raw = JSON.parse(lockText);
        if (raw && raw.schemaVersion === 1 && raw.modules && typeof raw.modules === 'object') remoteLock = raw;
        else throw new Error('unsupported envelope');
      } catch (e) {
        throw new FatalError(`remote ${LOCK_FILE} is unreadable: ${(e as Error).message}`);
      }
    }
    const statusText = await reader.read(STATUS_FILE);
    const remoteStatus = parseStatus(statusText);

    const ours = { lock: { modules: { ...x.lock.modules } as Record<string, unknown> }, status: { modules: { ...x.status.modules } as Record<string, ModuleStatus> } };
    for (const id of x.removed) {
      const keep = await remoteKeeps((p) => reader.read(p), id);
      if (keep.lock && remoteLock.modules[id]) ours.lock.modules[id] = remoteLock.modules[id];
      if (keep.status && remoteStatus.modules[id]) ours.status.modules[id] = remoteStatus.modules[id]!;
    }
    const files: Record<string, string> = {};
    const newLock = serializeLock(mergeModules(remoteLock, ours.lock, x.lockTouched) as SourcesLock);
    if (newLock !== lockText) files[LOCK_FILE] = newLock;
    const newStatus = serializeStatus(mergeModules(remoteStatus, ours.status, x.statusTouched));
    if (newStatus !== statusText) files[STATUS_FILE] = newStatus;
    if (!Object.keys(files).length) return { files: {}, message: '' };
    const ids = [...new Set([...x.lockTouched, ...x.statusTouched])].sort();
    const subject = `sync: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` and ${ids.length - 5} more` : ''}`;
    return {
      files,
      message: withTrailers(subject, { Action: 'sync', Module: ids.length === 1 ? ids[0] : undefined, Actor: DEFAULT_ACTOR, ...o.trailers }),
    };
  });
  d.log.log('info', res.commit ? 'lock and status committed' : 'remote lock and status already up to date', { commit: res.commit, attempts: res.attempts });
  return res.commit;
}
