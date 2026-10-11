import type { ApiClient } from './api/client.ts';
import type { MyModule, Repo, ReposResponse } from './api/types.ts';

/** Tiny session cache so navigating between repo pages does not refetch /api/repos every time. */
const cache = new Map<string, { at: number; p: Promise<unknown> }>();
const TTL = 60_000;

function cached<T>(key: string, load: () => Promise<T>, force = false): Promise<T> {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.p as Promise<T>;
  const p = load();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}

export function getRepos(api: ApiClient, force = false): Promise<ReposResponse> {
  return cached('repos', () => api.repos(), force);
}

export function getModules(api: ApiClient, force = false): Promise<MyModule[]> {
  return cached('modules', () => api.modules(), force);
}

export async function getRepo(api: ApiClient, repositoryId: number): Promise<Repo | undefined> {
  const { repos } = await getRepos(api);
  return repos.find((r) => r.repositoryId === repositoryId);
}

/** Call after any mutation that can change repos/modules. */
export function invalidate(...keys: ('repos' | 'modules')[]): void {
  if (keys.length === 0) cache.clear();
  for (const k of keys) cache.delete(k);
}
