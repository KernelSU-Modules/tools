import type { AdminModuleStatus, WorkflowRun } from '../api/types.ts';
import type { Tone } from './status.ts';

export function healthSummary(mods: readonly AdminModuleStatus[]) {
  const s = { total: mods.length, ok: 0, stale: 0, error: 0, installMissing: 0 };
  for (const m of mods) {
    s[m.health]++;
    if (m.installation === 'missing') s.installMissing++;
  }
  return s;
}

const RANK = { error: 0, stale: 1, ok: 2 } as const;

/** Problems first (error, stale, then ok), then by id. */
export function sortByHealth<T extends AdminModuleStatus>(mods: readonly T[]): T[] {
  return [...mods].sort((a, b) => RANK[a.health] - RANK[b.health] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function runTone(r: Pick<WorkflowRun, 'status' | 'conclusion'>): Tone {
  if (r.status !== 'completed') return 'info';
  switch (r.conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'danger';
    case 'cancelled':
    case 'skipped':
      return 'neutral';
    default:
      return 'warning';
  }
}
