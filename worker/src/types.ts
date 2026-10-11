import type { Context } from 'hono';
import type { Env } from './env.ts';
import type { SessionData } from './lib/session.ts';
import type { Services } from './services.ts';

export type AppEnv = { Bindings: Env; Variables: { svc: Services; session: SessionData | null } };

/** waitUntil-based deferral when running in the Workers runtime; undefined (= run inline) in tests. */
export function deferrer(c: Context<AppEnv>): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    return undefined;
  }
}
