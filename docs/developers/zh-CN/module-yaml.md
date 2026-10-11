# module.yaml 参考

`module.yaml` 只存放**展示用元数据**。KernelSU Modules 会在锁定的 commit 上，从仓库的跟踪分支（未登记其他分支时即默认分支）读取它（及其引用的文件）。version、versionCode 和下载地址来自 release ZIP 中的 `module.prop`，不要写在这里。

模块内容是**单语言**的：只有一个 `name`、一个 `summary` 和一个描述文档。（站点和 Portal 本身提供多语言界面；你的模块文本按原样展示。）

JSON Schema：[KernelSU-Modules/tools](https://github.com/KernelSU-Modules/tools) 中的 `schemas/module.schema.json`。支持 YAML language server 的编辑器可在文件第一行加入以下内容以获得补全：

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/KernelSU-Modules/tools/main/schemas/module.schema.json
```

## 完整示例

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

## 字段

任何层级的未知字段都只会产生**警告**并被忽略，因此为更新版本的 KernelSU Modules 编写的 `module.yaml` 仍能通过校验；请留意警告中是否有拼写错误。不支持的 `schemaVersion` 始终是错误（[`manifest-unsupported-version`](checks.md#manifest-unsupported-version)）。类型错误和非法取值是错误（[`manifest-schema`](checks.md#manifest-schema)）。可能被 YAML 解析为数字或布尔值的内容请加引号。

| 字段 | 必填 | 类型 / 规则 |
| --- | --- | --- |
| `schemaVersion` | 是 | 必须为 `1`。 |
| `id` | 是 | 必须与 `module.prop` 中的 `id` 以及注册的 ID 完全一致（区分大小写）。`^[a-zA-Z][a-zA-Z0-9._-]+$`，2–64 个字符。 |
| `name` | 是 | 显示名称，1–100 个字符。 |
| `summary` | 是 | 1–500 个字符，纯文本；一两句话最佳。 |
| `description` | 是 | 作为详情页的 Markdown 文档，相对于仓库的路径（见[路径](#路径)）。 |
| `license` | 否 | 1–64 个字符。推荐使用 [SPDX 标识符](https://spdx.org/licenses/)，如 `MIT` 或 `GPL-3.0-only`。 |
| `homepage` | 否 | URL。推荐 `https://`；`http://` 可以使用，但会产生警告。 |
| `support` | 否 | 用于反馈问题 / 获取帮助的 URL（issues 页面、论坛帖子、聊天群）。`http://` 可以使用，但会产生警告。 |
| `tags` | 否 | 最多 10 个由字母、数字和 `-` 组成的标签（最长 32 个字符，以字母或数字开头）。标签不区分大小写，统一保存为小写（`Root` → `root`）。 |
| `icon` | 否 | 图标相对于仓库的路径。 |
| `metamodule` | 否 | 若为 KernelSU metamodule 则设为 `true`。默认 `false`。须与 `module.prop` 中的 `metamodule=1`/`true` 一致，KernelSU 实际依据的是后者（[`manifest-metamodule-mismatch`](checks.md#manifest-metamodule-mismatch)）。 |
| `authors` | 否 | 1–20 个 `{name, url?}` 条目；`name` 1–64 个字符，`url` 必须是 `https://`。仅用于展示，权限来自 GitHub 仓库管理员身份，而非此列表。 |
| `compatibility` | 否 | 作者声明的兼容性提示，用于筛选，不构成保证。见下文。 |
| `release` | 否 | 见下文。 |

### `compatibility`

| 字段 | 规则 |
| --- | --- |
| `androidMinApi` | 21–99 的整数（Android API 级别，例如 29 = Android 10）。 |
| `androidMaxApi` | 21–99 的整数。 |
| `architectures` | 非空列表，取值为 `arm64-v8a`、`armeabi-v7a`、`x86_64`、`x86`、`riscv64`。 |

### `release`

| 字段 | 规则 |
| --- | --- |
| `assetPattern` | 用于在 release 资源中匹配模块 ZIP 的 glob。仅支持 `*` 和 `?` 通配符，不能含 `/` 或 `\`，最长 128 个字符。未设置时，release 必须包含**恰好一个** `.zip` 资源；设置后，必须有**恰好一个**资源匹配。 |

当 release 中包含多个 ZIP（例如调试版或源码包）时，请设置 `assetPattern`。[module-release action](releasing.md) 生成的资源名为 `{id}-{versionCode}-{version}.zip`（`version` 会按文件名规则清理），因此 `"{id}-*.zip"` 是个不错的模式。

## 路径

所有路径（`icon`、`description`）都相对于**仓库根目录**（而非 `module.yaml`），使用 `/` 分隔。开头的 `./` 可以使用并会被去掉（`./README.md` 即 `README.md`）；路径不能以 `/` 开头，也不能包含 `..` 段、空段或 `://`。每个被引用的文件都必须存在于跟踪分支上（[`manifest-path-missing`](checks.md#manifest-path-missing)）。

限制：`module.yaml` ≤ 64 KiB，描述文档 ≤ 512 KiB。

### KernelSU Modules 跟踪哪些文件

KernelSU Modules 锁定跟踪分支上的一个**内容 commit**，并记录它用到的每个文件的摘要：`module.yaml`、描述文档、图标，以及描述中引用的仓库内图片（相对路径图片）。只有这些文件发生变化时，锁定的 commit 才会前进；只修改其他文件（源码、CI 等）的推送不会产生新的锁定条目或 Check Run。站点构建会在锁定的 commit 上获取所有这些文件。

## 描述中的 Markdown 与 HTML

描述的渲染方式与 GitHub README 相同：CommonMark + 表格、删除线、自动链接、任务列表、脚注、`:emoji:` 短代码以及 `> [!NOTE]` 风格的提示块。允许使用原始 HTML，随后所有内容都会经过白名单清理：

- **保留**： 常规格式与结构（`p`、`div`、`span`、标题、列表、表格、`pre`、`code`、`blockquote`、`details`/`summary`、`picture`/`source`、`img`、`a`、`br`、`hr`、`kbd`、`sub`/`sup` 等）以及 `align`、`width`、`height`、`colspan` 等展示性属性。
- **连同内容一并移除**： `script`、`style`、`iframe`、`object`、`embed`、`form` 及表单控件、`svg`、`math`、`audio`、`video`、`canvas` 等。
- **移除的属性**： 所有 `on*` 事件处理器、`style`，以及不在白名单内的一切属性；`class` 的值会被丢弃，仅保留渲染器自身用到的少数几个；`id`/`name` 的值会加上 `user-content-` 前缀（与 GitHub 一致）。
- **URL**： 链接可使用 `https:`、`http:`、`mailto:` 或相对路径；图片可使用 `https:`、`http:` 或 `data:image/{png,jpeg,gif,webp,avif};base64`（≤ 256 KiB）。`javascript:` 及其他协议会被移除。

相对**链接**会指向锁定 commit 上该文件在 GitHub 的页面（`https://github.com/{owner}/{repo}/blob/{commit}/{path}`）。相对路径相对于文档自身所在目录解析，与 GitHub 完全一致（在 `docs/intro.md` 中，`../assets/x.png` 即 `assets/x.png`）。

## 图片

描述中的图片和图标会被**复制到 modules.kernelsu.org** 并以内容哈希命名提供，因此即使你之后修改了仓库，它们依然有效。复制时：

- 只获取 `https` 来源（相对路径的图片会从锁定 commit 上的仓库获取），主机必须解析到公网 IP，最多 3 次重定向；
- 每张图片 ≤ 5 MiB，每个模块最多 40 张、共 40 MiB；
- 不符合上述规则的图片会从页面中移除。

请使用 PNG、JPEG、WebP 或 GIF。图标建议使用至少 192×192 px 的方形 PNG/WebP。使用图片时请保留其原有的许可证和署名。
