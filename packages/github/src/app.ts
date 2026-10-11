// GitHub App authentication: App JWT, installation tokens, repo installation lookup.
import { GitHubClient, GitHubError, type ClientOptions } from './client.ts';
import { importRsaPrivateKey, signJwtRs256 } from './crypto.ts';

export interface AppCredentials {
  appId: string | number;
  /** PEM, PKCS#1 ("BEGIN RSA PRIVATE KEY", as downloaded from GitHub) or PKCS#8. Literal "\n" is accepted. */
  privateKey: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: number; // epoch ms
}

/**
 * The App itself could not authenticate (401 on an App-JWT request: bad App id / private key / clock skew).
 * Global: every installation is affected. Other 401s (an installation token revoked mid-run) are per-repository.
 */
export class AppAuthError extends GitHubError {
  constructor(e: GitHubError) {
    super(e.status, e.method, e.path, e.body, e.headers);
    this.name = 'AppAuthError';
  }
}

/** Run an App-JWT request; 401 becomes AppAuthError. */
async function asApp<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 401 && !(e instanceof AppAuthError)) throw new AppAuthError(e);
    throw e;
  }
}

export class GitHubApp {
  private key: Promise<CryptoKey> | null = null;
  private jwtCache: { jwt: string; exp: number } | null = null;
  private tokens = new Map<string, InstallationToken>();

  constructor(
    readonly creds: AppCredentials,
    private readonly opts: ClientOptions = {},
  ) {}

  /** App JWT, valid ~9 minutes, cached for ~8. iat is backdated 60s for clock skew. */
  async jwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwtCache && this.jwtCache.exp - 60 > now) return this.jwtCache.jwt;
    this.key ??= importRsaPrivateKey(this.creds.privateKey);
    const exp = now + 540;
    const jwt = await signJwtRs256(await this.key, { iat: now - 60, exp, iss: String(this.creds.appId) });
    this.jwtCache = { jwt, exp };
    return jwt;
  }

  /** Client authenticated as the App itself (JWT). */
  appClient(): GitHubClient {
    return new GitHubClient(() => this.jwt(), this.opts);
  }

  /**
   * Installation access token (cached until 5 minutes before expiry).
   * Optionally scope to repository ids or names (without owner) and/or reduced permissions.
   */
  async installationToken(
    installationId: number,
    scope?: { repositoryIds?: number[]; repositories?: string[]; permissions?: Record<string, 'read' | 'write'> },
  ): Promise<string> {
    const key = `${installationId}:${JSON.stringify(scope ?? {})}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;
    const body = scope
      ? { repository_ids: scope.repositoryIds, repositories: scope.repositories, permissions: scope.permissions }
      : undefined;
    const res = await asApp(this.appClient().post<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, body));
    const tok = { token: res.data.token, expiresAt: Date.parse(res.data.expires_at) };
    this.tokens.set(key, tok);
    return tok.token;
  }

  installationClient(installationId: number, scope?: Parameters<GitHubApp['installationToken']>[1]): GitHubClient {
    return new GitHubClient(() => this.installationToken(installationId, scope), this.opts);
  }

  /** GET /repos/{owner}/{repo}/installation; null when the App is not installed there. */
  async repoInstallation(owner: string, repo: string): Promise<{ id: number; account: { id: number; login: string } } | null> {
    const res = await asApp(this.appClient().get(`/repos/${owner}/${repo}/installation`, { allow: [404] }));
    return res.status === 404 ? null : res.data;
  }

  /** Same lookup by numeric repository id (survives renames). */
  async repoInstallationById(repositoryId: number): Promise<{ id: number; account: { id: number; login: string } } | null> {
    const res = await asApp(this.appClient().get(`/repositories/${repositoryId}/installation`, { allow: [404] }));
    return res.status === 404 ? null : res.data;
  }

  /** Client for a single repository via the App's installation on it; null when not installed. */
  async repoClient(owner: string, repo: string): Promise<GitHubClient | null> {
    const inst = await this.repoInstallation(owner, repo);
    return inst ? this.installationClient(inst.id) : null;
  }
}

export { GitHubError };
