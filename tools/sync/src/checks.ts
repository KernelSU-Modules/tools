// Check Run reporting on author repositories (Modules App installation token, Checks: write).
import type { GitHubClient } from '@kernelsu-modules/github';
import { ISSUE_CODES, type Issue } from '@kernelsu-modules/validator';
import { createCheckRun, listCheckRuns } from './repo-api.ts';

export const CHECK_NAME = 'KernelSU Modules';
export const DOCS_BASE = 'https://developers.kernelsu.org/docs/checks';
export const SYNC_ACTION = { label: 'Sync now', identifier: 'sync', description: 'Re-run sync' } as const;

export type Conclusion = 'success' | 'failure';

export interface CheckSpec {
  headSha: string;
  externalId: string;
  conclusion: Conclusion;
  title: string;
  /** Free-form markdown lines shown before the issue list. */
  lines: string[];
  issues: Issue[];
}

const esc = (s: string) => s.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));

export function issueLine(i: Issue): string {
  const link = `[\`${i.code}\`](${DOCS_BASE}#${encodeURIComponent(i.code)})`;
  const where = i.path ? ` (\`${esc(i.path)}\`)` : '';
  return `- **${i.severity}** ${link}: ${esc(i.message)}${where}`;
}

export function renderSummary(spec: Pick<CheckSpec, 'lines' | 'issues'>): string {
  const out = [...spec.lines];
  const errors = spec.issues.filter((i) => i.severity === 'error');
  const warnings = spec.issues.filter((i) => i.severity !== 'error');
  if (errors.length) out.push('', '### Errors', ...errors.map(issueLine));
  if (warnings.length) out.push('', '### Warnings', ...warnings.map(issueLine));
  const codes = [...new Set(spec.issues.map((i) => i.code))].filter((c) => ISSUE_CODES?.[c]);
  if (codes.length) out.push('', '### How to fix', ...codes.map((c) => `- [\`${c}\`](${DOCS_BASE}#${encodeURIComponent(c)}): ${esc(ISSUE_CODES[c]!)}`));
  out.push('', `See ${DOCS_BASE} for how checks work. Use **Sync now** or **Re-run** to retry.`);
  const text = out.join('\n');
  return text.length > 60000 ? text.slice(0, 60000) + '\n\n_(truncated)_' : text;
}

/**
 * Create a completed check run unless one with the same external_id and conclusion already exists on the commit
 * (avoids piling up identical runs when the same content commit is revalidated on every scheduled sync).
 */
export async function createCheckOnce(
  gh: GitHubClient,
  fullName: string,
  spec: CheckSpec,
  o: { appId?: number; now: Date; dedupe?: boolean },
): Promise<{ created: boolean; id?: number }> {
  if (o.dedupe !== false) {
    const existing = await listCheckRuns(gh, fullName, spec.headSha, CHECK_NAME, o.appId);
    if (existing.some((r) => r.external_id === spec.externalId && r.conclusion === spec.conclusion)) return { created: false };
  }
  const id = await createCheckRun(gh, fullName, {
    name: CHECK_NAME,
    head_sha: spec.headSha,
    external_id: spec.externalId,
    status: 'completed',
    conclusion: spec.conclusion,
    completed_at: o.now.toISOString(),
    output: { title: spec.title.slice(0, 255), summary: renderSummary(spec) },
    actions: [SYNC_ACTION],
  });
  return { created: true, id };
}
