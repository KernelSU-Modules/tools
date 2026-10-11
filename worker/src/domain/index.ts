// Derived lookups over a snapshot: the read-model equivalent of secondary indexes. Built once per snapshot
// (i.e. per data commit) on first use and memoized, so request handlers do map lookups instead of scanning
// every record. Time-dependent conditions (request expiry) are NOT baked in: callers filter the candidates.
import type { RegistryRecord } from '@kernelsu-modules/schema';
import type { Snapshot } from './data.ts';

type Maintainer = Snapshot['maintainers']['maintainers'][number];

export interface SnapshotIndex {
  /** repositoryId -> records referencing it via `source` or an open `request` (any status), in record order. */
  byRepo: Map<number, RegistryRecord[]>;
  /** repository ownerId -> records referencing a repository of that owner, in record order. */
  byOwner: Map<number, RegistryRecord[]>;
  /** submissionId -> record whose open request has it. */
  openBySubmission: Map<string, RegistryRecord>;
  /** submissionId -> record whose last review has it. */
  reviewedBySubmission: Map<string, RegistryRecord>;
  /** Records with an open request (expired ones included), oldest submission first. */
  open: RegistryRecord[];
  /** submittedBy -> records with an open request from that user. */
  openBySubmitter: Map<number, RegistryRecord[]>;
  maintainersByGithub: Map<number, Maintainer>;
  maintainersByTelegram: Map<number, Maintainer>;
}

const memo = new WeakMap<Snapshot, SnapshotIndex>();

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (!a) m.set(k, [v]);
  else if (a[a.length - 1] !== v) a.push(v);
}

export function indexOf(snap: Snapshot): SnapshotIndex {
  let ix = memo.get(snap);
  if (ix) return ix;
  ix = {
    byRepo: new Map(),
    byOwner: new Map(),
    openBySubmission: new Map(),
    reviewedBySubmission: new Map(),
    open: [],
    openBySubmitter: new Map(),
    maintainersByGithub: new Map(),
    maintainersByTelegram: new Map(),
  };
  for (const r of Object.values(snap.records)) {
    if (r.source) {
      push(ix.byRepo, r.source.repositoryId, r);
      push(ix.byOwner, r.source.ownerId, r);
    }
    if (r.request) {
      push(ix.byRepo, r.request.source.repositoryId, r);
      push(ix.byOwner, r.request.source.ownerId, r);
      ix.openBySubmission.set(r.request.submissionId, r);
      push(ix.openBySubmitter, r.request.submittedBy, r);
      ix.open.push(r);
    }
    if (r.review) ix.reviewedBySubmission.set(r.review.submissionId, r);
  }
  ix.open.sort((a, b) => Date.parse(a.request!.submittedAt) - Date.parse(b.request!.submittedAt));
  for (const m of snap.maintainers.maintainers) {
    if (!ix.maintainersByGithub.has(m.github.id)) ix.maintainersByGithub.set(m.github.id, m);
    if (m.telegram && !ix.maintainersByTelegram.has(m.telegram.id)) ix.maintainersByTelegram.set(m.telegram.id, m);
  }
  memo.set(snap, ix);
  return ix;
}

/** Records referencing a repository (source or open request), or []. */
export function recordsForRepo(snap: Snapshot, repositoryId: number): readonly RegistryRecord[] {
  return indexOf(snap).byRepo.get(repositoryId) ?? [];
}
