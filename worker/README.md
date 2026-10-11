# `@kernelsu-modules/worker` — Portal backend (Pages `kernelsu-developer-portal`) + cron Worker (`kernelsu-developer-portal-cron`)

KernelSU Developer Portal JSON API, maintainer admin API, KernelSU Modules App webhooks, scheduled jobs and the
Telegram review flow. One shared codebase (`src/`), two deployables:

| Deployable | What | Config | Entry |
| --- | --- | --- | --- |
| Cloudflare **Pages** project `kernelsu-developer-portal` (Direct Upload) | static Portal (`../portal/dist`: SPA + `/docs`, `_headers` CSP) + **Pages Functions** for `/api/*`, `/auth/*`, `/webhooks/*`, `/internal/*` | `wrangler.toml` (Pages config, `pages_build_output_dir`) | `src/entry/pages.ts` → `portal/dist/_worker.js` |
| Cloudflare **Worker** `kernelsu-developer-portal-cron` | Cron Triggers only (no routes, no fetch handler, no workers.dev) | `cron/wrangler.toml` | `src/entry/cron.ts` |

Why: `kernelsu.org` DNS is on Google Cloud DNS, so a Worker custom domain is impossible, while a Pages custom
domain works with an external CNAME (`developers` → `kernelsu-developer-portal.pages.dev`). Pages Functions have no Cron
Triggers, hence the separate cron Worker.

**Functions entry: Pages "advanced mode" (`_worker.js`)**, not a `functions/` directory. `pnpm build` bundles
`src/entry/pages.ts` with esbuild into one self-contained, minified `portal/dist/_worker.js` and writes
`portal/dist/_routes.json` from `src/routes-config.ts`; `wrangler pages deploy ../portal/dist` uploads
both with the static files (its bundling pass only wraps the self-contained file; verified with `wrangler pages dev`). Reasons: (1) it is the same `export default { fetch }` + Hono app as before, with no
file-based router or `hono/cloudflare-pages` adapter in between; (2) we control `_routes.json` explicitly (a
`functions/[[path]].ts` catch-all would generate `include: ["/*"]` and put every static request through
Functions); (3) Direct Upload needs no `functions/` directory next to the cwd and wrangler does not have to
resolve the workspace packages itself. Static requests never invoke Functions (free, unmetered); SPA fallback
is Pages' built-in behaviour (no top-level `404.html`, checked by the build script).

Both run on the **Workers Free** plan (10 ms CPU and 50 subrequests per invocation; Functions invocations
count against the same 100k/day) — see "CPU notes".

## Layout

| Path | What |
| --- | --- |
| `src/entry/pages.ts` | Pages Functions (advanced mode) `fetch` entry |
| `src/entry/cron.ts` | `kernelsu-developer-portal-cron` `scheduled` entry (CronEnv only; isolate-memory cache) |
| `src/routes-config.ts` | `DYNAMIC_PREFIXES` → `_routes.json` |
| `scripts/build-pages.ts` | esbuild bundle → `portal/dist/_worker.js` + `_routes.json` |
| `src/app.ts` | Hono app, `*.pages.dev` → custom-domain redirect for `/auth`+`/api`, security headers (CSP), error envelope, per-isolate service memo |
| `src/routes/auth.ts` | `/auth/login`, `/auth/callback` (login **and** post-install shapes), `/auth/logout` |
| `src/routes/api.ts` | developer API (`/api/me`, repos, precheck, preview, ids, submissions, transfers, modules, sync) |
| `src/routes/admin.ts` | maintainer API (`/api/admin/*`) |
| `src/routes/hooks.ts` | `/webhooks/github`, `/internal/telegram` (tgcloud forwarder), `/webhooks/telegram` (direct) |
| `src/cron.ts` | `*/15` dispatch + health (Actions API) + expiry + hourly pruning, daily health + expiry + pruning (both Pages projects), all under a per-invocation subrequest budget |
| `src/lib/budget.ts` | `SubrequestBudget`: counting `fetch` with a hard cap (cron) |
| `src/domain/actions.ts` | last successful sync run (Actions API, Bot token scoped to `actions` on `tools`) |
| `src/domain/state.ts` | record state machine (pure; throws `PreconditionFailed`) |
| `src/domain/ops.ts` | all writes: KernelSU Modules Bot + `commitWithRetry`, trailers, Telegram edits, dispatch |
| `src/domain/data.ts` | cached read model of the data repo (`KernelSU-Modules/repo`; snapshot per commit, `status.json` by blob sha, cron open-request scan) |
| `src/domain/fastyaml.ts` | fast parser for the YAML subset records use (falls back to `yaml`) |
| `src/domain/precheck.ts` | Portal precheck (API only: module.yaml, referenced paths, ID rules, latest release/asset) |
| `src/lib/session.ts` | AES-GCM sealed session cookie, CSRF (HMAC of session id) |
| `test/` | vitest suites with an in-memory fake GitHub/Telegram/Cloudflare (`test/fake.ts`) |
| `test/smoke/` | workerd smoke/benchmark worker (`pnpm smoke`, never deployed) |

## Secrets

Portal (Pages): `pnpm --filter @kernelsu-modules/worker exec wrangler pages secret put <NAME> --project-name kernelsu-developer-portal`
(Pages applies secret/var changes to **new deployments** only — redeploy afterwards).
Cron Worker: `pnpm --filter @kernelsu-modules/worker exec wrangler secret put <NAME> --config cron/wrangler.toml`.

| Name | Portal | Cron | Purpose |
| --- | :-: | :-: | --- |
| `MODULES_APP_ID`, `MODULES_APP_PRIVATE_KEY` | ✓ | | KernelSU Modules App (installation tokens: author repo reads, precheck) |
| `MODULES_APP_CLIENT_ID`, `MODULES_APP_CLIENT_SECRET` | ✓ | | user authorization (Portal login) |
| `MODULES_APP_WEBHOOK_SECRET` | ✓ | | `X-Hub-Signature-256` of App webhooks |
| `BOT_APP_ID`, `BOT_APP_PRIVATE_KEY` | ✓ | ✓ | KernelSU Modules Bot: all data repo reads/writes, `workflow_dispatch` + run queries on `tools`. Tokens are always minted **scoped**: `{repositories: ['repo'], permissions: {contents: 'write'}}` and `{repositories: ['tools'], permissions: {actions: 'write'}}` |
| `SESSION_KEY` | ✓ | | base64 of 32 random bytes (`openssl rand -base64 32`). HKDF → AES-256-GCM (cookie + secrets in Cache API) and HMAC (CSRF). Rotating it logs everybody out. |
| `TELEGRAM_BOT_TOKEN` | ✓ | ✓ | sendMessage / editMessageText / answerCallbackQuery only (never setWebhook/getUpdates while tgcloud owns the webhook) |
| `TG_FORWARD_SECRET` | ✓ | | HMAC key shared with the tgcloud forwarder (`X-KernelSU-Signature`) |
| `TELEGRAM_WEBHOOK_SECRET` | ✓ | | optional; enables `/webhooks/telegram` (direct webhook fallback, `X-Telegram-Bot-Api-Secret-Token`) |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | | ✓ | Pages deployment pruning (`Cloudflare Pages: Edit` on the account) |

Vars — Portal (`wrangler.toml`): `DATA_REPO`, `TOOLS_REPO`, `SYNC_WORKFLOW`, `PORTAL_URL`, `SITE_URL`,
`MODULES_APP_SLUG`, `TELEGRAM_CHAT_ID`. Cron (`cron/wrangler.toml`): `DATA_REPO`, `TOOLS_REPO`, `SYNC_WORKFLOW`,
`PORTAL_URL` (message links), `PAGES_PROJECTS` (`kernelsu-modules-repo,kernelsu-developer-portal`), `TELEGRAM_CHAT_ID`.
`TELEGRAM_CHAT_ID` stays `""` in both toml files: `portal-deploy.yml` injects the GitHub Environment variable
`production` → `TELEGRAM_CHAT_ID` at deploy time (rewrites the Pages toml line; `--var` for `kernelsu-developer-portal-cron`) and fails
when it is unset. Locally set it in `.dev.vars`.

GitHub App settings (KernelSU Modules): Callback URL `https://developers.kernelsu.org/auth/callback`,
"Request user authorization (OAuth) during installation" on, "Expire user authorization tokens" on (the
Portal refreshes them), webhook URL `https://developers.kernelsu.org/webhooks/github`, events `release`,
`installation`, `installation_repositories`, `check_run`.

## Local development

```sh
cp worker/.dev.vars.example worker/.dev.vars   # fill in a *development* App pair / test chat
pnpm --filter @kernelsu-modules/portal build          # static files in ../portal/dist
pnpm --filter @kernelsu-modules/worker dev            # bundles _worker.js, then `wrangler pages dev` on http://localhost:8787
# cron Worker (reads cron/.dev.vars): copy the Bot/Telegram/CF lines there, then
pnpm --filter @kernelsu-modules/worker cron:dev
curl "http://localhost:8790/__scheduled?cron=*/15+*+*+*+*"   # dispatches the real workflow of TOOLS_REPO!
```

`.dev.vars` is git-ignored. Point `DATA_REPO`/`TOOLS_REPO` at test repos: the Portal writes through the Bot.
The session cookie is `__Host-` + `Secure`; browsers accept that on `http://localhost`. Re-run
`pnpm --filter @kernelsu-modules/worker build` after code changes (`_worker.js` is a pre-built bundle).
Webhooks can be replayed with a signed body (`sha256=` HMAC of the exact bytes).

Checks: `pnpm --filter @kernelsu-modules/worker typecheck`, `... test`, `... build` (writes `_worker.js` +
`_routes.json` into `../portal/dist`, prints the size), `... cron:build` (dry-run bundle of `kernelsu-developer-portal-cron` to
`dist/cron`), `... smoke` (then `curl localhost:8799`: JWT signing, record/`status.json` parsing, webhook index,
session/CSRF, a client-side Markdown render reference and — for the sync's benefit — ZIP inspection inside
workerd, with timings).

Bundle sizes (2026-10-10, after moving Markdown rendering to the SPA): `_worker.js` 664 KiB minified / 162 KiB
gzip; as uploaded after wrangler's pass (`wrangler pages functions build --build-output-directory ../portal/dist`)
889 KiB / 187 KiB gzip; `kernelsu-developer-portal-cron` 619 KiB / 148 KiB gzip (`wrangler deploy --dry-run`). Free-plan limit: 3 MiB
gzip. `@kernelsu-modules/render` (markdown-it, htmlparser2) is no longer in either bundle (worker devDependency for
the smoke benchmark only); zod (from `@kernelsu-modules/schema`) is the largest part.

## Behaviour notes

- **Login.** `/auth/login?next=/path` stores `{state, next}` in a sealed `__Host-kernelsu-oauth` cookie.
  `/auth/callback` accepts (1) `code+state` (state must match), or (2) the post-install shape
  `code+installation_id+setup_action` without state — GitHub sends no state there. (2) permits a login CSRF;
  it is mitigated by never replacing an existing valid session (the code is then ignored) and by every write
  re-checking GitHub admin rights. Everything else is rejected.
- **Session.** `__Host-kernelsu-session` = AES-GCM(user token, refresh token, expiries, uid, login, `exp`). `exp` is an
  absolute lifetime of 30 days set at login; refreshes never extend it (cookie Max-Age is capped by it too).
  The access token is refreshed transparently within 60 s of expiry. GitHub refresh tokens are single-use, so
  refreshes are single-flight per isolate and the new token set is shared for 2 min through the sealed cache
  (keyed by a hash of the old refresh token): parallel requests of one page load reuse one refresh. A request
  that still cannot refresh (lost the race in another colo) does **not** clear the cookie — it is answered as
  signed-out with `X-KernelSU-Session: retry` and the SPA retries once (by then the browser holds the winner's
  cookie); the cookie is only cleared when the same refresh token still fails ≥30 s later. CSRF token =
  HMAC(sid, uid), returned by `/api/me`, required in `X-CSRF-Token` for every non-GET `/api/*` call **and for
  `POST /auth/logout`**. Logout revokes the user token (`DELETE /applications/{client_id}/token`, Basic
  client_id:client_secret) and clears the cookie. `safeNext` (post-login redirect) percent-decodes up to 3 times,
  normalizes dot segments and rejects anything that could resolve off-origin (`//x`, `/\x`, `/.//x`, `/%2F%2Fx`,
  control characters). Functions responses and `_headers` send HSTS (`max-age=31536000; includeSubDomains`).
- **Precheck** (`POST /api/precheck`) never downloads the ZIP: module.yaml schema (`parseManifest`), referenced
  files (icon, description doc) exist as regular files at the ref (one contents-API directory listing per parent
  directory, ≤4), ID rules (`checkModuleId`: format, reserved IDs/prefixes, case-fold
  collisions; skipped for an ID that already has a record), and the latest non-draft release: `immutable`, `checkReleaseEligibility`, `selectAsset`
  (name/size vs `zipMaxBytes`). Result `{ok, issues, manifest?, latestRelease?: {tag, immutable, url?, asset?}}`.
  module.prop / version / ZIP limits / sha256 are checked by the sync job.
- **Writes.** Only via the KernelSU Modules Bot + `commitWithRetry`; transitions in `domain/state.ts` run inside the
  mutate callback (re-validated on every retry), so concurrent decisions produce one commit and one `409`.
  New requests: submissionId → Telegram `sendMessage` (failure tolerated) → commit incl. `request.telegram` →
  respond. If the commit fails after the message was sent, the message is edited to "closed". When the new
  request replaces an expired one (submit over an expired pending submission, transfer over an expired
  request) the old message is edited to "expired" (`Expired: <sid>` trailer). A new request is refused (409)
  while another request on the same record is open.
- **Transfers.** Auto-approved when the requester (always verified as admin of the target repo) is also an admin
  of the currently bound repository; otherwise they go to maintainer review like a submission.
- **After a request is recorded** (submit / transfer awaiting review) the sync workflow is dispatched with
  `{reason: submit, module: <id>}` (in `waitUntil`), so Actions runs the full ZIP validation of the pending
  record's source and writes a Check Run. Auto-approved transfers dispatch `{reason: transfer}`.
  Releases themselves are never reviewed: release webhooks → dispatch → sync → build → deploy is automatic.
- **Decisions** (Portal or Telegram) edit the stored message (outcome, decider, time, no keyboard);
  approve / suspend / unsuspend / archive and auto-approved transfers dispatch the sync workflow.
  Edits/dispatch run in `waitUntil` so the tgcloud forwarder (8 s timeout) gets its answer quickly.
- **Webhooks** dispatch when the repository id maps to a `listed`/`suspended` record **or to the source of any
  open request** (submit / transfer — the sync validates every open request's source on every run, so
  "Re-run" / "Sync now" on a pending submission's Check Run works); everything else returns 204. The repoId →
  module index is memoized per snapshot. `installation` events without a repository list match records by
  `source.ownerId` / `request.source.ownerId`. `/webhooks/github` answers **503** while
  `MODULES_APP_WEBHOOK_SECRET` is unset (an HMAC with an empty key would be forgeable); `/internal/telegram`
  likewise without `TG_FORWARD_SECRET`. `POST /api/modules/:id/sync` is allowed for listed/suspended modules and
  for any record with an open request.
- **status.json.** The Portal and the cron Worker never parse `sources.lock.json`. tools/sync writes
  `status.json` in the data repo (`RegistryStatus`, `packages/schema/src/status.ts`) in the same commit as the lock;
  it is read by blob sha (cached like the snapshot; a missing file = empty). "My modules" (`sync` field = the
  module's entry), `/api/admin/status` and the queue's `check` use it; `request` is only passed on while its
  `submissionId` matches the record's open request.
- **Cron** (`kernelsu-developer-portal-cron`). `*/15`: dispatch `{reason: cron}`, sync health, expire ≤1 overdue request, and in the
  :00 run prune ≤8 Pages deployments across `PAGES_PROJECTS` (shared budget, rotating start project). Daily
  `17 3`: health, expire ≤2, prune ≤10. Health = Actions API: the newest successful run of `SYNC_WORKFLOW` on
  `TOOLS_REPO` (`status=success`, `main`) older than 60 min (or none) → alert (the lock-based 2 h check is gone:
  the sync no longer writes timestamp-only heartbeats). Expiry scans open requests with one GraphQL request and
  parses only records with a top-level `request:` (no full snapshot: the cron Worker has no cache), commits with
  ≤2 attempts. Pruning keeps the newest 5 production deployments, everything < 30 days and the current
  production deployment of each project. **Subrequests:** every fetch goes through a `SubrequestBudget` (hard cap
  45 < 50); each expiry starts only with ≥22 left, each project listing with ≥8, each deletion with ≥3, so a
  backlog or commit retries end the run early and the next run continues (tests: daily run with 6 overdue
  requests + 60 old deployments uses 38, `*/15` 28, all-conflicting commits 39). The cron Worker has no usable
  Cache API (no zone), so its alerts are gated by schedule: dispatch failure only from the :00 run (≤1/h), sync
  health only from the :00 run of every 6th hour and the daily run.
- **`/api/repos`** spends at most 30 GitHub requests on `/user/installations` + per-installation repository
  pages (100 per page) and returns `{repos, truncated}`; `truncated: true` when something was left out (the SPA
  shows a notice).
- **Preview.** `POST /api/preview {repositoryId}` → `{markdown, ctx: {fullName, commit, docPath}}`: the raw
  description Markdown (≤512 KiB, else 400 `content-too-large`) of the single `description` doc at the bound /
  requested / default-branch commit. The SPA renders it with `@kernelsu-modules/render` into the sandboxed iframe.
- **`*.pages.dev`.** `/auth/*` and `/api/*` on a `*.pages.dev` host 308-redirect to `PORTAL_URL` (OAuth callback
  and `__Host-` cookies are bound to the custom domain); webhooks and static files work on any host.
- **Rate limit.** `/api/modules/:id/sync`: 1 per 10 min per module (Cache API marker; per colo). Without the
  Cache API (`*.pages.dev`) it degrades to per-isolate memory (L1 entries live ≤5 min).
- **Caches.** Isolate memory (L1) + Cache API (L2, per colo; only effective on the custom domain — a no-op on
  `*.pages.dev`, so every cache degrades to L1): data-repo head 60 s, snapshots by commit, `status.json` by blob
  sha, installation tokens per (installation, scope) (sealed with SESSION_KEY, until
  5 min before expiry), installation ids, per-session repo lists (sealed, 60 s), refreshed user token sets (sealed,
  2 min). The cron Worker uses L1 only and never seals (it has no SESSION_KEY).

## CPU notes (Workers Free, 10 ms)

Measured in local workerd (`pnpm smoke`, 2026-10-10; wall time of synchronous work, ±1 ms timer
granularity). The edge should be similar or faster.

| Path | Cost | When |
| --- | --- | --- |
| RS256 App JWT (import + sign) | 2–3 ms | once per isolate per ~8 min and app; tokens then cached (L1 + sealed Cache API) |
| Session unseal / CSRF HMAC | ≤1 ms each | every API call |
| Snapshot from cache (JSON.parse, 300 records ≈150 KB) | 1–2 ms | most API calls / webhooks |
| Webhook repoId → module index (300 records) | ≤1 ms | once per snapshot (memoized) |
| `status.json` parse (300 modules ≈146 KB) | 1–2 ms | once per change per colo, then JSON from cache |
| Cold snapshot (300 records) — fast YAML subset parser | 5–6 ms | once per colo after eviction (Portal only); `yaml` package would be 27–35 ms |
| Incremental snapshot (new data commit) | <1 ms + 1 tree request + changed blobs | after each data commit |
| Precheck (module.yaml parse + release/asset selection; no ZIP) | ≤1 ms | precheck/submission |
| Preview | JSON only | rendering moved to the browser (a 19 KB README took 8–18 ms in workerd) |
| Cron cold run | JWT 2–3 ms + GraphQL JSON ≈1 ms + parse of the few records with a request | every run (no cache): ≈4–5 ms instead of ≈9 ms with a full snapshot |

Remaining risk: a cold Portal isolate that must mint a token (JWT 2–3 ms) **and** build a cold snapshot (5–6 ms at
300 records) in the same request is close to 10 ms; it happens once per colo after a cache eviction and an
occasional 1102 on that request is retried by the SPA/user. At ~600+ records move to Workers Paid or split the
snapshot.
