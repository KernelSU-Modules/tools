/**
 * Portal <-> Worker JSON API types.
 *
 * Only `import type` from @kernelsu-modules/schema: nothing from zod ends up in the bundle.
 * Fields marked "(portal assumption)" are optional extras: the Worker should match
 * them, but the UI tolerates their absence.
 */
import type {
  Banned,
  Maintainers,
  ModuleManifest,
  ModuleStatus,
  OpenRequest,
  RecordStatus,
  RegistryRecord,
  ReasonCode,
  Review,
  Source,
} from '@kernelsu-modules/schema';

export type { RecordStatus, ReasonCode, Source, OpenRequest, Review, ModuleManifest };

export type Moderation = NonNullable<RegistryRecord['moderation']>;
/** Entry of status.json in the data repo (written by the sync job; the Portal never parses sources.lock.json). */
export type { ModuleStatus };
export type SyncHealth = ModuleStatus['health'];
export type SyncStable = NonNullable<ModuleStatus['stable']>;
/** Sync validation of an open request's source (submit / transfer). */
export type RequestCheck = NonNullable<ModuleStatus['request']>;
export type StatusIssue = RequestCheck['issues'][number];
export type Maintainer = Maintainers['maintainers'][number];
export type BannedEntry = Banned['banned'][number];

/** Error envelope returned with a non-2xx status. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

/* ----------------------------- session ----------------------------- */

export interface User {
  id: number;
  login: string;
  avatarUrl: string;
}

/** GET /api/me */
export interface Me {
  user: User | null;
  isMaintainer: boolean;
  csrf: string;
  /** https://github.com/apps/kernelsu-modules/installations/new */
  installUrl: string;
}

/* ------------------------------ repos ------------------------------ */

/** GET /api/repos -> ReposResponse */
export interface Repo {
  repositoryId: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
  isAdmin: boolean;
  /** Module id this repository is currently bound to (any status), or null. */
  registeredId: string | null;
}

export interface ReposResponse {
  repos: Repo[];
  /** The Worker stopped paginating to stay within its per-request subrequest budget; the list is incomplete. */
  truncated: boolean;
}

/* ----------------------------- precheck ---------------------------- */

export type Severity = 'error' | 'warning';
export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  path?: string;
}

export interface PrecheckRelease {
  tag: string;
  immutable: boolean;
  /** (portal assumption) selected asset; any extra fields are ignored. */
  asset?: { name: string; size: number; url?: string };
  // No version/versionCode: the Portal precheck never reads the ZIP (module.prop is validated by the sync job).
  /** (portal assumption, optional) */
  publishedAt?: string;
  htmlUrl?: string;
}

/** POST /api/precheck {repositoryId} */
export interface PrecheckRequest {
  repositoryId: number;
}
export interface PrecheckResult {
  ok: boolean;
  issues: Issue[];
  manifest?: ModuleManifest;
  latestRelease?: PrecheckRelease;
}

/* ------------------------------- ids ------------------------------- */

/** GET /api/ids/:id */
export interface IdAvailability {
  id: string;
  available: boolean;
  /** Human readable reason or issue code when unavailable. */
  reason?: string;
  /** Status of the existing record, if any. */
  status?: RecordStatus;
}

/* --------------------------- submissions --------------------------- */

/** POST /api/submissions */
export interface SubmitRequest {
  repositoryId: number;
  id: string;
}
export interface SubmitResponse {
  submissionId: string;
  status: RecordStatus; // 'pending'
}

/** POST /api/transfers */
export interface TransferRequest {
  id: string;
  repositoryId: number;
}
export interface TransferResponse {
  submissionId?: string;
  autoApproved: boolean;
}

/* ----------------------------- modules ----------------------------- */

/** GET /api/modules -> MyModule[];  GET /api/modules/:id -> MyModule */
export interface MyModule {
  id: string;
  status: RecordStatus;
  source?: Source;
  request?: OpenRequest;
  review?: Review;
  moderation?: Moderation;
  /** status.json entry; absent before the first sync. `sync.request` only matches the open `request`. */
  sync?: ModuleStatus;
}

/** POST /api/modules/:id/sync (429 when rate-limited; Retry-After header honoured) */
export interface SyncResponse {
  ok?: boolean;
  /** (portal assumption, optional) */
  nextAllowedAt?: string;
}

/** POST /api/preview — module content is single-language: one description document. */
export interface PreviewRequest {
  repositoryId: number;
}
export interface PreviewResponse {
  /** Raw Markdown of module.yaml `description` (≤ 512 KiB); rendered in the browser with @kernelsu-modules/render. */
  markdown: string;
  /** Render context: relative links/images resolve against fullName@commit/docPath. */
  ctx: { fullName: string; commit: string; docPath: string };
}

/* ------------------------------ admin ------------------------------ */

/** GET /api/admin/queue -> QueueItem[]  (portal assumption on item shape) */
export interface QueueItem {
  id: string;
  status: RecordStatus;
  request: OpenRequest;
  /** Current binding (transfer requests). */
  source?: Source;
  /** Optional precheck summary captured at submit time. */
  precheck?: { ok: boolean; issues: Issue[] };
  /** Sync validation (full ZIP) of this request's source; present only when it matches the open request. */
  check?: RequestCheck | null;
}

export interface RejectRequest {
  reasonCode: ReasonCode;
  reason?: string;
}

export type ModerationAction = 'suspend' | 'unsuspend' | 'archive';

/** GET /api/admin/status */
export interface AdminStatus {
  generatedAt?: string;
  /** Data repo commit the summary was read from. */
  dataCommit?: string;
  /** Data files that failed to parse (path -> error). */
  invalidFiles?: Record<string, string>;
  /** Newest lastSuccessAt across status.json. */
  newestSuccessAt?: string | null;
  /** Most recent successful sync workflow run. */
  lastSuccessfulRun?: WorkflowRun | null;
  modules: AdminModuleStatus[];
  runs: WorkflowRun[];
}
export type AdminModuleStatus = ModuleStatus & { id: string; status?: RecordStatus };
export interface WorkflowRun {
  id: number;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | ...
  event?: string;
  createdAt: string;
  htmlUrl: string;
  displayTitle?: string;
}

/**
 * Row of GET /api/admin/maintainers ({maintainers: MaintainerView[]}); also the response of
 * POST /api/admin/maintainers {login} and PATCH /api/admin/maintainers/:githubId {telegramId}.
 * name / avatarUrl / login come from the GitHub profile (cached by the Worker), falling back to stored data.
 */
export interface MaintainerView {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  /** Numeric Telegram user id that authorizes review buttons and bot commands; null = not bound. */
  telegramId: number | null;
}
export interface MaintainersResponse {
  maintainers: MaintainerView[];
}
/** GET /api/admin/banned */
export type BannedDoc = Banned;
export interface BanRequest {
  githubId: number;
  reason: string;
}
