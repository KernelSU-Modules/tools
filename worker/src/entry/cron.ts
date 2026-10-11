// `kernelsu-developer-portal-cron` Worker entry (cron/wrangler.toml): Cron Triggers only, no routes, no fetch handler.
// Pages Functions cannot run Cron Triggers, so the scheduled work lives here and shares the business code.
import type { CronEnv, Env, ExecutionContextLike, ScheduledControllerLike } from '../env.ts';
import { CRON_SUBREQUEST_LIMIT, runScheduled } from '../cron.ts';
import { SubrequestBudget } from '../lib/budget.ts';
import { MemoryStore, TieredCache } from '../lib/cache.ts';
import { Services, type Deps } from '../services.ts';

// No custom domain -> the Cache API is a no-op here; isolate memory is the only cache tier.
const l1 = new MemoryStore();
let memo: { key: string; svc: Services } | null = null;
/**
 * Budget of the running invocation. All fetches of the memoized services go through it, so each invocation is
 * counted separately (overlapping invocations in one isolate are not expected: runs are ≥2 min apart).
 */
let active: SubrequestBudget | null = null;

/** Per-isolate services for the cron Worker. `deps` (tests) bypasses the isolate memo. */
export function cronServices(env: CronEnv, deps?: Deps): Services {
  // Services is typed with the full Portal Env; scheduled code only touches the CronEnv subset (the Modules App
  // and SESSION_KEY are created/used lazily and never reached from cron.ts).
  if (deps) return new Services(env as Env, deps);
  const key = [env.BOT_APP_ID, env.DATA_REPO, env.TOOLS_REPO].join('|');
  if (memo?.key === key) return memo.svc;
  const svc = new Services(env as Env, {
    fetch: (input, init) => (active ? active.fetch(input, init) : fetch(input, init)),
    cache: new TieredCache(l1, null),
    now: () => Date.now(),
  });
  memo = { key, svc };
  return svc;
}

export default {
  async scheduled(controller: ScheduledControllerLike, env: CronEnv, ctx: ExecutionContextLike) {
    const svc = cronServices(env);
    const budget = new SubrequestBudget(CRON_SUBREQUEST_LIMIT);
    active = budget;
    ctx.waitUntil(
      runScheduled(svc, controller.cron, controller.scheduledTime, budget)
        .then((r) => console.log('cron', controller.cron, JSON.stringify(r)))
        .finally(() => {
          if (active === budget) active = null;
        }),
    );
  },
};
