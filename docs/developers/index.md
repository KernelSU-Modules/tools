# KernelSU Modules — developer documentation

[KernelSU Modules](https://modules.kernelsu.org) is a static catalog of KernelSU
modules. **You keep your module in your own GitHub repository** and publish ZIPs as
**immutable GitHub releases**; KernelSU Modules only indexes them. It never hosts, mirrors or rebuilds
your ZIP.

> 中文版：[zh-CN](zh-CN/index.md)

## How it works

```
your repository                         KernelSU Modules
───────────────                         ────────────────
module.yaml + README/docs + icon   ──►  read at your default branch (display metadata)
tag → immutable release + ZIP      ──►  ZIP checked (module.prop, size, structure), sha256 locked
                                        ▼
                                   modules.kernelsu.org + KernelSU Manager
```

1. **One-time setup** – enable release immutability, add `module.yaml`, install the read-only
   *KernelSU Modules* GitHub App, and submit the repository in the
   [KernelSU Developer Portal](https://developers.kernelsu.org). A maintainer reviews the first submission.
2. **Every release** – bump `versionCode` in `module.prop`, push a tag, publish an immutable release
   with exactly one module ZIP. Our [release action](releasing.md#using-the-module-release-action)
   does this for you. KernelSU Modules picks it up within minutes, no review needed.
3. **Feedback** – results appear as a **Check Run named "KernelSU Modules"** on the tagged commit
   and in the Portal. There are no e-mails or issues.

## What comes from where

| Information | Source |
| --- | --- |
| id, version, versionCode | `module.prop` inside the release ZIP |
| Download URL, size, sha256, tag, commit | The immutable release (computed by KernelSU Modules) |
| Changelog | The release notes |
| Name, summary, description, icon, tags, links | `module.yaml` and the files it references, on your default branch |

## Pages

- [Getting started](getting-started.md) – from zero to listed
- [module.yaml reference](module-yaml.md)
- [Releasing](releasing.md) – immutable releases, versionCode, the release action
- [Closed-source modules](closed-source.md) – private source, public distribution repository
- [Checks](checks.md) – every check result code and how to fix it
- [KernelSU Developer Portal](portal.md) – submit, transfer, sync, statuses
- [FAQ](faq.md) – guarantees, signing, privacy

A complete working example is
[KernelSU-Modules/example-module](https://github.com/KernelSU-Modules/example-module).
