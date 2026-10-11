# Operator runbook — KernelSU Modules

Everything below is owned by the **`KernelSU-Modules`** GitHub organization (id `340597895`) and by
org-controlled accounts (Cloudflare, Telegram, domain). No personal account should be the only owner of
anything. Do the steps in order; section 11 is the condensed first-run checklist.

Contents: 1 Inventory · 2 Prerequisites · 3 Repositories · 4 GitHub Apps · 5 Secrets · 6 Cloudflare Pages ·
7 Portal (Pages) + cron Worker · 8 DNS · 9 Telegram bot · 10 tgcloud · 11 First-run checklist · 12 Technical validation ·
13 Key rotation · 14 Operations

---

## 1. Inventory

| Thing | Name / value | Where |
| --- | --- | --- |
| Tools repo (public) | `KernelSU-Modules/tools` | GitHub |
| Data repo (public, bot-only writes) | `KernelSU-Modules/repo` | GitHub |
| Public App | **KernelSU Modules**, slug `kernelsu-modules` | GitHub org → Settings → Developer settings → GitHub Apps |
| Private App | **KernelSU Modules Bot**, slug `kernelsu-modules-bot` | same |
| Static site | Pages project `kernelsu-modules-repo` (Direct Upload), `https://modules.kernelsu.org` | Cloudflare |
| Portal / API | Pages project `kernelsu-developer-portal` (Direct Upload, SPA + Pages Functions), `https://developers.kernelsu.org` (Workers **Free** limits) | Cloudflare |
| Scheduled jobs | Worker `kernelsu-developer-portal-cron` (Cron Triggers only, no routes, no workers.dev URL) | Cloudflare |
| Review bot | Telegram bot **@ksudevbot** ("KernelSU Developer Bot") + Telegram Serverless forwarder (`tgcloud/`) | BotFather |
| Review group | private Telegram supergroup "KernelSU Modules Review", bot in privacy mode | Telegram |

Secrets and where each one lives:

| Secret | Created in | GitHub Actions secret (repo `tools`, Environment `production`) | Portal secret (Pages `kernelsu-developer-portal`) | Cron secret (Worker `kernelsu-developer-portal-cron`) | Offline backup |
| --- | --- | :-: | :-: | :-: | :-: |
| Modules App ID | App settings | `MODULES_APP_ID` | `MODULES_APP_ID` | — | yes |
| Modules App private key (PKCS#1 PEM as downloaded) | App settings → Private keys | `MODULES_APP_PRIVATE_KEY` | `MODULES_APP_PRIVATE_KEY` | — | yes |
| Modules App client ID | App settings | — | `MODULES_APP_CLIENT_ID` | — | yes |
| Modules App client secret | App settings → Client secrets | — | `MODULES_APP_CLIENT_SECRET` | — | yes |
| Modules App webhook secret | App settings → Webhook | — | `MODULES_APP_WEBHOOK_SECRET` | — | yes |
| Bot App ID | App settings | `BOT_APP_ID` | `BOT_APP_ID` | `BOT_APP_ID` | yes |
| Bot App private key (PKCS#1 PEM) | App settings → Private keys | `BOT_APP_PRIVATE_KEY` | `BOT_APP_PRIVATE_KEY` | `BOT_APP_PRIVATE_KEY` | yes |
| Session key (base64, 32 bytes) | `openssl rand -base64 32` | — | `SESSION_KEY` | — | no (rotating it only logs everyone out) |
| Telegram bot token | BotFather | — | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` | yes |
| Forward secret (tgcloud → Portal) | `openssl rand -hex 32` | `TG_FORWARD_SECRET` | `TG_FORWARD_SECRET` | — | no |
| Telegram webhook secret (fallback only) | `openssl rand -hex 32` | — | `TELEGRAM_WEBHOOK_SECRET` | — | no |
| tgcloud CLI token (`app<id>:<secret>`) | BotFather → Serverless → CLI Access | `TGCLOUD_TOKEN` | — | — | yes |
| Cloudflare API token for CI (Pages + Worker deploy) | Cloudflare → API Tokens | `CLOUDFLARE_API_TOKEN` | — | — | no (re-issue) |
| Cloudflare account ID | Cloudflare dashboard | `CLOUDFLARE_ACCOUNT_ID` | — | `CF_ACCOUNT_ID` | — |
| Cloudflare API token for pruning Pages deployments | Cloudflare → API Tokens | — | — | `CF_API_TOKEN` | no |

Our code accepts the App private keys **exactly as GitHub downloads them** (`-----BEGIN RSA PRIVATE KEY-----`,
PKCS#1); no conversion to PKCS#8 is needed. Literal `\n` sequences are also accepted if a secret store
flattens newlines.

Non-secret vars (CONTRACTS.md, section 7): Portal in `worker/wrangler.toml` (a Pages config: `DATA_REPO`, `TOOLS_REPO`,
`SYNC_WORKFLOW`, `PORTAL_URL`, `SITE_URL`, `MODULES_APP_SLUG`, `TELEGRAM_CHAT_ID`); cron Worker in
`worker/cron/wrangler.toml` (`DATA_REPO`, `TOOLS_REPO`, `SYNC_WORKFLOW`, `PORTAL_URL`,
`PAGES_PROJECTS=kernelsu-modules-repo,kernelsu-developer-portal`, `TELEGRAM_CHAT_ID`). Both are deployed from these files, so they
are the source of truth (dashboard edits of vars are overwritten) — except deployment-specific values, which are
**GitHub variables injected at deploy time** (never committed):

| GitHub variable | Scope | Used by |
| --- | --- | --- |
| `TELEGRAM_CHAT_ID` (e.g. `-1001234567890`) | Environment `production` | `portal-deploy.yml` patches the `TELEGRAM_CHAT_ID = ""` placeholder line of `worker/wrangler.toml` (Pages has no `--var`) and deploys `kernelsu-developer-portal-cron` with `--var TELEGRAM_CHAT_ID:<id>`. The job **fails** if it is unset or not numeric. |
| `PORTAL_URL`, `SITE_URL` (optional, https origins) | repository | Override the public origins in `portal-deploy.yml` (patches both wrangler configs), `sync-build-deploy.yml` (`--base-url` / `--portal-url`) and `tgcloud-deploy.yml`. Use the `*.pages.dev` hosts until DNS is live (then also point the Modules App callback and webhook URLs there); delete the variables afterwards. |
| `DEPLOY_PAUSED` (`true`/`false`) | repository | `sync-build-deploy.yml`: `true` = sync (+ lock/status commit, Check Runs) still runs, build + Pages deploy are skipped (section 14 rollback). |

Data files the Portal and `kernelsu-developer-portal-cron` read (CONTRACTS.md, sections 5–7): records, `policy.yaml`, `maintainers.yaml`,
`banned.yaml`, and **`status.json`** — a compact per-module sync summary (health, installation, last success,
stable version, max versionCode, validation result of an open request's source) that `tools/sync` writes in the
same commit as `sources.lock.json`. Neither the Portal nor the cron Worker parses the (large) lock; a missing
`status.json` is treated as empty.

## 2. Prerequisites

- Org owner on `KernelSU-Modules`; member of the org's Cloudflare account with Super Administrator;
  a Telegram account that will own the bot (see section 9 about ownership).
- Local tools: `gh` (logged in as an org owner), Node 22, `pnpm` 10 (`corepack enable`), `openssl`, `jq`, `dig`.
- `cd tools && pnpm install` so that `pnpm --filter @kernelsu-modules/worker exec wrangler …` works.
  Wrangler is a pinned devDependency (no global install); `wrangler login` once, or export
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

## 3. Repositories

### 3.1 Tools repo `KernelSU-Modules/tools`

```sh
gh repo create KernelSU-Modules/tools --public --description "KernelSU Modules tools: schema, validator, sync, build, site, Developer Portal"
git -C tools push -u origin main
```

The tools repo holds the code that runs with the production secrets and the Bot App's credentials, so it is
locked down the same way as the data repo, but merges go through reviewed PRs:

1. **Access**: only the maintainers team has Write/Maintain on `tools` (merging a PR needs write access);
   everyone else contributes from forks. Actions → General: "Workflow permissions: Read repository contents"
   (our workflows declare `contents: read` anyway), "Allow GitHub Actions to create and approve pull requests"
   **off**, fork PR workflows from outside collaborators "Require approval for all outside collaborators".
2. **Rulesets** (no bypass actors at all — in particular the **KernelSU Modules Bot App is NOT a bypass
   actor**, although it has Contents: write on this repo; Bot tokens are additionally scoped, section 4):
   ```sh
   for f in docs/setup/rulesets/tools-branches.json docs/setup/rulesets/tools-tags.json; do
     gh api -X POST repos/KernelSU-Modules/tools/rulesets --input "$f"
   done
   gh api repos/KernelSU-Modules/tools/rulesets --jq '.[] | {id, name, enforcement}'
   gh api repos/KernelSU-Modules/tools/rules/branches/main --jq '.[].type'
   #   creation, deletion, non_fast_forward, pull_request, required_status_checks
   ```
   - `tools-branches.json` targets **all branches** (`~ALL`): no branch creation (work from forks), no
     deletion, no force pushes, and every change needs a PR with 1 approving review (last push approved,
     threads resolved) and green `Typecheck & test` + `actionlint` checks (GitHub Actions, integration id 15368).
     Net effect: `main` is the only branch and changes only by a reviewed PR merged by a maintainer.
   - `tools-tags.json` targets **all tags**: no creation, update or deletion. Authors pin
     `actions/module-release` by commit SHA, so no tags are needed. If release tags are ever wanted, add
     `{"actor_type": "OrganizationAdmin", "actor_id": 1, "bypass_mode": "always"}` to the tag ruleset only —
     never the Bot App.
   Verify as an org owner: `git push origin HEAD:refs/heads/test` and a direct push to `main` must both be
   declined ("push declined due to repository rule violations").
3. **Environment `production`** — holds every Actions secret (section 5) and the deploy-time variable
   `TELEGRAM_CHAT_ID`; only workflow runs on `main` can use it, so a run on any other ref (if one ever
   existed) or from a PR gets no secrets. No required reviewers (the sync is dispatched automatically):
   ```sh
   R=KernelSU-Modules/tools
   gh api -X PUT repos/$R/environments/production --input - <<'JSON'
   {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
   JSON
   gh api -X POST repos/$R/environments/production/deployment-branch-policies -f name=main -f type=branch
   gh api repos/$R/environments/production --jq '{name, deployment_branch_policy}'
   ```
   Jobs using it: `sync-build-deploy.yml` (publish), `portal-deploy.yml`, `tgcloud-deploy.yml`. `ci.yml` uses
   no secrets and no environment. Delete any old **repository-level** secrets after moving them
   (`gh secret list -R $R` must be empty; `gh secret list -R $R --env production` lists them).
4. **Variables**: `gh variable set DEPLOY_PAUSED -R $R --body false` (repository) and
   `gh variable set TELEGRAM_CHAT_ID -R $R --env production --body <chat id>` (section 9).

### 3.2 Data repo `KernelSU-Modules/repo`

1. Create it **public** (the audit log is public; workflows check it out without a token):
   ```sh
   gh repo create KernelSU-Modules/repo --public \
     --description "KernelSU Modules data. Written only by the KernelSU Modules Bot - no pull requests." \
     --disable-wiki --disable-issues
   ```
2. Create the initial content: an empty module index. It consists of `policy.yaml`, `maintainers.yaml`,
   `banned.yaml`, an empty `sources.lock.json` and an empty `status.json`; there are no `modules/*.yaml` yet
   (`modules/` may be absent or hold only a `.gitkeep`). The policy values below are `DEFAULT_POLICY` from
   `packages/schema/src/defaults.ts`; list at least one maintainer (GitHub user id from
   `gh api users/<login> --jq .id`; `telegram.id` is added in section 9):
   ```sh
   mkdir -p ../repo/modules && cd ../repo && git init -q && touch modules/.gitkeep
   cat > policy.yaml <<'YAML'
   # Policy. Written only by the KernelSU Modules Bot (Portal admin).
   schemaVersion: 1
   id:
     reservedPrefixes:
       - org.kernelsu.
       - me.weishu.
     reservedIds: [ksu, kernelsu, magisk, apatch, test, example, module]
   limits:
     zipMaxBytes: 104857600
     uncompressedMaxBytes: 536870912
     maxCompressionRatio: 200
     maxEntries: 20000
     modulePropMaxBytes: 65536
     manifestMaxBytes: 65536
     docMaxBytes: 524288
     imageMaxBytes: 5242880
     imagesMaxPerModule: 40
     imagesMaxTotalBytes: 41943040
     imageMaxRedirects: 3
     changelogMaxBytes: 65536
   history:
     keepReleases: 10
   pending:
     expireDays: 30
   YAML
   cat > maintainers.yaml <<'YAML'
   # KernelSU Modules maintainers. Identity = GitHub user id (logins are informational, refreshed on Portal writes).
   # telegram.id is the numeric Telegram user id; only listed ids may use the review buttons and bot commands.
   # Edited through the Portal (Maintainers page), written by the KernelSU Modules Bot.
   maintainers:
     - github:
         id: 583231
         login: octocat
   YAML
   printf '# Banned developers (GitHub user ids). Written only by the KernelSU Modules Bot.\nbanned: []\n' > banned.yaml
   printf '{\n  "modules": {},\n  "schemaVersion": 1\n}\n' > sources.lock.json
   cp sources.lock.json status.json
   cd ../tools
   ```
3. Validate it and push. The very first commit is the only human commit; it carries the `init` trailer:
   ```sh
   pnpm --filter @kernelsu-modules/sync check-data -- --data-dir "$PWD/../repo"   # must report 0 error(s)
   cd ../repo
   git add -A
   git commit -m "Initialize data" -m "Action: init"
   git branch -M main && git remote add origin https://github.com/KernelSU-Modules/repo.git
   git push -u origin main
   ```
   CI (`ci.yml`, job "Validate the data repo against current schemas") runs the same check against
   `KernelSU-Modules/repo@main` on every push and pull request of `tools`.
4. Repository settings:
   - Settings → General: disable Wikis, Issues, Projects, Discussions. Pull requests: if your plan offers
     "Disable pull requests", turn it on; otherwise the ruleset below still prevents any merge.
   - Settings → Actions → General → **Disable actions** (this repo runs no workflows).
5. Rulesets (after the Bot App exists — section 4 — because the bypass actor is the Bot App ID):
   ```sh
   BOT_APP_ID=<id>
   for f in docs/setup/rulesets/repo-branches.json docs/setup/rulesets/repo-tags.json; do
     jq --argjson id "$BOT_APP_ID" '.bypass_actors[0].actor_id = $id' "$f" |
       gh api -X POST repos/KernelSU-Modules/repo/rulesets --input -
   done
   gh api repos/KernelSU-Modules/repo/rulesets --jq '.[] | {id, name, enforcement}'
   ```
   The branch ruleset targets **all branches** and blocks creation, updates (direct pushes and merges),
   deletion and force pushes for everyone, including org owners. The only bypass actor is the
   **KernelSU Modules Bot** App (`actor_type: Integration`, `actor_id` = App ID). Verify:
   ```sh
   # as an org owner — must be rejected:
   git -C ../repo commit --allow-empty -m test && git -C ../repo push   # → "push declined due to repository rule violations"
   git -C ../repo reset --hard HEAD~1
   gh api repos/KernelSU-Modules/repo/rules/branches/main --jq '.[].type'       # creation, update, deletion, non_fast_forward
   ```
   Note: org owners can still edit or delete rulesets; that is an audited org-level action, not a data write.

## 4. GitHub Apps (App Manifest flow)

Both Apps are created **under the organization** from the manifests in `docs/setup/apps/`.

| | KernelSU Modules (`kernelsu-modules.manifest.json`) | KernelSU Modules Bot (`kernelsu-modules-bot.manifest.json`) |
| --- | --- | --- |
| Visibility | **public** (any account can install) | **private** (only this org) |
| Permissions | Metadata: read · Contents: read · Checks: write | Metadata: read · Contents: write · Actions: write |
| Events | `release`, `check_run` (+ `installation`, `installation_repositories`, always delivered to Apps; not selectable) | none |
| Webhook | `https://developers.kernelsu.org/webhooks/github`, active, secret auto-generated | none (no `hook_attributes`) |
| Callback URL | `https://developers.kernelsu.org/auth/callback` | — |
| Request user authorization (OAuth) during installation | **on** (`request_oauth_on_install: true`; disables Setup URL; no `state` on the post-install redirect) | — |
| Installed on | authors' module repos | **only** `tools` and `repo` |

Create each App:

```sh
docs/setup/apps/create-app.sh docs/setup/apps/kernelsu-modules.manifest.json
#   browser: review → "Create GitHub App for KernelSU-Modules"
#   you land on http://localhost:8976/created?code=XXXX&state=YYYY (page does not load: fine; check state matches)
docs/setup/apps/convert.sh XXXX ~/secure/kernelsu-modules-app        # within 1 hour; writes app.json + private-key.pem (0600)
docs/setup/apps/create-app.sh docs/setup/apps/kernelsu-modules-bot.manifest.json
docs/setup/apps/convert.sh YYYY ~/secure/kernelsu-modules-bot
```

`app.json` holds `id`, `slug`, `client_id`, `client_secret`, `webhook_secret`. The conversion returns one
private key; generate a second one later only for rotation (section 13).

After creation, check in the App settings page (`https://github.com/organizations/KernelSU-Modules/settings/apps/<slug>`):

- KernelSU Modules: Homepage `https://modules.kernelsu.org`; "Callback URL" = `https://developers.kernelsu.org/auth/callback`;
  "Request user authorization (OAuth) during installation" = on; Optional features → "User-to-server token expiration"
  opted in (default for new Apps: the button reads **Opt-out**);
  "Enable Device Flow" off (turn on temporarily only for section 12.1); Webhook active with the generated secret;
  Permissions exactly Checks RW, Contents R, Metadata R; events Release + Check run;
  "Where can this GitHub App be installed?" → **Any account**. Upload a logo.
  Permissions must be right the first time: every later permission change has to be re-approved by every installation.
- KernelSU Modules Bot: "Only on this account"; no webhook; Contents RW, Actions RW, Metadata R.
  The App-level permissions apply to both repos it is installed on, so the Portal and `kernelsu-developer-portal-cron` never use an
  unscoped installation token: every token is minted per purpose with `repositories` + `permissions` —
  data reads/writes `{repositories: ["repo"], permissions: {contents: "write"}}` (read-only paths
  `contents: "read"`), workflow dispatch and run queries (Portal status page, the cron health check of the last
  successful sync run) `{repositories: ["tools"], permissions: {actions: "write"}}`. A leaked Portal token
  thus can neither push code to `tools` (also blocked by its rulesets, section 3.1) nor dispatch from the data repo.

Install:

```sh
# Bot App: org Settings → GitHub Apps → KernelSU Modules Bot → Install → "Only select repositories": tools, repo
open https://github.com/apps/kernelsu-modules-bot/installations/new
# Modules App: install on the example module (and later, authors install it on their own repos)
open https://github.com/apps/kernelsu-modules/installations/new
# verify (App JWT needed → use the sync/worker code paths or):
gh api orgs/KernelSU-Modules/installations --jq '.installations[] | {app_slug, repository_selection, id}'
```

## 5. Secrets

GitHub Actions secrets on **`KernelSU-Modules/tools`**, all in the **Environment `production`** (section 3.1 —
create it first; deployment branches: `main` only). Do not create repository-level secrets:

```sh
R=KernelSU-Modules/tools; E="-R $R --env production"
gh secret set MODULES_APP_ID      $E --body "$(jq -r .id ~/secure/kernelsu-modules-app/app.json)"
gh secret set MODULES_APP_PRIVATE_KEY $E < ~/secure/kernelsu-modules-app/private-key.pem
gh secret set BOT_APP_ID          $E --body "$(jq -r .id ~/secure/kernelsu-modules-bot/app.json)"
gh secret set BOT_APP_PRIVATE_KEY $E < ~/secure/kernelsu-modules-bot/private-key.pem
gh secret set CLOUDFLARE_API_TOKEN  $E           # paste CI token (section 6)
gh secret set CLOUDFLARE_ACCOUNT_ID $E --body <account-id>
gh secret set TGCLOUD_TOKEN       $E             # paste app<id>:<secret> (section 10)
gh secret set TG_FORWARD_SECRET   $E --body "$FORWARD_SECRET"   # same value as the Portal secret
gh variable set TELEGRAM_CHAT_ID  $E --body "$CHAT_ID"          # section 9; portal-deploy fails without it
gh variable set DEPLOY_PAUSED -R $R --body false                # repository variable (section 14)
gh secret list $E; gh secret list -R $R                         # the second list must be empty
```

Portal secrets on the **Pages project `kernelsu-developer-portal`** (create the project first, section 7; run from the repo root;
each command reads the value from stdin; secrets apply to the production environment = branch `main`):

```sh
P="pnpm --filter @kernelsu-modules/worker exec wrangler pages secret put --project-name kernelsu-developer-portal"
jq -r .id            ~/secure/kernelsu-modules-app/app.json  | $P MODULES_APP_ID
                                              $P MODULES_APP_PRIVATE_KEY < ~/secure/kernelsu-modules-app/private-key.pem
jq -r .client_id     ~/secure/kernelsu-modules-app/app.json  | $P MODULES_APP_CLIENT_ID
jq -r .client_secret ~/secure/kernelsu-modules-app/app.json  | $P MODULES_APP_CLIENT_SECRET
jq -r .webhook_secret ~/secure/kernelsu-modules-app/app.json | $P MODULES_APP_WEBHOOK_SECRET
jq -r .id            ~/secure/kernelsu-modules-bot/app.json | $P BOT_APP_ID
                                              $P BOT_APP_PRIVATE_KEY < ~/secure/kernelsu-modules-bot/private-key.pem
openssl rand -base64 32                                  | $P SESSION_KEY
printf %s "$TELEGRAM_BOT_TOKEN"                          | $P TELEGRAM_BOT_TOKEN
printf %s "$FORWARD_SECRET"                              | $P TG_FORWARD_SECRET
pnpm --filter @kernelsu-modules/worker exec wrangler pages secret list --project-name kernelsu-developer-portal
```

Cron Worker secrets on **`kernelsu-developer-portal-cron`** (the Worker must exist first: deploy it once via **portal-deploy**, section 7,
or `pnpm --filter @kernelsu-modules/worker cron:deploy`; a fresh Worker just logs failed steps until its secrets exist):

```sh
C="pnpm --filter @kernelsu-modules/worker exec wrangler secret put --config cron/wrangler.toml"
jq -r .id ~/secure/kernelsu-modules-bot/app.json | $C BOT_APP_ID
                                     $C BOT_APP_PRIVATE_KEY < ~/secure/kernelsu-modules-bot/private-key.pem
printf %s "$TELEGRAM_BOT_TOKEN"             | $C TELEGRAM_BOT_TOKEN
printf %s "$CF_PRUNE_TOKEN"                 | $C CF_API_TOKEN
printf %s "$CF_ACCOUNT_ID"                  | $C CF_ACCOUNT_ID
pnpm --filter @kernelsu-modules/worker exec wrangler secret list --config cron/wrangler.toml
```

Generate the shared forward secret once: `FORWARD_SECRET=$(openssl rand -hex 32)`. Store every credential in
the org password manager; then `shred -u` the files under `~/secure/`.

## 6. Cloudflare Pages (static site `kernelsu-modules-repo`)

The project **must be Direct Upload** — a Direct Upload project cannot later be switched to Git integration,
and we never want Cloudflare to build from Git.

```sh
pnpm --filter @kernelsu-modules/build exec wrangler pages project create kernelsu-modules-repo --production-branch main
pnpm --filter @kernelsu-modules/build exec wrangler pages project list
```

- Never connect a Git repository to this project. Deploys only come from `sync-build-deploy.yml`
  (`wrangler pages deploy dist --branch main --commit-hash <buildId>` → production).
- No Pages Functions, no `_worker.js`, no Worker routes on `modules.kernelsu.org`: the public site is served
  from static assets only, so it never consumes Workers quota.
- Custom domain `modules.kernelsu.org`: add it in Pages → Custom domains and create the CNAME (section 8); until it is
  verified the site is served at `https://kernelsu-modules-repo.pages.dev`.
- Retention: the `kernelsu-developer-portal-cron` Worker (hourly + daily) deletes deployments older than 30 days except the latest 5
  production deployments and the current production deployment — for both Pages projects, `kernelsu-modules-repo`
  and `kernelsu-developer-portal` (`PAGES_PROJECTS`; needs `CF_API_TOKEN`, below).

API tokens (Cloudflare → My Profile/Account → API Tokens → Create custom token):

| Token | Permissions | Used by |
| --- | --- | --- |
| CI (`CLOUDFLARE_API_TOKEN`) | Account · Cloudflare Pages · Edit; Account · Workers Scripts · Edit (for `kernelsu-developer-portal-cron`; no zone permissions needed — nothing is routed through a zone) | `sync-build-deploy.yml`, `portal-deploy.yml` |
| Cron runtime (`CF_API_TOKEN` on `kernelsu-developer-portal-cron`) | Account · Cloudflare Pages · Edit | `kernelsu-developer-portal-cron` (list/delete old Pages deployments of both projects) |

Restrict both to the org's account and rotate them (section 13). If `wrangler deploy` reports a missing permission,
add Account · Account Settings · Read to the CI token.

## 7. Portal: Pages project `kernelsu-developer-portal` + cron Worker `kernelsu-developer-portal-cron`

`kernelsu.org` DNS is on Google Cloud DNS (section 8), so a Worker custom domain is impossible. The Portal is therefore a
**Pages project with Pages Functions** (custom domain via an external CNAME), and the scheduled jobs — which Pages
Functions cannot run — live in a tiny separate Worker:

| | `kernelsu-developer-portal` (Pages, Direct Upload) | `kernelsu-developer-portal-cron` (Worker) |
| --- | --- | --- |
| Serves | `portal/dist`: SPA (fallback to `index.html`), `/docs/*`, `_headers` CSP; Functions (`_worker.js`, advanced mode) only for `/api/*`, `/auth/*`, `/webhooks/*`, `/internal/*` (`_routes.json`) | nothing (no fetch handler, no routes, no workers.dev) |
| Config | `worker/wrangler.toml` (`pages_build_output_dir = "../portal/dist"`) | `worker/cron/wrangler.toml` |
| Schedule | — | `17 3 * * *` once a day: dispatch sync (lost-webhook fallback) + sync-health check (Actions API) + expiry + pruning of both Pages projects |

Static asset requests never invoke Functions (free, unmetered). Functions invocations count against the Workers
Free quota (100k/day, 10 ms CPU, 50 subrequests) like a Worker.

1. Create the Pages project (Direct Upload; never connect Git):
   ```sh
   pnpm --filter @kernelsu-modules/worker exec wrangler pages project create kernelsu-developer-portal --production-branch main
   ```
2. Set the Environment variable `TELEGRAM_CHAT_ID` (section 9) on `production` (section 5). Do **not** write it into
   `worker/wrangler.toml` / `worker/cron/wrangler.toml` — they keep an empty placeholder that **portal-deploy**
   fills at deploy time (and the job fails while the variable is unset). Confirm the other vars match section 1.
3. Set the Portal secrets (section 5) with `wrangler pages secret put … --project-name kernelsu-developer-portal`. Pages applies
   secret/var changes only to **new deployments**: after changing one, re-run **portal-deploy**.
4. Deploy: Actions → **portal-deploy** → Run workflow (or push to `main`). It builds `portal/`, bundles the
   Functions entry into `portal/dist/_worker.js` + `_routes.json` (`pnpm --filter @kernelsu-modules/worker build`),
   runs `wrangler pages deploy ../portal/dist --project-name kernelsu-developer-portal --branch main` from `worker/`,
   then `wrangler deploy --config cron/wrangler.toml` for `kernelsu-developer-portal-cron` (both with `TELEGRAM_CHAT_ID` injected from
   the Environment variable). Then set the cron secrets (section 5) once.
5. Custom domain: Pages → `kernelsu-developer-portal` → Custom domains → **Set up a domain** → `developers.kernelsu.org`. Pages shows
   the target; in **Google Cloud DNS** add `developers.kernelsu.org. CNAME kernelsu-developer-portal.pages.dev.`. Pages verifies the CNAME and issues the certificate (minutes to hours).
   Until then test on `https://kernelsu-developer-portal.pages.dev`: static pages and webhooks work there, but `/auth/*` and
   `/api/*` redirect to `PORTAL_URL` (the App callback URL and `__Host-` cookies are bound to the custom domain).
   GitHub App callback URL (`https://developers.kernelsu.org/auth/callback`) and webhook URL
   (`https://developers.kernelsu.org/webhooks/github`) are **unchanged**.
6. Smoke test:
   ```sh
   curl -sS https://developers.kernelsu.org/api/me | jq .        # {"user":null,...}
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://developers.kernelsu.org/webhooks/github   # 401 (bad signature); 503 = MODULES_APP_WEBHOOK_SECRET missing
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://developers.kernelsu.org/internal/telegram # 401; 503 = TG_FORWARD_SECRET missing
   curl -sSI https://developers.kernelsu.org/modules | grep -iE 'content-security-policy|strict-transport-security'  # SPA fallback + _headers (CSP, HSTS)
   ```
   GitHub → App settings → Advanced → Recent deliveries: the `ping` delivery should be 2xx after "Redeliver".
7. Cron triggers are declared in `worker/cron/wrangler.toml`; check them under Workers → `kernelsu-developer-portal-cron` → Settings →
   Triggers, and the runs under Workers → `kernelsu-developer-portal-cron` → Logs (each run logs a JSON summary).

Pages Functions caveats this setup relies on:
- **Cache API** (`caches.default`) only stores on the custom domain; on `*.pages.dev` (and in `kernelsu-developer-portal-cron`) it is a
  no-op. All caches (data snapshot, installation tokens, repo lists) and the per-module "Sync now" rate limit
  fall back to per-isolate memory there — correct, just less effective.
- The cron runs once a day, so it sends at most one alert of each kind per day.
- **Sync health** comes from the Actions API, not from the data repo (the sync writes no timestamp-only
  heartbeat commits): if the last **successful** run of `SYNC_WORKFLOW` on `TOOLS_REPO` is older than 26 h,
  `kernelsu-developer-portal-cron` alerts the maintainers chat.
- **Fail closed on missing secrets**: `/webhooks/github` answers 503 when `MODULES_APP_WEBHOOK_SECRET` is not
  set (GitHub retries/redelivers), `/internal/telegram` 503 without `TG_FORWARD_SECRET`.
- `portal/public/_headers` sends `Strict-Transport-Security` (HSTS) besides the CSP for static responses.
- `_headers` only applies to static responses; Functions responses set their own CSP (`worker/src/app.ts`).
- Pages only does the SPA fallback when `portal/dist/404.html` does not exist (the build script checks).
- Optional hardening: an account-level Bulk Redirect `kernelsu-developer-portal.pages.dev/*` → `https://developers.kernelsu.org/$1`.

## 8. DNS

Check where `kernelsu.org` is hosted and what the two hostnames point to:

```sh
dig +short NS kernelsu.org                    # Cloudflare zones answer *.ns.cloudflare.com
dig +short CNAME modules.kernelsu.org         # target: kernelsu-modules-repo.pages.dev
dig +short CNAME developers.kernelsu.org      # target: kernelsu-developer-portal.pages.dev
whois kernelsu.org | grep -i 'name server'
```

Observed on 2026-10-10 (from a workstation whose resolver may be proxied — re-check): NS =
`ns-cloud-d{1..4}.googledomains.com` (Google Cloud DNS), i.e. **not Cloudflare**. Consequences:

- Pages custom domain `modules.kernelsu.org` works with an external DNS: add the domain in Pages,
  then set `modules CNAME kernelsu-modules-repo.pages.dev` at the current DNS provider (Pages shows the exact
  target and verifies it).
- Worker custom domains and routes would require the zone on Cloudflare. **Decision:** keep DNS on Google Cloud
  DNS; the Portal is a Pages project (`kernelsu-developer-portal`, section 7), so `developers CNAME kernelsu-developer-portal.pages.dev` works the same
  way as the site. The cron Worker `kernelsu-developer-portal-cron` needs no hostname at all.

## 9. Telegram bot and review group

Bots belong to a Telegram user. Use an org-controlled Telegram account (or create with a maintainer account and
later use BotFather → Bot Settings → **Transfer Ownership** to the org account); record who holds it.

1. **Create**: BotFather → `/newbot` → name "KernelSU Developer Bot", username `ksudevbot`. Save the token
   as `TELEGRAM_BOT_TOKEN`.
2. **Privacy mode on**: `/setprivacy` → select the bot → **Enable** (the default). The bot then only receives
   commands addressed to it and its own button callbacks — use `/suspend@ksudevbot <id> <reason>` and `/whoami@ksudevbot`.
3. `/setcommands` → select the bot → send:
   ```
   suspend - Suspend a module: /suspend <id> <reason>
   whoami - Show your Telegram user id
   ```
4. **Group**: create a private group "KernelSU Modules Review", add the maintainers and the bot. Make it a
   supergroup before reading its id (e.g. Group settings → Chat history for new members → Visible), because the
   id changes on upgrade. Then `/setjoingroups` → **Disable** so nobody can add the bot elsewhere.
5. **Get the chat id and maintainers' user ids — before enabling Serverless** (afterwards the platform owns the
   webhook and `getUpdates` is unavailable):
   ```sh
   T=$TELEGRAM_BOT_TOKEN
   curl -s "https://api.telegram.org/bot$T/getWebhookInfo" | jq .result.url      # must be "" for getUpdates
   # in the group, every maintainer sends: /start@ksudevbot
   curl -s "https://api.telegram.org/bot$T/getUpdates" |
     jq '.result[].message | {chat_id: .chat.id, chat_type: .chat.type, from_id: .from.id, who: (.from.username // .from.first_name)}'
   ```
   The supergroup id looks like `-100…`. Store it as the GitHub Environment variable `TELEGRAM_CHAT_ID`
   (`production`, section 5); portal-deploy injects it into both the Portal and `kernelsu-developer-portal-cron`. Put each maintainer's
   numeric `from_id` into `maintainers.yaml` (`telegram.id`) via the Portal (Maintainers page → click the maintainer), or,
   before launch, in the initial data commit. Telegram usernames are not used. Once the bot is live (section 10),
   maintainers get their id without `getUpdates`: send `/whoami@ksudevbot` in the review group and the bot replies
   with the numeric id and whether it is bound.
6. Test that the bot can post: `curl -s "https://api.telegram.org/bot$T/sendMessage" -d chat_id=$CHAT -d text=hello`.

## 10. Telegram Serverless (tgcloud)

Details and all assumptions: [`tgcloud/README.md`](../../tgcloud/README.md).

1. BotFather → your bot → **Serverless** → enable. Then **CLI Access → Access token** → copy `app<id>:<secret>`
   → GitHub secret `TGCLOUD_TOKEN`.
2. Make sure `TG_FORWARD_SECRET` has the same value in GitHub secrets and in the Portal (Pages secret).
3. Actions → **tgcloud-deploy** → Run workflow. Expect the webhook status to say "in sync", allowed updates
   `callback_query, message`.
4. End-to-end: submit the example module in the Portal → a review message with buttons appears in the group →
   press **Approve** as a maintainer → toast text from the Portal, message edited, record `listed`. Press a
   button from a non-maintainer account → "Not authorized", no commit in the data repo. Send `/whoami@ksudevbot`
   in the group → the bot replies with your numeric Telegram user id and "Bound to maintainer @…".
5. Fallback to direct Worker webhook: see `tgcloud/README.md` → "Fallback".

## 11. First-run checklist

1. [ ] section 12 technical validation items 5 (DNS) and 6 (tgcloud) answered; DNS decision taken.
2. [ ] Cloudflare account owned by the org; Pages project `kernelsu-modules-repo` created (Direct Upload); API tokens issued.
3. [ ] Tools repo (`KernelSU-Modules/tools`) pushed; CI green; maintainers-only write access, rulesets (`tools-branches.json`,
       `tools-tags.json`, no bypass actors) applied and verified; Environment `production` (branch `main`
       only) created; variable `DEPLOY_PAUSED=false` (section 3.1).
4. [ ] Empty data repo content created and validated locally (section 3.2 steps 2–3):
       ```sh
       pnpm --filter @kernelsu-modules/sync check-data -- --data-dir "$PWD/../repo"
       ```
5. [ ] Both Apps created (section 4); Bot App installed on `tools` + `repo` only.
6. [ ] Data repo (`KernelSU-Modules/repo`) created, initial commit pushed, features disabled, rulesets applied with the Bot App ID and verified (section 3.2).
7. [ ] GitHub Actions secrets + `TELEGRAM_CHAT_ID` set in Environment `production`; no repository-level secrets (section 5).
8. [ ] Telegram bot, privacy mode, group, chat id, maintainer ids (section 9); maintainers' `telegram.id` filled.
9. [ ] Pages project `kernelsu-developer-portal` + Worker `kernelsu-developer-portal-cron`: vars + secrets set, deployed, `developers` CNAME live, smoke tests pass (section 7).
10. [ ] App webhook "ping" redelivered → 2xx.
11. [ ] tgcloud deployed, webhook in sync (section 10).
12. [ ] Actions → **sync-build-deploy** → Run (reason `first-run`): sync report artifact uploaded, build OK,
        deployment visible at `https://kernelsu-modules-repo.pages.dev`. Run it again: deploy is skipped (same buildId).
13. [ ] Within 15 minutes `kernelsu-developer-portal-cron` dispatches a run by itself (Actions → sync-build-deploy, event `workflow_dispatch`, actor = the Bot App).
14. [ ] Example module: install the Modules App, publish an immutable release → Check Run "KernelSU Modules" appears on the tag commit; submit + approve via Telegram → module listed on the site.

## 12. Technical validation

| # | Question | How to verify | Status |
| --- | --- | --- | --- |
| 1 | Can a user token read `permissions.admin` of a repo? | below | open |
| 2 | Do assets uploaded before June 2025 have `digest`? | below | **answered: no** (`digest: null`) |
| 3 | After transferring an org repo to a person, are its releases still immutable? | below | open |
| 4 | Can the Worker sign an RS256 App JWT within 10 ms CPU? | below | open |
| 5 | Is `kernelsu.org` DNS on Cloudflare? | section 8 | **observed: no** (Google Cloud DNS) — confirm |
| 6 | Telegram Serverless: secrets, WebCrypto, quotas/pricing, Bot API with token while enabled | below | partly answered |

**12.1 `permissions.admin` with a user token.** Temporarily enable "Device Flow" on the Modules App, then:

```sh
CID=$(jq -r .client_id ~/secure/kernelsu-modules-app/app.json)
curl -s -X POST https://github.com/login/device/code -d client_id=$CID -H 'Accept: application/json' | tee /tmp/dc.json
# open verification_uri, enter user_code, then:
curl -s -X POST https://github.com/login/oauth/access_token -H 'Accept: application/json' \
  -d client_id=$CID -d device_code=$(jq -r .device_code /tmp/dc.json) \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code | jq -r .access_token > /tmp/ghu
GH_TOKEN=$(cat /tmp/ghu) gh api user/installations --jq '.installations[] | {id, account: .account.login}'
GH_TOKEN=$(cat /tmp/ghu) gh api user/installations/<installation-id>/repositories --jq '.repositories[] | {full_name, admin: .permissions.admin}'
GH_TOKEN=$(cat /tmp/ghu) gh api repos/<owner>/<repo> --jq .permissions
```

Test with (a) your own repo (expect `admin: true`), (b) a repo where you are only a `write` collaborator
(expect `false`). Disable Device Flow afterwards and `rm /tmp/ghu /tmp/dc.json`.

**12.2 Digests on old assets.** Checked 2026-10-10 with public read-only calls:

```sh
gh api 'repos/osm0sis/PlayIntegrityFork/releases?per_page=100' --jq '.[] | .assets[] | {created_at, digest}' | tail -2
#   2023-12-02 asset → "digest": null ; 2026-08-29 asset → "sha256:…"
gh api 'repos/5ec1cff/TrickyStore/releases?per_page=100' --jq '.[] | .assets[] | {created_at, digest}' | tail -2
#   2024-07-16 asset → null
```

Result: pre-June-2025 assets have no `digest` → sync must rely on its own sha256 (it does; `digest` is
stored only when present). Also noted: these upstream releases have `immutable: false` — authors must enable
release immutability and publish a **new** release before submitting.

**12.3 Immutability after transfer.** In a scratch org repo: Settings → enable release immutability → publish
a release with an asset → transfer the repo to a personal account → check:

```sh
gh api repos/KernelSU-Modules/transfer-test/releases --jq '.[] | {tag_name, immutable}'          # before
gh api -X POST repos/KernelSU-Modules/transfer-test/transfer -f new_owner=<user>
gh api repos/<user>/transfer-test/releases --jq '.[] | {tag_name, immutable}'                     # after
gh api repos/<user>/transfer-test/releases/latest --jq '.assets[0] | {name, digest}'
```

If `immutable` becomes `false`, authors who transfer their module repository must publish a new release after
the transfer; document that in the developer FAQ.

**12.4 RS256 JWT CPU time on Workers Free.** Deploy the Portal, trigger ~50 App-authenticated requests
(e.g. "Sync now" in the Portal, or webhook redeliveries), then query CPU percentiles:

```sh
curl -s https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $CF_ANALYTICS_TOKEN" -d @- <<EOF | jq .
{"query":"{ viewer { accounts(filter:{accountTag:\"$CF_ACCOUNT_ID\"}) { workersInvocationsAdaptive(limit:10, filter:{scriptName:\"kernelsu-developer-portal\", datetime_gt:\"$(date -u -d '-1 hour' +%FT%TZ)\"}) { sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { status } } } } }"}
EOF
```

(token needs Account Analytics: Read). `cpuTimeP99` is in microseconds; > 10000 or any `exceededCpu` status
→ move to Workers Paid. Pages Functions may be reported under an internal script name — if the filter returns
nothing, drop `scriptName` and look at the `dimensions`, or use Pages → kernelsu-developer-portal → Functions → Metrics (CPU time).
Installation tokens are cached by the Portal, so most requests should not sign a JWT at all.

**12.5 DNS.** See section 8.

**12.6 Telegram Serverless.** Already answered from the official docs and the CLI source (details in
`tgcloud/README.md`): no documented secrets mechanism (we inject at deploy time); outbound HTTP via `sdk.fetch`;
CI auth via `TGCLOUD_TOKEN`. Still to probe on the real platform — `tgcloud run` executes a local module
**without deploying it**:

```sh
cd tgcloud && npm ci --ignore-scripts && export TGCLOUD_TOKEN=app…:…
mkdir -p tgcloud/endpoints && cat > tgcloud/endpoints/probe.js <<'EOF'
export default async function () {
  const t0 = Date.now();
  let subtleOk = false;
  try {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('k'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    subtleOk = (await crypto.subtle.sign('HMAC', k, new Uint8Array(1))).byteLength === 32;
  } catch {}
  return { subtle: typeof crypto !== 'undefined' && !!crypto.subtle, subtleOk, textEncoder: typeof TextEncoder,
           setTimeout: typeof setTimeout, ms: Date.now() - t0 };
}
EOF
npx tgcloud run endpoints/probe '{}' --ctx '{ initData: { user: { id: 1 } } }'
rm -r tgcloud/endpoints            # never push the probe
# Bot API with the raw token while Serverless is enabled:
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe" | jq .ok
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -d chat_id=$CHAT -d text=probe | jq .ok
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo" | jq .result.url   # the tgcloud-managed URL (do NOT change it)
```

Quotas/pricing: look in BotFather → bot → Serverless; record what is shown. Latency: time 10 button presses
(Portal Functions logs — `wrangler pages deployment tail --project-name kernelsu-developer-portal` — show the forwarded request; the toast should appear in < 3 s).

## 13. Key rotation

Do one secret at a time; after each, run the matching smoke test. Record the date in the password manager.

| Secret | Procedure | Downtime |
| --- | --- | --- |
| App private key (either App) | App settings → Private keys → **Generate** (now two keys valid) → update GitHub (Environment `production`) secret + Portal/cron secrets (section 5) + re-run **portal-deploy** → run sync-build-deploy and a Portal login → **Delete** the old key | none |
| Modules App webhook secret | App settings → Webhook secret → save new value **and immediately** `wrangler pages secret put MODULES_APP_WEBHOOK_SECRET --project-name kernelsu-developer-portal` + re-run **portal-deploy** → Advanced → Redeliver any failed deliveries | seconds (redeliver) |
| Modules App client secret | App settings → Client secrets → Generate new → `wrangler pages secret put MODULES_APP_CLIENT_SECRET …` + re-run **portal-deploy** → test login → delete old | none |
| `SESSION_KEY` | `openssl rand -base64 32 \| wrangler pages secret put SESSION_KEY …` + re-run **portal-deploy** | everyone is logged out |
| `TG_FORWARD_SECRET` | new value → Portal secret (+ re-run **portal-deploy**) **and** GitHub secret → run **tgcloud-deploy** | buttons answer "Service unavailable" between the two steps (≈1 min) |
| Telegram bot token | BotFather → `/revoke` → `TELEGRAM_BOT_TOKEN` on the Portal (+ **portal-deploy**) and on `kernelsu-developer-portal-cron`; then check `tgcloud webhook` (re-sync with `npx tgcloud webhook sync` if needed) | sends/edits fail until updated |
| `TGCLOUD_TOKEN` | BotFather → Serverless → CLI Access → regenerate → GitHub secret | none |
| Cloudflare API tokens | Cloudflare → API Tokens → Roll → update GitHub secret / `kernelsu-developer-portal-cron` secret | none |
| `TELEGRAM_WEBHOOK_SECRET` (fallback mode only) | new value → Portal secret + **portal-deploy** → `setWebhook … secret_token=<new>` | seconds |

After a suspected leak of an App key: delete the key first (stops the attacker), then generate a new one.

## 14. Operations

- **Manual sync / redeploy**: `gh workflow run sync-build-deploy.yml -R KernelSU-Modules/tools -f reason=manual [-f module=<id>] [-f force_deploy=true]`.
- **Portal down**: public site and clients are unaffected; dispatch syncs manually as above; review in the Portal once back.
- **Telegram bot down**: review in the Portal (`/admin`).
- **Rollback the site** (bad build, broken builder, malicious content that slipped through):
  1. **Pause deploys** so the next dispatched run (every webhook and the daily cron dispatch one) does not
     redeploy over the rollback: `gh variable set DEPLOY_PAUSED -R KernelSU-Modules/tools --body true`.
     Sync keeps running (lock/status commits, Check Runs, author feedback); build + deploy are skipped and each
     run's summary says "Deploy paused".
  2. **Roll back Pages**: Cloudflare → Pages → `kernelsu-modules-repo` → Deployments → pick an older production
     deployment → ⋯ → **Rollback**. API equivalent:
     ```sh
     A=$CLOUDFLARE_ACCOUNT_ID; P=kernelsu-modules-repo
     curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$A/pages/projects/$P/deployments?env=production&per_page=10" |
       jq -r '.result[] | [.id, .created_on, .deployment_trigger.metadata.commit_hash] | @tsv'   # commit_hash = buildId
     curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$A/pages/projects/$P/deployments/<id>/rollback" | jq .success
     ```
     Pruning never deletes the current production (canonical) deployment, and keeps the newest 5 production + 30 days.
  3. Fix the cause (revert in `tools` via PR, suspend a module, fix data), then **unpause**
     (`--body false`) and run `gh workflow run sync-build-deploy.yml -R KernelSU-Modules/tools -f reason=unpause -f force_deploy=true`.
- **Rollback the Portal**: Cloudflare → Pages → `kernelsu-developer-portal` → Deployments → **Rollback** (static SPA and
  Functions roll back together); cron Worker: `pnpm --filter @kernelsu-modules/worker exec wrangler rollback --config cron/wrangler.toml`.
  Then revert the offending commit on `main` via PR (portal-deploy redeploys on merge). `DEPLOY_PAUSED` does
  not affect portal-deploy.
- **Who wrote what**: `git -C ../repo log --format='%h %an %s%n%(trailers)'`.
- **Malicious module**: `/suspend@ksudevbot <id> <reason>` or Portal → Suspend; the next run removes it from the index; also delete older Pages deployments that still contain it.
