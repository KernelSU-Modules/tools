// Cloudflare Pages "advanced mode" entry: bundled by scripts/build-pages.ts into `portal/dist/_worker.js`
// and deployed with the static Portal by `wrangler pages deploy` (project `kernelsu-developer-portal`). `_routes.json`
// restricts invocations to DYNAMIC_PREFIXES; `env.ASSETS` serves the static files if a request still lands here.
import { createApp } from '../app.ts';
import type { Env, ExecutionContextLike } from '../env.ts';

const app = createApp();

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContextLike) => app.fetch(req, env, ctx as never),
};
