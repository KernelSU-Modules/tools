# tgcloud — Telegram review-bot forwarder

The Telegram review bot (`@ksudevbot`, "KernelSU Developer Bot") runs on [Telegram Serverless](https://core.telegram.org/bots/serverless) as a
**thin, stateless forwarder** (interface: CONTRACTS.md, section 8). It holds no GitHub credentials, keeps no
state and makes no decisions. Everything (authorization against `maintainers.yaml`, state checks, data
writes, editing the review message) happens in the Portal Worker.

```
button press ─▶ handlers/callback_query.js
                  │ body = UTF-8(JSON.stringify(ctx.update))      (serialized once)
                  │ X-KernelSU-Signature: sha256=hex(HMAC-SHA256(TG_FORWARD_SECRET, body))
                  ▼
                POST https://developers.kernelsu.org/internal/telegram
                  ◀ 200 {"answer": {"text": "...", "show_alert": false}}
                  ▼
                api.answerCallbackQuery({callback_query_id, ...answer})
                (any failure → "Service unavailable, use the Portal";
                 no reply within 8 s → "Still processing. If the message does not update shortly, use the Portal.")

"/suspend <id> <reason>" ─▶ handlers/message.js ─▶ same POST; the Worker replies via the Bot API.
                             Any other message is ignored. On failure the bot replies with the fallback text.
```

Only `callback_data` starting with `v1:` is forwarded; anything else is answered with
"This button is no longer supported." without contacting the Worker.

## Layout

| Path | Deployed | Purpose |
| --- | --- | --- |
| `tgcloud.jsonc` | config | Project config (no Mini App → no `static` block) |
| `tgcloud/handlers/callback_query.js` | yes | Button handler |
| `tgcloud/handlers/message.js` | yes | `/suspend` command handler |
| `tgcloud/lib/forward.js` | yes | Forwarding logic (pure, dependency-injected, unit-tested) |
| `tgcloud/lib/hmac.js` | yes | HMAC-SHA256: `crypto.subtle` if present, else pure-JS SHA-256 |
| `tgcloud/lib/config.js` | yes | Portal URL default, path, timeout |
| `tgcloud/lib/env.js` | yes, **generated, git-ignored** | `FORWARD_SECRET`, `PORTAL_URL` (see "Secrets") |
| `tgcloud/schema.js` | yes | Empty (no tables) |
| `scripts/gen-env.mjs` | no | Writes `tgcloud/lib/env.js` from `TG_FORWARD_SECRET` / `PORTAL_URL` |
| `test/` | no | Node harness: fakes `sdk` and `lib/env.js`, runs the real handlers |
| `package.json`, `package-lock.json` | no | Pins `@tgcloud/cli@0.2.0` (+ transitive deps with integrity hashes) for CI |

This directory is **not** a pnpm workspace member: the platform forbids npm packages at runtime and the
CLI is installed with `npm ci` from its own lockfile.

> **Do not use `npx tgcloud@…`.** The unscoped npm package `tgcloud` is an unrelated third-party
> package. The official CLI is `@tgcloud/cli` (binary `tgcloud`).

## Test locally

```sh
cd tgcloud
node --import ./test/register.mjs --test "test/*.test.mjs"        # or: npm test
# against a local Worker (wrangler dev) using the real handler code; Bot API calls are printed:
TG_FORWARD_SECRET=<same as worker .dev.vars> PORTAL_URL=http://127.0.0.1:8787 \
  node --import ./test/register.mjs test/simulate.mjs v1:ap:abcdefghij <telegram-user-id>
```

The tests check the pure-JS and WebCrypto HMAC against `node:crypto`, the exact signed bytes, the
fallback texts (HTTP error, network error, timeout), unknown `callback_data`, 200-char clamping, and the
`/suspend` filter. HMAC interop with `verifySha256Signature` from `@kernelsu-modules/github` was checked too.

## Deploy

CI: `.github/workflows/tgcloud-deploy.yml` (manual, or on push to `main` touching `tgcloud/**`):
`npm ci --ignore-scripts` → tests → `scripts/gen-env.mjs` → `npx --no-install tgcloud push --force` →
`tgcloud webhook` status.

Manual (from a maintainer machine):

```sh
cd tgcloud
npm ci --ignore-scripts
npx tgcloud login                     # paste the CLI token: BotFather → your bot → Serverless → CLI Access
TG_FORWARD_SECRET=... node scripts/gen-env.mjs
npx tgcloud status && npx tgcloud push
npx tgcloud webhook                   # must say "in sync"; allowed updates: callback_query, message
rm tgcloud/lib/env.js
```

Why `--force` in CI: the CLI stores the last known cloud revision in `.tgcloud/state.json`. A fresh CI
checkout has no state, and the CLI refuses to push to a bot that already has modules unless `--force` is
given (verified in `@tgcloud/cli@0.2.0` `src/commands/deploy.js`). Git is the source of truth for this code,
so overwriting is intended. A full push also deletes cloud modules that are absent locally.

## Secrets

Telegram Serverless documents **no secrets / environment mechanism** for runtime code (verified against
the official page and the SDK reference shipped in `@tgcloud/cli@0.2.0`). Chosen workaround:

- `scripts/gen-env.mjs` writes `tgcloud/lib/env.js` with the forward secret **at deploy time** from the
  `TG_FORWARD_SECRET` GitHub Actions secret (Environment `production` of `KernelSU-Modules/tools`, usable only by
  workflows running on `main`). The file is git-ignored and deleted after the CI push.
- The secret therefore lives inside the deployed module. Anyone holding the bot's tgcloud CLI token can
  read it back (`tgcloud pull`). That is the same trust boundary as the bot itself — whoever has that token
  can already change what the bot does — so it is acceptable for this design. The secret only lets a
  caller submit a Telegram Update to the Worker; the Worker still authorizes `from.id` against
  `maintainers.yaml`, so a leaked forward secret alone lets an attacker impersonate a maintainer's button
  press **only if** they also know a maintainer's Telegram user id. Rotate it if in doubt
  (docs/setup/README.md, "Key rotation").
- Alternative that was not chosen: store the secret in the bot's SQLite DB and seed it with
  `npx tgcloud run …`. That needs a runnable seeding module (handlers/ or endpoints/ only), which would
  otherwise be deployed and reachable; build-time injection is simpler.

`PORTAL_URL` (default `https://developers.kernelsu.org`) can be overridden at generation time for a
staging Worker.

## Fallback: direct webhook to the Worker

If Telegram Serverless proves unsuitable (quota, latency, missing APIs), point Telegram straight at the
Worker. Bot logic does not change; the Worker's optional `POST /webhooks/telegram` validates
`X-Telegram-Bot-Api-Secret-Token` instead of `X-KernelSU-Signature`:

```sh
SECRET=$(openssl rand -hex 32)                       # also: wrangler pages secret put TELEGRAM_WEBHOOK_SECRET --project-name kernelsu-developer-portal (+ redeploy)
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url=https://developers.kernelsu.org/webhooks/telegram \
  -d secret_token="$SECRET" \
  -d 'allowed_updates=["callback_query","message"]' -d drop_pending_updates=true
```

Then disable `tgcloud-deploy.yml` (a later `tgcloud push` / `tgcloud webhook sync` re-points the webhook
at Telegram Serverless) and, if possible, turn Serverless off in BotFather. To switch back:
`npx tgcloud webhook sync`.

## Verified vs assumed

Verified (official page https://core.telegram.org/bots/serverless and `@tgcloud/cli@0.2.0` sources/templates, 2026-10-10):

- Handlers are the default export of `tgcloud/handlers/<update_type>.js`, called as `(payload, ctx)`;
  `ctx.update` is the raw Update. The webhook and its `allowed_updates` are managed by the platform from the
  deployed handler files.
- Runtime is a V8 isolate; only `sdk` (`api`, `fetch`, `db`, …) and project modules can be imported; no npm,
  no filesystem, no `Buffer`. Relative imports must end in `.js` and stay inside `tgcloud/`.
- `fetch` from `sdk` is web-like (`ok`, `status`, `text()`, `json()`), accepts `Uint8Array` bodies, follows
  redirects, rejects only on network errors.
- `api.<method>(params)` calls any Bot API method with snake_case params, returns the unwrapped result,
  throws `BotApiError` (`.code`, `.description`) on failure.
- CLI: package `@tgcloud/cli`, token order `TGCLOUD_TOKEN` env → `.tgcloud/credentials`; token format
  `app<id>:<secret>`, obtained in BotFather → bot → Serverless → CLI Access. `push` is atomic, guarded by a
  revision number, non-interactive outside a TTY; commands exit non-zero on failure.
- `npx tgcloud run <module>` executes a local handler/endpoint **on the platform without deploying** —
  useful for the runtime probes below.

Assumed / unverified (check during technical validation, docs/setup/README.md, section 12):

- **[ASSUMED]** `crypto.subtle` and `TextEncoder` may or may not exist in the isolate — not documented.
  Code feature-detects both and falls back to pure JS, so either way works.
- **[ASSUMED]** `setTimeout` exists (used only for the 8 s forward timeout; skipped if absent).
- **[ASSUMED]** The handler's own wall-clock/CPU budget is enough for one outbound HTTPS round trip to the
  Worker plus `answerCallbackQuery` (limits are not published).
- **[ASSUMED]** `sdk.fetch` sends a `Uint8Array` body byte-for-byte and keeps our `Content-Type` header. The
  Worker must verify the HMAC over the raw received bytes and must not depend on `Content-Type`.
- **[ASSUMED]** An empty `tgcloud/schema.js` and an empty `tgcloud.jsonc` (`{}`) are accepted by `push`.
- **[ASSUMED]** With Serverless enabled, the Worker can still call the Bot API directly with the bot token
  (`sendMessage`, `editMessageText`). Hint in the CLI docs: someone calling `setWebhook` with the raw token
  makes `tgcloud webhook` report "out of sync", i.e. the raw token keeps working. **The Worker must never
  call `setWebhook`, `deleteWebhook` or `getUpdates` while Serverless is in use.**
- **[ASSUMED]** Quotas and pricing: not published.
- **[ASSUMED]** Telegram replays an Update when the handler throws. Our handlers never throw on forward
  failures (they answer with a fallback), so a decision is never applied twice by a retry from our side;
  the Worker's state-precondition check makes repeats harmless anyway.
