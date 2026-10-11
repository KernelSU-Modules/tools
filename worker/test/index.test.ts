import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type RegistryRecord } from '@kernelsu-modules/schema';
import type { Snapshot } from '../src/domain/data.ts';
import { indexOf, recordsForRepo } from '../src/domain/index.ts';
import { findBinding } from '../src/domain/state.ts';

const T = '2026-01-01T00:00:00.000Z';
const src = (repositoryId: number, ownerId = 1) => ({ host: 'github' as const, repositoryId, ownerId, fullName: `o/r${repositoryId}`, manifestPath: 'module.yaml' });
const req = (submissionId: string, repositoryId: number, submittedBy: number, submittedAt: string, kind: 'submit' | 'transfer' = 'submit') => ({
  submissionId,
  kind,
  source: src(repositoryId, 2),
  submittedBy,
  submittedAt,
});

function snapOf(records: RegistryRecord[]): Snapshot {
  return {
    commit: 'c'.repeat(40),
    blobs: {},
    records: Object.fromEntries(records.map((r) => [r.id, r])),
    invalid: {},
    policy: DEFAULT_POLICY,
    maintainers: { maintainers: [{ github: { id: 7, login: 'm' }, telegram: { id: 70 } }, { github: { id: 8, login: 'n' } }] },
    banned: { banned: [] },
  };
}

const records: RegistryRecord[] = [
  { id: 'aa', status: 'listed', source: src(10), createdAt: T, updatedAt: T },
  // transfer to another repo + same repo referenced twice must not duplicate
  { id: 'bb', status: 'listed', source: src(11), request: req('bbbbbbbbbb', 12, 5, '2026-02-02T00:00:00.000Z', 'transfer'), createdAt: T, updatedAt: T },
  { id: 'cc', status: 'pending', request: req('cccccccccc', 13, 5, '2026-02-01T00:00:00.000Z'), createdAt: T, updatedAt: T },
  { id: 'dd', status: 'listed', source: src(14), request: req('dddddddddd', 14, 6, '2026-03-01T00:00:00.000Z', 'transfer'), createdAt: T, updatedAt: T },
  {
    id: 'ee',
    status: 'rejected',
    review: { submissionId: 'eeeeeeeeee', kind: 'submit', submittedBy: 5, submittedAt: T, decision: 'rejected', decidedBy: 7, decidedVia: 'portal', decidedAt: T, reason: null },
    createdAt: T,
    updatedAt: T,
  },
];

describe('snapshot index', () => {
  const snap = snapOf(records);
  const ix = indexOf(snap);

  it('is memoized per snapshot object', () => {
    expect(indexOf(snap)).toBe(ix);
    expect(indexOf(snapOf(records))).not.toBe(ix);
  });

  it('maps repositories to records via source and request, without duplicates', () => {
    expect(recordsForRepo(snap, 10).map((r) => r.id)).toEqual(['aa']);
    expect(recordsForRepo(snap, 11).map((r) => r.id)).toEqual(['bb']);
    expect(recordsForRepo(snap, 12).map((r) => r.id)).toEqual(['bb']);
    expect(recordsForRepo(snap, 14).map((r) => r.id)).toEqual(['dd']);
    expect(recordsForRepo(snap, 99)).toEqual([]);
    expect(ix.byOwner.get(1)!.map((r) => r.id)).toEqual(['aa', 'bb', 'dd']);
    expect(ix.byOwner.get(2)!.map((r) => r.id)).toEqual(['bb', 'cc', 'dd']);
  });

  it('lists open requests oldest first and by submitter / submission id', () => {
    expect(ix.open.map((r) => r.id)).toEqual(['cc', 'bb', 'dd']);
    expect(ix.openBySubmitter.get(5)!.map((r) => r.id)).toEqual(['bb', 'cc']);
    expect(ix.openBySubmission.get('dddddddddd')?.id).toBe('dd');
    expect(ix.openBySubmission.has('eeeeeeeeee')).toBe(false);
    expect(ix.reviewedBySubmission.get('eeeeeeeeee')?.id).toBe('ee');
  });

  it('indexes maintainers by GitHub and Telegram id', () => {
    expect(ix.maintainersByGithub.get(8)?.github.login).toBe('n');
    expect(ix.maintainersByTelegram.get(70)?.github.id).toBe(7);
    expect(ix.maintainersByTelegram.has(8)).toBe(false);
  });

  it('gives findBinding the same answer as a full scan', () => {
    const now = Date.parse('2026-02-10T00:00:00.000Z');
    for (const rid of [10, 11, 12, 13, 14, 99])
      for (const except of [undefined, 'aa', 'bb', 'cc', 'dd'])
        expect(findBinding(recordsForRepo(snap, rid), rid, DEFAULT_POLICY, now, except)).toBe(findBinding(records, rid, DEFAULT_POLICY, now, except));
  });
});
