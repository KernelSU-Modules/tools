# KernelSU 开发者门户

[developers.kernelsu.org](https://developers.kernelsu.org) 是提交和管理模块的唯一入口。使用 GitHub 登录（通过 *KernelSU Modules* App）。没有独立账号：**谁是模块 GitHub 仓库的管理员，谁就管理该模块**。 在 GitHub 上添加或移除仓库管理员，Portal 会随之更新。

## 我的仓库

列出你是管理员且已安装 KernelSU Modules App 的仓库。如果某个仓库没有出现：

- 在该仓库上安装 App（**安装 / 配置 App** 按钮），或将其添加到已有的安装中；
- 组织仓库需要组织所有者批准安装；
- 你必须拥有该仓库的 **admin** 角色（write/maintain 不够）。

将 App 安装到 "All repositories" 也没问题，在你点击 **提交收录** 之前不会提交任何内容。

对每个仓库，你可以：

- **预检**：仅通过 GitHub API 验证 `module.yaml` 及其引用的文件、模块 ID，以及最新 release（已发布、immutable、恰好一个 ZIP、大小限制）。ZIP 本身（`module.prop`、哈希、zip 炸弹检查）由 KernelSU Modules 的同步任务（GitHub Actions）验证：提交后立即运行，之后每次发布新 release 时再次运行；结果作为 Check Run 报告在你的仓库上，并显示在 Portal 中。
- **预览**：使用与站点相同的渲染器和清理器渲染你的描述。
- **提交收录**：注册新的模块 ID（见下文）。
- **转移**：将已有模块指向此仓库。

## 提交收录

输入（或确认）模块 ID。Portal 会检查 ID 是否有效且可用、你是否是该仓库的管理员，以及你的账号是否被封禁。记录进入 **待审核** 状态，并通知维护者。审核只涉及规则：无垃圾或滥用内容、ID 合适、没有抢注他人项目名称，不是代码审计。

## 转移

将已上架（或被 suspended）的模块转移到另一个仓库，例如重写后的新仓库，或交接给新的维护者。如果你同时是**当前**仓库和**新**仓库的管理员，转移会立即生效；否则由维护者审核。重命名仓库不需要转移：模块绑定的是仓库的数字 ID，而不是名称。但如果把仓库本身转移给其他账号或组织，所有者会发生变化：Check Run 会报告 [`owner-changed`](checks.md#owner-changed)，新所有者需要提交转移申请。

新仓库必须满足同样的要求（已安装 App、`module.yaml` 中 `id` 相同、immutable release 的 `module.prop` 中 `id` 相同）。转移申请处理期间，每次同步都会验证**新**仓库并在其上发布 Check Run。新仓库的 release 必须使用高于 KernelSU Modules 曾为该模块接受过的最高 versionCode；如果新仓库中最新 release 的 versionCode 不更高，申请会显示警告：转移后它不会被发布，请在新仓库发布更高 versionCode 的 release。转移后的首次同步只检查最新的合格 release（及之后发布的 release）。

## 我的模块

按模块显示：状态、绑定的仓库、锁定的稳定版本、上次同步时间与健康状况、最新检查结果，以及被拒绝或 suspended 的原因。

**立即同步** 会为你的模块重新运行同步（每个模块最多每 10 分钟一次）。在修复 `module.yaml` / 文档后，或 release 未被收录时使用。它总会发布一个新的 Check Run（即使没有任何变化），重新验证处理中的提交或转移申请，并重试因可重试原因失败的 release（下载失败、大小或摘要不匹配、找不到 tag）。Check Run 上的 **Re-run** 和 **Sync now** 按钮与它效果相同。

"上次同步"时间只在模块有变化或健康状况变化时更新；没有周期性心跳，因此健康模块显示较早的时间是正常的。

## 状态

| 状态 | 含义 | 你可以做什么 |
| --- | --- | --- |
| 待审核（`pending`） | 已提交，等待审核。30 天内无决定则过期，ID 随之释放。 | 等待；保持 release 和 `module.yaml` 有效。 |
| 已收录（`listed`） | 已通过。**拥有有效的稳定 release 后**才会显示在站点和 Manager 中。更新自动发布。 | 发布新版本。 |
| 已拒绝（`rejected`） | 审核未通过，并显示原因（`spam`、`violation`、`bad-id`、`squatting` 或自定义说明）。ID 重新可用。 | 修复问题后重新提交（若问题出在 ID 上则换一个 ID）。 |
| 已暂停（`suspended`） | 被维护者从索引中移除；ID 仍绑定在你的仓库上。 | 查看原因；修复后联系维护者。 |
| 已归档（`archived`） | 已退役（例如被废弃）。该 ID 不能再被注册。 | 联系维护者。 |

同步健康状况（显示在已收录模块旁）：

| 健康状况 | 含义 |
| --- | --- |
| 正常（`ok`） | 上次同步成功。 |
| 数据过期（`stale`） | 上次同步失败（网络问题、新的 `module.yaml` 无效等）；仍提供上一次的有效数据。请查看 Check Run。 |
| 错误（`error`） | 从未同步成功，因此尚未发布任何内容。请查看 Check Run。 |
| App missing | App 被卸载或仓库已从安装中移除。同步暂停，最后一个版本保持在线；重新安装即可恢复。此状态下无法发布 Check Run，只能在 Portal 中看到。 |
