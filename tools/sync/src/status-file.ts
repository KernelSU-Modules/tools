// status.json entries: a compact, churn-free summary derived from the lock + request checks.
import type { ModuleLock, ModuleStatus, RegistryRecord } from '@kernelsu-modules/schema';
import type { RequestCheckResult, RequestStatus } from './request-check.ts';

/** Records with an entry: listed / suspended (bound), and any record with an open request. */
export function wantsStatus(r: RegistryRecord): boolean {
  return r.status === 'listed' || r.status === 'suspended' || !!r.request;
}

/**
 * Derive the status entry. For records without a bound source in the lock (pending submit) the top-level fields
 * describe the requested repository.
 */
export function moduleStatus(
  record: RegistryRecord,
  lock: ModuleLock | undefined,
  request: { status: RequestStatus; check?: Pick<RequestCheckResult, 'installation' | 'fullName'> } | null,
  prev: ModuleStatus | undefined,
): ModuleStatus {
  const bound = (record.status === 'listed' || record.status === 'suspended') && record.source;
  const req = request?.status ?? null;
  if (bound && lock) {
    return {
      repositoryId: lock.repositoryId,
      fullName: lock.fullName,
      health: lock.health.status,
      installation: lock.health.installation,
      lastSuccessAt: lock.health.lastSuccessAt,
      message: lock.health.message,
      contentCommit: lock.content?.commit ?? null,
      stable: lock.stable ? { tag: lock.stable.tag, version: lock.stable.version, versionCode: lock.stable.versionCode, publishedAt: lock.stable.publishedAt } : null,
      maxVersionCode: lock.maxVersionCode,
      request: req,
    };
  }
  if (bound) {
    // Listed but not synced yet (e.g. sync of this module failed before writing a lock entry).
    return {
      repositoryId: record.source!.repositoryId,
      fullName: record.source!.fullName,
      health: 'error',
      installation: prev?.installation ?? 'present',
      lastSuccessAt: null,
      message: 'not-synced: the module has not been synced yet',
      contentCommit: null,
      stable: null,
      maxVersionCode: lock?.maxVersionCode ?? prev?.maxVersionCode ?? null,
      request: req,
    };
  }
  const src = record.request!.source;
  const firstError = req?.issues.find((i) => i.severity === 'error');
  return {
    repositoryId: src.repositoryId,
    fullName: request?.check?.fullName ?? (prev?.repositoryId === src.repositoryId ? prev.fullName : src.fullName),
    health: req ? (req.ok ? 'ok' : 'error') : 'error',
    installation: request?.check?.installation ?? (prev?.repositoryId === src.repositoryId ? prev.installation : 'present'),
    lastSuccessAt: null,
    message: firstError ? `${firstError.code}: ${firstError.message ?? ''}`.replace(/: $/, '').slice(0, 1000) : null,
    contentCommit: req?.commit ?? null,
    stable: null,
    // An archived record's lock entry keeps the ID's high-water mark.
    maxVersionCode: lock?.maxVersionCode ?? null,
    request: req,
  };
}
