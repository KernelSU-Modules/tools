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
