# KernelSU Module Release action

Publishes a KernelSU module ZIP as an **immutable GitHub release** in the shape the
[KernelSU Modules](https://modules.kernelsu.org) expects — after checking it with the
same validator KernelSU Modules uses, so a broken ZIP never costs you an immutable version number.

What it does:

1. Takes a prebuilt ZIP (`zip`) or zips a directory (`module-dir`; `.git`, `.github` and other VCS
   files are skipped, symlinks are skipped with a warning; the archive is reproducible).
2. Prechecks with `@kernelsu-modules/validator`: ZIP structure and limits, root `module.prop` (required
   fields, id, int32 versionCode), `module.yaml` schema and referenced files, `id` equality between
   `module.prop` and `module.yaml`, the asset name against `release.assetPattern`.
3. Reads existing releases (read-only): refuses if a published release for the tag exists; reads
   `module.prop` of the newest stable release (HTTP Range, only the ZIP index) and refuses unless
   the new `versionCode` is greater; warns if the latest release is not immutable.
4. **Any error → nothing is published.**
5. Creates a **draft** release → uploads `{id}-{versionCode}-{version}.zip` → checks the uploaded
   asset's name and sha256 digest → publishes. (Immutability applies at publish time, so the asset
   must be uploaded first.) On failure, the release is re-read and deleted only if it is still a
   draft — a release GitHub already published is never deleted. Leftover drafts for
   the same tag from earlier failed runs are deleted.
6. Verifies the published release is immutable; fails the step if not (`require-immutable`).

KernelSU Modules re-validates every release on its side; this action is a convenience for authors.

## Usage

Enable **Settings → General → Releases → Enable release immutability** in your repository first.

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
      - uses: actions/checkout@<sha> # pin to a commit SHA
      - uses: KernelSU-Modules/tools/actions/module-release@<sha> # pin to a commit SHA
        with:
          module-dir: module
          release-notes-file: CHANGELOG.md
```

Build the ZIP yourself (e.g. native binaries) and pass it in:

```yaml
      - run: ./gradlew zipRelease
      - uses: KernelSU-Modules/tools/actions/module-release@<sha>
        id: release
        with:
          zip: out/my_module.zip
          prerelease: ${{ contains(github.ref_name, '-') }}
          generate-release-notes: true
      - env:
          SHA256: ${{ steps.release.outputs.sha256 }} # pass outputs via env:, never ${{ }} inside run:
        run: echo "sha256 ${SHA256}"
```

Precheck on pull requests without publishing (no tag, no write permission needed):

```yaml
on: pull_request
permissions:
  contents: read
jobs:
  precheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - uses: KernelSU-Modules/tools/actions/module-release@<sha>
        with:
          module-dir: module
          dry-run: true
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `zip` | — | Path to a prebuilt module ZIP. Exactly one of `zip` / `module-dir`. |
| `module-dir` | — | Directory whose **contents** become the ZIP root. |
| `manifest` | `module.yaml` | Path to `module.yaml`. If missing, only a warning is printed (KernelSU Modules needs it on your default branch, not in the release). |
| `tag` | triggering tag | Tag to release; created at `GITHUB_SHA` if it does not exist. |
| `name` | tag | Release title. |
| `token` | `github.token` | Needs `contents: write`. |
| `prerelease` | `false` | Publish as prerelease. |
| `release-notes` | — | Release notes (Markdown); KernelSU Modules shows them as the changelog. |
| `release-notes-file` | — | File with release notes. |
| `generate-release-notes` | `false` | Let GitHub generate notes when none are given. |
| `asset-pattern` | `release.assetPattern` from module.yaml | Glob the generated asset name must match. |
| `require-immutable` | `true` | Fail if the published release is not immutable. |
| `dry-run` | `false` | Checks only (including read-only release checks when a token and tag are available). |

## Outputs

| Output | Description |
| --- | --- |
| `release-id` | ID of the published release (empty on dry run) |
| `release-url` | HTML URL of the release (empty on dry run) |
| `asset-name` | `{id}-{versionCode}-{version}.zip`; in `version`, each run of characters outside `[A-Za-z0-9._-]` becomes `_`, leading/trailing `._-` are removed, max 64 characters (`unknown` if empty) |
| `sha256` | Hex SHA-256 of the ZIP |
| `zip-path` | Path of the ZIP (the generated one for `module-dir`) |
| `module-id`, `version`, `version-code` | From `module.prop` |

## Result codes

Errors and warnings are printed as annotations with the KernelSU Modules issue code; each links to
<https://developers.kernelsu.org/docs/checks>. Two codes are specific to this action:

| Code | Meaning |
| --- | --- |
| `release-exists` | A published release for this tag already exists. Bump versionCode and use a new tag. |
| `previous-release-unreadable` | (warning) The previous release's `module.prop` could not be read, so the versionCode comparison was skipped. |

## Development

```sh
pnpm --filter @kernelsu-modules/module-release test
pnpm --filter @kernelsu-modules/module-release typecheck
pnpm --filter @kernelsu-modules/module-release build   # regenerates dist/index.js — commit it
pnpm --filter @kernelsu-modules/module-release check-dist   # CI: fails if dist/index.js is stale
```

`dist/index.js` is a self-contained esbuild bundle (validator, schema, zod and yaml included); the
runner executes it with Node 24 (`runs.using: node24`).
