// Minimal fetch-based GitHub REST client. Runtime-agnostic.

export const GITHUB_API = 'https://api.github.com';
export const API_VERSION = '2022-11-28';
export const USER_AGENT = 'KernelSU-Modules';

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
    readonly headers?: Headers,
  ) {
    super(`GitHub ${method} ${path} -> ${status}: ${typeof body === 'object' && body && 'message' in body ? (body as { message: string }).message : String(body)}`);
    this.name = 'GitHubError';
  }

  /** Primary or secondary rate limit (429, or 403 with rate-limit headers / message). Retryable later. */
  get rateLimited(): boolean {
    return isRateLimitResponse(this.status, this.headers ?? null, this.body);
  }

  /** 403 that is not a rate limit: missing permission, suspended installation, blocked resource. Not retryable. */
  get forbidden(): boolean {
    return this.status === 403 && !this.rateLimited;
  }
}

function isRateLimitResponse(status: number, headers: Headers | null, body: unknown): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  if (headers?.get('retry-after')) return true;
  if (headers?.get('x-ratelimit-remaining') === '0') return true;
  const msg = typeof body === 'object' && body && 'message' in body ? String((body as { message: unknown }).message) : typeof body === 'string' ? body : '';
  return /rate limit/i.test(msg);
}

/** Network failure or per-attempt timeout (no HTTP response). */
export class GitHubNetworkError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly cause: unknown,
  ) {
    super(`GitHub ${method} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'GitHubNetworkError';
  }
}

export interface RetryOptions {
  /** Extra attempts after the first (default 2). */
  retries?: number;
  /** Base backoff in ms, doubled per attempt with jitter (default 500). */
  baseDelayMs?: number;
  /**
   * Never wait longer than this for Retry-After / rate-limit reset / secondary-limit cool-down (default 10 s);
   * longer waits fail fast with a rate-limited GitHubError. Batch jobs (sync) raise it to 60 s.
   */
  maxDelayMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Send If-None-Match; a 304 response is returned (not thrown) with data = null. */
  etag?: string | null;
  /** Statuses returned instead of thrown (e.g. [404]). 304 is always returned when etag is set. */
  allow?: number[];
  /** Per-attempt timeout in ms (default: client timeoutMs, 30 s). */
  timeoutMs?: number;
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  etag: string | null;
  headers: Headers;
}

export type TokenProvider = string | (() => Promise<string>);

export interface ClientOptions {
  baseUrl?: string;
  userAgent?: string;
  fetch?: typeof fetch;
  /** Per-attempt timeout (AbortSignal), default 30 s. */
  timeoutMs?: number;
  /** Retry policy; `false` disables retries. */
  retry?: RetryOptions | false;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Retries:
 *  - rate limits (429 / 403 with rate-limit headers): any method (the request was not processed), honouring
 *    Retry-After / x-ratelimit-reset up to maxDelayMs;
 *  - 5xx and network errors / timeouts: idempotent methods only (GET/HEAD), exponential backoff with jitter.
 * Everything else (4xx incl. permission 403 and 422) is returned/thrown immediately.
 */
export class GitHubClient {
  constructor(
    private readonly token: TokenProvider | null,
    private readonly opts: ClientOptions = {},
  ) {}

  private async authHeader(): Promise<Record<string, string>> {
    if (!this.token) return {};
    const t = typeof this.token === 'string' ? this.token : await this.token();
    return { authorization: `Bearer ${t}` };
  }

  async request<T = any>(method: string, path: string, o: RequestOptions = {}): Promise<GitHubResponse<T>> {
    method = method.toUpperCase();
    const url = new URL(path.startsWith('http') ? path : (this.opts.baseUrl ?? GITHUB_API) + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    let body: string | undefined;
    if (o.body !== undefined) body = JSON.stringify(o.body);
    const retry = this.opts.retry === false ? { retries: 0 } : (this.opts.retry ?? {});
    const retries = retry.retries ?? 2;
    const base = retry.baseDelayMs ?? 500;
    const maxDelay = retry.maxDelayMs ?? 10_000;
    const sleep = this.opts.sleep ?? defaultSleep;
    const backoff = (attempt: number) => Math.min(maxDelay, base * 2 ** attempt * (0.75 + Math.random() * 0.5));

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        'user-agent': this.opts.userAgent ?? USER_AGENT,
        ...(await this.authHeader()),
        ...o.headers,
      };
      if (o.etag) headers['if-none-match'] = o.etag;
      if (body !== undefined) headers['content-type'] = 'application/json';
      let res: Response;
      try {
        res = await (this.opts.fetch ?? fetch)(url, { method, headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? this.opts.timeoutMs ?? 30_000) });
      } catch (e) {
        if (IDEMPOTENT.has(method) && attempt < retries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new GitHubNetworkError(method, path, e);
      }
      const etag = res.headers.get('etag');
      if (res.status === 304 && o.etag) return { status: 304, data: null as T, etag: o.etag, headers: res.headers };
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        if (IDEMPOTENT.has(method) && attempt < retries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new GitHubNetworkError(method, path, e);
      }
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok && !(o.allow ?? []).includes(res.status)) {
        if (attempt < retries) {
          if (isRateLimitResponse(res.status, res.headers, data)) {
            const wait = rateLimitWait(res.headers, backoff(attempt));
            if (wait <= maxDelay) {
              await sleep(wait);
              continue;
            }
          } else if (res.status >= 500 && IDEMPOTENT.has(method)) {
            await sleep(backoff(attempt));
            continue;
          }
        }
        throw new GitHubError(res.status, method, path, data, res.headers);
      }
      return { status: res.status, data: data as T, etag, headers: res.headers };
    }
  }

  get<T = any>(path: string, o?: RequestOptions) {
    return this.request<T>('GET', path, o);
  }
  post<T = any>(path: string, body?: unknown, o?: RequestOptions) {
    return this.request<T>('POST', path, { ...o, body });
  }
  patch<T = any>(path: string, body?: unknown, o?: RequestOptions) {
    return this.request<T>('PATCH', path, { ...o, body });
  }
  put<T = any>(path: string, body?: unknown, o?: RequestOptions) {
    return this.request<T>('PUT', path, { ...o, body });
  }
  delete<T = any>(path: string, o?: RequestOptions) {
    return this.request<T>('DELETE', path, o);
  }

  /**
   * Follow `Link: rel="next"` up to maxPages. `pick` extracts the array from wrapped responses.
   * Conditional requests are not supported here (a 304 has no body to return): `etag` is ignored. A non-2xx status
   * listed in `allow` ends the listing with what was collected so far.
   */
  async paginate<T>(path: string, o: RequestOptions & { maxPages?: number; pick?: (d: any) => T[] } = {}): Promise<T[]> {
    const { etag: _ignored, maxPages, pick, ...rest } = o;
    const out: T[] = [];
    let next: string | null = path;
    let page = 0;
    const query = { per_page: 100, ...rest.query };
    while (next && page < (maxPages ?? 10)) {
      const res: GitHubResponse<any> = await this.request('GET', next, page === 0 ? { ...rest, query } : { headers: rest.headers, allow: rest.allow, timeoutMs: rest.timeoutMs });
      if (res.status < 200 || res.status >= 300) break;
      const items = pick ? pick(res.data) : res.data;
      if (Array.isArray(items)) out.push(...(items as T[]));
      next = parseNextLink(res.headers.get('link'));
      page++;
    }
    return out;
  }
}

/**
 * Wait for a rate-limited response (GitHub guidance): Retry-After seconds; else until x-ratelimit-reset when
 * remaining is 0; else (secondary limit without hints) at least one minute.
 */
function rateLimitWait(h: Headers, _fallback: number): number {
  const ra = Number(h.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return ra * 1000;
  if (h.get('x-ratelimit-remaining') === '0') {
    const reset = Number(h.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(1000, reset * 1000 - Date.now() + 1000);
  }
  return 60_000;
}

export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}

export function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) throw new Error(`invalid repository name: ${fullName}`);
  return { owner, repo };
}
