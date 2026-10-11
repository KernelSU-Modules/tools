// Per-isolate service graph: GitHub Apps (JWT memo), installation-token cache, data repo, Telegram.
// Everything here is created once per isolate and reused across requests (module-level memo in app.ts / entry/cron.ts),
// so the RS256 JWT signature (~1-2 ms CPU in workerd) and token minting happen at most once per isolate/hour,
// and installation tokens are additionally shared across isolates of a colo through the Cache API (sealed).
import { GitHubApp, GitHubClient, splitFullName, type ClientOptions } from '@kernelsu-modules/github';
import type { Env } from './env.ts';
import { getJson, getSecret, putJson, putSecret, type KvCache } from './lib/cache.ts';
import { DataRepo } from './domain/data.ts';
import { Telegram } from './domain/telegram.ts';

export interface Deps {
  fetch: typeof fetch;
  cache: KvCache;
  now: () => number;
  /**
   * GitHub client retry policy. Interactive Portal routes pass a short `maxDelayMs` so a user request never waits
   * for a long Retry-After / rate-limit reset (it fails fast instead); the cron Worker keeps the client defaults.
   */
  retry?: ClientOptions['retry'];
}

/** GitHub client options derived from the service deps (fetch + retry policy). */
export function clientOptions(deps: Pick<Deps, 'fetch' | 'retry'>): ClientOptions {
  return deps.retry === undefined ? { fetch: deps.fetch } : { fetch: deps.fetch, retry: deps.retry };
}

/** Narrowed installation token (POST /app/installations/{id}/access_tokens body). */
export interface TokenScope {
  /** Repository names (without owner) the token may access. */
  repositories: string[];
  permissions: Record<string, 'read' | 'write'>;
}
const scopeKey = (s?: TokenScope) =>
  s ? `${s.repositories.join(',')}:${Object.entries(s.permissions).map(([k, v]) => `${k}=${v}`).join(',')}` : '*';

/** Installation-token provider with L1 memory + sealed Cache API tier. */
export class AppAuth {
  readonly app: GitHubApp;
  private mem = new Map<string, { token: string; exp: number }>();
  constructor(
    readonly name: 'modules' | 'bot',
    appId: string,
    privateKey: string,
    private readonly deps: Deps,
    /** Seals tokens before they reach the shared cache; without it (cron Worker) tokens stay in isolate memory only. */
    private readonly sessionKey: string | undefined,
  ) {
    this.app = new GitHubApp({ appId, privateKey }, clientOptions(deps));
  }

  /**
   * Installation token, optionally narrowed to some repositories/permissions (the KernelSU Modules Bot always mints
   * scoped tokens: contents on the data repo, actions on the tools repo). Cached per (installation, scope).
   */
  async installationToken(installationId: number, scope?: TokenScope): Promise<string> {
    const now = this.deps.now();
    const sk = `${installationId}/${scopeKey(scope)}`;
    const m = this.mem.get(sk);
    if (m && m.exp - 5 * 60_000 > now) return m.token;
    const key = `tok/${this.name}/${sk}`;
    const c = this.sessionKey ? await getSecret<{ token: string; exp: number }>(this.deps.cache, this.sessionKey, key) : null;
    if (c && c.exp - 5 * 60_000 > now) {
      this.mem.set(sk, c);
      return c.token;
    }
    const res = await this.app
      .appClient()
      .post<{ token: string; expires_at: string }>(
        `/app/installations/${installationId}/access_tokens`,
        scope ? { repositories: scope.repositories, permissions: scope.permissions } : undefined,
      );
    const tok = { token: res.data.token, exp: Date.parse(res.data.expires_at) || now + 60 * 60_000 };
    this.mem.set(sk, tok);
    if (this.sessionKey) await putSecret(this.deps.cache, this.sessionKey, key, tok, Math.max(60, Math.floor((tok.exp - now) / 1000) - 5 * 60));
    return tok.token;
  }

  client(installationId: number, scope?: TokenScope): GitHubClient {
    return new GitHubClient(() => this.installationToken(installationId, scope), clientOptions(this.deps));
  }

  /** Installation id for owner/repo (positive results cached 1 day). */
  async installationFor(fullName: string): Promise<number | null> {
    const key = `inst/${this.name}/name/${fullName.toLowerCase()}`;
    const c = await getJson<number>(this.deps.cache, key);
    if (c) return c;
    const { owner, repo } = splitFullName(fullName);
    const inst = await this.app.repoInstallation(owner, repo);
    if (inst) await putJson(this.deps.cache, key, inst.id, 86400);
    return inst?.id ?? null;
  }

  /** Installation id for a repository id (positive results cached 5 min; negatives never, so fresh installs show up). */
  async installationForRepoId(repositoryId: number): Promise<number | null> {
    const key = `inst/${this.name}/id/${repositoryId}`;
    const c = await getJson<number>(this.deps.cache, key);
    if (c) return c;
    const inst = await this.app.repoInstallationById(repositoryId);
    if (inst) await putJson(this.deps.cache, key, inst.id, 300);
    return inst?.id ?? null;
  }

  /** Client for one repository; `permissions` narrows the token to that repository and those permissions. */
  async repoClient(fullName: string, permissions?: TokenScope['permissions']): Promise<GitHubClient> {
    const id = await this.installationFor(fullName);
    if (!id) throw new Error(`${this.name} app is not installed on ${fullName}`);
    return this.client(id, permissions ? { repositories: [splitFullName(fullName).repo], permissions } : undefined);
  }
}

export class Services {
  private _modules: AppAuth | null = null;
  readonly bot: AppAuth;
  readonly data: DataRepo;
  readonly telegram: Telegram;
  /**
   * `env` is the full Portal env. The cron Worker passes its smaller CronEnv (see entry/cron.ts): scheduled code
   * only touches the Bot App, Telegram and Cloudflare settings, and the Modules App is created lazily.
   */
  constructor(
    readonly env: Env,
    readonly deps: Deps,
  ) {
    this.bot = new AppAuth('bot', env.BOT_APP_ID, env.BOT_APP_PRIVATE_KEY, deps, env.SESSION_KEY || undefined);
    // KernelSU Modules Bot tokens are always scoped: contents on the data repo, actions on the tools repo (sync dispatch,
    // run queries). One data token serves reads and writes so a request never mints two.
    this.data = new DataRepo(env.DATA_REPO, () => this.bot.repoClient(env.DATA_REPO, { contents: 'write' }), deps);
    this.telegram = new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, deps.fetch);
  }

  /** KernelSU Modules App (Portal only). */
  get modules(): AppAuth {
    if (!this._modules) {
      if (!this.env.MODULES_APP_ID || !this.env.MODULES_APP_PRIVATE_KEY) throw new Error('MODULES_APP_ID / MODULES_APP_PRIVATE_KEY are not configured');
      this._modules = new AppAuth('modules', this.env.MODULES_APP_ID, this.env.MODULES_APP_PRIVATE_KEY, this.deps, this.env.SESSION_KEY || undefined);
    }
    return this._modules;
  }

  /** KernelSU Modules Bot client for TOOLS_REPO, scoped to `actions: write` (workflow_dispatch, workflow runs). */
  toolsClient(): Promise<GitHubClient> {
    return this.bot.repoClient(this.env.TOOLS_REPO, { actions: 'write' });
  }

  userClient(token: string): GitHubClient {
    return new GitHubClient(token, clientOptions(this.deps));
  }

  now(): number {
    return this.deps.now();
  }
  nowIso(): string {
    return new Date(this.deps.now()).toISOString();
  }
}
