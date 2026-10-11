# 发布

你发布的每个版本都是**你仓库中的一个 GitHub release**，并附带模块 ZIP。模块上架后，新 release 会被自动收录，通常在几分钟内（webhook），最迟在 15 分钟的兜底同步后。更新无需审核。

## release 的要求

只有**同时满足**以下全部条件的 release 才会被使用：

1. 已**发布**（不是 draft）。
2. 是 **immutable** 的（GitHub API 中 `immutable: true`），见下文。
3. 有**恰好一个**模块 ZIP：恰好一个 `.zip` 资源；或者，若 `module.yaml` 设置了 `release.assetPattern`，则恰好一个资源与之匹配。其他不匹配的资源没有影响。
4. ZIP 通过检查：
   - ≤ 100 MiB，解压后 ≤ 512 MiB，压缩比 ≤ 200，≤ 20 000 个条目；
   - ZIP **根目录**有 `module.prop`（≤ 64 KiB，UTF-8，stored 或 deflate 压缩），含 `id`、`name`、`version`、`versionCode`、`author`、`description`。它按 KernelSU 的方式读取（Java properties 语法；同一个键重复时以**最后一个**值为准），且 `id`、`name`、`version`、`versionCode`、`author` 或 `description` 重复会被拒绝；
   - `id` 与你注册的模块 ID 完全一致；
   - 没有绝对路径、`..` 段、反斜杠或加密条目，也没有解压到同一路径的两个条目（`./a`、`a` 和 `.//a` 是同一路径）；
   - 只使用 KernelSU 能解压的压缩方法：stored、deflate、deflate64、LZMA 或 XZ。
5. 其 `versionCode` 有效且更新（见下一节）。

所有失败都会以 Check Run 的形式报告在打 tag 的 commit 上，详见[检查](checks.md)。

## Immutable release

启用 **Settings → General → Releases → Enable release immutability**（启用 release 不可变性）后，GitHub 会在 release 发布时将其锁定：资源无法被替换或删除，tag 无法移动或复用，即使仓库被删除后重建也一样。这正是 KernelSU Modules 能把 sha256 与 URL 永久绑定的原因。

- 该设置**不会追溯生效**。启用之前发布的 release 仍然可变，会被忽略。KernelSU Modules 检查的是每个 release 的 `immutable` 标志，而不是仓库设置。
- release 在**发布时**才变为 immutable。因此资源必须在 release 仍是 draft 时上传：*创建 draft → 上传 ZIP → 发布*。先发布再上传是行不通的。module-release action 和 `gh release create <tag> <file>` 都是这样做的。

### 为什么无法修复已发布的 release

immutable release 的资源和 tag 都被冻结，而且 KernelSU Modules 对每个 release 只处理一次。如果 release 有问题（ZIP 错误、`id` 错误、`versionCode` 过低等），唯一的修复办法是发布一个 **versionCode 更高的新 release**。你可以删除有问题的 release，但不能复用它的 tag，也不能复用 KernelSU Modules 已经接受过的 release 的 versionCode。

发布后仍然可以编辑的内容：标题、release notes 和预发布标记。KernelSU Modules 每次同步都会重新读取它们。

这就是发布前预检如此重要的原因：module-release action 会拒绝发布任何无法通过检查的内容，避免白白浪费一个版本号。

## versionCode 规则

- `versionCode` 必须是 **1 … 2147483647**（int32）范围内的普通十进制整数，与 KernelSU Manager 一致。只有 `versionCode` 决定哪个版本更新；`version` 字符串仅用于显示。
- 每个新 release 的 `versionCode` 必须**大于 KernelSU Modules 曾为该模块 ID 接受过的最高 versionCode**（稳定版或预发布）。这个最高值永不下降：删除 release 或转移到另一个仓库后依然保留。
- 恰好等于该最高 versionCode、且与持有该值的锁定 release 渠道相同（稳定版 / 预发布）的 release 是"同一版本"，会被忽略（Check Run 仍为成功）。
- 其他情况都会被 [`version-not-newer`](checks.md#version-not-newer) 拒绝——包括复用已删除 release 的 versionCode，以及发布与已接受预发布 versionCode 相同的正式版。
- **稳定版本**是有效的非预发布 release 中 `versionCode` 最高的那个，但 KernelSU Modules 永远不会回退到比曾经的最高稳定版更低的 versionCode。如果你删除了稳定版 release 或把它标记为预发布，模块会**从索引中隐藏**，直到你发布 versionCode 更高的 release——更早的 release 不会重新成为稳定版。
- KernelSU Modules 保留最近 10 个有效 release 作为版本历史。
- 仓库首次同步时（新上架或转移到另一个仓库），只检查最新的合格 release 及其后发布的 release；更早的 release 只做记录，不会生成 Check Run。

## release notes 即更新日志

release notes 会作为该版本的更新日志展示，渲染和清理方式与描述相同（见 [module.yaml](module-yaml.md)），最大 64 KiB。

## 预发布

在 GitHub 上将 release 标记为 **pre-release**（或在 action 中设置 `prerelease: true`）即可发布测试版。预发布会被检查并记录，但不会作为稳定版本提供；当前的站点和 Manager 暂不显示它们。预发布同样计入已接受的最高 versionCode，因此正式版要么使用更高的 versionCode，要么在 GitHub 上取消 "Set as a pre-release" 勾选来**提升该预发布**（KernelSU Modules 每次同步都会重新读取该标记）。发布与已接受预发布 versionCode 相同的正式版会被拒绝。

## 使用 module-release action

[`KernelSU-Modules/tools/actions/module-release`](https://github.com/KernelSU-Modules/tools/tree/main/actions/module-release)
会在发布**之前**对你的 ZIP 运行 KernelSU Modules 所用的同一个验证器，然后按正确顺序（draft → 上传 → 发布）发布，资源命名为 `{id}-{versionCode}-{version}.zip`。在文件名中，`version` 里每一段 `A-Z a-z 0-9 . _ -` 以外的字符会变成 `_`，首尾的 `.`、`_` 和 `-` 会被去掉，并截断为 64 个字符（若为空则为 `unknown`）——例如 version `v1.2 (beta)` 得到 `mymodule-120-v1.2_beta.zip`。显示的版本仍然原样取自 `module.prop`。

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
          module-dir: module            # 其内容将成为 ZIP 根目录的目录
          # zip: out/my-module.zip      # …或前面步骤中构建好的 ZIP
          release-notes-file: CHANGELOG.md
```

请将 action 固定到完整的 commit SHA。主要输入：

| 输入 | 默认值 | 说明 |
| --- | --- | --- |
| `zip` / `module-dir` | — | 二选一：预构建的 ZIP，或要打包的目录（会跳过 VCS 文件）。 |
| `tag` | 推送的 tag | 要发布的 tag。 |
| `prerelease` | `false` | 作为预发布发布。 |
| `release-notes` / `release-notes-file` | — | release notes（更新日志）。 |
| `asset-pattern` | `release.assetPattern` | 用于匹配生成的资源名。 |
| `dry-run` | `false` | 运行全部检查但不发布（适合在 pull request 中使用）。 |

输出：`release-id`、`release-url`、`asset-name`、`sha256`（另有 `zip-path`、`module-id`、`version`、`version-code`）。完整列表见 action 的 README。

action 的检查只是为了方便；KernelSU Modules 仍会在自己一侧再次验证每个 release。

### 不使用 action

任何工具都可以，只要保证 release 是在上传 ZIP *之后*才发布的，例如：

```sh
gh release create v1.2.0 my_module-120-v1.2.0.zip --title v1.2.0 --notes-file CHANGELOG.md
```

## 可选：托管的 update.json

KernelSU 会读取 `module.prop` 中的 `updateJson` 来进行应用内更新。KernelSU Modules 会为每个已上架的模块发布一个经过验证的 update.json：

```properties
updateJson=https://modules.kernelsu.org/api/v1/modules/<id>/update.json
```

它包含当前稳定版本的 `version`、`versionCode`、`zipUrl` 以及 `changelog` URL，并在每次同步后更新，因此你无需自行维护文件。`changelog` URL（`https://modules.kernelsu.org/api/v1/modules/<id>/changelog.md`）以纯 Markdown 提供该版本的 Release 说明（KernelSU 会在更新前显示；Release 没有说明时为 `(no release notes)`）。
