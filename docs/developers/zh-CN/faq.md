# FAQ

## KernelSU Modules 保证什么？

- 你下载的 ZIP 与模块注册的 GitHub 仓库中某个 **immutable release 的资源逐字节一致**。KernelSU Modules 会锁定其 sha256，新版 KernelSU Manager（使用 modules.kernelsu.org `api/v1` 的版本）在安装前会进行校验。旧版 Manager 以及从 GitHub 手动下载时不会校验——请自行与模块页面上的 sha256 比对。
- 该 release 的资源和 tag 之后永远无法被替换（GitHub release 不可变性）。
- ZIP 通过了结构检查（大小、zip 炸弹、路径、`module.prop`），其 `id` 和 `versionCode` 遵守规则，版本不会倒退。
- 每个模块的**首次**提交都经过维护者的规则合规性审核。
- 详情页经过清理；模块页面无法在站点或 Manager 中运行脚本。

## KernelSU Modules 不保证什么？

- **没有签名，也不验证开发者身份**。 模块既不由 KernelSU Modules 签名，也不由作者签名，作者身份也不经验证：谁管理模块的 GitHub 仓库，谁就管理该模块。
- **没有代码审计，也没有恶意软件扫描**。 审核检查的是规则（垃圾内容、滥用、ID、抢注），而不是模块在你设备上做了什么。
- **无法防范恶意作者或被入侵的作者账号**。 更新是自动发布的，不经审核。
- sha256 匹配只能证明文件就是 KernelSU Modules 索引的那个文件，不代表它是安全的。

每个模块的页面都会显示源仓库、tag、commit、immutable 标志和 attestation 链接，你可以自行核实来源，例如使用 `gh release verify`。

一旦维护者得知恶意模块，会立即将其 suspended（从索引中移除）。请向维护者报告问题。

## 为什么只支持 GitHub？

Immutable release 和 GitHub App 使得"作者自托管、自动更新"的模块索引在无需我们托管文件的前提下足够安全。以后可能会支持其他托管平台。

## KernelSU Modules 会托管或镜像我的 ZIP 吗？

不会。下载直接指向 GitHub release 资源。KernelSU Modules 只会复制描述中的图片和图标（以保证页面完整）。

## KernelSU Modules App 能对我的仓库做什么？

- **Metadata: read、Contents: read**：读取 `module.yaml`、你的文档和 release。
- **Checks: write**：发布带有验证结果的 "KernelSU Modules" Check Run。它不能修改代码、release、issue 或设置。
- 它接收 `release`、`installation` 和 `check_run` 事件，以便知道何时同步。

登录 KernelSU 开发者门户使用的是同一个 App。你的 GitHub token 只会加密存放在浏览器的 HttpOnly cookie 中，不会保存在服务器上。KernelSU Modules 会随提交和审核记录保存你的 GitHub 用户 ID（可在公开数据仓库 `KernelSU-Modules/repo` 的历史中看到）。

## 可以把仓库设为私有吗？

你提交的仓库不可以：KernelSU Modules 及其用户必须能够匿名读取你的文档并下载 release。私有仓库会停止同步（最后一个版本保持在线，并标记为 stale）。

不过你可以让**源代码**保持私有：在私有仓库中构建，再用 module-release action 把 release 发布到一个公开的分发仓库。见[闭源模块](closed-source.md)。

## 我卸载了 App，会怎样？

同步暂停；最后锁定的版本保持在线并标记为 stale。重新安装即可恢复。

## 可以更改模块 ID 吗？

不可以。ID 是模块在用户设备上的身份标识。如果确实需要，请注册一个新模块并归档旧模块。

## 更新多久会发布？

通常在 release 发布后几分钟内（由 webhook 触发），最多约 15 分钟加上构建时间。如果看起来卡住了，可以在 Portal 或 Check Run 中使用 **Sync now**。

## 去哪里获取帮助？

先在[检查](checks.md)页面查找你的错误代码，然后到 <https://github.com/KernelSU-Modules/tools> 的 GitHub discussions 或 issues 中提问。
