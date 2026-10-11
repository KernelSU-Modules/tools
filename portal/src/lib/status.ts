import type { Issue, MyModule, RecordStatus, RequestCheck, SyncHealth } from '../api/types.ts';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const RECORD_STATUSES: readonly RecordStatus[] = ['pending', 'listed', 'rejected', 'suspended', 'archived'];

const STATUS_TONE: Record<RecordStatus, Tone> = {
  pending: 'info',
  listed: 'success',
  rejected: 'danger',
  suspended: 'warning',
  archived: 'neutral',
};

/** Badge tone for a record status. Unknown statuses (future schema) render neutral. */
export function statusTone(status: string): Tone {
  return (STATUS_TONE as Record<string, Tone>)[status] ?? 'neutral';
}

/** i18n key for a record status; falls back to a generic key for unknown values. */
export function statusKey(status: string): `status.${RecordStatus}` | 'status.unknown' {
  return (RECORD_STATUSES as readonly string[]).includes(status) ? (`status.${status}` as `status.${RecordStatus}`) : 'status.unknown';
}

export function healthTone(health: SyncHealth | undefined | null, installation?: 'present' | 'missing'): Tone {
  if (!health) return 'neutral';
  if (health === 'ok') return installation === 'missing' ? 'warning' : 'success';
  if (health === 'stale') return 'warning';
  return 'danger';
}

export function isStale(m: Pick<MyModule, 'sync'>): boolean {
  return m.sync?.health === 'stale';
}

/** Whether the module is visible on the public site (listed + has a stable release). */
export function isPublic(m: Pick<MyModule, 'status' | 'sync'>): boolean {
  return m.status === 'listed' && !!m.sync?.stable;
}

/**
 * Records the sync job processes: listed/suspended modules, plus any record with an open request
 * (the sync validates every open submit/transfer source, so "Sync now" re-runs that check).
 */
export function canSync(m: Pick<MyModule, 'status' | 'request'>): boolean {
  return m.status === 'listed' || m.status === 'suspended' || !!m.request;
}

/** status.json's validation of the record's open request (only when it is for that very request). */
export function requestCheckOf(m: Pick<MyModule, 'request' | 'sync'>): RequestCheck | null {
  const c = m.sync?.request;
  return m.request && c && c.submissionId === m.request.submissionId ? c : null;
}

/** Allowed moderation actions: listed <-> suspended, listed | suspended -> archived. */
export function moderationActions(status: string): ('suspend' | 'unsuspend' | 'archive')[] {
  switch (status) {
    case 'listed':
      return ['suspend', 'archive'];
    case 'suspended':
      return ['unsuspend', 'archive'];
    default:
      return [];
  }
}

/** Why the module needs attention, most important first (i18n keys). */
export function attention(m: MyModule): string[] {
  const out: string[] = [];
  if (m.status === 'rejected') out.push('attention.rejected');
  if (m.status === 'suspended') out.push('attention.suspended');
  if (m.status === 'listed' && m.sync && !m.sync.stable) out.push('attention.noStable');
  if (m.sync?.installation === 'missing') out.push('attention.installMissing');
  if (m.sync?.health === 'error') out.push('attention.syncError');
  else if (m.sync?.health === 'stale') out.push('attention.stale');
  if (requestCheckOf(m)?.ok === false) out.push('attention.requestCheckFailed');
  return out;
}

export interface IssueGroups {
  error: Issue[];
  warning: Issue[];
}

/** Groups issues by severity (errors first), preserving order within a group. */
export function groupIssues(issues: readonly Issue[]): IssueGroups {
  const g: IssueGroups = { error: [], warning: [] };
  for (const i of issues) (i.severity === 'error' ? g.error : g.warning).push(i);
  return g;
}
