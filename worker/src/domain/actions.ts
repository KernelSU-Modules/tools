// GitHub Actions queries on TOOLS_REPO through the KernelSU Modules Bot (token scoped to `actions` on that repo).
import { splitFullName } from '@kernelsu-modules/github';
import type { Services } from '../services.ts';

export interface WorkflowRunLite {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

/** Newest successful run of SYNC_WORKFLOW on TOOLS_REPO (main), via the KernelSU Modules Bot (actions-scoped token). */
export async function lastSuccessfulSync(svc: Services): Promise<WorkflowRunLite | null> {
  const { owner, repo } = splitFullName(svc.env.TOOLS_REPO);
  const gh = await svc.toolsClient();
  const res = await gh.get<{ workflow_runs: WorkflowRunLite[] }>(
    `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(svc.env.SYNC_WORKFLOW)}/runs`,
    { query: { status: 'success', branch: 'main', per_page: 1, exclude_pull_requests: 'true' } },
  );
  return res.data.workflow_runs[0] ?? null;
}
