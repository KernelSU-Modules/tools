# KernelSU Developer Portal

[developers.kernelsu.org](https://developers.kernelsu.org) is the only place to submit and manage
modules. Sign in with GitHub (through the *KernelSU Modules* App). There are no separate accounts:
**whoever is an admin of the module's GitHub repository manages the module.** Add or remove
repository admins on GitHub and the Portal follows.

## My repositories

Lists the repositories where you are an admin and the KernelSU Modules App is installed. If a
repository is missing:

- install the App on it (**Install / configure App** button), or add it to an existing installation;
- for organization repositories, an organization owner must approve the installation;
- you must have the **admin** role on the repository (write/maintain is not enough).

Installing the App on "All repositories" is fine — nothing is submitted until you press **Submit**.

From each repository you can:

- **Precheck** — validates `module.yaml` and the files it references, the module ID, and the newest
  release (published, immutable, exactly one ZIP, size limit) using the GitHub API only. The ZIP itself
  (`module.prop`, hashing, zip-bomb checks) is validated by the KernelSU Modules sync job (GitHub Actions)
  right after you submit and again for every new release; the result is reported as a Check Run on
  your repository and shown in the Portal.
- **Preview** — renders your description with the same renderer and sanitizer as the site.
- **Submit** — register a new module ID (below).
- **Transfer** — point an existing module to this repository.

## Submit

Enter (or confirm) the module ID. The Portal checks that the ID is valid and available, that you
are an admin of the repository and that your account is not banned. The record becomes
**pending** and maintainers are notified. Review covers rules only: no spam or abusive content, an
appropriate ID, no squatting of someone else's project name. It is not a code audit.

## Transfer

Moves a listed (or suspended) module to another repository — e.g. a new home after a rewrite or a
hand-over to a new maintainer. If you are an admin of **both** the current and the new repository,
the transfer applies immediately; otherwise maintainers review it. Renaming a repository does not
need a transfer: modules are bound to the repository's numeric ID, not its name. Transferring the
repository itself to another account or organization, however, changes its owner — the check run
reports [`owner-changed`](checks.md#owner-changed) and the new owner should request a transfer.

The new repository must meet the same requirements (App installed, `module.yaml` with the same
`id`, immutable releases whose `module.prop` has the same `id`). While the transfer is open, every
sync validates the **new** repository and posts Check Runs there. Its releases must use a versionCode
higher than the highest one KernelSU Modules ever accepted for this module — if the newest release in the
new repository is not higher, the request shows a warning: it will not be published after the
transfer, so publish a higher versionCode there. On the first sync after the transfer only the newest
eligible release (and later ones) is checked.

## My modules

Shows, per module: status, the bound repository, the locked stable version, last sync time and
health, the latest check result, and the reason of a rejection or suspension.

**Sync now** re-runs the sync for your module (at most once every 10 minutes per module).
Use it after fixing `module.yaml`/documentation, or when a release was not picked up. It always posts
a fresh Check Run (even if nothing changed), re-validates an open submission or transfer, and
retries releases that failed for retryable reasons (download failed, size or digest mismatch, tag not
found). The Check Run's **Re-run** and **Sync now** buttons do the same.

The "last sync" time only changes when something about the module changed or its health changed;
there is no periodic heartbeat, so an old time on a healthy module is normal.

## Statuses

| Status | Meaning | What you can do |
| --- | --- | --- |
| `pending` | Submitted, waiting for review. Expires after 30 days without a decision, which frees the ID. | Wait; keep your release and `module.yaml` valid. |
| `listed` | Accepted. Shown on the site and in the Manager **once it has a valid stable release**. Updates publish automatically. | Release new versions. |
| `rejected` | Review declined; the reason is shown (`spam`, `violation`, `bad-id`, `squatting` or a custom note). The ID is free again. | Fix the problem and submit again (another ID if the ID was the issue). |
| `suspended` | Removed from the index by maintainers; the ID stays bound to your repository. | Read the reason; contact the maintainers once fixed. |
| `archived` | Retired (e.g. abandoned). The ID cannot be registered again. | Contact the maintainers. |

Sync health (shown next to `listed` modules):

| Health | Meaning |
| --- | --- |
| `ok` | The last sync succeeded. |
| `stale` | The last sync failed (network, invalid new `module.yaml`, …); the last good data is still served. See the check run. |
| `error` | No sync has ever succeeded, so nothing is published yet. See the check run. |
| App missing | The App was uninstalled or the repository removed from the installation. Sync is paused and the last version stays online; reinstall to resume. No Check Run can be posted in this state — the Portal is the only place that shows it. |
