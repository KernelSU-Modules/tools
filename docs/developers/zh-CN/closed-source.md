# 闭源模块

KernelSU Modules 只收录**公开** GitHub 仓库中的模块。如果你不想公开源代码，可以把源码放在**私有**仓库中，再把 release 发布到一个单独的**公开分发仓库**。[module-release action](releasing.md) 可以完成这件事：它在私有仓库中运行，只写入分发仓库。

## 为什么发布 release 的仓库必须公开

- KernelSU Modules、KernelSU Manager 和所有用户都是**匿名**从 GitHub release 下载 ZIP 的。私有仓库的 release 资源需要 GitHub token 才能下载，因此无法提供给用户。
- ZIP 本来就是公开分发的：每个安装你模块的人都会拿到它。把它放在公开仓库中，不会泄露 ZIP 本身之外的任何内容。
- KernelSU Modules 从仓库读取 `module.yaml`、描述文档和图标，并在那里发布 Check Run。它永远不需要访问你的源代码。

## 仓库布局

```
my-module-src（私有）                     my-module（公开，分发仓库）
────────────────────────                 ─────────────────────────────────
源代码、构建脚本                           module.yaml、README.md、图标、图片  ◄─ 由 action 同步
module.yaml、README.md、图标、图片          tag v1.2.0 → immutable release + ZIP ◄─ 由 action 发布
.github/workflows/release.yml  ──────►   在此安装 KernelSU Modules App（仅此仓库）
  （secret DIST_REPO_TOKEN）               在 KernelSU 开发者门户中提交此仓库
```

`module.yaml`、描述文档和图标**只在私有仓库中编辑**。每次发布时，action 会把它们（以及描述中引用的仓库内图片）复制到分发仓库默认分支上的相同路径，只用一个 commit，并且只在有变化时提交。它从不删除分发仓库中的文件。不要在分发仓库中手动编辑这些文件：下一次发布会用私有仓库中的版本覆盖它们。

## 一次性设置

1. **创建公开的分发仓库**，例如 `my-name/my-module`。勾选 **Add a README file**，让它有一个默认分支（action 无法向空仓库提交）。
2. 在分发仓库中启用 **Settings → General → Releases → Enable release immutability**（启用 release 不可变性）（[GitHub 文档](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)）。
3. **只在分发仓库上安装 KernelSU Modules App**（<https://github.com/apps/kernelsu-modules/installations/new>，选择 *Only select repositories*）。不要安装到私有仓库：KernelSU Modules 在那里用不到它，私有仓库本来也无法上架。
4. **创建 fine-grained personal access token**（GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens）：
   - *Resource owner*：分发仓库的所有者；
   - *Repository access*：**Only select repositories** → 只选分发仓库；
   - *Permissions*：**Contents: Read and write**（Metadata: Read-only 会自动添加）。可选 **Administration: Read-only**，这样 action 可以确认 release 不可变性已启用（没有它只会给出警告，action 仍会检查已发布的 release）；
   - 一个你记得住的过期时间（见[令牌轮换](#token-rotation)）。
5. 在**私有**仓库中把 token 保存为 Actions secret：**Settings → Secrets and variables → Actions → New repository secret**，名称为 `DIST_REPO_TOKEN`。
6. 在私有仓库中添加 `module.yaml`（见 [module.yaml](module-yaml.md)）、描述文档和图标，并把[下面的工作流](#工作流)复制到私有仓库的 `.github/workflows/release.yml`。
7. **先以 dry run 运行一次**：Actions → *Release* → **Run workflow**。手动运行只做检查：token、分发仓库（公开、不可变性、写权限）、你的 ZIP 和 `module.yaml`，并列出将要同步的文件。它不会写入任何内容。
8. **发布第一个 release**：提升 `module.prop` 中的 `versionCode`，然后推送一个附注 tag（annotated tag）：

   ```sh
   git tag -a v1.0.0 -m "v1.0.0" -m "- 首个版本"
   git push origin v1.0.0
   ```

9. 在 [KernelSU 开发者门户](https://developers.kernelsu.org)中**提交分发仓库**（不是私有仓库），见[快速开始](getting-started.md#7-提交)。你需要拥有分发仓库的 admin 角色。

## 工作流

在**私有**仓库中创建 `.github/workflows/release.yml`：

```yaml
name: Release
on:
  push:
    tags: ['v*']
  workflow_dispatch: # 手动运行 = dry run（只检查，不写入）
permissions:
  contents: read # 分发仓库的 token 来自 secret
concurrency:
  group: release
  cancel-in-progress: false
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<40-char-sha>
        with:
          fetch-depth: 0 # 拉取附注 tag，其消息将作为 release notes

      # 占位：构建模块 ZIP（module.prop 位于 ZIP 根目录）。
      - run: ./build.sh --out out/my_module.zip

      - uses: KernelSU-Modules/tools/actions/module-release@<40-char-sha>
        with:
          zip: out/my_module.zip
          repository: my-name/my-module # 公开的分发仓库
          token: ${{ secrets.DIST_REPO_TOKEN }}
          tag: ${{ github.ref_type == 'tag' && github.ref_name || '' }}
          dry-run: ${{ github.event_name == 'workflow_dispatch' }}
```

请把两个 action 都固定到完整的 40 位 commit SHA，不要使用分支名。

在这种模式下，action 会：

1. **预检**（dry run 也会执行）：token 已设置，且不是工作流自带的 `GITHUB_TOKEN`（它无法写入其他仓库）；分发仓库存在、可读、**公开**且未归档；token 有推送权限；已启用 release 不可变性；默认分支至少有一个 commit。它还会提醒你在分发仓库上安装 KernelSU Modules App（用你的 token 无法检查这一点）。
2. **检查 ZIP 和 `module.yaml`**，与普通发布完全相同，并对照分发仓库中的 release（versionCode 必须更新，tag 不能已被使用）。
3. **同步元数据**：如果 `module.yaml`、描述文档、图标和描述中引用的仓库内图片与分发仓库默认分支上的不同，就把它们提交过去（commit 消息为 `Sync module metadata for <tag>`）。适用 KernelSU Modules 的限制：描述超过 512 KiB 或图标超过 5 MiB 会导致运行失败；超过 5 MiB、总量超过 40 MiB 或第 40 张之后的图片会被跳过并给出警告。
4. **创建 tag**：在分发仓库中把 tag 创建在这个 commit 上（若没有变化，则创建在当前 HEAD 上）。如果该 tag 已存在并指向别处，运行会在写入任何内容之前失败：tag 永远不会被移动或复用。
5. **发布 release**：draft → 上传 ZIP → 发布，然后确认 release 是 immutable 的。

除了常规的 `release-url`、`asset-name`、`sha256` 等输出外，还有 `repository` 和 `metadata-commit`（无需提交时为空），见[发布](releasing.md)。

之后 KernelSU Modules 会像处理其他 release 一样从分发仓库收录它；Check Run 显示在**分发仓库**中打 tag 的 commit 上。

## Release notes

分发仓库没有源码历史，GitHub 自动生成的 release notes 没有意义，因此 `generate-release-notes` 会被忽略。release notes 按以下顺序确定：

1. 如果设置了 `release-notes` 或 `release-notes-file`，使用它；
2. 否则使用你推送的**附注 tag**（`git tag -a`）的消息。action 从检出的仓库中读取它，所以 `actions/checkout` 需要 `fetch-depth: 0`：浅检出 tag 时只会创建一个没有消息的轻量 tag；
3. 否则为空（并给出警告）。

release notes 会作为该版本的更新日志展示。发布后仍可在 GitHub 上编辑。

## 令牌轮换 {#token-rotation}

Fine-grained token 会过期。当 token 将在 30 天内过期时，action 会给出警告（依据 GitHub 的 `github-authentication-token-expiration` 响应头）。请在过期前重新生成 token（或用相同设置新建一个），并更新 `DIST_REPO_TOKEN` secret。token 过期后，运行会在写入任何内容之前以 HTTP 401 失败。

### 替代方案：你自己的 GitHub App

除了个人 token，你也可以创建自己的 GitHub App（不是 KernelSU Modules App），授予 **Contents: Read and write**，只安装在分发仓库上；在私有仓库中把它的 ID 保存为 variable、私钥保存为 secret，然后在工作流中生成短期 token：

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

这类 token 一小时后就会过期，除私钥外无需轮换。

## 不要这样做

- **不要让分发仓库能访问私有仓库**。分发仓库中不要放任何能读取源码的 secret、deploy key 或 token。它根本不需要任何工作流。
- **不要扩大 token 的权限范围**。它应当只能访问分发仓库。任何持有它的人都能向你的用户发布模块更新，所以只把它保存在私有仓库的 secret 中，并只在发布工作流中使用。
- **不要在私有仓库上安装 KernelSU Modules App**。它只需要分发仓库。而且该 App 从不写入你的仓库（它唯一的写权限是 Check Run）。
- **不要把分发仓库设为私有**。同步会停止，模块会被标记为 stale。
- **不要手动编辑分发仓库中被同步的文件**，也不要在那里复用 tag：每次发布都创建新 tag（并使用更高的 versionCode）。
