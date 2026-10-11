# Checks: reading and fixing validation results

KernelSU Modules reports validation results **only** as a GitHub **Check Run named
"KernelSU Modules"** (and the same result in the Portal). There are no e-mails or issues.

## Where to find the result

- **On GitHub:** open your repository's **Commits** or **Tags** page. Next to the commit there is a
  ✓ or ✗; click it and open **KernelSU Modules**.
  - Release checks (ZIP, module.prop, versionCode) are attached to the commit **your release tag
    points to**.
  - `module.yaml` and documentation checks are attached to the commit of the tracked branch where
    KernelSU Modules saw a **change to a tracked file** (`module.yaml`, the description, the icon or a
    repository image it references). Pushes that touch only other files get no Check Run. While the
    content is invalid, each new failing commit gets one failing Check Run.
  - Repository problems (repository made private, owner changed) are reported as a failing Check
    Run on the **current head** of the tracked branch.
  - While a submission or transfer is open, the **requested** repository gets the same content
    and release Check Runs (for a transfer: the new repository).
  - **Re-run** and **Sync now** always post a fresh Check Run, even if nothing changed.
  - The release page itself does not show check results.
- **From the command line:**

  ```sh
  gh api repos/{owner}/{repo}/commits/{tag}/check-runs \
    --jq '.check_runs[] | select(.name == "KernelSU Modules") | {conclusion, title: .output.title, summary: .output.summary}'
  ```

  Run it inside a clone of your repository: `gh` fills in `{owner}` and `{repo}` itself. Replace
  `{tag}` with the release tag (e.g. `v1.2.0`) or a commit SHA — `gh` does not fill that one in.

- **In the Portal:** **My modules** shows the same result, the locked version, the last sync time and
  whether the data is stale. If the KernelSU Modules App is not installed on the repository, no Check
  Run can be posted at all — the Portal is then the only place that shows the problem.

Each problem has a code (for example `version-not-newer`) that links to its section below. Errors
block the release or the content update; warnings don't.

## After fixing

| Problem is in… | What to do |
| --- | --- |
| The release, its ZIP, `module.prop` or `versionCode` | Immutable releases can't be changed. Publish a **new release with a higher versionCode**. |
| `module.yaml`, descriptions, icon or images | Push the fix to the tracked branch, then click **Re-run** on the check run, use **Sync now** (check run button or Portal), or wait for the next sync (≤ 15 min). |
| Transient download/network errors | Click **Re-run** or **Sync now**: releases that failed for a retryable reason (`asset-download-failed`, `asset-size-mismatch`, `asset-digest-mismatch`, `tag-not-found`) are checked again. |

**Precheck before publishing.** The [module-release action](releasing.md#using-the-module-release-action)
runs the same validator before anything is published, so a mistake doesn't cost you a version
number. The Portal's **Precheck** checks `module.yaml` and your newest release via the GitHub API; it
does not download or read the ZIP. The ZIP and `module.prop` are validated by the sync job (GitHub
Actions) right after you submit and again for every new release — the result appears in this Check
Run and in the Portal.

When a repository is synced for the first time after it was bound (new listing or
transfer to another repository), only the newest eligible release (immutable, not a prerelease) and
releases published after it are checked; older releases are recorded silently, without Check Runs.

Submission and transfer **review** results (approved / rejected and the reason) are shown in
the [Portal](portal.md), not in check runs.

## Issue codes

Grouped by area. Limits quoted below are the current defaults of the KernelSU Modules policy (`policy.yaml`).

## Module ID

### id-invalid

**Cause:** the module ID does not match `^[a-zA-Z][a-zA-Z0-9._-]+$` or is not 2–64 characters.

**Fix:** use an ID that starts with a letter and contains only letters, digits, `.`, `_` and `-`.

### id-reserved

**Cause:** the ID is reserved by the policy (`ksu`, `kernelsu`, `magisk`, `apatch`, `test`,
`example`, `module`, or starts with `org.kernelsu.` / `me.weishu.`; compared case-insensitively).

**Fix:** Pick a different ID.

### id-reserved-suffix

**Cause:** the ID ends with a file suffix KernelSU Modules uses for its own files: `.json`, `.html`,
`.htm`, `.md`, `.xml` or `.txt` (case-insensitive). The website and the API derive file names from
the ID, so such an ID would clash with another module's files.

**Fix:** choose an ID without that suffix, e.g. `foo-json` or `foo.tools` instead of `foo.json`.

### id-collision

**Cause:** the ID differs only in letter case from an already registered ID.

**Fix:** choose an ID that is not a case variant of an existing one.

## Repository and content

### repo-not-found

**Cause:** the registered repository no longer exists, or the KernelSU Modules App can no longer see
it (App uninstalled or repository removed from the installation).

**Fix:** restore the repository or reinstall the App on it. If the module moved to another
repository, use **Transfer** in the Portal.

### repo-private

**Cause:** the registered repository is private. Only public repositories can be listed.

**Fix:** make the repository public. (Reported as a failing Check Run on the head of the tracked
branch.)

### owner-changed

**Cause:** the repository was transferred to a different owner since the module was registered.
This is treated as an ownership change.

**Fix:** request a **Transfer** in the Portal so the new owner can be confirmed. (Reported as a
failing Check Run on the head of the tracked branch; sync is paused until the transfer is approved.)

### ref-not-found

**Cause:** the tracked branch (or the default branch) could not be resolved.

**Fix:** recreate the branch, or ask the maintainers to update the tracked branch.

### tag-not-found

**Cause:** the release's tag could not be resolved to a commit.

**Fix:** immutable releases keep their tag; if it is gone anyway, publish a new release with a
higher versionCode.

### content-not-file

**Cause:** a path used by KernelSU Modules (`module.yaml`, the icon or a description) is a directory,
symlink or submodule instead of a regular file.

**Fix:** point the path at a regular file committed to the repository.

### content-too-large

**Cause:** a file read by KernelSU Modules exceeds its limit: `module.yaml` 64 KiB, the description
document 512 KiB, images 5 MiB. An oversized repository image referenced by the description is a
warning (the image is left out of the page); an oversized `module.yaml`, description or icon is an
error.

**Fix:** shrink the file (compress images, split long documents).

## module.yaml

### manifest-missing

**Cause:** no `module.yaml` at the registered path (repository root by default) on the tracked
branch.

**Fix:** commit `module.yaml` — see [module.yaml reference](module-yaml.md).

### manifest-too-large

**Cause:** `module.yaml` is larger than 64 KiB.

**Fix:** keep it short; long text belongs in the description Markdown files.

### manifest-yaml

**Cause:** the file is not valid YAML: syntax error, duplicate key, multiple documents or excessive
aliases.

**Fix:** fix the syntax (the message shows the line). A YAML linter or the action's `dry-run` helps.

### manifest-unsupported-version

**Cause:** `schemaVersion` is not a version KernelSU Modules supports.

**Fix:** set `schemaVersion: 1`.

### manifest-schema

**Cause:** a field has the wrong type or value, or a required field (`name`, `summary`,
`description`, …) is missing — error. Unknown fields (typos count) and `http://` URLs for `homepage`/`support` are warnings: unknown fields are ignored. The
message names the field.

**Fix:** correct that field as described in the [reference](module-yaml.md#fields). Quote values
YAML might read as numbers or booleans.

### manifest-id-mismatch

**Cause:** `id` in `module.yaml` differs from your registered module ID.

**Fix:** set `id` to exactly the registered ID (case-sensitive).

### manifest-path-missing

**Cause:** a file referenced by `module.yaml` (`icon` or `description`) does not exist at the
synced commit.

**Fix:** commit the file or fix the path. Paths are relative to the repository root, not to
`module.yaml`, and are case-sensitive.

### manifest-paths-unchecked

**Cause (warning, Portal precheck only):** `module.yaml` references files in more directories than
the precheck looks into, so some of them were not checked yet.

**Fix:** nothing to do if the files are committed; the sync job checks every referenced file after
submission and reports `manifest-path-missing` in the Check Run and the Portal if one is missing.

### manifest-metamodule-mismatch

**Cause (warning):** `metamodule` in `module.yaml` disagrees with the release's `module.prop`.
KernelSU treats a module as a metamodule only when `module.prop` has `metamodule=1` or
`metamodule=true` (case-insensitive, surrounding whitespace ignored); anything else, or no
`metamodule` line, means a regular module.

**Fix:** set `metamodule: true` in `module.yaml` exactly when `module.prop` has `metamodule=1` (or
`true`). Fixing `module.yaml` only needs a push; fixing `module.prop` needs a new release.

## Release selection

### release-none

**Cause:** the repository has no published (non-prerelease) release yet.

**Fix:** publish an immutable release that contains the module ZIP.

### release-rejected

**Cause:** the release was rejected for a reason that has no more specific code.

**Fix:** open the Check Run details for the full message, fix the problem, and publish a new release with a higher versionCode.

### release-exists

**Cause:** (module-release action) a release for this tag already exists.

**Fix:** bump version and versionCode and push a new tag — immutable releases cannot be replaced.

### previous-release-unreadable

**Cause:** (module-release action, warning) the newest existing release could not be read to compare versionCode.

**Fix:** usually harmless; make sure the new versionCode is higher than every published release.

### release-draft

**Cause:** the release is still a draft.

**Fix:** publish it.

### release-not-published

**Cause:** the release has no publication date (not published yet).

**Fix:** publish it.

### release-not-immutable

**Cause:** the release is not immutable. Either release immutability is disabled, or the release
was published before you enabled it.

**Fix:** enable **Settings → General → Releases → Enable release immutability**, then publish a
**new** release with a higher versionCode. See [Releasing](releasing.md#immutable-releases).

### asset-pattern-invalid

**Cause:** `release.assetPattern` is empty or contains `/` or `\`.

**Fix:** use a file-name glob with only `*` and `?`, e.g. `"my_module-*.zip"`.

### asset-none

**Cause:** no asset matches `release.assetPattern` — or, without a pattern, the release has no
`.zip` asset.

**Fix:** attach the module ZIP to a new release, or correct `assetPattern` in `module.yaml` (then
**Re-run**).

### asset-multiple

**Cause:** several assets match `release.assetPattern` — or, without a pattern, the release has
more than one `.zip`.

**Fix:** set `release.assetPattern` so exactly one asset matches, then **Re-run**.

### asset-not-uploaded

**Cause:** the asset's upload did not complete (state is not `uploaded`).

**Fix:** publish a new release; upload assets before publishing.

### asset-url-invalid

**Cause:** the asset's download URL is not a release download of your registered repository.

**Fix:** attach the ZIP to a release in the registered repository itself.

### asset-download-failed

**Cause:** KernelSU Modules could not download the asset (network error, repository private or
unavailable).

**Fix:** usually transient — use **Sync now**. Make sure the repository and the release are public.

### asset-size-mismatch

**Cause:** the downloaded size differs from the size GitHub reports.

**Fix:** usually transient — retry. If it persists, publish a new release.

### asset-digest-mismatch

**Cause:** the sha256 of the downloaded ZIP differs from the digest GitHub reports for the asset.

**Fix:** usually transient — retry. If it persists, publish a new release.

## Version

### version-not-newer

**Cause:** the release's `versionCode` is not greater than the highest `versionCode` KernelSU Modules has
ever accepted for this module ID (stable or prerelease). This high-water mark never goes down: it
survives deleted releases and transfers to another repository. A release with exactly that highest
versionCode on the same channel (stable/prerelease) as the locked release is treated as the same
version and silently ignored; everything else is rejected, including:

- re-using the versionCode of a release you deleted;
- publishing a final release with the same versionCode as an accepted prerelease.

**Fix:** publish a new release with a higher `versionCode` in `module.prop`. To finish a beta
without bumping, untick **pre-release** on the accepted prerelease instead — that promotes it to
stable. See [versionCode rules](releasing.md#versioncode-rules).

## ZIP structure

KernelSU Modules reads only the ZIP's central directory and `module.prop`; it never extracts or runs
anything. Entry names are compared the way KernelSU extracts them: `.` and empty path segments are
dropped, so `./module.prop`, `.//module.prop` and `module.prop` are the same file. Archives made with
`zip`, 7-Zip, Android Studio or the module-release action pass these checks.

### zip-too-large

**Cause:** the ZIP is larger than 100 MiB.

**Fix:** reduce the module size (e.g. download large payloads at install time).

### zip-not-zip

**Cause:** the asset is not a ZIP (no end-of-central-directory record), or data was appended after
the archive.

**Fix:** upload a regular ZIP file.

### zip-corrupt

**Cause:** inconsistent ZIP structure (bad offsets, signatures or sizes).

**Fix:** re-create the ZIP with a standard tool.

### zip-multi-disk

**Cause:** split or multi-volume archive.

**Fix:** create a single-file ZIP.

### zip64-invalid

**Cause:** ZIP64 records are missing or contradict the regular headers.

**Fix:** re-create the ZIP with a standard tool.

### zip-too-many-entries

**Cause:** more than 20 000 entries.

**Fix:** reduce the number of files (pack data into an archive inside the module).

### zip-uncompressed-too-large

**Cause:** the total uncompressed size exceeds 512 MiB.

**Fix:** reduce the module contents.

### zip-bomb-ratio

**Cause:** the compression ratio of the archive or of a single large entry exceeds 200:1.

**Fix:** remove highly compressible filler (e.g. zero-filled images); generate them at install time.

### zip-overlapping-entries

**Cause:** several entries point at the same or overlapping data (a zip-bomb technique).

**Fix:** re-create the ZIP with a standard tool.

### zip-path-traversal

**Cause:** an entry name contains a `..` segment.

**Fix:** create the ZIP from inside the module directory so names are relative.

### zip-absolute-path

**Cause:** an entry name starts with `/` or a drive letter such as `C:`.

**Fix:** create the ZIP from inside the module directory.

### zip-backslash-path

**Cause:** an entry name contains `\`. ZIP paths must use `/` (common with some Windows tools).

**Fix:** re-create the ZIP with a tool that writes `/` separators (7-Zip, `zip`, the action).

### zip-path-invalid

**Cause:** an entry name is empty, is a file entry without a file name (e.g. `.` or `./.`),
contains control characters, is not valid UTF-8, or has an invalid (bad checksum) or
conflicting Unicode path field.

**Fix:** rename the file and re-create the ZIP.

### zip-duplicate-entry

**Cause:** two entries extract to the same path. Names are compared after dropping `.` and empty
segments, so `a/b`, `./a/b`, `a/./b` and `a//b` collide, as do a file `a` and a directory `a/`.
KernelSU would silently overwrite one with the other.

**Fix:** re-create the ZIP so each path appears once.

### zip-encrypted

**Cause:** the ZIP contains password-protected entries.

**Fix:** create the ZIP without a password.

### zip-unsupported-method

**Cause:** an entry uses a compression method KernelSU cannot extract. KernelSU supports stored
(0), deflate (8), deflate64 (9), LZMA (14) and XZ (95); anything else (BZip2, Zstandard, PPMd,
Implode, …) makes the installation fail, so it is an error for every entry. `module.prop` itself
must be stored or deflated, because KernelSU Modules reads it.

**Fix:** re-create the ZIP with deflate or no compression.

### zip-entry-corrupt

**Cause:** the `module.prop` entry cannot be read (header mismatch, inflate error, size or CRC
mismatch).

**Fix:** re-create the ZIP with a standard tool.

## module.prop

### prop-missing

**Cause:** there is no `module.prop` at the root of the ZIP.

**Fix:** put `module.prop` at the top level of the ZIP.

### prop-not-at-root

**Cause:** `module.prop` exists only in a sub-directory — the module *folder* was zipped instead of
its *contents*.

**Fix:** zip the contents (`cd module && zip -r ../module.zip .`), or use the action's
`module-dir` input.

### prop-duplicate

**Cause:** more than one entry extracts to the root `module.prop` — for example both `module.prop`
and `./module.prop`, or a `module.prop/` directory. KernelSU would read one and install another.

**Fix:** re-create the ZIP with a single `module.prop`.

### prop-too-large

**Cause:** `module.prop` is larger than 64 KiB.

**Fix:** keep only the standard `key=value` lines.

### prop-encoding

**Cause:** `module.prop` is not valid UTF-8.

**Fix:** save it as UTF-8.

KernelSU reads `module.prop` as a Java properties file, and so does KernelSU Modules: besides
`key=value` it accepts `key:value` and `key value`, leading whitespace, `#` and `!` comments,
`\` line continuations and escapes such as `\uXXXX`. The checks below apply to the result exactly
as KernelSU sees it.

### prop-line-invalid

**Cause (warning):** a line uses `:` or whitespace instead of `=` as separator (KernelSU still reads
it, as the message shows), or the file ends with a `\` continuation, which makes KernelSU drop the
last line.

**Fix:** use plain `key=value` lines; start comments with `#`; don't end the file with `\`.

### prop-syntax

**Cause:** a malformed `\uXXXX` escape (fewer than four hex digits, or a surrogate such as
`\uD83D`), even inside a comment. KernelSU refuses to install such a module.

**Fix:** write the character directly (the file is UTF-8) or use a valid four-digit escape.

### prop-duplicate-key

**Cause:** a key appears more than once (also via escapes, continuations or another separator, e.g.
`id=a` and `i\u0064:b`); KernelSU uses the **last** value. An error for `id`, `name`, `version`,
`versionCode`, `author`, `description` (a duplicate of these is only ever useful to show one value
and install another); a warning otherwise.

**Fix:** keep one line per key.

### prop-missing-field

**Cause:** one of `id`, `name`, `version`, `versionCode`, `author`, `description` is missing or
empty.

**Fix:** add the missing `key=value` line and publish a new release.

### prop-id-invalid

**Cause:** `id` in `module.prop` does not match `^[a-zA-Z][a-zA-Z0-9._-]+$` (2–64 characters).

**Fix:** use your registered module ID.

### prop-id-mismatch

**Cause:** `id` in `module.prop` differs from your registered module ID (case-sensitive). The
module-release action also reports this when `module.prop` and `module.yaml` disagree.

**Fix:** set `id` to exactly the registered ID and publish a new release.

### prop-versioncode-invalid

**Cause:** `versionCode` is not a plain decimal integer (e.g. `1.2`, `0x10`, `12a`).

**Fix:** use an integer such as `versionCode=120`, and publish a new release.

### prop-versioncode-range

**Cause:** `versionCode` is outside 1 … 2147483647 (int32).

**Fix:** use a positive versionCode not greater than 2147483647.
