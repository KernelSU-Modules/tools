# Getting started

This page takes a module from "lives in my GitHub repository" to "listed on
modules.kernelsu.org". Budget about 15 minutes plus review time.

**Requirements:** a **public** GitHub repository you administer, containing a KernelSU module whose
`module.prop` has `id`, `name`, `version`, `versionCode`, `author` and `description`.

## 1. Enable release immutability

In your repository: **Settings → General → Releases → Enable release immutability**
([GitHub docs](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)).

KernelSU Modules only accepts releases that are immutable. The setting is **not retroactive**: releases
published before you turned it on stay mutable and will be ignored, so you will publish a new
version in step 6.

## 2. Pick your module ID

The ID is the `id` in `module.prop`. It must:

- match `^[a-zA-Z][a-zA-Z0-9._-]+$`, 2–64 characters;
- not end with `.json`, `.html`, `.htm`, `.md`, `.xml` or `.txt` (any letter case; see
  [`id-reserved-suffix`](checks.md#id-reserved-suffix));
- not be reserved (`ksu`, `kernelsu`, `magisk`, `apatch`, `test`, `example`, `module`, or start
  with `org.kernelsu.` / `me.weishu.`);
- not differ only in letter case from an existing module.

You can check availability in the Portal before submitting. IDs never change after listing.

## 3. Add module.yaml

Create `module.yaml` at the repository root. Minimal version:

```yaml
schemaVersion: 1
id: my_module               # must equal module.prop id
name: My Module
summary: One sentence about what it does
description: README.md      # Markdown file shown as the detail page
```

Commit it to your default branch. See the [module.yaml reference](module-yaml.md) for icons,
tags and compatibility hints. Module text is single-language: write `name`, `summary` and the
description in the language you want users to see.

## 4. Install the KernelSU Modules App

Sign in to the [KernelSU Developer Portal](https://developers.kernelsu.org) and follow **Install the App**,
or install it from GitHub directly. Select only the repositories you want to submit.

The App is **read-only** on your code (Metadata: read, Contents: read). Its only write permission is
**Checks**, used to report validation results. Installing it proves that you administer the
repository; it does not submit anything by itself.

Repositories owned by an organization need the organization owner to approve the installation.

## 5. Precheck

In the Portal, open **My repositories → Precheck**. It validates `module.yaml` (and that the
files it references exist), your module ID and the newest release (immutable? exactly one ZIP?). It does not
download the ZIP: right after you submit, and again for every new release, the KernelSU Modules sync job
(GitHub Actions) checks the ZIP and its `module.prop` and reports the result as a **KernelSU Modules**
Check Run on your repository and in the Portal. While your submission is open, every sync run
re-validates the repository whenever the branch head or the newest release changes (or when you
press **Sync now**). Fix everything marked as an error; [Checks](checks.md) explains each code.

## 6. Publish an immutable release

Bump `versionCode`, push a tag and publish a release with exactly one module ZIP. The easiest way is
the [module-release action](releasing.md#using-the-module-release-action), which prechecks locally
before anything is published:

```yaml
- uses: KernelSU-Modules/tools/actions/module-release@<commit-sha>
  with:
    module-dir: module   # or: zip: path/to/prebuilt.zip
```

## 7. Submit

In the Portal: **My repositories → Submit**, confirm the ID. Your module becomes **pending** and a
maintainer reviews it — usually within a few days. The review only checks that the module follows
the rules (no spam, no abuse, an appropriate ID, not squatting someone else's name); it is not a
code audit.

After approval the status becomes **listed** and the module appears on the site after the next sync
(minutes). On this first sync only your newest eligible release (and anything published after it) is
checked; older releases are recorded without Check Runs. From now on every new immutable release
with a higher versionCode is published automatically.
