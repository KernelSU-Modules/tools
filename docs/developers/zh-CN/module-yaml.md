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
| `kind` | 否 | `module`（默认）或 `script`：管理器运行一次而不安装的[一次性脚本](#脚本条目kind-script)。须与 `module.prop` 中的 `oneshot=1`/`true` 一致（[`manifest-kind-mismatch`](checks.md#manifest-kind-mismatch)）；`script` 不能与 `metamodule: true` 同时使用。 |
| `metamodule` | 否 | 若为 KernelSU metamodule 则设为 `true`。默认 `false`。须与 `module.prop` 中的 `metamodule=1`/`true` 一致，KernelSU 实际依据的是后者（[`manifest-metamodule-mismatch`](checks.md#manifest-metamodule-mismatch)）。 |
| `authors` | 否 | 1–20 个 `{name, url?}` 条目；`name` 1–64 个字符，`url` 必须是 `https://`。该列表就是**完整的**作者列表：增删作者直接编辑它即可。省略时，站点和 API 显示**模块仓库的所有者**（其 GitHub 用户名，链接到个人主页）。仅用于展示，权限来自 GitHub 仓库管理员身份，而非此列表。 |
| `starsRepository` | 否 | 一个 GitHub 仓库的 `owner/name`，显示它的 Star 数而不是模块仓库的，例如模块改为从[闭源 release 仓库](closed-source.md)发布之前的开源仓库。只有当该仓库是公开仓库，**并且**与模块仓库属于同一所有者，**或**安装了 KernelSU Modules GitHub App（以此证明你控制该仓库）时才会使用；否则显示模块仓库自身的 Star 数，并报告警告（[`stars-repo-unverified`](checks.md#stars-repo-unverified)）。 |
| `compatibility` | 否 | 作者声明的兼容性提示，用于筛选，不构成保证。见下文。 |
| `release` | 否 | 见下文。 |

### Star 数

模块列表和模块页面显示模块仓库（闭源模块为公开的 release 仓库）或已验证的 `starsRepository` 的 GitHub Star 数。Star 数仅用于展示，大约每天刷新一次，不会影响检查、release 或上架。

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

## 脚本条目（`kind: script`）

条目可以是**一次性脚本**而不是模块。托管方式完全相同（一个包含单个 ZIP 的不可变 GitHub release，按模块的规则检查），但 KernelSU 管理器不会安装它：管理器下载 ZIP，询问 `params.json` 中声明的参数，展示 `action.sh` 源码，并在 root shell 中**运行一次**。不会留下任何已安装的内容。适用于“开启某个隐藏设置”“导出日志”这类任务；需要在开机时运行或修改系统分区的内容应当做成模块。

在 `module.yaml` 中设置 `kind: script`，并在 `module.prop` 中设置 `oneshot=true`：

```text
<id>-<version>.zip
├── module.prop      # 常规字段 + oneshot=true
├── action.sh        # 必需：管理器运行的脚本
├── params.json      # 可选：参数声明（见下文）
├── customize.sh     # 可选：仅在旧版管理器把 ZIP 当作模块安装时使用
└── 其他文件          # 脚本通过 $MODPATH 读取的数据
```

`oneshot` 的读取方式与 `metamodule` 相同：忽略首尾空白后值为 `1` 或 `true`（不区分大小写）；其他任何值或没有 `oneshot` 行都表示普通模块。不认识脚本条目的旧版管理器会把 ZIP 当作普通模块安装，其**操作**按钮会运行 `action.sh`，请让 `action.sh` 在这种情况下也能正常工作。

脚本条目的 release 检查（均为错误，见[检查](checks.md#脚本条目)）：

- 当且仅当 `module.prop` 含有 `oneshot=1`/`true` 时设置 `kind: script`（[`manifest-kind-mismatch`](checks.md#manifest-kind-mismatch)）；
- ZIP 根目录有 `action.sh`（[`script-missing-action`](checks.md#script-missing-action)）；
- ZIP 根目录没有仅模块使用的文件 `post-fs-data.sh`、`post-mount.sh`、`service.sh`、`boot-completed.sh`、`uninstall.sh`、`metamount.sh`、`metainstall.sh`、`metauninstall.sh`、`system.prop`、`sepolicy.rule`、`skip_mount`，也没有目录 `system/`、`vendor/`、`product/`、`system_ext/`、`odm/`、`webroot/`、`zygisk/`（[`script-forbidden-file`](checks.md#script-forbidden-file)）；
- 不是元模块：`module.yaml` 中的 `metamodule: true` 是 [`manifest-schema`](checks.md#manifest-schema) 错误，`module.prop` 中的 `metamodule=1` 是 [`script-metamodule`](checks.md#script-metamodule)；
- 存在 `params.json` 时它必须有效（[`script-params-invalid`](checks.md#script-params-invalid)）。

普通模块的 ZIP 根目录含有 `params.json` 时会产生警告 [`params-ignored`](checks.md#params-ignored)。

在 API（`api/v1/modules.json` 和 `api/v1/modules/{id}.json`）中，每个条目都有 `kind: "module" | "script"`；客户端把缺失的值视为 `module`，并隐藏 kind 未知的条目。

### `params.json`

可选，位于 ZIP 根目录，UTF-8 JSON，最大 64 KiB。JSON Schema：`schemas/params.schema.json`。

```json
{
  "schemaVersion": 1,
  "params": [
    {
      "key": "ENABLE_FASTBOOT",
      "type": "bool",
      "label": "Also enable fastboot",
      "description": "Optional longer help text",
      "default": true
    },
    { "key": "MODE", "type": "enum", "label": "Mode", "default": "a",
      "options": [ { "value": "a", "label": "A" }, { "value": "b" } ] },
    { "key": "NAME", "type": "string", "label": "Name", "default": "", "maxLength": 64,
      "pattern": "^[a-z]*$", "required": false },
    { "key": "COUNT", "type": "int", "label": "Count", "default": 1, "min": 0, "max": 10 }
  ]
}
```

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 必须为 `1`。 |
| `params` | 最多 16 个参数。 |
| `key` | `^[A-Z][A-Z0-9_]{0,31}$`，不能重复。脚本通过 `KSU_PARAM_<key>` 获得该值。 |
| `type` | `bool`、`enum`、`string` 或 `int`。 |
| `label` | 必填。非空字符串（≤ 200 个字符）。与模块内容一样只有一种语言。 |
| `description` | 可选字符串，规则同 `label`。 |

各类型：

| 类型 | 字段 |
| --- | --- |
| `bool` | `default`：`true` / `false`（默认 `false`）。以 `true` / `false` 传入。 |
| `enum` | `options`：1–32 个 `{value, label?}`；`value` 匹配 `^[A-Za-z0-9._-]{1,64}$` 且不能重复。`default` 必须是其中一个值（默认为第一个选项）。 |
| `string` | `default`（默认 `""`）、`maxLength` 1–1024（默认 256）、可选的 `pattern`（必须能编译的 JavaScript 正则表达式；管理器要求**完全**匹配，请只使用 ECMAScript 与 Java 共有的语法）、`required`（默认 `false`：空值总是允许，`pattern` 只作用于非空值）。值不能包含 NUL 或换行符。 |
| `int` | 可选的 `min` / `max`、`default`（默认为 `min`，没有 `min` 时为 `0`）；`min ≤ default ≤ max`；32 位有符号整数。以十进制传入。 |

每个参数的 `default` 都必须满足它自身的约束。未知字段会产生警告并被忽略；其他任何问题（无效的 JSON、同一对象中重复的键、未知的 `schemaVersion`、重复的 key 或选项值、无法编译的 pattern、违反约束的默认值）都是 [`script-params-invalid`](checks.md#script-params-invalid)。

### 管理器如何运行 `action.sh`

管理器校验下载内容（sha256 和大小，与模块相同），检查 `module.prop` 为 `oneshot` 且 `id` 与注册的 ID 一致、`action.sh` 存在，然后把 ZIP 解压到私有目录，并在全局挂载命名空间中新开的 root shell 里运行（与模块的操作按钮相同）：

```sh
cd <dir> && <env> /data/adb/ksu/bin/busybox sh ./action.sh
```

环境变量如下（没有标准输入）：

| 变量 | 值 |
| --- | --- |
| `ASH_STANDALONE` | `1` |
| `KSU` | `true` |
| `KSU_VER`、`KSU_VER_CODE`、`KSU_KERNEL_VER_CODE` | KernelSU 版本，与模块相同 |
| `KSU_LATE_LOAD` | 仅在 late-load 模式下为 `1` |
| `KSU_MODULE` | 条目 ID |
| `KSU_ONESHOT` | `1`（`action.sh` 可据此区分一次性运行与已安装模块的操作按钮） |
| `MODPATH` | 解压目录（从这里读取数据文件） |
| `PATH` | `$PATH:/data/adb/ksu/bin` |
| `KSU_PARAM_<KEY>` | 每个参数一个：`bool` → `true`/`false`，`int` → 十进制，`enum` → 选项值，`string` → 用户输入 |

退出码 `0` 表示成功，`2` 表示“不适用于此设备”（以提示而非失败的形式显示），其他值表示失败。输出与操作按钮的输出界面相同，可以保存。管理器只记录最近一次运行（版本与退出码）；没有已安装状态，也没有更新检查。

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
