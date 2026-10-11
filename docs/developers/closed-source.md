# Closed-source modules

KernelSU Modules lists modules from **public** GitHub repositories. If you do not want to publish
your source code, keep it in a **private** repository and publish releases to a separate **public
distribution repository**. The [module-release action](releasing.md#using-the-module-release-action)
does this for you: it runs in the private repository and writes only to the distribution
repository.

## Why the release repository must be public

- KernelSU Modules, the KernelSU Manager and every user download the ZIP **anonymously** from the
  GitHub release. Release assets of a private repository need a GitHub token to download, so they
  cannot be offered to users.
- The ZIP is distributed publicly anyway: everyone who installs your module gets it. Publishing it in
  a public repository does not reveal anything that the ZIP itself does not.
- KernelSU Modules reads `module.yaml`, the description and the icon from the repository, and posts its
  Check Runs there. It never needs access to your source code.

## Layout

```
my-module-src  (private)                 my-module  (public, distribution)
────────────────────────                 ─────────────────────────────────
source code, build scripts               module.yaml, README.md, icon, images  ◄─ synced by the action
module.yaml, README.md, icon, images     tag v1.2.0 → immutable release + ZIP  ◄─ published by the action
.github/workflows/release.yml  ──────►   KernelSU Modules App installed here (only here)
  (secret DIST_REPO_TOKEN)                submitted in the KernelSU Developer Portal
```

You edit `module.yaml`, the description document and the icon **only in the private repository**.
On every release the action copies them (and the repository images the description references) to
the same paths on the default branch of the distribution repository, in one commit, and only when
something changed. It never deletes files there. Do not edit those files in the distribution
repository by hand — the next release overwrites them with the private copy.

## One-time setup

1. **Create the public distribution repository**, e.g. `my-name/my-module`. Tick **Add a README
   file** so it has a default branch (the action cannot commit to an empty repository).
2. In the distribution repository, enable **Settings → General → Releases → Enable release
   immutability** ([GitHub docs](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)).
3. **Install the KernelSU Modules App on the distribution repository only**
   (<https://github.com/apps/kernelsu-modules/installations/new>, *Only select repositories*). Do not
   install it on the private repository: KernelSU Modules does not need it there, and the private
   repository cannot be listed anyway.
4. **Create a fine-grained personal access token** (GitHub → Settings → Developer settings →
   Personal access tokens → Fine-grained tokens):
   - *Resource owner*: the owner of the distribution repository;
   - *Repository access*: **Only select repositories** → the distribution repository only;
   - *Permissions*: **Contents: Read and write** (Metadata: Read-only is added automatically).
     Optionally **Administration: Read-only**, so the action can verify that release immutability
     is enabled (without it you get a warning, and the action still checks the published release);
   - an expiration date you will remember (see [Token rotation](#token-rotation)).
5. In the **private** repository, store the token as an Actions secret: **Settings → Secrets and
   variables → Actions → New repository secret**, name `DIST_REPO_TOKEN`.
6. Add `module.yaml` (see [module.yaml](module-yaml.md)), the description document and the icon to
   the private repository, and copy the [workflow below](#workflow) to
   `.github/workflows/release.yml` in the private repository.
7. **Run it once as a dry run**: Actions → *Release* → **Run workflow**. A manual run only checks:
   token, distribution repository (public, immutability, write access), your ZIP and `module.yaml`,
   and lists the files that would be synced. It writes nothing.
8. **Publish the first release**: bump `versionCode` in `module.prop`, then push an annotated tag:

   ```sh
   git tag -a v1.0.0 -m "v1.0.0" -m "- First release"
   git push origin v1.0.0
   ```

9. **Submit the distribution repository** (not the private one) in the
   [KernelSU Developer Portal](https://developers.kernelsu.org) — see [Getting started](getting-started.md#7-submit).
   You need the admin role on the distribution repository.

## Workflow

In the **private** repository, `.github/workflows/release.yml`:

```yaml
name: Release
on:
  push:
    tags: ['v*']
  workflow_dispatch: # manual run = dry run (checks only, writes nothing)
permissions:
  contents: read # the token for the distribution repository comes from the secret
concurrency:
  group: release
  cancel-in-progress: false
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<40-char-sha>
        with:
          fetch-depth: 0 # fetches the annotated tag, whose message becomes the release notes

      # Placeholder: build your module ZIP (module.prop at the ZIP root).
      - run: ./build.sh --out out/my_module.zip

      - uses: KernelSU-Modules/tools/actions/module-release@<40-char-sha>
        with:
          zip: out/my_module.zip
          repository: my-name/my-module # the public distribution repository
          token: ${{ secrets.DIST_REPO_TOKEN }}
          tag: ${{ github.ref_type == 'tag' && github.ref_name || '' }}
          dry-run: ${{ github.event_name == 'workflow_dispatch' }}
```

Pin both actions to a full 40-character commit SHA, never to a branch.

What the action does in this mode:

1. **Preflight** (also on dry runs): the token is set and is not the workflow's own `GITHUB_TOKEN`
   (which cannot write to other repositories); the distribution repository exists, is readable,
   **public** and not archived; the token can push; release immutability is enabled; the default
   branch has a commit. It also reminds you to install the KernelSU Modules App on the distribution
   repository (this cannot be checked with your token).
2. **Prechecks** of the ZIP and `module.yaml`, exactly as for a normal release, against the
   releases of the distribution repository (versionCode must be newer, the tag must be unused).
3. **Metadata sync**: `module.yaml`, the description, the icon and the referenced repository images
   are committed to the default branch of the distribution repository if they differ
   (commit message `Sync module metadata for <tag>`). The limits of KernelSU Modules apply: a
   description over 512 KiB or an icon over 5 MiB fails the run; images over 5 MiB, beyond 40 MiB in
   total or beyond the 40th are skipped with a warning.
4. **Tag**: the tag is created in the distribution repository at that commit (or at its current
   HEAD if nothing changed). If the tag already exists there and points somewhere else, the run fails
   before writing anything — tags are never moved or reused.
5. **Release**: draft → upload ZIP → publish, then the action verifies the release is immutable.

Outputs include `repository` and `metadata-commit` (empty when nothing had to be committed) in
addition to the usual `release-url`, `asset-name`, `sha256`, … — see
[Releasing](releasing.md#using-the-module-release-action).

KernelSU Modules then picks up the release from the distribution repository like any other
release; Check Runs appear on the tagged commit **in the distribution repository**.

## Release notes

GitHub's generated release notes are useless in the distribution repository (it has no source
history), so `generate-release-notes` is ignored. The release notes are, in this order:

1. `release-notes` or `release-notes-file`, if set;
2. otherwise the message of the **annotated tag** you pushed (`git tag -a`). The action reads it from
   the checkout, so `actions/checkout` needs `fetch-depth: 0` — a shallow checkout of a tag only
   creates a lightweight tag without the message;
3. otherwise empty (with a warning).

The notes are shown as the changelog of the version. You can still edit them on GitHub after
publishing.

## Token rotation

Fine-grained tokens expire. When the token expires within 30 days, the action prints a warning
(from GitHub's `github-authentication-token-expiration` header). Before it expires, regenerate the
token (or create a new one with the same settings) and update the `DIST_REPO_TOKEN` secret. An
expired token makes the run fail with HTTP 401 before anything is written.

### Alternative: your own GitHub App

Instead of a personal token you can create your own GitHub App (not the KernelSU Modules App) with
**Contents: Read and write**, install it on the distribution repository only, store its ID as a
variable and its private key as a secret in the private repository, and mint a short-lived token in
the workflow:

```yaml
      - uses: actions/create-github-app-token@<40-char-sha>
        id: dist-token
        with:
          app-id: ${{ vars.DIST_APP_ID }}
          private-key: ${{ secrets.DIST_APP_PRIVATE_KEY }}
          owner: my-name
          repositories: my-module
      - uses: KernelSU-Modules/tools/actions/module-release@<40-char-sha>
        with:
          zip: out/my_module.zip
          repository: my-name/my-module
          token: ${{ steps.dist-token.outputs.token }}
```

The tokens expire after an hour, so there is nothing to rotate except the private key.

## What not to do

- **Do not give the distribution repository access to the private repository.** No secrets, deploy
  keys or tokens in the distribution repository that can read the source. It needs no workflows at
  all.
- **Do not widen the token.** It should reach the distribution repository only. Anyone who has it
  can publish a module update to your users, so keep it in the private repository's secrets and use
  it only in the release workflow.
- **Do not install the KernelSU Modules App on the private repository.** It only needs the
  distribution repository. The App never writes to your repositories anyway (its only write
  permission is Check Runs).
- **Do not make the distribution repository private.** Syncing stops and the module is marked stale.
- **Do not edit the synced files in the distribution repository by hand**, and do not reuse tags
  there: create a new tag (and a higher versionCode) for every release.
