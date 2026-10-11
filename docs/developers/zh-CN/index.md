# KernelSU Modules 开发者文档

[KernelSU Modules](https://modules.kernelsu.org) 是一个静态的 KernelSU 模块目录。**模块保存在你自己的 GitHub 仓库中**，并以 **immutable GitHub release**（不可变发布）的形式发布 ZIP；KernelSU Modules 只负责索引，不会托管、镜像或重新构建你的 ZIP。

> English: [index](../index.md)

## 工作原理

```
你的仓库                                 KernelSU Modules
───────────────                         ────────────────
module.yaml + README/docs + 图标   ──►  从默认分支读取（展示用元数据）
tag → immutable release + ZIP      ──►  检查 ZIP（module.prop、大小、结构），锁定 sha256
                                        ▼
                                   modules.kernelsu.org + KernelSU Manager
```

1. **一次性设置**：启用 release 不可变性，添加 `module.yaml`，安装只读的 *KernelSU Modules* GitHub App，并在[KernelSU 开发者门户](https://developers.kernelsu.org)（KernelSU Developer Portal）提交仓库。首次提交需要维护者审核。
2. **每次发布**：在 `module.prop` 中提升 `versionCode`，推送 tag，发布只包含一个模块 ZIP 的 immutable release。我们的 [release action](releasing.md) 可以代劳。KernelSU Modules 会在几分钟内收录，无需审核。
3. **反馈**：结果会以名为 **"KernelSU Modules" 的 Check Run** 显示在打 tag 的 commit 上，也会显示在 Portal 中。不会发送邮件，也不会创建 issue。

## 信息来源

| 信息 | 来源 |
| --- | --- |
| id、version、versionCode | release ZIP 内的 `module.prop` |
| 下载 URL、大小、sha256、tag、commit | immutable release（由 KernelSU Modules 计算） |
| 更新日志 | release notes |
| 名称、简介、描述、图标、标签、链接 | 默认分支上的 `module.yaml` 及其引用的文件 |

## 页面导航

- [快速开始](getting-started.md)：从零到上架
- [module.yaml 参考](module-yaml.md)
- [发布](releasing.md)：immutable release、versionCode、release action
- [检查](checks.md)：所有检查结果代码及修复方法
- [KernelSU 开发者门户](portal.md)：提交、转移、同步、状态
- [FAQ](faq.md)：保证范围、签名、隐私

完整的可用示例见 [KernelSU-Modules/example-module](https://github.com/KernelSU-Modules/example-module)。
