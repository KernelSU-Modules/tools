# 快速开始

本页带你把模块从"放在我的 GitHub 仓库里"变成"上架 modules.kernelsu.org"。预计耗时约 15 分钟，另加审核时间。

**前提**： 一个你拥有管理员权限的**公开** GitHub 仓库，其中包含一个 KernelSU 模块，且其 `module.prop` 含有 `id`、`name`、`version`、`versionCode`、`author` 和 `description`。闭源模块可以把源码放在私有仓库，发布到公开的分发仓库，见[闭源模块](closed-source.md)；此时下面的步骤都针对分发仓库。

## 1. 启用 release 不可变性

在你的仓库中：**Settings → General → Releases → Enable release immutability**（启用 release 不可变性）
（[GitHub 文档](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)）。

KernelSU Modules 只接受 immutable 的 release。该设置**不会追溯生效**：启用之前发布的 release 仍然可变，会被忽略，因此你需要在第 6 步发布一个新版本。

## 2. 选择模块 ID

ID 即 `module.prop` 中的 `id`，必须满足：

- 匹配 `^[a-zA-Z][a-zA-Z0-9._-]+$`，长度 2–64 个字符；
- 不以 `.json`、`.html`、`.htm`、`.md`、`.xml` 或 `.txt` 结尾（不区分大小写，见 [`id-reserved-suffix`](checks.md#id-reserved-suffix)）；
- 不是保留 ID（`ksu`、`kernelsu`、`magisk`、`apatch`、`test`、`example`、`module`，或以 `org.kernelsu.` / `me.weishu.` 开头）；
- 不与已有模块仅存在大小写差异。

提交前可以在 Portal 中检查 ID 是否可用。ID 上架后不可更改。

## 3. 添加 module.yaml

在仓库根目录创建 `module.yaml`。最小示例：

```yaml
schemaVersion: 1
id: my_module               # 必须与 module.prop 的 id 一致
name: My Module
summary: One sentence about what it does
description: README.md      # 作为详情页展示的 Markdown 文件
```

将其提交到默认分支。图标、标签和兼容性提示见 [module.yaml 参考](module-yaml.md)。模块文本是单语言的：请用你希望用户看到的语言编写 `name`、`summary` 和描述。

## 4. 安装 KernelSU Modules App

登录 [KernelSU 开发者门户](https://developers.kernelsu.org)并按 **Install the App** 操作，或直接从 GitHub 安装。只选择你要提交的仓库。

该 App 对你的代码是**只读**的（Metadata: read、Contents: read），唯一的写权限是 **Checks**，用于报告验证结果。安装 App 即证明你是该仓库的管理员，但它本身不会提交任何内容。

属于组织的仓库需要组织所有者批准安装。

## 5. 预检

在 Portal 中打开 **My repositories → Precheck**。它会验证 `module.yaml`（及其引用的文件是否存在）、模块 ID 以及最新的 release（是否 immutable？是否恰好一个 ZIP？）。预检不会下载 ZIP：提交后以及之后每次发布新 release 时，KernelSU Modules 的同步任务（GitHub Actions）都会检查 ZIP 及其中的 `module.prop`，并把结果作为 **KernelSU Modules** Check Run 报告在你的仓库上，同时显示在 Portal 中。提交处理期间，只要分支最新 commit 或最新 release 发生变化（或你点击 **Sync now**），每次同步都会重新验证该仓库。请修复所有标记为错误的项目；各代码的含义见[检查](checks.md)。

## 6. 发布 immutable release

提升 `versionCode`，推送 tag，并发布只包含一个模块 ZIP 的 release。最简单的方式是使用 [module-release action](releasing.md)，它会在发布前先在本地预检：

```yaml
- uses: KernelSU-Modules/tools/actions/module-release@<commit-sha>
  with:
    module-dir: module   # 或：zip: path/to/prebuilt.zip
```

## 7. 提交

在 Portal 中：**My repositories → Submit**，确认 ID。模块进入 **pending** 状态，由维护者审核，通常需要几天。审核只检查模块是否遵守规则（无垃圾内容、无滥用、ID 合适、没有抢注他人名称），不是代码审计。

通过后状态变为 **listed**，模块会在下一次同步（几分钟）后出现在站点上。首次同步只检查你最新的合格 release（及其后发布的 release）；更早的 release 只做记录，不会生成 Check Run。此后每个 versionCode 更高的新 immutable release 都会自动发布。
