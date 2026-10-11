export * from './client.ts';
export * from './crypto.ts';
export * from './app.ts';
export * from './commit.ts';

import type { GitHubClient } from './client.ts';

/** POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches (needs Actions: write). */
export async function dispatchWorkflow(
  gh: GitHubClient,
  o: { owner: string; repo: string; workflow: string; ref?: string; inputs?: Record<string, string> },
): Promise<void> {
  await gh.post(`/repos/${o.owner}/${o.repo}/actions/workflows/${encodeURIComponent(o.workflow)}/dispatches`, {
    ref: o.ref ?? 'main',
    inputs: o.inputs ?? {},
  });
}
