# module.yaml reference

`module.yaml` holds **display metadata only**. KernelSU Modules reads it (and the files it references)
from your repository's tracked branch (the default branch unless another branch was registered) at a
locked commit. Version, versionCode and the download come
from the release ZIP's `module.prop` — never put them here.

Module content is **single-language**: one `name`, one `summary` and one description document. (The
site and the Portal themselves are translated; your module text is shown as written.)

JSON Schema: `schemas/module.schema.json` in
[KernelSU-Modules/tools](https://github.com/KernelSU-Modules/tools). Editors with YAML language
server support can use it for completion by adding this first line:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/KernelSU-Modules/tools/main/schemas/module.schema.json
```

## Full example

```yaml
schemaVersion: 1
id: demo.toolbox
name: Demo Toolbox
summary: Utilities for rooted Android devices
description: README.md
license: MIT
homepage: https://example.org/demo-toolbox
support: https://github.com/demo/toolbox/issues
tags: [system, tools]
icon: assets/icon.png
metamodule: false

authors:
  - name: Demo Author
    url: https://github.com/demo

compatibility:
  androidMinApi: 28
  architectures: [arm64-v8a]

release:
  assetPattern: "demo.toolbox-*.zip"
```

## Fields

Unknown fields (at any level) are reported as a **warning** and ignored, so a `module.yaml` written for
a newer version of KernelSU Modules still validates; check the warning for typos. An unsupported
`schemaVersion` is always an error ([`manifest-unsupported-version`](checks.md#manifest-unsupported-version)).
Wrong types and invalid values are errors ([`manifest-schema`](checks.md#manifest-schema)). Quote
values that YAML could read as numbers or booleans.

| Field | Required | Type / rule |
| --- | --- | --- |
| `schemaVersion` | yes | Must be `1`. |
| `id` | yes | Must equal the `id` in `module.prop` and the registered ID, exactly (case-sensitive). `^[a-zA-Z][a-zA-Z0-9._-]+$`, 2–64 chars. |
| `name` | yes | Display name, 1–100 chars. |
| `summary` | yes | 1–500 chars, plain text; one or two sentences work best. |
| `description` | yes | Repository-relative path to the Markdown document used as the detail page (see [Paths](#paths)). |
| `license` | no | 1–64 chars. An [SPDX identifier](https://spdx.org/licenses/) such as `MIT` or `GPL-3.0-only` is recommended. |
| `homepage` | no | URL. `https://` is recommended; `http://` is accepted with a warning. |
| `support` | no | URL for bug reports / help (issues page, forum thread, chat). `http://` is accepted with a warning. |
| `tags` | no | Up to 10 tags of letters, digits and `-` (max 32 chars, starting with a letter or digit). Tags are case-insensitive and stored in lower case (`Root` → `root`). |
| `icon` | no | Repository-relative path to the icon. |
| `kind` | no | `module` (default) or `script`: a [one-shot script](#script-entries-kind-script) the manager runs once instead of installing. Must agree with `oneshot=1`/`true` in `module.prop` ([`manifest-kind-mismatch`](checks.md#manifest-kind-mismatch)); `script` cannot be combined with `metamodule: true`. |
| `metamodule` | no | `true` if this is a KernelSU metamodule. Default `false`. Must agree with `metamodule=1`/`true` in `module.prop`, which is what KernelSU actually uses ([`manifest-metamodule-mismatch`](checks.md#manifest-metamodule-mismatch)). |
| `authors` | no | 1–20 entries of `{name, url?}`; `name` 1–64 chars, `url` must be `https://`. The list is the **complete** author list: add or remove people by editing it. When omitted, the site and the API show the **owner of the module repository** (its GitHub login, linked to the profile). Display only — permissions come from GitHub repository admin rights, not from this list. |
| `starsRepository` | no | `owner/name` of a GitHub repository whose stars are shown instead of the module repository's, e.g. the former open-source repository of a module now published from a [closed-source release repository](closed-source.md). Used only when it is public **and** has the same owner as the module repository **or** the KernelSU Modules GitHub App is installed on it (proves you control it); otherwise the module repository's own stars are shown and a warning is reported ([`stars-repo-unverified`](checks.md#stars-repo-unverified)). |
| `compatibility` | no | Author-declared hints used for filtering; not a guarantee. See below. |
| `release` | no | See below. |

### Stars

The module list and page show the GitHub star count of the module repository (for closed-source
modules: the public release repository), or of a verified `starsRepository`. Stars are display-only,
refreshed about once a day, and never affect checks, releases or the listing.

### `compatibility`

| Field | Rule |
| --- | --- |
| `androidMinApi` | Integer 21–99 (Android API level, e.g. 29 = Android 10). |
| `androidMaxApi` | Integer 21–99. |
| `architectures` | Non-empty list of `arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`, `riscv64`. |

### `release`

| Field | Rule |
| --- | --- |
| `assetPattern` | Glob for the module ZIP among the release assets. Only `*` and `?` wildcards, no `/` or `\`, max 128 chars. Without it, a release must contain **exactly one** `.zip` asset. With it, **exactly one** asset must match. |

Set `assetPattern` when your releases contain more than one ZIP (for example a debug build or
sources). The [module-release action](releasing.md#using-the-module-release-action) names assets
`{id}-{versionCode}-{version}.zip` (with `version` sanitized for file names), so `"{id}-*.zip"` is a
good pattern.

## Script entries (`kind: script`)

An entry can be a **one-shot script** instead of a module. Hosting is the same — an immutable GitHub
release with one ZIP, checked like any module — but the KernelSU manager does not install it: it
downloads the ZIP, asks for the parameters declared in `params.json`, shows the `action.sh` source
and runs it **once** in a root shell. Nothing stays installed. Use it for tasks such as "unlock a
hidden setting" or "export a log"; anything that must run at boot or modify the system partitions is
a module.

Set `kind: script` in `module.yaml` and `oneshot=true` in `module.prop`:

```text
<id>-<version>.zip
├── module.prop      # the usual fields + oneshot=true
├── action.sh        # required: the script the manager runs
├── params.json      # optional: parameters (see below)
├── customize.sh     # optional: only used if an older manager installs the ZIP as a module
└── other files      # data the script reads via $MODPATH
```

`oneshot` is read like `metamodule`: the value, ignoring surrounding whitespace, is `1` or `true`
(case-insensitive); anything else, or no `oneshot` line, means a regular module. Older managers that
do not know script entries install the ZIP as a normal module whose **Action** button runs
`action.sh` — keep `action.sh` working in that case too.

Release checks for script entries (all errors, see [Checks](checks.md#script-entries)):

- `kind: script` exactly when `module.prop` has `oneshot=1`/`true`
  ([`manifest-kind-mismatch`](checks.md#manifest-kind-mismatch));
- a root `action.sh` ([`script-missing-action`](checks.md#script-missing-action));
- none of the module-only files `post-fs-data.sh`, `post-mount.sh`, `service.sh`,
  `boot-completed.sh`, `uninstall.sh`, `metamount.sh`, `metainstall.sh`, `metauninstall.sh`,
  `system.prop`, `sepolicy.rule`, `skip_mount` or directories `system/`, `vendor/`, `product/`,
  `system_ext/`, `odm/`, `webroot/`, `zygisk/` at the ZIP root
  ([`script-forbidden-file`](checks.md#script-forbidden-file));
- not a metamodule: `metamodule: true` in `module.yaml` is a [`manifest-schema`](checks.md#manifest-schema)
  error and `metamodule=1` in `module.prop` is [`script-metamodule`](checks.md#script-metamodule);
- a valid `params.json` when present ([`script-params-invalid`](checks.md#script-params-invalid)).

A regular module with a root `params.json` gets the warning
[`params-ignored`](checks.md#params-ignored).

In the API (`api/v1/modules.json` and `api/v1/modules/{id}.json`) every entry has
`kind: "module" | "script"`; clients treat a missing value as `module` and hide entries with a kind
they do not know.

### `params.json`

Optional, at the ZIP root, UTF-8 JSON, at most 64 KiB. JSON Schema: `schemas/params.schema.json`.

```json
{
  "schemaVersion": 1,
  "params": [
    {
      "key": "ENABLE_FASTBOOT",
      "type": "bool",
      "label": "Also enable fastboot",
      "description": "Optional longer help text",
      "default": true
    },
    { "key": "MODE", "type": "enum", "label": "Mode", "default": "a",
      "options": [ { "value": "a", "label": "A" }, { "value": "b" } ] },
    { "key": "NAME", "type": "string", "label": "Name", "default": "", "maxLength": 64,
      "required": false },
    { "key": "COUNT", "type": "int", "label": "Count", "default": 1, "min": 0, "max": 10 }
  ]
}
```

| Field | Rule |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `params` | Up to 16 parameters. |
| `key` | `^[A-Z][A-Z0-9_]{0,31}$`, unique. The value reaches the script as `KSU_PARAM_<key>`. |
| `type` | `bool`, `enum`, `string` or `int`. |
| `label` | Required. A non-empty string (≤ 200 chars). Single-language, like module content. |
| `description` | Optional string, same rules as `label`. |

Per type:

| Type | Fields |
| --- | --- |
| `bool` | `default`: `true` / `false` (default `false`). Passed as `true` / `false`. |
| `enum` | `options`: 1–32 entries `{value, label?}`; `value` matches `^[A-Za-z0-9._-]{1,64}$` and is unique. `default` must be one of the values (default: the first option). |
| `string` | `default` (default `""`), `maxLength` 1–1024 (default 256), `required` (default `false`: an empty value is always allowed). Values must not contain NUL or line breaks; there is no format check (no `pattern`), so `action.sh` must validate the value itself. |
| `int` | Optional `min` / `max`, `default` (default `min`, or `0` without `min`); `min ≤ default ≤ max`; 32-bit signed integers. Passed in decimal. |

The `default` of every parameter must satisfy its own constraints. Unknown fields are reported as a
warning and ignored; any other problem — invalid JSON, a repeated object key, an unknown
`schemaVersion`, duplicate keys or option values, a default that
violates its constraints — is [`script-params-invalid`](checks.md#script-params-invalid).

### How the manager runs `action.sh`

The manager verifies the download (sha256 and size, as for modules), checks that `module.prop` is
`oneshot` with the registered `id` and that `action.sh` exists, extracts the ZIP to a private
directory and runs, in a new root shell in the global mount namespace (like a module's Action button):

```sh
cd <dir> && <env> /data/adb/ksu/bin/busybox sh ./action.sh
```

with these environment variables (no stdin):

| Variable | Value |
| --- | --- |
| `ASH_STANDALONE` | `1` |
| `KSU` | `true` |
| `KSU_VER`, `KSU_VER_CODE`, `KSU_KERNEL_VER_CODE` | KernelSU versions, as for modules |
| `KSU_LATE_LOAD` | `1` in late-load mode only |
| `KSU_MODULE` | the entry ID |
| `KSU_ONESHOT` | `1` (lets `action.sh` tell a one-shot run from the Action button of an installed module) |
| `MODPATH` | the extraction directory (read your data files from here) |
| `PATH` | `$PATH:/data/adb/ksu/bin` |
| `KSU_PARAM_<KEY>` | one per parameter: `bool` → `true`/`false`, `int` → decimal, `enum` → the option value, `string` → as entered |

Exit code `0` means success, `2` means "not applicable to this device" (shown as a notice, not a
failure), anything else is a failure. The output is shown like the Action output and can be saved.
The manager only remembers the last run (version and exit code); there is no installed state and no
update check.

## Paths

All paths (`icon`, `description`) are relative to the **repository root** — not to `module.yaml` —
and use `/` separators. A leading `./` is accepted and removed (`./README.md` = `README.md`); paths
must not start with `/` or contain `..` segments, empty segments or `://`. Every referenced file must
exist on the tracked branch ([`manifest-path-missing`](checks.md#manifest-path-missing)).

Limits: `module.yaml` ≤ 64 KiB, the description document ≤ 512 KiB.

### What KernelSU Modules tracks

KernelSU Modules locks one **content commit** of the tracked branch and records a digest of every file it
uses: `module.yaml`, the description document, the icon and the repository images referenced by the
description (relative image paths). The locked commit only moves when one of these files changes —
pushes that touch other files (source code, CI, …) do not create a new lock entry or Check Run. The
site build fetches all of these files at the locked commit.

## Markdown and HTML in descriptions

Descriptions are rendered like GitHub READMEs: CommonMark + tables, strikethrough, autolinks, task
lists, footnotes, `:emoji:` shortcodes and `> [!NOTE]`-style alerts. Raw HTML is allowed, then
everything is passed through a whitelist sanitizer:

- **Kept:** ordinary formatting and structure (`p`, `div`, `span`, headings, lists, tables, `pre`,
  `code`, `blockquote`, `details`/`summary`, `picture`/`source`, `img`, `a`, `br`, `hr`, `kbd`,
  `sub`/`sup`, …) and presentational attributes such as `align`, `width`, `height`, `colspan`.
- **Removed with their content:** `script`, `style`, `iframe`, `object`, `embed`, `form` and form
  controls, `svg`, `math`, `audio`, `video`, `canvas`, …
- **Removed attributes:** all `on*` event handlers, `style`, and anything not on the whitelist;
  `class` values are dropped except a few the renderer itself uses; `id`/`name` values are prefixed
  with `user-content-` (as on GitHub).
- **URLs:** links may use `https:`, `http:`, `mailto:` or be relative; images may use `https:`,
  `http:` or `data:image/{png,jpeg,gif,webp,avif};base64` (≤ 256 KiB). `javascript:` and other
  schemes are removed.

Relative **links** point to the file on GitHub at the locked commit
(`https://github.com/{owner}/{repo}/blob/{commit}/{path}`). Relative paths resolve against the
document's own directory, exactly like on GitHub (in `docs/intro.md`, `../assets/x.png` is `assets/x.png`).

## Images

Images in descriptions and the icon are **copied to modules.kernelsu.org** and served under a
content-hash name, so they keep working even if you later change your repository. When copying:

- only `https` sources are fetched (relative images are fetched from your repository at the locked
  commit), the host must resolve to a public IP, at most 3 redirects;
- each image ≤ 5 MiB, at most 40 images and 40 MiB per module;
- images that fail these rules are dropped from the page.

Use PNG, JPEG, WebP or GIF. For the icon, a square PNG/WebP of at least 192×192 px works best.
Keep the original licenses and attribution of images you include.
