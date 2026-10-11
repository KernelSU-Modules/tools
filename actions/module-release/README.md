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

With `repository` set (**external mode**, for closed-source modules) the release goes to a separate
public distribution repository instead; see [below](#publishing-to-a-distribution-repository-closed-source-modules).

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

## Publishing to a distribution repository (closed-source modules)

Keep the source in a private repository and publish releases to a **public** distribution
repository (release assets of private repositories cannot be downloaded anonymously). Run the
workflow in the private repository and set `repository` and `token`:

```yaml
name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
        with:
          fetch-depth: 0 # fetches the annotated tag object, used as release notes
      - run: ./build.sh # produces out/my_module.zip
      - uses: KernelSU-Modules/tools/actions/module-release@<sha>
        with:
          zip: out/my_module.zip
          repository: my-name/my-module # the public distribution repository
          token: ${{ secrets.DIST_REPO_TOKEN }} # fine-grained PAT: that repository only, Contents: Read and write
```

In external mode the action:

1. **Preflight** (also on `dry-run`): the token is set and is not the workflow's `GITHUB_TOKEN`
   (which cannot write to other repositories); the target repository exists, the token can read it,
   it is **public** and not archived; the token can push (`permissions.push`, a warning if GitHub does
   not report it); **release immutability** is enabled (a warning instead if the token may not read the
   setting — it is verified again after publishing); the default branch has a commit. Warns when the
   token expires within 14 days (`github-authentication-token-expiration` header). Prints a reminder
   to install the KernelSU Modules App on the distribution repository (this cannot be checked with
   your token).
2. **Metadata sync** (`sync-files: true`): reads `module.yaml` (`manifest`), the description
   document, the icon and the repository images the description references from the workspace —
   with the same limits as KernelSU Modules (description ≤ 512 KiB and icon ≤ 5 MiB, otherwise an
   error; at most 40 images, each ≤ 5 MiB and ≤ 40 MiB in total, others are skipped with a warning) —
   and writes the files whose git blob sha differs to the same paths on the default branch of
   `repository`, in **one** commit (`Sync module metadata for <tag>`, non-force ref update, retried
   if the branch moved). Nothing changed → no commit. Files are never deleted. A missing `module.yaml`
   is an error here; with `sync-files: false` you maintain the distribution repository yourself.
3. **Tag**: creates `refs/tags/<tag>` in `repository` at the synced commit (or at the default-branch
   HEAD when nothing changed). If the tag already exists elsewhere the run fails before writing
   anything — tags are never moved or reused. (A tag that already points at the unchanged HEAD, e.g.
   from a run whose upload failed, is reused.)
4. **Release**: draft → upload → publish → immutability check, as in the same-repository mode.

Release notes default to the message of the **annotated** tag that triggered the workflow (read
with `git for-each-ref` from the checkout — use `fetch-depth: 0`, since a shallow tag checkout only
has a lightweight ref). Without one, the notes are empty and a warning is printed.
`release-notes` / `release-notes-file` take precedence; `generate-release-notes` is ignored (the
distribution repository has no source history).

Token: a **fine-grained personal access token** with *Repository access: Only select repositories →
the distribution repository* and *Contents: Read and write* (optionally *Administration: Read-only*,
so the preflight can read the immutability setting), or a GitHub App installation token
(`actions/create-github-app-token`) with the same permissions. Never give it access to the private
source repository. Full walkthrough: <https://developers.kernelsu.org/docs/closed-source>.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `zip` | — | Path to a prebuilt module ZIP. Exactly one of `zip` / `module-dir`. |
| `module-dir` | — | Directory whose **contents** become the ZIP root. |
| `manifest` | `module.yaml` | Path to `module.yaml`. If missing, only a warning is printed (KernelSU Modules needs it on your default branch, not in the release). |
| `tag` | triggering tag | Tag to release; created at `GITHUB_SHA` if it does not exist (external mode: created in `repository` at the synced commit). |
| `name` | tag | Release title. |
| `token` | `github.token` | Needs `contents: write` on the release repository. With `repository`: a PAT or App token for that repository (required). |
| `repository` | — | `owner/name` of a public distribution repository to publish to (external mode). Same as the current repository = normal mode. |
| `sync-files` | `true` | External mode only: commit `module.yaml`, description, icon and referenced images to the default branch of `repository` before releasing. |
| `prerelease` | `false` | Publish as prerelease. |
| `release-notes` | — | Release notes (Markdown); KernelSU Modules shows them as the changelog. External mode default: the annotated tag message. |
| `release-notes-file` | — | File with release notes. |
| `generate-release-notes` | `false` | Let GitHub generate notes when none are given. Ignored in external mode. |
| `asset-pattern` | `release.assetPattern` from module.yaml | Glob the generated asset name must match. |
| `require-immutable` | `true` | Fail if the published release is not immutable. |
| `dry-run` | `false` | Checks only (including read-only release checks when a token and tag are available, and the external-mode preflight and metadata comparison). Writes nothing. |
| `workflow-token` | `github.token` | Internal, do not set: compared with `token` to detect a token left at its default in external mode. |

## Outputs

| Output | Description |
| --- | --- |
| `release-id` | ID of the published release (empty on dry run) |
| `release-url` | HTML URL of the release (empty on dry run) |
| `asset-name` | `{id}-{versionCode}-{version}.zip`; in `version`, each run of characters outside `[A-Za-z0-9._-]` becomes `_`, leading/trailing `._-` are removed, max 64 characters (`unknown` if empty) |
| `sha256` | Hex SHA-256 of the ZIP |
| `zip-path` | Path of the ZIP (the generated one for `module-dir`) |
| `module-id`, `version`, `version-code` | From `module.prop` |
| `repository` | Repository the release was published in (`owner/name`) |
| `metadata-commit` | External mode: the metadata commit on the default branch of `repository` (empty if nothing changed, on dry run, or with `sync-files: false`) |

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
