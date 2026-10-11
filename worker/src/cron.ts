// Scheduled work of the `kernelsu-developer-portal-cron` Worker (entry/cron.ts). Pages Functions have no Cron Triggers, so this
// runs in a separate tiny Worker that shares the business code with the Portal.
//   17 3 * * *    once a day: dispatch sync (fallback for lost webhooks; releases, Portal actions and maintainer
//                 decisions dispatch it immediately), sync health (Actions API), expire ≤2 pending requests,
//                 prune old Pages deployments across PAGES_PROJECTS.
//
// Subrequest budget (Workers Free: 50 per invocation). Every fetch goes through a SubrequestBudget (hard cap
// CRON_SUBREQUEST_LIMIT, below 50) and each unit of work first checks that its worst case still fits:
// an expiry needs EXPIRE_RESERVE (one commit attempt is 8 requests, at most 2 attempts, + snapshot delta +
// Telegram edit), a Pages project listing PRUNE_LIST_RESERVE, each deletion 1, and ALERT_RESERVE stays free
// for alerts. Whatever does not fit is left for the next run.
//
// Alerts: one run a day, so at most one dispatch-failure and one sync-health alert per day.
import type { Services } from './services.ts';
import { alert, dispatchSync, expireRequests } from './domain/ops.ts';
import { SubrequestBudget } from './lib/budget.ts';
import { lastSuccessfulSync } from './domain/actions.ts';

export const CRON_DAILY = '17 3 * * *';
/** Hard cap per invocation (Free plan limit is 50). */
export const CRON_SUBREQUEST_LIMIT = 45;
/** Alert when the newest successful sync run is older than this (daily dispatch + slack). */
export const SYNC_STALE_AFTER_MS = 26 * 3600_000;
const EXPIRE_RESERVE = 20;
const PRUNE_LIST_RESERVE = 5;
const ALERT_RESERVE = 2;
const KEEP_PRODUCTION = 5;
const KEEP_DAYS = 30;

export async function runScheduled(
  svc: Services,
  cron: string,
  scheduledTime: number,
  budget: SubrequestBudget = new SubrequestBudget(Number.POSITIVE_INFINITY),
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (e) {
      console.error(`cron ${name} failed`, (e as Error).message);
      out[name] = { error: (e as Error).message };
    }
  };
  const t = new Date(scheduledTime);
  const expire = (max: number) => expireRequests(svc, max, () => budget.remaining() >= EXPIRE_RESERVE + ALERT_RESERVE);
  const prune = (max: number, rotate: number) => prunePagesProjects(svc, max, rotate, () => budget.remaining() - ALERT_RESERVE);
  if (cron !== CRON_DAILY) console.warn(`unexpected cron "${cron}"; running the daily schedule`);
  await step('dispatched', () => dispatchSync(svc, { reason: 'cron' }, { alert: true }));
  await step('health', () => healthCheck(svc, { alert: true }));
  await step('expired', () => expire(2));
  await step('pruned', () => prune(10, t.getUTCDate()));
  out.subrequests = budget.used;
  return out;
}

/**
 * Sync health from the Actions API (the sync no longer writes timestamp-only heartbeats): alert when the newest
 * successful run of SYNC_WORKFLOW finished more than 26 h ago (or never), when `opts.alert`.
 */
export async function healthCheck(svc: Services, opts: { alert?: boolean } = {}): Promise<{ lastSuccessAt: string | null; stale: boolean }> {
  const run = await lastSuccessfulSync(svc);
  const last = run ? run.updated_at || run.created_at : null;
  const stale = !last || svc.now() - Date.parse(last) > SYNC_STALE_AFTER_MS;
  if (stale && opts.alert !== false)
    await alert(
      svc,
      `⚠️ Sync looks stale: the last successful ${svc.env.SYNC_WORKFLOW} run on ${svc.env.TOOLS_REPO} finished ${last ?? 'never'}${run ? ` (${run.html_url})` : ''}.`,
      'stale-sync',
      6 * 3600,
    );
  return { lastSuccessAt: last, stale };
}

interface PagesDeployment {
  id: string;
  environment: 'production' | 'preview';
  created_on: string;
}

export function pagesProjects(svc: Services): string[] {
  return (svc.env.PAGES_PROJECTS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Prune every project in PAGES_PROJECTS (site `kernelsu-modules-repo` and portal `kernelsu-developer-portal`) with a shared
 * deletion budget. The starting project rotates with `rotate` so neither project starves the other.
 */
export async function prunePagesProjects(
  svc: Services,
  maxDeletes: number,
  rotate = 0,
  /** Subrequests still available to this step (listing a project costs up to PRUNE_LIST_RESERVE, each deletion 1). */
  available: () => number = () => Number.POSITIVE_INFINITY,
): Promise<Record<string, { deleted: string[]; skipped?: string } | { error: string }>> {
  const projects = pagesProjects(svc);
  const out: Record<string, { deleted: string[]; skipped?: string } | { error: string }> = {};
  if (!projects.length) return out;
  let budget = maxDeletes;
  for (let i = 0; i < projects.length; i++) {
    const project = projects[(i + rotate) % projects.length]!;
    if (budget > 0 && available() < PRUNE_LIST_RESERVE + 1) {
      out[project] = { deleted: [], skipped: 'subrequest budget' };
      continue;
    }
    try {
      const r = await prunePagesDeployments(svc, project, budget, () => available());
      budget -= r.deleted.length;
      out[project] = r;
    } catch (e) {
      console.error('prune failed', project, (e as Error).message);
      out[project] = { error: (e as Error).message };
    }
  }
  return out;
}

/**
 * Delete old Cloudflare Pages deployments of one project: keep the newest 5 production deployments,
 * everything younger than 30 days, and never the current production (canonical) deployment.
 */
export async function prunePagesDeployments(
  svc: Services,
  project: string,
  maxDeletes: number,
  available: () => number = () => Number.POSITIVE_INFINITY,
): Promise<{ deleted: string[]; skipped?: string }> {
  const { CF_API_TOKEN: token, CF_ACCOUNT_ID: account } = svc.env;
  if (!token || !account || !project) return { deleted: [], skipped: 'not configured' };
  if (maxDeletes <= 0) return { deleted: [], skipped: 'budget exhausted' };
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${encodeURIComponent(project)}`;
  const cf = async <T>(path: string, method = 'GET'): Promise<{ result: T; result_info?: { total_pages?: number; page?: number } }> => {
    const res = await svc.deps.fetch(base + path, { method, headers: { authorization: `Bearer ${token}` } });
    const data = (await res.json().catch(() => null)) as { success: boolean; result: T; result_info?: { total_pages?: number }; errors?: { message: string }[] } | null;
    if (!res.ok || !data?.success) throw new Error(`Cloudflare ${method} ${path}: ${res.status} ${data?.errors?.map((e) => e.message).join('; ') ?? ''}`);
    return data;
  };
  const proj = await cf<{ canonical_deployment?: { id: string } | null; latest_deployment?: { id: string } | null }>('');
  const keep = new Set<string>();
  if (proj.result.canonical_deployment?.id) keep.add(proj.result.canonical_deployment.id);
  else return { deleted: [], skipped: 'no canonical deployment' }; // be conservative

  // Deployments are listed newest first. Page 1 decides the newest production ones; old candidates are on the last pages.
  const first = await cf<PagesDeployment[]>('/deployments?page=1&per_page=25');
  const pages = new Map<number, PagesDeployment[]>([[1, first.result]]);
  const total = first.result_info?.total_pages ?? 1;
  for (let p = total; p > 1 && p >= total - 2; p--) pages.set(p, (await cf<PagesDeployment[]>(`/deployments?page=${p}&per_page=25`)).result);
  const all = [...pages.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, d]) => d);
  const prod = all.filter((d) => d.environment === 'production').sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
  // Only trust the "newest 5" from page 1 (which holds the newest deployments overall).
  for (const d of first.result.filter((x) => x.environment === 'production').slice(0, KEEP_PRODUCTION)) keep.add(d.id);
  if (prod.length && first.result.filter((x) => x.environment === 'production').length < KEEP_PRODUCTION) {
    // Fewer than 5 production deployments on page 1: we cannot be sure which are the newest 5 overall -> keep all production.
    for (const d of prod) keep.add(d.id);
  }
  const cutoff = svc.now() - KEEP_DAYS * 86400_000;
  const candidates = all
    .filter((d) => !keep.has(d.id) && Date.parse(d.created_on) < cutoff)
    .sort((a, b) => Date.parse(a.created_on) - Date.parse(b.created_on))
    .slice(0, maxDeletes);
  const deleted: string[] = [];
  for (const d of candidates) {
    if (available() < 1) break;
    try {
      await cf(`/deployments/${encodeURIComponent(d.id)}?force=true`, 'DELETE');
      deleted.push(d.id);
    } catch (e) {
      console.error('prune failed', d.id, (e as Error).message);
    }
  }
  return { deleted };
}
