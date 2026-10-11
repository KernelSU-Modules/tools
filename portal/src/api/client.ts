import type {
  AdminStatus,
  BanRequest,
  BannedDoc,
  IdAvailability,
  MaintainersDoc,
  Me,
  ModerationAction,
  MyModule,
  PrecheckResult,
  PreviewRequest,
  PreviewResponse,
  QueueItem,
  RejectRequest,
  ReposResponse,
  SubmitRequest,
  SubmitResponse,
  SyncResponse,
  TransferRequest,
  TransferResponse,
} from './types.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Normalised error for any non-2xx response or network failure. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds, from Retry-After (429/503). */
  readonly retryAfter: number | null;
  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/** Parses Retry-After (delta-seconds or HTTP date). */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiClientOptions {
  fetch?: FetchLike;
  /** Prefix for all requests; '' = same origin. */
  base?: string;
  /** Delay before the one-shot retry after `X-KernelSU-Session: retry` (ms). */
  sessionRetryDelayMs?: number;
}

/**
 * The Worker sets `X-KernelSU-Session: retry` when it could not refresh an expired GitHub token, typically because a
 * parallel request already rotated the refresh token. That parallel response carries the newer session cookie,
 * so the same request is retried once after a short pause instead of treating the user as signed out.
 */
export const SESSION_RETRY_HEADER = 'X-KernelSU-Session';

export class ApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly retryDelay: number;
  private csrf: string | null = null;

  constructor(opts: ApiClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.base = opts.base ?? '';
    this.retryDelay = opts.sessionRetryDelayMs ?? 400;
  }

  setCsrf(token: string | null): void {
    this.csrf = token;
  }

  async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (!SAFE_METHODS.has(method)) {
      if (this.csrf) headers['X-CSRF-Token'] = this.csrf;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, init);
    } catch (e) {
      throw new ApiError(0, 'network', e instanceof Error ? e.message : 'Network error');
    }
    if (!retried && res.headers.get(SESSION_RETRY_HEADER)?.toLowerCase() === 'retry') {
      await res.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, this.retryDelay));
      return this.request<T>(method, path, body, true);
    }
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      const code = typeof err?.code === 'string' ? err.code : `http_${res.status}`;
      const message = typeof err?.message === 'string' ? err.message : res.statusText || `HTTP ${res.status}`;
      throw new ApiError(res.status, code, message, parseRetryAfter(res.headers.get('Retry-After')));
    }
    return data as T;
  }

  /* --------------------------- session --------------------------- */
  async me(): Promise<Me> {
    const me = await this.request<Me>('GET', '/api/me');
    this.setCsrf(me.csrf || null);
    return me;
  }
  /** Requires the CSRF token from /api/me (sent automatically); the Worker also revokes the GitHub token. */
  async logout(): Promise<void> {
    await this.request<unknown>('POST', '/auth/logout');
    this.setCsrf(null);
  }

  /* --------------------------- developer -------------------------- */
  repos(): Promise<ReposResponse> {
    return this.request('GET', '/api/repos');
  }
  precheck(repositoryId: number): Promise<PrecheckResult> {
    return this.request('POST', '/api/precheck', { repositoryId });
  }
  checkId(id: string): Promise<IdAvailability> {
    return this.request('GET', `/api/ids/${encodeURIComponent(id)}`);
  }
  submit(req: SubmitRequest): Promise<SubmitResponse> {
    return this.request('POST', '/api/submissions', req);
  }
  transfer(req: TransferRequest): Promise<TransferResponse> {
    return this.request('POST', '/api/transfers', req);
  }
  modules(): Promise<MyModule[]> {
    return this.request('GET', '/api/modules');
  }
  module(id: string): Promise<MyModule> {
    return this.request('GET', `/api/modules/${encodeURIComponent(id)}`);
  }
  syncModule(id: string): Promise<SyncResponse> {
    return this.request('POST', `/api/modules/${encodeURIComponent(id)}/sync`, {});
  }
  preview(req: PreviewRequest): Promise<PreviewResponse> {
    return this.request('POST', '/api/preview', req);
  }

  /* ----------------------------- admin ---------------------------- */
  queue(): Promise<QueueItem[]> {
    return this.request('GET', '/api/admin/queue');
  }
  approve(submissionId: string): Promise<unknown> {
    return this.request('POST', `/api/admin/requests/${encodeURIComponent(submissionId)}/approve`, {});
  }
  reject(submissionId: string, req: RejectRequest): Promise<unknown> {
    return this.request('POST', `/api/admin/requests/${encodeURIComponent(submissionId)}/reject`, req);
  }
  moderate(id: string, action: ModerationAction, reason: string): Promise<unknown> {
    return this.request('POST', `/api/admin/modules/${encodeURIComponent(id)}/${action}`, { reason });
  }
  maintainers(): Promise<MaintainersDoc> {
    return this.request('GET', '/api/admin/maintainers');
  }
  saveMaintainers(doc: MaintainersDoc): Promise<unknown> {
    return this.request('PUT', '/api/admin/maintainers', doc);
  }
  banned(): Promise<BannedDoc> {
    return this.request('GET', '/api/admin/banned');
  }
  ban(req: BanRequest): Promise<unknown> {
    return this.request('POST', '/api/admin/banned', req);
  }
  unban(githubId: number): Promise<unknown> {
    return this.request('DELETE', `/api/admin/banned/${githubId}`);
  }
  status(): Promise<AdminStatus> {
    return this.request('GET', '/api/admin/status');
  }
}
