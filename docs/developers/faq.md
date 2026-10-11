# FAQ

## What does KernelSU Modules guarantee?

- The ZIP you download is **byte-for-byte the asset of an immutable release** in the module's
  registered GitHub repository. KernelSU Modules pins its sha256, and the new KernelSU Manager (the
  versions that use the `api/v1` of modules.kernelsu.org) verifies it before installing. Older Managers and
  manual downloads from GitHub do not check it — compare the sha256 on the module page yourself.
- Asset and tag of that release can never be swapped afterwards (GitHub release immutability).
- The ZIP passed structural checks (size, zip-bomb, paths, `module.prop`), and its `id` and
  `versionCode` follow the rules — versions never go backwards.
- A maintainer reviewed the **first** submission of every module for rule compliance.
- Detail pages are sanitized; module pages cannot run scripts on the site or in the Manager.

## What does it *not* guarantee?

- **No signing, no developer identity verification.** Modules are not signed by KernelSU Modules or by
  their authors, and authors' identities are not verified: whoever administers a module's GitHub
  repository manages the module.
- **No code audit and no malware scanning.** Review checks rules (spam, abuse, IDs, squatting), not
  what the module does on your device.
- **No protection against a malicious author or a compromised author account.** Updates are
  published automatically without review.
- A sha256 match only proves the file is the one KernelSU Modules indexed, not that it is safe.

The page of every module shows the source repository, tag, commit, the immutable flag and an
attestation link, so you can check provenance yourself, e.g. with `gh release verify`.

Malicious modules are suspended (removed from the index) as soon as maintainers learn about them.
Report problems to the maintainers.

## Why GitHub only?

Immutable releases and GitHub Apps are what make an author-hosted, automatically updated module index
safe enough without hosting files ourselves. Other hosts may come later.

## Does KernelSU Modules host or mirror my ZIP?

No. Downloads go directly to GitHub release assets. KernelSU Modules copies only description images and
the icon (so pages stay intact).

## What can the KernelSU Modules App do with my repository?

- **Metadata: read, Contents: read** — read `module.yaml`, your documents and releases.
- **Checks: write** — publish the "KernelSU Modules" check run with validation results. It cannot
  change code, releases, issues or settings.
- It receives `release`, `installation` and `check_run` events to know when to sync.

Signing in to the KernelSU Developer Portal uses the same App. Your GitHub token is stored only encrypted in an
HttpOnly cookie in your browser, never on the server. KernelSU Modules stores your GitHub user ID with
submissions and reviews (visible in the history of the public data repo, `KernelSU-Modules/repo`).

## Can I make the repository private?

Not the repository you submit — KernelSU Modules and its users must be able to read your documents
and download releases anonymously. A private repository stops syncing (the last version stays
online, marked stale).

You can keep your **source code** private, though: build in a private repository and publish
releases to a public distribution repository with the module-release action. See
[Closed-source modules](closed-source.md).

## I uninstalled the App. What happens?

Sync pauses; the last locked version stays online and is marked stale. Reinstall to resume.

## Can I change my module ID?

No. The ID is the module's identity on users' devices. Register a new module and archive the old
one if you really need to.

## How fast are updates published?

Usually within a few minutes of publishing the release (webhook-triggered), at most about 15
minutes plus build time. Use **Sync now** in the Portal or the check run if something seems stuck.

## Where do I get help?

Check the [Checks](checks.md) page for your error code, then ask in the GitHub
discussions or issues of <https://github.com/KernelSU-Modules/tools>.
