# Implementation contracts

This file pins down the interfaces between the components of KernelSU Modules: data files, CLIs, workflows, the Portal
HTTP surface and the Telegram review flow. A change to a contract updates every consumer in the same change.

## 0. Org, repos, names

| Thing | Value |
| --- | --- |
| GitHub org (owns everything) | `KernelSU-Modules` |
| Tools monorepo (this repo) | `KernelSU-Modules/tools` |
| Data repo | `KernelSU-Modules/repo` |
| Example module repo | `KernelSU-Modules/example-module` |
| Public App | "KernelSU Modules", slug `kernelsu-modules` (read-only on author repos) |
| Private App | "KernelSU Modules Bot", slug `kernelsu-modules-bot` (installed only on `tools` + `repo`) |
| Check Run name | `KernelSU Modules` |
| Site | `https://modules.kernelsu.org` (Cloudflare Pages project `kernelsu-modules-repo`, Direct Upload) |
| Portal | `https://developers.kernelsu.org` = Cloudflare **Pages** project `kernelsu-developer-portal` (Direct Upload: `portal/dist` + Pages Functions in advanced mode `_worker.js` for `/api`, `/auth`, `/webhooks`, `/internal` only). DNS stays on Google Cloud DNS: `developers CNAME kernelsu-developer-portal.pages.dev`. **Workers Free** limits: 10 ms CPU / invocation |
| Cron Worker | Cloudflare Worker `kernelsu-developer-portal-cron` (Cron Triggers only; no routes, no workers.dev). Pages Functions have no cron |
| Sync workflow | `.github/workflows/sync-build-deploy.yml` in `tools`, concurrency group `publish` |
| Telegram bot | `@ksudevbot` ("KernelSU Developer Bot"), review group "KernelSU Modules Review" |

Operational decisions: only GitHub-hosted modules; pending requests expire after 30 days; Cloudflare Workers Free; Telegram Serverless thin forwarder (fallback: direct webhook to the Worker); all accounts owned by the org; keep the last 5 production Pages deployments + everything younger than 30 days; keep 10 releases per module, prereleases recorded but not shown; an update.json hosted on the site is provided; domains as above.

## 1. Stack & conventions

- TypeScript, ESM, Node ≥ 22 (Actions: `ubuntu-latest`, Node 22). pnpm workspace (`pnpm@10`).
- Packages are consumed **as TS source** (`"exports": {".": "./src/index.ts"}`), no build step for libs. Run TS with `tsx`, test with `vitest`, typecheck with `pnpm exec tsc -p .` (TypeScript 7). Each package has `typecheck` and `test` scripts.
- Package names: `@kernelsu-modules/{schema,github,validator,render,sync,build,site,worker,portal,module-release}`.
- Code in `packages/*` must be **runtime-agnostic** (Node + Workers + browser): only `fetch`, WebCrypto, `TextEncoder/Decoder`, `DecompressionStream`, Web Streams. No `node:*` imports, no `Buffer`, no `new Function`/eval (rules out ajv runtime compile — use zod).
- Data files: YAML via `yaml` package (`YAML.parse`, stringify with `lineWidth: 0`), JSON with 2-space indent + trailing newline, stable key order.
- Tests never call write APIs on real GitHub / Cloudflare / Telegram; network access is injected (fakes in tests).

## 2. Shared packages

### `@kernelsu-modules/schema` (`packages/schema/src`)
zod schemas + inferred types; JSON Schema generated to `schemas/` by `pnpm schemas`.
- `common.ts`: `ModuleId` (`^[a-zA-Z][a-zA-Z0-9._-]+$`, 2–64), `foldId`, `Locale`, `RelativePath`, `HttpsUrl`, `WebUrl` (http or https), `Sha256Hex`, `GitSha`, `IsoDateTime`, `GitHubId`, `VersionCode` (1..INT32_MAX), `Architecture`.
- `canonical.ts`: `sortKeys`, `canonicalJson` (sorted keys, 2-space indent, trailing newline) — the serialization of `sources.lock.json` and `status.json`.
- `manifest.ts`: `ModuleManifest` (author `module.yaml`, schemaVersion 1, **single language**): `schemaVersion, id, name (≤100), summary (≤500), description (repo path of one Markdown doc), license?, homepage?, support? (http(s); http warns), tags? (lowercased), icon?, metamodule, kind (`module` default | `script`; `script` + `metamodule: true` is a `manifest-schema` error), authors? (the complete list; omitted → the build shows the bound repository's owner), starsRepository? (`owner/name`; verified by sync, see Sync), compatibility?, release?`. Objects are not strict: unknown fields are stripped (validator: `manifest-schema` **warning**) so older validators accept newer manifests; an unsupported `schemaVersion` major is an error. Paths may start with `./` (stripped). Without top-level `name/summary/description` the manifest fails with `manifest-schema`. `MANIFEST_KNOWN_KEYS` lists the known keys.
- `params.ts`: `ScriptParams` (`params.json` of a script entry, schemaVersion 1, ≤ 64 KiB, `PARAMS_KNOWN_KEYS`): `params` ≤ 16 of `bool | enum | string | int` with `key` (`^[A-Z][A-Z0-9_]{0,31}$`), `label`, `description?` (single-language string ≤ 200) and per-type `default` / `options` (1–32, value `^[A-Za-z0-9._-]{1,64}$`) / `maxLength` (1–1024, 256) / `pattern?` / `required` / `min?` / `max?` (int32). Objects are not strict (unknown fields: warning). Cross-field rules live in the validator (`parseParams`).
- `registry.ts`: `RegistryRecord` (`modules/{id}.yaml`), `Source`, `OpenRequest`, `Review`, `Moderation`, `Policy`, `Maintainers`, `Banned`, `SubmissionId` (`[a-z0-9]{10}`), `ReasonCode`.
- `lock.ts`: `SourcesLock` (`sources.lock.json`), `ModuleLock` (+ `maxVersionCode`, `maxStableVersionCode`), `LockedRelease`, `LockedContent` (+ `blobs`), `LockedStars` (optional `ModuleLock.stars`: `{count, fetchedAt, repositoryId, fullName, verified: 'self'|'owner'|'app', requested?, problem?}` — display only).
- `status.ts`: `RegistryStatus` (`status.json`), `ModuleStatus`, `StatusIssue`.
- `defaults.ts`: `DEFAULT_POLICY` (initial policy.yaml values; limits used by validator defaults).
- `api.ts`: `ApiIndex`, `ApiModules`, `ApiModuleSummary` (`name`, `summary`; no locales; `kind: "module"|"script"` always emitted (clients default a missing value to `module` and hide unknown values); `authors` = module.yaml authors, or `[{name: <owner login>, url: https://github.com/<owner login>}]` when omitted; `stars?: number|null` and `starsRepository?: "owner/name"|null` — the repository the count belongs to), `ApiModuleDetail` (`readme`: `"api/v1/modules/{id}/readme"` (served from `readme.html`; Pages strips `.html`) or null; `homepage`/`support` http(s)), `ApiRelease`, `ApiUpdateJson`. All paths in API docs are relative to the site root (`api/v1/...`, `assets/...`).

### `@kernelsu-modules/github` (`packages/github/src`)
- `GitHubClient(token | () => Promise<token>, {fetch?, baseUrl?, timeoutMs? (30 s per attempt, AbortSignal), retry?: {retries (2), baseDelayMs (500), maxDelayMs (10 s)} | false, sleep?})`: `.get/.post/.patch/.put/.delete/.request(method, path, {query, body, etag, allow, timeoutMs})`, `.paginate()` (ignores `etag`; stops on an allowed non-2xx). `etag` → sends If-None-Match and returns `{status: 304, data: null}` (GitHub ETags depend on the exact Authorization header, so they only match with the same token). Retries: rate limits (429 / 403 with rate-limit headers or message) for any method, waiting Retry-After / reset / 60 s for secondary limits when ≤ `maxDelayMs`; 5xx, network errors and timeouts for GET/HEAD only. Throws `GitHubError(status, …)` (`.rateLimited`, `.forbidden` = permission 403) unless status in `allow`, `GitHubNetworkError` without a response.
- `GitHubApp({appId, privateKey}, clientOptions?)`: `.jwt()`, `.appClient()`, `.installationToken(id, scope?)`, `.installationClient(id, scope?)`, `.repoInstallation(owner, repo)`, `.repoInstallationById(repositoryId)`, `.repoClient(owner, repo)`. Accepts PKCS#1 PEMs directly. A 401 on an App-JWT request (installation lookup, token creation) throws `AppAuthError` (subclass of `GitHubError`): global; other 401s are per installation.
- `commitWithRetry(gh, {owner, repo, branch}, mutate)`: optimistic Git Data API commit; `mutate(reader)` returns `{files: {path: content|null}, message}`; throw `PreconditionFailed` to abort. `reader.read(path)`, `reader.list(prefix)`, `reader.baseCommit`. Deleting a path absent from the base tree is a no-op (dropped). Retries only ref races (409, 422 "not a fast forward"); other 422s (protected branch / rulesets) are thrown.
- `withTrailers(subject, {Action, Module, ...})` → commit message with audit trailers.
- `dispatchWorkflow(gh, {owner, repo, workflow, ref, inputs})`.
- `verifySha256Signature(secret, body, header)`, `hmacSha256Hex`, `sha256Hex`, `timingSafeEqual`.

## 3. `@kernelsu-modules/validator` API (`packages/validator`)

Runtime-agnostic. Consumers (sync, worker, module-release action) code against exactly this surface:

```ts
export type Severity = 'error' | 'warning';
export interface Issue { code: string; severity: Severity; message: string; path?: string }
export interface Result<T> { ok: boolean; value?: T; issues: Issue[] }

// ID rules (policy-aware): format, policy.id.reservedPrefixes / reservedIds, output-file suffixes,
// case-fold collision against existing ids
export function checkModuleId(id: string, policy: Policy, existingIds?: Iterable<string>): Issue[];

// module.yaml: YAML parse + schema + semantic checks
export function parseManifest(text: string, opts?: { maxBytes?: number }): Result<ModuleManifest>;
export function manifestReferencedPaths(m: ModuleManifest): string[]; // icon + description doc

// module.prop
export function parseModuleProp(text: string): Result<{ props: Record<string, string>; id: string; name: string; version: string; versionCode: number; author: string; description: string }>;
export function isMetamoduleProp(props: Record<string, string>): boolean; // ksud: trimmed "1" or ASCII-case-insensitive "true"
export function isOneshotProp(props: Record<string, string>): boolean;    // `oneshot`, same rule (script entries)

// ZIP (central directory only; never extracts to disk)
export interface RangeReader { size: number; read(offset: number, length: number): Promise<Uint8Array> }
export function rangeReaderFromBytes(bytes: Uint8Array): RangeReader;
export function rangeReaderFromUrl(url: string, opts?: { fetch?: typeof fetch; headers?: Record<string, string>; size?: number }): Promise<RangeReader>; // HTTP Range
export interface ZipLimits { zipMaxBytes: number; uncompressedMaxBytes: number; maxCompressionRatio: number; maxEntries: number; modulePropMaxBytes: number }
export function inspectZip(reader: RangeReader, limits: ZipLimits): Promise<Result<{ entries: number; uncompressedTotal: number; moduleProp: string;
  files: string[] /* extracted paths, directories end with "/" */; paramsJson?: { text: string } | { error: string } /* root params.json, not an issue by itself */ }>>;
// rejects: absolute paths, '..', backslash-traversal, duplicate module.prop, encrypted entries, zip64 lies,
// total uncompressed > limit, ratio > limit, too many entries, missing root module.prop

// Release selection & version rules
export interface ReleaseLike { id: number; tag_name: string; draft: boolean; prerelease: boolean; immutable?: boolean; published_at: string | null; assets: { id: number; name: string; size: number; digest?: string | null; browser_download_url: string; state?: string }[] }
export function selectAsset(release: ReleaseLike, assetPattern?: string): Result<ReleaseLike['assets'][number]>; // exactly one match
export function checkReleaseEligibility(release: ReleaseLike, repoFullName: string): Issue[]; // draft, immutable!==true, url host/path
export function compareWithLocked(versionCode: number, lockedStable: { versionCode: number } | null): 'newer' | 'same' | 'older';
export function globMatch(pattern: string, name: string): boolean;

// End-to-end for one release asset (used by sync and the author-side action)
export function validateReleaseAsset(input: { reader: RangeReader; expectedId: string; limits: ZipLimits; kind?: 'module' | 'script' }): Promise<Result<{ props: Record<string,string>; version: string; versionCode: number }>>;

// Script entries. checkReleaseKind (part of validateReleaseAsset; called directly by the module-release action):
// manifest-kind-mismatch (module.yaml kind vs isOneshotProp; kind undefined = decided by oneshot, no mismatch),
// script-missing-action, script-forbidden-file (root files / dirs only), script-metamodule, script-params-invalid
// (parseParams), params-ignored (warning: params.json in a module).
export function checkReleaseKind(input: { kind: 'module' | 'script' | undefined; props: Record<string, string>; zip: { files: string[]; paramsJson?: { text: string } | { error: string } } }): Issue[];
export function parseParams(text: string, opts?: { maxBytes?: number }): Result<ScriptParams>; // defaults resolved; all issues script-params-invalid

export const ISSUE_CODES: Record<string, string>; // code -> human description (used for Check Run docs)
```
Issue codes are stable kebab-case strings (e.g. `manifest-kind-mismatch`, `script-missing-action`, `script-forbidden-file`, `script-metamodule`, `script-params-invalid`, `params-ignored`, `release-not-immutable`, `asset-none`, `asset-multiple`, `zip-too-large`, `zip-bomb-ratio`, `zip-path-traversal`, `prop-missing-field`, `prop-id-mismatch`, `prop-versioncode-range`, `version-not-newer`, `manifest-schema`, `manifest-path-missing`, `id-reserved`, `id-collision`, …). Full sha256 of a downloaded asset is computed by the caller (sync streams it with node:crypto).

## 4. `@kernelsu-modules/render` API (`packages/render`)

Runtime-agnostic and DOM-free (runs in the Portal SPA for the preview, and in the site build; not bundled into the Worker).
```ts
export interface RenderContext { fullName: string; commit: string; docPath: string; /* rewrite relative links/images; '' drops the image */ resolveImage?: (absUrl: string) => string | null; remoteImages?: 'keep' | 'link' }
export function renderMarkdown(md: string, ctx: RenderContext): { html: string; images: string[] /* absolute https URLs referenced */ };
export function sanitizeHtml(html: string): string; // fixed tag / attribute / URL-scheme whitelist
export function renderChangelog(md: string, ctx: Omit<RenderContext, 'docPath'>): string;
```

## 5. Data repo layout (`KernelSU-Modules/repo`)

```
modules/{id}.yaml        RegistryRecord
policy.yaml              Policy
maintainers.yaml         Maintainers   ({github: {id, login}, telegram?: {id}}; numeric ids only, Telegram usernames are not used.
                         Readers strip a legacy telegram.username (stripLegacyMaintainerFields); the next Bot write drops it)
banned.yaml              Banned
sources.lock.json        SourcesLock  (written only by tools/sync)
status.json              RegistryStatus (packages/schema/src/status.ts; written by tools/sync in the same commit as the lock;
                         the Portal and the cron Worker read only this, never the lock; missing file = empty)
README.md
```
Every commit is made by the KernelSU Modules Bot through `commitWithRetry` with trailers:
```
<subject>

Action: submit|transfer|approve|reject|suspend|unsuspend|archive|ban|unban|maintainers|expire|sync|init
Module: <id>                       (when applicable)
Submission: <submissionId>         (when applicable)
Submitted-by: github:<id>
Approved-by: github:<id> via telegram|portal|auto      (approve)
Rejected-by: github:<id> via telegram|portal           (reject)
Actor: github:<id> via portal|telegram|cron            (other actions)
Actor: app:<app-slug> via sync|cron                    (automated writes without a human actor;
                                                        sync commits: app:kernelsu-modules-bot via sync)
```
State machine (Worker enforces; precondition = current record state at reader.baseCommit):
- submit: no record, or record `rejected`, or `pending` older than `policy.pending.expireDays` → `pending` + `request{kind: submit}`.
- Any new request that replaces an expired open request edits the old Telegram message to "expired" (trailer `Expired: <sid>`).
- transfer: record `listed|suspended` → if user is admin of both old and new repo: update `source` (auto) else `request{kind: transfer}`.
- approve(submissionId): requires `request.submissionId == submissionId`; submit → `listed`, transfer → swap `source`; clears `request`, writes `review`.
- reject: same precondition; submit → `rejected`; transfer → unchanged source.
- suspend: `listed` → `suspended` (+moderation). unsuspend: `suspended` → `listed`. archive: `listed|suspended` → `archived`. An archived record keeps its `source` (required by the schema).
- Request kinds per status (checked by `check-data`): `submit` only on `pending`, `transfer` only on `listed|suspended`. One active binding per repository across sources and open requests.
- Only `listed` modules with a non-null `stable` in the lock appear in builds.

## 6. Sync (`tools/sync`) ↔ workflow ↔ build

CLI: `pnpm --filter @kernelsu-modules/sync start -- --data-dir <path> [--module <id>] [--commit|--dry-run] [--report <file>]`

Data check: `pnpm --filter @kernelsu-modules/sync check-data -- --data-dir <path> [--now <iso>]` (read-only; exit 1 on errors). Validates
every file against `@kernelsu-modules/schema` plus cross-file rules: `{id}.yaml` file names, case-fold collisions, request kind
per status, one active binding per repository, canonical JSON for `sources.lock.json` / `status.json`, lock/status entries
without a matching record (warnings), expired requests (warnings). An absent or empty `modules/` is a valid empty data repo.
Runs in CI against `KernelSU-Modules/repo@main`.

- Reads records/policy from `--data-dir`, existing `sources.lock.json` and `status.json`; syncs every `listed|suspended` record into the lock, validates the source of **every open request** (`request.source` of submit/transfer, any record status; for a transfer on a listed record the new repository is validated separately from the current binding) and writes `sources.lock.json` + `status.json`. With `--commit` both are committed in **one** commit to `KernelSU-Modules/repo` via the Bot App (`Action: sync`, `Actor: app:<BOT_APP_SLUG|kernelsu-modules-bot> via sync`), only when something substantive changed. Writes a JSON report (`--report`).
- `--module <id>` = "Sync now" / "Re-run": forced re-check of that module and its open request (no dedupe), fresh Check Runs even when the result is unchanged, retryable release failures retried. Accepted for records that only have an open request.
- No heartbeat: a lock entry is persisted only when content, releases, `seen`, marks or health (status / installation / message) change; `health.lastSuccessAt` / `lastAttemptAt` only move together with such a change (incl. health transitions). Health messages are deterministic (`<code>: <text>`). Sync health monitoring = last successful workflow run (Worker side).
- Stars (`ModuleLock.stars`, display only — never health, validation, Check Run conclusions, releases or listing): the bound repository's `stargazers_count` comes with the `GET /repositories/{id}` response sync already makes (closed source: the public release repository). module.yaml `starsRepository` (`owner/name`) is used only when that repository is public and (a) has the same owner id as the bound repository (`verified: owner`) or (b) the Modules App is installed on it (`GET /repositories/{id}/installation` with the App JWT; installing needs admin = proof of control; `verified: app`). It is looked up by the stored `repositoryId` while module.yaml names the same `requested` value (survives renames; a new repository at the old name is not picked up), else by name; nothing is written to it (no Check Runs). Otherwise the bound repository's count is used with `problem` set: warning `stars-repo-unverified` in the content Check Run (when content is re-validated) and a health note `stars-repo-unverified: …` in the health / status.json message (health status unchanged). Verification runs only when the entry is due: missing, ≥ 24 h old, `requested` changed, content/releases changed, or a forced run. Persistence (no churn): the stars entry rides along with any other lock change; alone (entry equal apart from `fetchedAt` = no change) it is persisted only when the stored entry is missing or ≥ 24 h old, or on `--module`, and then only `stars` changes (health timestamps and status.json stay). Webhooks from a stars-only repository match no binding and are ignored by the Worker.
- No persisted ETags: GitHub ETags are derived from the exact Authorization header and each run uses a new installation token, so a stored ETag would never yield a 304. Each run lists the first releases page (30) per module.
- Content: tracked = module.yaml, the description, the icon and repository images referenced by the description (`content.files` = sha256 within image limits; `content.blobs` = git blob shas of all tracked paths). `content.commit` advances only when a tracked blob changes (one tree listing per run when the branch head moved); unrelated pushes change nothing and produce no Check Run.
- versionCode: `maxVersionCode` = highest versionCode ever accepted for the ID (any channel; survives deleted releases and repository transfers). New releases must exceed it; equal to it on the same channel as the still-locked release = same version (ignored); else `version-not-newer`. `maxStableVersionCode` = highest versionCode ever stable; stable = highest non-prerelease release with versionCode ≥ it, else null (module hidden, health note `stable-unavailable`) — deleting or demoting the stable release never falls back to an older one.
- First sync of a binding (nothing in `seen`): only the newest eligible stable release and releases published after it (and after the binding, `review.decidedAt`) are examined; older ones are recorded in `seen` with `skipped: true`, without download or Check Run.
- Errors: only App-JWT failures (`AppAuthError`) are fatal. Per-installation 401, permission 403, 404, … are recorded in the module's health message; rate limits / 5xx / network errors are retried by the client (sync waits up to 60 s) and otherwise reported as temporary.
- GC: lock entries are kept for `listed|suspended|archived` records (archived keeps the marks) and removed otherwise; status entries are removed for records that are neither `listed|suspended` nor have an open request. Removals are re-checked against the remote record inside the commit.
- `status.json` (`RegistryStatus`, canonical JSON, no generatedAt): one entry per `listed|suspended` record and per record with an open request: `{repositoryId, fullName, health, installation, lastSuccessAt, message, contentCommit, stable: {tag, version, versionCode, publishedAt}|null, maxVersionCode, request: {submissionId, repositoryId, ok, checkedAt, latestTag, issues: [{code, severity, message?}], commit?, releaseId?}|null}`. For records without a bound source (pending submit) the top-level fields describe the requested repository (`health` = request result, `lastSuccessAt` null). A request is re-validated when the branch head or the newest eligible release changes, or on `--module`; `checkedAt` only changes with the result.
- Env: `MODULES_APP_ID`, `MODULES_APP_PRIVATE_KEY`, `BOT_APP_ID`, `BOT_APP_PRIVATE_KEY`, `DATA_REPO` (default `KernelSU-Modules/repo`), `BOT_APP_SLUG` (default `kernelsu-modules-bot`).
- Check Runs: name `KernelSU Modules`, created with the Modules App installation token. Release checks on the release tag commit (`external_id: release:<releaseId>`); manifest/doc checks on the checked branch head (`external_id: content:<commit>`; when tracked content changes, once per failing commit, and on forced runs); repository state problems (`repo-private`, `owner-changed`) on the branch head (`external_id: state:<code>`). A missing installation cannot be reported on the repository (status.json message only). Requested action `{label: "Sync now", identifier: "sync", description: "Re-run sync"}`. Output summary in English, issue codes linked to `https://developers.kernelsu.org/docs/checks#<code>`.

Build CLI: `pnpm --filter @kernelsu-modules/build start -- --data-dir <path> --out <dist> [--cache-dir <dir>] [--base-url https://modules.kernelsu.org] [--portal-url <url>] [--data-commit <sha>] [--report <file>]`
- Produces the full `dist/`: site pages (`index.html`, `404.html`, `{locale}/index.html`, `{locale}/modules/{id}/index.html`, `sitemap.xml`, `robots.txt`), `api/v1/**`, `assets/`, `search/{locale}.json`, `_headers` and `build-manifest.json` (written last). Only `listed` records whose lock has a non-null `stable` from the bound repository are built (`stable: null` = module hidden).
- Module content is single-language (module.yaml `name` / `summary` / `description`); only the site UI is translated (en, zh-CN; both locales show the same content). Per module: `api/v1/modules/{id}.json`, `api/v1/modules/{id}/update.json`, `api/v1/modules/{id}/changelog.md` (raw Markdown body of the stable release, truncated to `changelogMaxBytes`, `(no release notes)` when empty; `_headers` serves it as `text/markdown; charset=utf-8`) and the README fragment file `api/v1/modules/{id}/readme.html`. The API `readme` path is **`api/v1/modules/{id}/readme`** (no extension): Cloudflare Pages 308-redirects `*.html` to the extension-less URL and serves `readme.html` there (verified with `wrangler pages dev`). `update.json.changelog` = `{baseUrl}/api/v1/modules/{id}/changelog.md`. API `kind` = module.yaml `kind` at the locked content; when the stable release's locked `prop` disagrees (`oneshot` per `isOneshotProp`; module.yaml changed after the release was accepted) the build uses the kind of the stable ZIP and logs a warning. The site shows a "Script" badge for `kind: script`.
- README / changelog images: copied to `assets/` (same-origin) when within limits, otherwise rendered as links (fragments and site pages alike; site CSP `img-src 'self' data:`). Global file budget: when the projected file count reaches 15,000, remaining images are linked instead of copied; the build only fails when non-image files exceed 19,500.
- Files are fetched at `content.commit` and verified against `content.files` (repository images not in `files` are fetched as remote images at the locked commit URL), with retries (backoff) for 429 / 5xx / network errors. Content errors (digest mismatch, missing file, invalid module.yaml, output path collision) skip only that module (served stale from the verified last good content in `--cache-dir` when available). If a module's inputs cannot be fetched (network / 429 / 5xx after retries) and no verified last good copy exists, the **whole build fails** (non-zero exit; the live site keeps the previous deployment).
- `buildId` = first 16 hex of sha256 over the canonical JSON of the inputs that affect the output: builder fingerprint (sha256 over the sources of `tools/build`, `site`, `packages/render`, `packages/schema`, `packages/validator` (tests excluded) + `pnpm-lock.yaml`), base/portal URLs, the policy fields used, the included records + their lock subset (no `seen`, `lastAttemptAt`, installation, `prop`; stars as `{count, fullName}` — a stars change is a deploy, ≤ daily per module), and per-module build results (status, content commit used, output digest). The data commit is **not** an input: a data commit that changes nothing in the output keeps the buildId and the workflow skips the deploy, so the live `repoCommit` (in `api/v1/index.json` and `build-manifest.json`, informational only) may lag behind the data repo. `status.json` is never read by the build.
- Uses `GITHUB_TOKEN`-free raw fetches at locked commits: `https://raw.githubusercontent.com/{fullName}/{commit}/{path}` (public repos), cached in `--cache-dir`.
- Module IDs ending in `.json`, `.html`, `.htm`, `.md`, `.xml`, `.txt` are rejected by `checkModuleId` (`id-reserved-suffix`); the build additionally skips any module whose output paths collide (file vs directory) with another module's.

Workflow `sync-build-deploy.yml`: `workflow_dispatch` inputs `reason` (string), `module` (string, optional). Steps: checkout tools → checkout the data repo → pnpm install → sync `--commit` → build → `wrangler pages deploy dist --project-name kernelsu-modules-repo --branch main --commit-hash <buildId>` . Secrets: `MODULES_APP_ID`, `MODULES_APP_PRIVATE_KEY`, `BOT_APP_ID`, `BOT_APP_PRIVATE_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. All third-party actions pinned to commit SHAs.

## 7. Worker (`worker/`) — Pages project `kernelsu-developer-portal` + Worker `kernelsu-developer-portal-cron`

One codebase (`worker/src`), two deployables:
- **Pages `kernelsu-developer-portal`** (`worker/wrangler.toml`, a Pages config with `pages_build_output_dir = "../portal/dist"`).
  `pnpm --filter @kernelsu-modules/worker build` bundles `src/entry/pages.ts` (Hono app) into `portal/dist/_worker.js`
  (advanced mode) and writes `portal/dist/_routes.json` (`include: /api/* /auth/* /webhooks/* /internal/*`), so
  static requests never invoke Functions. Pages serves the SPA (fallback to `index.html`; no top-level `404.html`)
  and `/docs/*`; `portal/public/_headers` sets the static CSP. Deployed by `portal-deploy.yml`:
  `wrangler pages deploy ../portal/dist --project-name kernelsu-developer-portal --branch main` (cwd `worker/`; wrangler re-wraps the self-contained `_worker.js`).
  `/auth/*` and `/api/*` on `*.pages.dev` hosts redirect to `PORTAL_URL`.
- **Worker `kernelsu-developer-portal-cron`** (`worker/cron/wrangler.toml`, entry `src/entry/cron.ts`): once a day (`17 3 * * *`) →
  dispatch sync (fallback for lost webhooks), sync health, expire pending (≤2), prune. Health: newest successful run
  of `SYNC_WORKFLOW` on `TOOLS_REPO` (Actions API) older than 26 h →
  alert (no lock-based check). Every invocation runs under a counting subrequest budget (hard cap 45 < 50); work that
  does not fit is left for the next run. Pruning covers every project in `PAGES_PROJECTS` (`kernelsu-modules-repo,kernelsu-developer-portal`):
  keep the newest 5 production deployments, everything < 30 days and the current production deployment.

Caveats: the Cache API only stores on the custom domain (no-op on `*.pages.dev` and in `kernelsu-developer-portal-cron`) — caches and the
sync rate limit degrade to per-isolate memory; cron alerts are de-duplicated by schedule (≤1/h dispatch failure,
≤1/6 h stale sync). Pages applies secret/var changes only to new deployments. `TELEGRAM_CHAT_ID` is injected at deploy
time from the GitHub Environment `production` variable (toml placeholder `""`).

KernelSU Modules Bot tokens are always scoped: data repo → `{repositories: ['repo'], permissions: {contents: 'write'}}`;
dispatch / run queries → `{repositories: ['tools'], permissions: {actions: 'write'}}`.

Env:
```
Pages kernelsu-developer-portal
  vars:    DATA_REPO=KernelSU-Modules/repo  TOOLS_REPO=KernelSU-Modules/tools  SYNC_WORKFLOW=sync-build-deploy.yml
           PORTAL_URL=https://developers.kernelsu.org  SITE_URL=https://modules.kernelsu.org  MODULES_APP_SLUG=kernelsu-modules
           TELEGRAM_CHAT_ID=<id>
  secrets: MODULES_APP_ID MODULES_APP_PRIVATE_KEY MODULES_APP_CLIENT_ID MODULES_APP_CLIENT_SECRET MODULES_APP_WEBHOOK_SECRET
           BOT_APP_ID BOT_APP_PRIVATE_KEY SESSION_KEY(base64 32B) TELEGRAM_BOT_TOKEN TG_FORWARD_SECRET
           TELEGRAM_WEBHOOK_SECRET(optional, direct-webhook fallback)          (wrangler pages secret put --project-name kernelsu-developer-portal)
Worker kernelsu-developer-portal-cron
  vars:    DATA_REPO TOOLS_REPO SYNC_WORKFLOW PORTAL_URL PAGES_PROJECTS=kernelsu-modules-repo,kernelsu-developer-portal TELEGRAM_CHAT_ID
  secrets: BOT_APP_ID BOT_APP_PRIVATE_KEY TELEGRAM_BOT_TOKEN CF_API_TOKEN CF_ACCOUNT_ID   (wrangler secret put --config cron/wrangler.toml)
```

HTTP surface:
```
GET  /auth/login                 -> GitHub authorize (state cookie)
GET  /auth/callback              -> handles both login (code+state) and post-install (code+installation_id+setup_action, no state)
POST /auth/logout                requires X-CSRF-Token (when a session exists); revokes the user token (DELETE /applications/{client_id}/token), clears the cookie
POST /webhooks/github            Modules App webhooks (X-Hub-Signature-256): release.*, installation*, check_run.rerequested, check_run.requested_action
                                 503 while MODULES_APP_WEBHOOK_SECRET is unset. Dispatches for repos bound to listed/suspended records AND
                                 repos referenced by any open request.source (module=<id>); others 204
POST /internal/telegram          from tgcloud forwarder (see section 8)
POST /webhooks/telegram          optional direct Telegram webhook (X-Telegram-Bot-Api-Secret-Token)
GET  /docs/*                     served from static assets (developer docs)

JSON API (cookie session; mutating requests require header X-CSRF-Token = csrf from /api/me):
GET  /api/me                      {user:{id,login,avatarUrl}|null, isMaintainer, csrf, installUrl}
GET  /api/repos                   {repos: [{repositoryId, fullName, private, defaultBranch, installationId, isAdmin, registeredId|null}], truncated}
                                  ≤30 GitHub requests; truncated=true when installations/repositories were cut
POST /api/precheck                {repositoryId, ref?, id?} -> PrecheckResult {ok, issues: Issue[], manifest?, latestRelease?: {tag, immutable, url?, asset?: {name, size, digest, url}}}
                                  API-only, never downloads the ZIP: parseManifest, referenced paths exist at the ref, checkModuleId
                                  (skipped when the ID already has a record), latest release: immutable, checkReleaseEligibility,
                                  selectAsset (+ size <= zipMaxBytes). No version/versionCode (module.prop is read only by the sync).
GET  /api/ids/:id                 {id, available, reason?, status?}
POST /api/submissions             {repositoryId, id} -> {submissionId, status}
                                  After any submit/transfer request is recorded: dispatch sync {reason: submit, module: <id>}
                                  (auto-approved transfer: {reason: transfer, module}) -> Actions does the full ZIP
                                  validation and writes the Check Run. Releases are never reviewed (webhook -> sync -> build -> deploy).
POST /api/transfers               {id, repositoryId} -> {submissionId?, autoApproved}
GET  /api/modules                 my modules: [{id, status, source?, request?, review?, moderation?, sync?: ModuleStatus}]
                                  sync = the module's status.json entry; sync.request is null unless it matches the open request's submissionId
GET  /api/modules/:id             same shape
POST /api/modules/:id/sync        listed/suspended or any record with an open request; rate-limited (1 / 10 min / module, Cache API) -> dispatch
POST /api/preview                 {repositoryId} -> {markdown, ctx: {fullName, commit, docPath}}  raw description Markdown (≤512 KiB, else 400
                                  content-too-large); the SPA renders it with @kernelsu-modules/render inside the sandboxed iframe
GET  /api/admin/queue             open requests [{id, status, request, source?, expired, check?: ModuleStatus['request']}]
GET  /api/admin/requests/:submissionId                one request, open or decided: RegistryRecord & {open}
POST /api/admin/requests/:submissionId/approve        {}
POST /api/admin/requests/:submissionId/reject         {reasonCode, reason?}
POST /api/admin/modules/:id/(suspend|unsuspend|archive) {reason}
GET    /api/admin/maintainers            {maintainers: [{githubId, login, name|null, avatarUrl, telegramId|null}]}
                                         name / avatarUrl / current login from GitHub GET /user/{id} (caller's user token; cached
                                         per id 1 day; ≤10 uncached lookups per request, in parallel); on failure: stored login and
                                         https://avatars.githubusercontent.com/u/{id}?s=64
POST   /api/admin/maintainers            {login} -> 201 row. Resolves GET /users/{login} (caller's token); 400 bad-login | not-a-user
                                         (Organization/Bot), 404 user-not-found, 409 already-maintainer | banned
PATCH  /api/admin/maintainers/:githubId  {telegramId: positive integer | null} -> row. 400 bad-telegram-id, 404 not-maintainer,
                                         409 telegram-taken (unique across maintainers)
DELETE /api/admin/maintainers/:githubId  -> {removed}. 400 cannot-remove-self, 404 not-maintainer, 409 last-maintainer
                                         Each write = one Bot commit of maintainers.yaml (trailers Action: maintainers, Target: github:<id>,
                                         Actor: github:<id> via portal); preconditions re-checked at the base commit; stored logins are
                                         refreshed from cached profiles; an unchanged file is not committed
GET  /api/admin/banned  POST /api/admin/banned {githubId, reason}  DELETE /api/admin/banned/:githubId
GET  /api/admin/status            {generatedAt, dataCommit, invalidFiles, newestSuccessAt, lastSuccessfulRun, modules: [ModuleStatus & {id, status?}], runs}
                                  (from status.json + Actions API)
Errors: {error: {code, message}} with proper HTTP status.
```
Reads of data-repo state: Bot installation token (scoped) + Git Data API, cached ≤60 s in the Cache API. Sessions: sealed cookie with an
absolute 30-day `exp`; token refresh is single-flight and tolerant (a lost refresh race answers `X-KernelSU-Session: retry`, the SPA retries once). Public site and client never touch the Portal.
Telegram review messages show kind, id, repo(s), submitter, latest release tag (+ immutable flag, asset name) and the precheck summary; no version/versionCode.

## 8. Telegram

- Worker sends review messages via Bot API `sendMessage` to `TELEGRAM_CHAT_ID` (HTML parse mode) with inline keyboard; edits them with `editMessageText` after any decision (portal or telegram). Outcomes shown: approved, rejected, expired (cron expiry, or an expired request replaced by a new one), closed (submission aborted / module archived). `TELEGRAM_CHAT_ID` comes from the `production` Environment variable at deploy time.
- `callback_data`: `v1:{action}:{submissionId}` where action ∈ `ap` (approve), `rs` (reject spam), `rv` (violation), `ri` (bad-id), `rq` (squatting). ≤ 64 bytes.
- tgcloud forwarder → `POST {PORTAL_URL}/internal/telegram` (503 while `TG_FORWARD_SECRET` is unset; no timestamp/anti-replay by decision), body = the raw Telegram Update JSON (bytes as received/serialized once), header `X-KernelSU-Signature: sha256=<hex HMAC-SHA256(TG_FORWARD_SECRET, body)>`. Worker responds `200 {"answer": {"text": "...", "show_alert": bool}}` and the forwarder calls `answerCallbackQuery(callback_query.id, answer)`. On forward failure the forwarder answers "Service unavailable, use the Portal".
- Commands (message updates; privacy mode, so in the group they are sent as `/cmd@ksudevbot`; the Worker accepts `/cmd` and `/cmd@<any>`). Worker replies via Bot API:
  - `/suspend <id> <reason>` (maintainers only, P1).
  - `/whoami` (anyone, review group `TELEGRAM_CHAT_ID` only; elsewhere ignored): replies to the message with the sender's numeric Telegram user id and whether it is bound to a maintainer (`@login`, GitHub id). No write. Used to fill `telegram.id` on the Portal Maintainers page.
- Authorization: `from.id` must match a `maintainers[].telegram.id`; otherwise answer "Not authorized" and write nothing.

## 9. Repository layout

| Component | Paths |
| --- | --- |
| Shared libraries | `packages/schema/**`, `packages/github/**`, `packages/validator/**`, `packages/render/**` |
| Sync + data check | `tools/sync/**` |
| Static build + site | `tools/build/**`, `site/**` |
| Portal backend + cron | `worker/**` |
| Portal SPA + developer docs build | `portal/**` |
| Author-side release action | `actions/module-release/**` |
| Telegram forwarder | `tgcloud/**` |
| Workflows | `.github/**` |
| Developer docs | `docs/developers/**` |
| Operator runbook, App manifests, rulesets | `docs/setup/**` |
| Generated JSON Schemas | `schemas/` (`pnpm schemas`) |
