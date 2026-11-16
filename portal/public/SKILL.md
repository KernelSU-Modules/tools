---
name: kernelsu-modules-portal
description: Work with the KernelSU Modules registry (modules.kernelsu.org) and its Developer Portal (developers.kernelsu.org). Use when reviewing module submissions and transfers, moderating modules, managing maintainers or bans, or checking sync health through the Portal's MCP server (maintainers only); also when helping a module author with module.yaml, releases, prechecks or submitting a module.
---

# KernelSU Modules Developer Portal

[KernelSU Modules](https://modules.kernelsu.org) is a static catalog of KernelSU modules. Authors keep
each module in their own GitHub repository and publish ZIPs as **immutable GitHub releases**; the registry
only indexes them. The [Developer Portal](https://developers.kernelsu.org) is where authors submit
and manage modules and where maintainers review and moderate them.

Registry state lives in the data repository `KernelSU-Modules/repo` (one `modules/<id>.yaml` record per
module, plus `maintainers.yaml`, `banned.yaml`, `policy.yaml`, `status.json`). Every change made through
the Portal is a commit by the *KernelSU Modules Bot*, with trailers that name the maintainer who made it.

## Who can do what

- **Module authors** (anyone who is an admin of the module's GitHub repository): use the Portal in a
  browser. There is no MCP or token access for authors; point them to the docs below.
- **Maintainers** (GitHub accounts listed in `maintainers.yaml`): the Portal's admin area, Telegram review
  buttons, and the **MCP server** described here.

## Connecting to the MCP server (maintainers)

The server is `https://developers.kernelsu.org/mcp` (Streamable HTTP). It uses **OAuth**: there is no token to
create or paste.

```sh
claude mcp add --transport http kernelsu-portal https://developers.kernelsu.org/mcp
```

or, for clients configured with JSON:

```json
{ "mcpServers": { "kernelsu-portal": { "type": "http", "url": "https://developers.kernelsu.org/mcp" } } }
```

On first use the client opens a browser: the maintainer signs in to the Portal with GitHub (if not already
signed in) and clicks **Allow** on the consent page. In Claude Code, run `/mcp` and choose the server to start
or redo this.

Access is tied to the Portal login it was approved from: it ends when that login expires (30 days after the
GitHub sign-in) and immediately when the account is no longer in `maintainers.yaml`. A `401` means the
authorization ended — authorize again from the client; a `403` means the account is not a maintainer. Never
ask the human for tokens or cookies, and never print them.

## Tools

Read-only (safe to call freely):

| Tool | Use |
| --- | --- |
| `queue_list` | Open requests (pending submissions, transfers needing review), oldest first, with the sync's validation result (`check`) and `expired` |
| `request_get` | One request by `submissionId`, open or already decided |
| `modules_list` | All records, optionally filtered by `status` (`pending`, `listed`, `rejected`, `changes-requested`, `suspended`, `archived`) |
| `module_get` | A module's full record (source, request, review, moderation) and its sync status |
| `sync_status` | `status.json` health per module, newest sync workflow runs, invalid data files; filter with `ids` or `unhealthyOnly` |
| `maintainers_list` | Maintainers with GitHub profile and Telegram binding |
| `banned_list` | Banned GitHub users |

Writes (each is a commit to the data repository; decisions also update the Telegram review message and
are visible to the author):

| Tool | Effect |
| --- | --- |
| `request_approve` | Submission → `listed`; transfer → source swapped. Starts a sync |
| `request_reject` | `reasonCode`: `spam`, `violation`, `bad-id`, `squatting`, or `other` (then `reason` is required). A rejected submission frees the ID; a rejected transfer leaves the module unchanged |
| `request_changes` | Submissions only. Sends it back with a required `reason`; ID and repository stay reserved for the submitter for 30 days |
| `module_moderate` | `suspend` (hidden from the site), `unsuspend`, `archive` (final: removed from the site, ID never reusable). `reason` required |
| `module_sync` | Re-run the sync for one module (re-validates an open request's source). At most once per 10 minutes per module |
| `maintainer_add` / `maintainer_remove` | By GitHub login / numeric id. You cannot remove yourself or the last maintainer |
| `maintainer_set_telegram` | Bind a numeric Telegram user id (not the @username), or `null` to unbind |
| `user_ban` / `user_unban` | By numeric GitHub id, with a reason. Banned users cannot submit or transfer |

Tool failures come back as a result with `isError: true` and `{error: {code, message}}`. Common codes:
`not-found`, `bad-request` (fix the arguments), `bad-state` / other `409`s (the record changed — re-read it
before retrying), `rate-limited`.

## Rules for agents

- **Confirm every write with the human first.** Summarize what will happen (module id, submission id,
  decision, the exact reason text the author will see) and wait for an explicit yes. Never batch-approve or
  batch-reject.
- Re-read before deciding: call `request_get` (or `queue_list`) right before a decision; another maintainer
  may already have decided in Telegram or the Portal.
- Reasons are shown to authors: keep them factual, polite, specific and under 500 characters, in English
  unless the author wrote in another language.
- Never retry a failed write blindly; read the error and the current state first.

## Reviewing a request

Review covers **rules only**, not code quality: no spam or abusive content, an appropriate ID, no squatting
of someone else's project name, no policy violations. The technical checks (ZIP structure,
`module.prop`, immutable release, sizes) are done automatically by the sync.

1. `queue_list` → pick the oldest request. Note `request.kind` (`submit` or `transfer`), the requested
   repository, the submitter and their `note`.
2. Look at `check`: if the sync has not validated the source yet it is absent; if `check.ok` is false, its
   `issues` say what is wrong (codes are documented at <https://developers.kernelsu.org/docs/checks>).
   Technical errors are usually a reason to **request changes**, not to reject.
3. For a `submit`: does the ID fit the module and not impersonate another project? Is the repository the
   real home of the project (not a re-upload of someone else's module)? Use `modules_list` /
   `module_get` to look for similar or colliding IDs.
4. For a `transfer`: the module moves to a different repository whose admins are not the current
   repository's admins. Make sure the new repository is a legitimate successor (same project, announced
   hand-over, fork of an abandoned project) rather than a takeover.
5. Propose the decision to the human with your reasoning, then call the tool once they confirm.
   `expired: true` requests are closed automatically by the daily cron; leave them unless asked.

## Health checks

`sync_status` with `unhealthyOnly: true` lists modules whose last sync failed (`health: error`), whose data
is stale, or whose repository lost the KernelSU Modules App (`installation: missing`). `runs` shows the
newest sync workflow runs; `invalidFiles` lists data-repo files that failed to parse. Report findings;
`module_sync` can re-run one module after the author fixed something.

## For module authors

Point authors to the docs instead of acting for them:

- Getting started: <https://developers.kernelsu.org/docs/getting-started>
- `module.yaml` reference: <https://developers.kernelsu.org/docs/module-yaml>
- Releasing (immutable releases, release action): <https://developers.kernelsu.org/docs/releasing>
- Using the Portal (precheck, preview, submit, transfer): <https://developers.kernelsu.org/docs/portal>
- Check codes: <https://developers.kernelsu.org/docs/checks>
- 中文文档: <https://developers.kernelsu.org/docs/zh-CN/>
