# Releasing

Every version you publish is a **GitHub release in your repository** with the module ZIP attached.
Once your module is listed, new releases are picked up automatically — usually within minutes
(webhook), at the latest after the 15-minute fallback sync. No review is needed for updates.

## Requirements for a release

A release is used only if **all** of these hold:

1. It is **published** (not a draft).
2. It is **immutable** (`immutable: true` in the GitHub API) — see below.
3. It has **exactly one** module ZIP: exactly one `.zip` asset, or, if `module.yaml` sets
   `release.assetPattern`, exactly one asset matching it. Other non-matching assets are fine.
4. The ZIP passes the checks:
   - ≤ 100 MiB, ≤ 512 MiB uncompressed, compression ratio ≤ 200, ≤ 20 000 entries;
   - `module.prop` at the **root** of the ZIP (≤ 64 KiB, UTF-8, stored or deflated) with `id`,
     `name`, `version`, `versionCode`, `author`, `description`. It is read exactly like KernelSU
     reads it (Java properties syntax; for a repeated key the **last** value wins), and a repeated
     `id`, `name`, `version`, `versionCode`, `author` or `description` is rejected;
   - `id` equals your registered module ID exactly;
   - no absolute paths, `..` segments, backslashes or encrypted entries, and no two entries that
     extract to the same path (`./a`, `a` and `.//a` are the same path);
   - only compression methods KernelSU can extract: stored, deflate, deflate64, LZMA or XZ.
5. Its `versionCode` is valid and newer (next section).

Every failure is reported on the tagged commit as a Check Run — see [Checks](checks.md).

## Immutable releases

With **Settings → General → Releases → Enable release immutability** turned on, GitHub locks a
release when it is published: its assets cannot be replaced or deleted and its tag cannot be moved
or reused, even if the repository is deleted and recreated. That is what lets KernelSU Modules pin a
sha256 to a URL forever.

- The setting is **not retroactive**. Releases published before enabling it remain mutable and are
  ignored. KernelSU Modules checks the `immutable` flag of each release, not the repository setting.
- A release becomes immutable **when it is published**. Assets must therefore be uploaded while the
  release is still a draft: *create draft → upload ZIP → publish*. Publishing first and uploading
  later does not work. The module-release action and `gh release create <tag> <file>` both do this.

### Why you cannot fix a published release

Assets and tag of an immutable release are frozen, and KernelSU Modules processes each release only
once. If a release is broken (wrong ZIP, wrong `id`, too low `versionCode`, …) the only fix is a
**new release with a higher versionCode**. You may delete the broken release; you cannot reuse its
tag, and you cannot reuse the versionCode of a release KernelSU Modules already accepted.

What you *can* still edit after publishing: title, release notes and the prerelease flag. KernelSU
Modules re-reads them on every sync.

This is why prechecking before publishing matters — the module-release action refuses to publish
anything that would fail, so you don't burn a version number.

## versionCode rules

- `versionCode` must be a plain decimal integer in **1 … 2147483647** (int32), like in the
  KernelSU Manager. Only `versionCode` decides which version is newer; the `version` string is
  display text.
- Every new release must have a `versionCode` **greater than the highest versionCode KernelSU Modules has
  ever accepted for this module ID** — stable or prerelease. This high-water mark never goes down: it
  survives deleted releases and transfers to another repository.
- A release with exactly that highest versionCode, on the same channel (stable/prerelease) as the
  locked release that has it, is "the same version" and ignored (the Check Run is still a success).
- Everything else is rejected with [`version-not-newer`](checks.md#version-not-newer) — including
  re-using the versionCode of a deleted release, and publishing a final release with the same
  versionCode as an accepted prerelease.
- The **stable** version is the valid non-prerelease release with the highest `versionCode`, but
  KernelSU Modules never falls back to a lower versionCode than the highest one that was ever stable. If you
  delete the stable release or mark it as a prerelease, the module is **hidden from the index** until
  you publish a release with a higher versionCode — older releases do not become stable again.
- KernelSU Modules keeps the 10 most recent valid releases as version history.
- When a repository is synced for the first time (new listing or transfer to another
  repository), only the newest eligible release and releases published after it are checked; older
  releases are recorded silently without Check Runs.

## Release notes = changelog

The release notes are shown as the changelog of that version, rendered and sanitized like the
description (see [module.yaml](module-yaml.md#markdown-and-html-in-descriptions)), max 64 KiB.

## Prereleases

Mark a release as **pre-release** on GitHub (or `prerelease: true` in the action) to publish a
test build. Prereleases are checked and recorded but are not offered as the stable version; the
current site and Manager do not show them yet. A prerelease counts towards the highest accepted
versionCode, so the final release must either use an even higher versionCode, or you **promote the
prerelease** by unticking "Set as a pre-release" on GitHub (KernelSU Modules re-reads the flag on every
sync). Publishing the final with the same versionCode as the accepted prerelease is rejected.

## Using the module-release action

[`KernelSU-Modules/tools/actions/module-release`](https://github.com/KernelSU-Modules/tools/tree/main/actions/module-release)
runs the same validator KernelSU Modules uses on your ZIP **before** publishing, then publishes in the right
order (draft → upload → publish) with the asset named `{id}-{versionCode}-{version}.zip`. In the
file name, every run of characters outside `A-Z a-z 0-9 . _ -` in `version` becomes `_`, leading
and trailing `.`, `_` and `-` are removed and it is cut to 64 characters (`unknown` if nothing is
left) — e.g. version `v1.2 (beta)` gives `mymodule-120-v1.2_beta.zip`. The displayed version
still comes from `module.prop` unchanged.

```yaml
name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<commit-sha>
      - uses: KernelSU-Modules/tools/actions/module-release@<commit-sha>
        with:
          module-dir: module            # directory whose contents become the ZIP root
          # zip: out/my-module.zip      # …or a ZIP you built in an earlier step
          release-notes-file: CHANGELOG.md
```

Pin actions to a full commit SHA. Main inputs:

| Input | Default | Description |
| --- | --- | --- |
| `zip` / `module-dir` | — | Exactly one: a prebuilt ZIP, or a directory to zip (VCS files skipped). |
| `tag` | pushed tag | Tag to release. |
| `prerelease` | `false` | Publish as prerelease. |
| `release-notes` / `release-notes-file` | — | Release notes (changelog). |
| `asset-pattern` | `release.assetPattern` | Checked against the generated asset name. |
| `dry-run` | `false` | Run all checks, publish nothing (useful on pull requests). |

Outputs: `release-id`, `release-url`, `asset-name`, `sha256` (plus `zip-path`, `module-id`,
`version`, `version-code`, `repository`, `metadata-commit`). The full list is in the action's README.

To publish from a private source repository to a public distribution repository, set `repository`
and `token` — see [Closed-source modules](closed-source.md).

The action's checks are a convenience; KernelSU Modules validates every release again on its side.

### Without the action

Any tool works as long as the release is published *after* the ZIP is uploaded, e.g.:

```sh
gh release create v1.2.0 my_module-120-v1.2.0.zip --title v1.2.0 --notes-file CHANGELOG.md
```

## Optional: hosted update.json

KernelSU checks `updateJson` from `module.prop` for in-app updates. KernelSU Modules publishes a
verified one for every listed module:

```properties
updateJson=https://modules.kernelsu.org/api/v1/modules/<id>/update.json
```

It contains `version`, `versionCode`, `zipUrl` and a `changelog` URL for the current stable version and is
updated after each sync, so you do not need to maintain your own file. The `changelog` URL
(`https://modules.kernelsu.org/api/v1/modules/<id>/changelog.md`) serves the release notes of that version as
plain Markdown (KernelSU shows it before updating; `(no release notes)` when the release has none).
