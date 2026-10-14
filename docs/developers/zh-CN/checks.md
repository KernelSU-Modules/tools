# 检查：查看并修复验证结果

KernelSU Modules **仅**通过名为 **"KernelSU Modules"** 的 GitHub **Check Run** 报告验证结果（Portal 中也会显示相同结果）。不会发送邮件，也不会创建 issue。

## 在哪里查看结果

- **在 GitHub 上**： 打开仓库的 **Commits** 或 **Tags** 页面。commit 旁边有 ✓ 或 ✗，点击后打开 **KernelSU Modules**。
  - release 检查（ZIP、module.prop、versionCode）附加在**你的 release tag 所指向的** commit 上。
  - `module.yaml` 和文档检查附加在被跟踪分支上 KernelSU Modules 发现**被跟踪文件发生变化**（`module.yaml`、描述文档、图标或描述引用的仓库内图片）的 commit 上。只修改其他文件的推送不会产生 Check Run。内容无效期间，每个新的失败 commit 会得到一个失败的 Check Run。
  - 仓库问题（仓库变为私有、所有者变化）会以失败的 Check Run 报告在被跟踪分支的**当前最新 commit** 上。
  - 提交或转移申请处理期间，**申请的**仓库会收到同样的内容和 release Check Run（转移时为新仓库）。
  - Check Run 上的 **Re-run** / **Sync now** 以及 Portal 中的 **立即同步** 总会发布一个新的 Check Run，即使没有任何变化。
  - release 页面本身不显示检查结果。
- **命令行**：

  ```sh
  gh api repos/{owner}/{repo}/commits/{tag}/check-runs \
    --jq '.check_runs[] | select(.name == "KernelSU Modules") | {conclusion, title: .output.title, summary: .output.summary}'
  ```

  请在仓库的本地克隆中运行：`gh` 会自动填入 `{owner}` 和 `{repo}`。把 `{tag}` 替换为 release 的 tag（例如 `v1.2.0`）或 commit SHA——`gh` 不会自动填入它。

- **在 Portal 中**： **我的模块** 显示相同的结果、锁定的版本、上次同步时间以及数据是否 stale。如果仓库上没有安装 KernelSU Modules App，就完全无法发布 Check Run，此时只能在 Portal 中看到问题。

每个问题都有一个代码（例如 `version-not-newer`），对应下文中的一个小节。错误会阻止 release 或内容更新；警告不会。

## 修复之后

| 问题出在… | 该怎么做 |
| --- | --- |
| release、其 ZIP、`module.prop` 或 `versionCode` | Immutable release 无法修改。请发布一个 **versionCode 更高的新 release**。 |
| `module.yaml`、描述文档、图标或图片 | 将修复推送到被跟踪的分支，然后点击 Check Run 上的 **Re-run**，或使用 Check Run 上的 **Sync now** / Portal 中的 **立即同步**，或等待下一次同步（≤ 15 分钟）。 |
| 临时的下载 / 网络错误 | 点击 Check Run 上的 **Re-run** / **Sync now**，或 Portal 中的 **立即同步**：因可重试原因（`asset-download-failed`、`asset-size-mismatch`、`asset-digest-mismatch`、`tag-not-found`）失败的 release 会被重新检查。 |

**发布前预检**。 [module-release action](releasing.md) 会在发布任何内容之前运行同一个验证器，所以出错不会浪费版本号。Portal 的 **预检** 通过 GitHub API 检查 `module.yaml` 和最新的 release，不会下载或读取 ZIP。ZIP 和 `module.prop` 由同步任务（GitHub Actions）在你提交后立即检查，并在之后每次发布新 release 时再次检查——结果显示在此 Check Run 和 Portal 中。

仓库绑定后首次同步时（新上架或转移到另一个仓库），只检查最新的合格 release（immutable 且不是预发布）以及其后发布的 release；更早的 release 只做记录，不会生成 Check Run。

提交和转移的**审核**结果（通过 / 拒绝及原因）显示在 [Portal](portal.md) 中，而不是 Check Run 里。

## 问题代码

按领域分组。下面引用的限制是 KernelSU Modules 策略（`policy.yaml`）当前的默认值。

## 模块 ID

### id-invalid

**原因**：模块 ID 不匹配 `^[a-zA-Z][a-zA-Z0-9._-]+$`，或长度不在 2–64 个字符之间。

**修复**：使用以字母开头、只包含字母、数字、`.`、`_` 和 `-` 的 ID。

### id-reserved

**原因**：该 ID 是策略保留的 ID（`ksu`、`kernelsu`、`magisk`、`apatch`、`test`、`example`、`module`，或以 `org.kernelsu.` / `me.weishu.` 开头；不区分大小写比较）。

**修复**：换一个 ID。

### id-reserved-suffix

**原因**：该 ID 以 KernelSU Modules 自身文件使用的后缀结尾：`.json`、`.html`、`.htm`、`.md`、`.xml` 或 `.txt`（不区分大小写）。网站和 API 会根据 ID 生成文件名，这样的 ID 会与其他模块的文件冲突。

**修复**：换一个不带该后缀的 ID，例如用 `foo-json` 或 `foo.tools` 代替 `foo.json`。

### id-collision

**原因**：该 ID 与已注册的 ID 仅有大小写差异。

**修复**：选择一个不是现有 ID 大小写变体的 ID。

## 仓库与内容

### repo-not-found

**原因**： 绑定的仓库已不存在，或 KernelSU Modules App 已无法访问它（App 被卸载，或仓库已从安装中移除）。

**修复**： 恢复仓库，或在该仓库上重新安装 App。如果模块已搬到其他仓库，请在 Portal 中使用 **转移**。

### repo-private

**原因**： 绑定的仓库是私有仓库。只有公开仓库才能被收录。

**修复**： 将仓库设为公开。（以失败的 Check Run 报告在被跟踪分支的最新 commit 上。）

### owner-changed

**原因**： 模块注册后，仓库被转移给了其他所有者。这会被视为所有权变更。

**修复**： 在 Portal 中提交 **转移** 申请，由维护者确认新的所有者。（以失败的 Check Run 报告在被跟踪分支的最新 commit 上；转移通过前同步暂停。）

### ref-not-found

**原因**： 无法解析跟踪的分支（或默认分支）。

**修复**： 重新创建该分支，或联系维护者更新跟踪的分支。

### tag-not-found

**原因**： 无法将该 release 的 tag 解析到某个 commit。

**修复**： immutable release 的 tag 不会变化；如果 tag 仍然丢失，请发布一个 versionCode 更高的新 release。

### content-not-file

**原因**： KernelSU Modules 使用的某个路径（`module.yaml`、图标或描述文档）是目录、符号链接或子模块，而不是普通文件。

**修复**： 让该路径指向仓库中已提交的普通文件。

### content-too-large

**原因**： KernelSU Modules 读取的某个文件超过了大小上限：`module.yaml` 64 KiB，描述文档 512 KiB，图片 5 MiB。描述中引用的仓库内图片过大是警告（该图片不会出现在页面上）；`module.yaml`、描述文档或图标过大是错误。

**修复**： 缩小文件（压缩图片、拆分过长的文档）。

## module.yaml

### manifest-missing

**原因**：被跟踪分支上，注册的路径（默认为仓库根目录）下没有 `module.yaml`。

**修复**：提交 `module.yaml`，见 [module.yaml 参考](module-yaml.md)。

### manifest-too-large

**原因**：`module.yaml` 大于 64 KiB。

**修复**：保持简短；长文本应放在描述用的 Markdown 文件中。

### manifest-yaml

**原因**：文件不是有效的 YAML：语法错误、重复的键、多个文档或过多的别名。

**修复**：修正语法（消息中会显示行号）。YAML linter 或 action 的 `dry-run` 会有帮助。

### manifest-unsupported-version

**原因**：`schemaVersion` 不是 KernelSU Modules 支持的版本。

**修复**：设置 `schemaVersion: 1`。

### manifest-schema

**原因**：某个字段的类型或值错误，或缺少必填字段（`name`、`summary`、`description` 等）——这是错误。未知字段（包括拼写错误）和 `homepage`/`support` 使用 `http://` 属于警告：未知字段会被忽略。消息中会指出字段名。

**修复**：按照[参考](module-yaml.md)的说明更正该字段。可能被 YAML 解析为数字或布尔值的内容请加引号。

### manifest-id-mismatch

**原因**：`module.yaml` 中的 `id` 与你注册的模块 ID 不一致。

**修复**：将 `id` 设置为与注册的 ID 完全一致（区分大小写）。

### manifest-path-missing

**原因**：`module.yaml` 引用的文件（`icon` 或 `description`）在同步的 commit 中不存在。

**修复**：提交该文件或修正路径。路径相对于仓库根目录而非 `module.yaml`，且区分大小写。

### manifest-paths-unchecked

**原因（警告，仅 Portal 预检**）：`module.yaml` 引用的文件分布在比预检会查看的更多的目录中，因此其中一些尚未检查。

**修复**：只要文件已提交就无需处理；同步任务会在提交后检查每个被引用的文件，如有缺失会在 Check Run 和 Portal 中报告 `manifest-path-missing`。

### manifest-metamodule-mismatch

**原因（警告**）：`module.yaml` 中的 `metamodule` 与 release 中 `module.prop` 不一致。只有当 `module.prop` 含有 `metamodule=1` 或 `metamodule=true`（不区分大小写，忽略首尾空白）时，KernelSU 才把模块当作元模块；其他任何值或没有 `metamodule` 行都表示普通模块。

**修复**：当且仅当 `module.prop` 含有 `metamodule=1`（或 `true`）时，在 `module.yaml` 中设置 `metamodule: true`。修改 `module.yaml` 只需推送；修改 `module.prop` 需要发布新 release。

### manifest-kind-mismatch

**原因**：`module.yaml` 中的 `kind` 与 release 中的 `module.prop` 不一致。[脚本条目](module-yaml.md#脚本条目kind-script)（`kind: script`）要求 `module.prop` 含有 `oneshot=1` 或 `oneshot=true`（不区分大小写，忽略首尾空白）；含有 `oneshot` 的 `module.prop` 则要求 `kind: script`。该 release 会被拒绝：否则管理器会安装脚本或运行模块。

**修复**：当且仅当 `module.prop` 含有 `oneshot=1`（或 `true`）时，在 `module.yaml` 中设置 `kind: script`；普通模块省略 `kind`（或设为 `kind: module`）并去掉 `oneshot`。修改 `module.prop` 需要发布新 release；把已有条目在模块与脚本之间切换时，请先推送 `module.yaml` 的修改，再发布 release。

### stars-repo-unverified

**原因（警告**）：`module.yaml` 中的 `starsRepository` 指向的仓库无法用于显示 Star：仓库不存在、是私有仓库，或属于其他账号且没有安装 KernelSU Modules App。模块页面会改为显示模块自身仓库的 Star 数。该警告不会阻止 release 或上架，只会出现在内容 Check Run 中，并作为提示显示在开发者门户。

**修复**：使用与模块仓库属于同一账号的公开仓库，或在该 Star 仓库上安装 KernelSU Modules GitHub App（安装 App 需要该仓库的管理员权限，以此证明你控制该仓库；App 不会在那里报告任何内容）。然后点击 **立即同步**（Portal）或 **Sync now**（Check Run），否则会在一天内重新检查。

## release 选择

### release-none

**原因**：仓库还没有已发布的（非预发布）release。

**修复**：发布一个包含模块 ZIP 的 immutable release。

### release-rejected

**原因**：release 被拒绝，且没有更具体的错误码。

**修复**：在 Check Run 详情中查看完整信息，修复后用更大的 versionCode 发布新 release。

### release-exists

**原因**：（module-release Action）该 tag 已存在 release。

**修复**：提升 version 和 versionCode 并推送新 tag；immutable release 无法替换。

### previous-release-unreadable

**原因**：（module-release Action，警告）无法读取最新的已有 release 来比较 versionCode。

**修复**：通常无碍；确认新的 versionCode 大于所有已发布版本即可。

### release-draft

**原因**：该 release 仍是 draft。

**修复**：发布它。

### release-not-published

**原因**：该 release 没有发布日期（尚未发布）。

**修复**：发布它。

### release-not-immutable

**原因**：该 release 不是 immutable。要么 release 不可变性未启用，要么该 release 发布于你启用之前。

**修复**：启用 **Settings → General → Releases → Enable release immutability**（启用 release 不可变性），然后发布一个 versionCode 更高的**新** release。见[发布](releasing.md)。

### asset-pattern-invalid

**原因**：`release.assetPattern` 为空，或包含 `/` 或 `\`。

**修复**：使用只含 `*` 和 `?` 的文件名 glob，例如 `"my_module-*.zip"`。

### asset-none

**原因**：没有资源匹配 `release.assetPattern`；或者在未设置 pattern 时，release 中没有 `.zip` 资源。

**修复**：将模块 ZIP 附加到新的 release，或更正 `module.yaml` 中的 `assetPattern`（然后 **Re-run**）。

### asset-multiple

**原因**：有多个资源匹配 `release.assetPattern`；或者在未设置 pattern 时，release 中有多个 `.zip`。

**修复**：设置 `release.assetPattern`，使其只匹配一个资源，然后 **Re-run**。

### asset-not-uploaded

**原因**：资源上传未完成（状态不是 `uploaded`）。

**修复**：发布新的 release；请在发布之前上传资源。

### asset-url-invalid

**原因**：资源的下载 URL 不是你所注册仓库的 release 下载地址。

**修复**：将 ZIP 附加到注册仓库本身的 release 上。

### asset-download-failed

**原因**：KernelSU Modules 无法下载该资源（网络错误、仓库为私有或不可用）。

**修复**：通常是暂时的，使用 **立即同步**（Portal）或 **Sync now**（Check Run）。确保仓库和 release 是公开的。

### asset-size-mismatch

**原因**：下载到的大小与 GitHub 报告的大小不一致。

**修复**：通常是暂时的，重试即可。如果持续出现，请发布新的 release。

### asset-digest-mismatch

**原因**：下载的 ZIP 的 sha256 与 GitHub 报告的该资源 digest 不一致。

**修复**：通常是暂时的，重试即可。如果持续出现，请发布新的 release。

## 版本

### version-not-newer

**原因**：该 release 的 `versionCode` 不大于 KernelSU Modules 曾为该模块 ID 接受过的最高 `versionCode`（稳定版或预发布）。这个最高值永不下降：删除 release 或转移到另一个仓库后依然保留。与锁定 release 渠道相同（稳定版 / 预发布）且恰好等于该最高 versionCode 的 release 被视为同一版本，会被静默忽略；其他情况都会被拒绝，包括：

- 复用已删除 release 的 versionCode；
- 发布与已接受的预发布 versionCode 相同的正式版。

**修复**：发布新的 release，并在 `module.prop` 中使用更高的 `versionCode`。如果想不提升版本号就结束测试，请取消已接受预发布的 **pre-release** 勾选，它会被提升为稳定版。见 [versionCode 规则](releasing.md#versioncode-规则)。

## ZIP 结构

KernelSU Modules 只读取 ZIP 的中央目录和 `module.prop`，从不解压或运行任何内容。条目名称按 KernelSU 解压时的方式比较：去掉 `.` 和空的路径段，因此 `./module.prop`、`.//module.prop` 和 `module.prop` 是同一个文件。由 `zip`、7-Zip、Android Studio 或 module-release action 制作的压缩包都能通过这些检查。

### zip-too-large

**原因**：ZIP 大于 100 MiB。

**修复**：减小模块体积（例如在安装时再下载大型数据）。

### zip-not-zip

**原因**：该资源不是 ZIP（没有 end-of-central-directory 记录），或压缩包后面被追加了数据。

**修复**：上传普通的 ZIP 文件。

### zip-corrupt

**原因**：ZIP 结构不一致（偏移、签名或大小有误）。

**修复**：用标准工具重新创建 ZIP。

### zip-multi-disk

**原因**：分卷 / 多卷压缩包。

**修复**：创建单文件 ZIP。

### zip64-invalid

**原因**：ZIP64 记录缺失，或与常规头部矛盾。

**修复**：用标准工具重新创建 ZIP。

### zip-too-many-entries

**原因**：条目数超过 20 000。

**修复**：减少文件数量（把数据打包成模块内的一个压缩包）。

### zip-uncompressed-too-large

**原因**：解压后的总大小超过 512 MiB。

**修复**：减少模块内容。

### zip-bomb-ratio

**原因**：压缩包整体或单个大条目的压缩比超过 200:1。

**修复**：移除高度可压缩的填充内容（例如全零的镜像），改为在安装时生成。

### zip-overlapping-entries

**原因**：多个条目指向相同或重叠的数据（一种 zip 炸弹技术）。

**修复**：用标准工具重新创建 ZIP。

### zip-path-traversal

**原因**：条目名称包含 `..` 段。

**修复**：在模块目录内部创建 ZIP，使名称为相对路径。

### zip-absolute-path

**原因**：条目名称以 `/` 或盘符（如 `C:`）开头。

**修复**：在模块目录内部创建 ZIP。

### zip-backslash-path

**原因**：条目名称包含 `\`。ZIP 路径必须使用 `/`（某些 Windows 工具常出现此问题）。

**修复**：用会写入 `/` 分隔符的工具（7-Zip、`zip`、action）重新创建 ZIP。

### zip-path-invalid

**原因**：条目名称为空、是没有文件名的文件条目（例如 `.` 或 `./.`）、包含控制字符、不是有效的 UTF-8，或带有无效（校验和错误）或相互冲突的 Unicode 路径字段。

**修复**：重命名该文件并重新创建 ZIP。

### zip-duplicate-entry

**原因**：两个条目解压到同一路径。比较前会去掉 `.` 和空的路径段，因此 `a/b`、`./a/b`、`a/./b` 和 `a//b` 互相冲突，文件 `a` 与目录 `a/` 也冲突。KernelSU 会静默地用其中一个覆盖另一个。

**修复**：重新创建 ZIP，使每个路径只出现一次。

### zip-encrypted

**原因**：ZIP 包含受密码保护的条目。

**修复**：不使用密码创建 ZIP。

### zip-unsupported-method

**原因**：某个条目使用了 KernelSU 无法解压的压缩方法。KernelSU 支持 stored (0)、deflate (8)、deflate64 (9)、LZMA (14) 和 XZ (95)；其他方法（BZip2、Zstandard、PPMd、Implode 等）会导致安装失败，因此对每个条目都是错误。`module.prop` 本身必须是 stored 或 deflate，因为 KernelSU Modules 需要读取它。

**修复**：使用 deflate 或不压缩重新创建 ZIP。

### zip-entry-corrupt

**原因**：无法读取 `module.prop` 条目（头部不匹配、inflate 错误、大小或 CRC 不匹配）。

**修复**：用标准工具重新创建 ZIP。

## module.prop

### prop-missing

**原因**：ZIP 根目录没有 `module.prop`。

**修复**：把 `module.prop` 放在 ZIP 的顶层。

### prop-not-at-root

**原因**：`module.prop` 只存在于子目录中，也就是压缩了模块的*文件夹*而不是它的*内容*。

**修复**：压缩其内容（`cd module && zip -r ../module.zip .`），或使用 action 的 `module-dir` 输入。

### prop-duplicate

**原因**：有多个条目解压到根目录的 `module.prop`——例如同时有 `module.prop` 和 `./module.prop`，或有一个 `module.prop/` 目录。KernelSU 会读取其中一个、安装另一个。

**修复**：重新创建 ZIP，只保留一个 `module.prop`。

### prop-too-large

**原因**：`module.prop` 大于 64 KiB。

**修复**：只保留标准的 `key=value` 行。

### prop-encoding

**原因**：`module.prop` 不是有效的 UTF-8。

**修复**：以 UTF-8 保存。

KernelSU 把 `module.prop` 当作 Java properties 文件读取，KernelSU Modules 也一样：除了 `key=value`，还接受 `key:value` 和 `key value`、行首空白、`#` 和 `!` 注释、`\` 续行以及 `\uXXXX` 等转义。下面的检查针对的正是 KernelSU 看到的结果。

### prop-line-invalid

**原因（警告**）：某行使用 `:` 或空白而不是 `=` 作为分隔符（KernelSU 仍会读取，读取结果见消息），或者文件以 `\` 续行结尾，导致 KernelSU 丢弃最后一行。

**修复**：使用普通的 `key=value` 行；注释以 `#` 开头；不要以 `\` 结束文件。

### prop-syntax

**原因**：存在格式错误的 `\uXXXX` 转义（不足四位十六进制数字，或是 `\uD83D` 这样的代理码点），即使位于注释中也算。KernelSU 会拒绝安装这样的模块。

**修复**：直接写出该字符（文件是 UTF-8），或使用有效的四位转义。

### prop-duplicate-key

**原因**：某个键出现多次（也包括通过转义、续行或其他分隔符写出的同名键，例如 `id=a` 和 `i\u0064:b`）；KernelSU 使用**最后一个**值。对 `id`、`name`、`version`、`versionCode`、`author`、`description` 是错误（这些键重复只会被用来显示一个值、安装另一个值），其他键是警告。

**修复**：每个键只保留一行。

### prop-missing-field

**原因**：`id`、`name`、`version`、`versionCode`、`author`、`description` 之一缺失或为空。

**修复**：补上缺失的 `key=value` 行并发布新的 release。

### prop-id-invalid

**原因**：`module.prop` 中的 `id` 不匹配 `^[a-zA-Z][a-zA-Z0-9._-]+$`（2–64 个字符）。

**修复**：使用你注册的模块 ID。

### prop-id-mismatch

**原因**：`module.prop` 中的 `id` 与你注册的模块 ID 不一致（区分大小写）。当 `module.prop` 与 `module.yaml` 不一致时，module-release action 也会报告此问题。

**修复**：将 `id` 设置为与注册的 ID 完全一致，并发布新的 release。

### prop-versioncode-invalid

**原因**：`versionCode` 不是普通的十进制整数（例如 `1.2`、`0x10`、`12a`）。

**修复**：使用整数，如 `versionCode=120`，并发布新的 release。

### prop-versioncode-range

**原因**：`versionCode` 超出 1 … 2147483647（int32）范围。

**修复**：使用不超过 2147483647 的正数 versionCode。

## 脚本条目

针对[脚本条目](module-yaml.md#脚本条目kind-script)（`kind: script`，`module.prop` 中 `oneshot=true`）的检查。每个 release 都会在同步任务和 module-release action 中执行这些检查。

### script-missing-action

**原因**：ZIP 根目录没有 `action.sh`（或它是一个目录）。管理器运行的就是这个脚本，没有它脚本条目什么也做不了。

**修复**：把 `action.sh` 放在 ZIP 的顶层（压缩模块目录中的内容，而不是目录本身），然后发布新 release。

### script-forbidden-file

**原因**：ZIP 根目录包含只有已安装模块才会用到的文件或目录：`post-fs-data.sh`、`post-mount.sh`、`service.sh`、`boot-completed.sh`、`uninstall.sh`、`metamount.sh`、`metainstall.sh`、`metauninstall.sh`、`system.prop`、`sepolicy.rule`、`skip_mount`，或 `system/`、`vendor/`、`product/`、`system_ext/`、`odm/`、`webroot/`、`zygisk/`。脚本只运行一次且不会被安装，这些内容会悄无声息地失效。子目录中的同名文件不受影响。

**修复**：从 ZIP 中移除它们（脚本可以从 `$MODPATH` 读取其他名称的数据文件），或把条目作为普通模块发布：在 `module.yaml` 中省略 `kind`，并从 `module.prop` 中去掉 `oneshot`。

### script-metamodule

**原因**：脚本条目在 `module.prop` 中声明了 `metamodule=1` 或 `metamodule=true`。脚本不会被安装，因此不能是元模块。（`module.yaml` 中 `kind: script` 与 `metamodule: true` 同时出现会报告为 [`manifest-schema`](#manifest-schema)。）

**修复**：从 `module.prop` 中去掉 `metamodule`，或把条目作为模块发布。

### script-params-invalid

**原因**：脚本的 `params.json` 无效。消息会说明问题，并尽可能指出字段（如 `params[2].default`）：

- 不是 UTF-8、超过 64 KiB、不是 stored/deflate 压缩，或不是有效的 JSON；
- 同一个对象中出现重复的键（Android 的 JSON 解析器会拒绝这样的文件）；
- 缺少 `schemaVersion` 或其值不是 `1`；
- 不符合 schema：`key` 不匹配 `^[A-Z][A-Z0-9_]{0,31}$`、未知的 `type`、`label` 为空或过长、`label` / `description` 不是字符串、超过 16 个参数、`options` 为 0 个或超过 32 个、`maxLength` 不在 1–1024 之间、`int` 的值不是整数等；
- 同一个 `key` 声明了两次，或同一个 `enum` 中出现重复的选项 `value`；
- `default` 违反自身约束：`enum` 的默认值不是选项之一；字符串超过 `maxLength`、包含 NUL 或换行符；`int` 的默认值超出 `min`/`max`（未设置 `default` 时为 `min`，或 `0`）；或 `min` 大于 `max`。

未知字段会以同一代码报告为**警告**并被忽略。

**修复**：按消息修正 `params.json`（见 [params.json 参考](module-yaml.md#paramsjson)），然后发布新 release。

### params-ignored

**原因（警告**）：普通模块（没有 `kind: script`）的 ZIP 根目录含有 `params.json`。只有脚本条目使用它，管理器对模块会忽略它。

**修复**：删除 `params.json`；如果该条目本应是一次性脚本，请在 `module.yaml` 中设置 `kind: script`，并在 `module.prop` 中设置 `oneshot=true`。
