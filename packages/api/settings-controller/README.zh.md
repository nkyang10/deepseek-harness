---
description: "settings、凭据、OpenCode 配置与只写 Web 口令界面的 Host Remote owner，涵盖脱敏读取、写入、凭据引用、原生文档打开与默认 OpenCode 配置读取。"
kind: "package-reference"
---
# Settings Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-settings-controller` 为浏览器配置界面提供生成的 `ctx.remote.settings`、`ctx.remote.credentials`、`ctx.remote.opencodeConfig` 与 `ctx.remote.webAccess` namespace。它返回脱敏的 settings 与凭据元数据，支持 settings 与凭据写入而不返回机密值，在 Host 桌面打开由提供方持有的 settings 或 Agent preset 位置，读取 Host 的默认 OpenCode 配置文件而不接受浏览器提供的路径，并把 Connection 口令写成单向校验记录而不返回它。提供方缺失时，namespace 仍会注册，并返回可操作的配置错误。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

请把本包作为 Loader entry 挂载到提供浏览器配置的 profile 中。本 entry 不依赖提供方是否存在而注册四个 namespace，因此缺少提供方会在调用时产生具名配置错误。它生成的 descriptor 进入严格 Typert 注册表，而 settings 与凭据 Definition 仍是普通 Cordis 服务，自身不承担任何 wire 义务。

`describe(refs)` 以请求的名字为键返回一份 map，因此设置页描述其各行携带的全部引用时，这些行会一起落定。单次调用最多接受 64 个名字，无效名字或空写入值报告为 `bad-request`，并逐字段复制每个答案——提供方返回超出 `CredentialInfo` 声明的内容也无法扩大跨越 wire 的字段。有效的 `set(ref, value)` 与 `unset(ref)` 调用把提供方拒绝报告为 `credential-rejected`，携带提供方的消息，details 中只有该引用。机密值只在这个方向跨越 wire：这里没有任何方法会返回它。

`settings.describe()` 返回部署信息，以及在 `redactSecrets: true` 下读取的所有 namespace。`settings.update`、`settings.replace` 与 `settings.mutate` 暴露 settings 服务的三种写入操作，并返回该 namespace 的新脱敏视图；陈旧写入使用 `settings-conflict`，其他提供方拒绝使用 `settings-rejected`。

`settings.openSettingsDocument()` 准备提供方持有的文档，并用原生文本编辑器打开；该方法不接受浏览器提供的文件系统目标。

`opencodeConfig.readDefault()` 按 OpenCode 文档中的全局位置读取第一个存在的文件：设置了 `OPENCODE_CONFIG` 时以其为准，否则读取 `XDG_CONFIG_HOME` 或 `~/.config/opencode/opencode.json`，Windows 还会回退到 `APPDATA` 与 `LOCALAPPDATA`。它返回路径与 UTF-8 内容，拒绝非普通文件、非文本文件及大于 1 MiB 的文件，并在没有候选文件时返回列出候选路径的可操作错误。浏览器不提供路径，因此该 namespace 无法读取任意文件。

`webAccess.status()` 只报告是否存储了所有者口令的校验记录。`webAccess.setPasscode(passcode)` 在 Connection 中派生新的加盐 scrypt 校验记录并替换存储的记录；`webAccess.clearPasscode()` 删除该记录，且不会撤销已配对的浏览器。没有任何方法返回口令或校验记录。缺少 Connection 服务时报告 `web-access-unavailable`，校验记录写入失败时报告 `web-access-rejected` 并指明操作。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-settings-controller)是所有受支持字段及其 JSDoc 的完整来源。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 settings、凭据、OpenCode 配置与 Web 口令的读取或写入属于浏览器和 Host 状态，并且不注册提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；读取或写入这些配置值不会改变已经在途的模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 批量上限固定为 64 个引用，不是可按部署配置的字段。
- OpenCode 配置发现遵循环境变量与平台约定，而不是 Config 字段；1 MiB 读取上限是固定的 Host 约束。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
