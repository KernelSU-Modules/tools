// Bindings of the two deployables:
//   - Pages project `kernelsu-developer-portal` (advanced-mode `_worker.js`): vars in wrangler.toml, secrets via `wrangler pages secret put`.
//   - Cron Worker `kernelsu-developer-portal-cron` (cron/wrangler.toml): vars there, secrets via `wrangler secret put --config cron/wrangler.toml`.

/** Minimal Workers runtime types (we keep the DOM lib from tsconfig.base and avoid @cloudflare/workers-types conflicts). */
export interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
export interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException?(): void;
}
export interface ScheduledControllerLike {
  cron: string;
  scheduledTime: number;
}

/** What the scheduled work needs (the cron Worker has exactly these). */
export interface CronEnv {
  // vars
  DATA_REPO: string;
  TOOLS_REPO: string;
  SYNC_WORKFLOW: string;
  PORTAL_URL: string;
  /** Comma-separated Cloudflare Pages projects whose old deployments are pruned (site + portal). */
  PAGES_PROJECTS?: string;
  TELEGRAM_CHAT_ID?: string;
  // secrets
  BOT_APP_ID: string;
  BOT_APP_PRIVATE_KEY: string;
  TELEGRAM_BOT_TOKEN?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

/** Full Portal environment (Pages Functions). */
export interface Env extends CronEnv {
  // vars
  SITE_URL: string;
  MODULES_APP_SLUG: string;
  // secrets
  MODULES_APP_ID: string;
  MODULES_APP_PRIVATE_KEY: string;
  MODULES_APP_CLIENT_ID: string;
  MODULES_APP_CLIENT_SECRET: string;
  MODULES_APP_WEBHOOK_SECRET: string;
  /** base64, 32 bytes. Encrypts the session cookie and secrets stored in the Cache API; keys the CSRF HMAC. */
  SESSION_KEY: string;
  TG_FORWARD_SECRET?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  // bindings (Pages advanced mode: static assets of the deployment)
  ASSETS?: Fetcher;
}
