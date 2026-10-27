# Agent Note: OpenCode provider configuration import

Status: implemented

[English](2026-10-27-opencode-provider-import.md) | 中文

## 问题

已经在使用 OpenCode 的用户拥有一个可用的 `opencode.json` 提供商映射：中转站、端点、模型列表、容量、输入类型与 API 密钥。Models 页面只能通过重新输入每个提供商及其模型来描述相同的 pi-ai 路由。这种重复录入让迁移容易出错，也阻碍用户在保留现有 OpenCode 配置的同时试用 DSH。

## 决定

新增卡片在目录与自定义提供商方式之外提供**从 OpenCode 导入**。它通过三种来源接受同一份 `opencode.json` 文档：Host 的默认 OpenCode 配置文件、浏览器选择的文件，以及粘贴文本。三种方式都会填充同一个可编辑文本框，因此解析、预览与写入只有一条路径。卡片把其中的 `provider` 映射翻译成 pi-ai profile，用一次设置写入提交所有可导入的提供商，然后通过凭据 seam 存储明文 API 密钥。卡片报告导入数量、每个被跳过的提供商及各自的跳过原因；profile 写入之后卡片保持打开，以便单独重试失败的密钥。

settings controller 挂载只读的 `opencodeConfig` Remote namespace。`readDefault()` 在设置了 `OPENCODE_CONFIG` 时使用该路径，否则使用 `XDG_CONFIG_HOME` 或 `~/.config/opencode/opencode.json` 下的全局文件，并带有 Windows `APPDATA` 与 `LOCALAPPDATA` 回退。浏览器不提供路径，因此该端点无法读取任意文件。Host 返回第一个存在的普通 UTF-8 文件（上限 1 MiB），没有候选文件时列出所有候选路径。文件系统或 namespace 缺失时文件与粘贴来源仍可使用，卡片会把默认来源报告为不可用。

提供商键成为 `providers.<route>`。路由转为小写，`[a-z0-9]` 之外的连续字符变成 `-`，去掉首尾连字符，无法作为设置键开头的 id 加上 `p-` 前缀（`llama.cpp` → `llama-cpp`，`302.ai` → `p-302-ai`）。文档中的 `name` 成为 `displayName`，`options.baseURL` 成为 `baseURL`，`options.apiKey` 成为派生 `<ROUTE>_API_KEY` 引用下的只写凭据。`{env:NAME}` 与 `provider.env` 中第一个可用名称则成为 `apiKeyEnv`。

协议来自显式且受支持的 `api`，否则来自提供商的 `npm` 包，再否则来自已知的 OpenCode 提供商 id。只写入本页 schema 接受的协议。`@ai-sdk/anthropic` 映射为 `anthropic-messages`；OpenAI 兼容包与列出的网关 id 映射为 `openai-completions`。使用 Azure、Bedrock、Vertex 或 Google 等包的提供商会跳过，因为它们的认证与协议事实无法成为等价的端点加密钥 profile。

模型映射成为 `models`。模型键或其 `id` 是模型 id；`name`、`limit.context` 与 `limit.output` 成为显示名、`contextWindow` 与 `maxTokens`。输入类型保留适配器的 `text` 与 `image` 值；缺少 modalities 时，`attachment: true` 提供文本与图片。`reasoning: false` 写入 `reasoningEfforts: false`；`reasoning: true` 不写入任何内容，因为 OpenCode 没有给出档位，而本页不能凭空发明。

已安装目录自带的路由可以继承端点与模型。本页不自带的路由必须声明 HTTP(S) 端点与至少一个有效模型。导入会跳过已配置的提供商、规范化后与已导入路由重复的后续提供商、不支持的协议、格式错误的提供商或模型条目、不可用密钥，以及无法满足这些要求的路由。

所有 profile 在卡片打开时的 revision 上一起写入，因此冲突不会改动文档。凭据明文在该写入之后存储。密钥失败时，profile 写入保持已提交，卡片禁用粘贴文本，**重试密钥**只存储尚未成功的引用。提交写入后关闭会重新加载页面快照；在任何写入之前关闭则丢弃草稿。

## 备选方案

**只读取默认路径。** 固定文件位置对 `OPENCODE_CONFIG`、项目配置，以及在另一台机器上运行 DSH 的用户都会失效。文件选择器覆盖浏览器能读取的任意位置，粘贴则覆盖远程或已复制的文档。默认来源只是便利方式，而不是必要条件。

**读取 OpenCode 的认证存储与内置提供商目录。** 这些内容位于 OpenCode 管理的文件与运行时注册表中，不在配置文档里。导入它们会让 DSH 耦合到另一个产品的私有存储与版本化目录。文本框让导入的每项事实对用户可见。

**扩展 pi-ai schema 以原样存储 OpenCode JSON。** 保留原始块能保留 DSH 无法解释的字段，但会让设置文档与模型运行时对哪些字段重要产生分歧。翻译到现有 profile schema 保持单一权威。

**为每个提供商分别写入。** 分开写入会在失败后留下部分导入的文档，并放大 revision 竞争。一次写入让集合具备原子性；凭据仍单独处理，因为它们使用不同的 seam。

**把 `reasoning: true` 映射为猜测的档位。** OpenCode 的布尔值表示模型会推理，但没有说明端点接受哪些档位。猜测会公布提供商拒绝的档位。导入只保留它能够承载的事实：`false` 关闭推理。

**原样使用 OpenCode 提供商键。** `llama.cpp` 与 `302.ai` 等键是有效的 OpenCode id，但不是有效的 pi-ai 设置键或凭据引用主干。规范化保留了这些网关的导入，而不是丢弃它们；卡片会报告规范化后冲突的 id，而不是覆盖其中一个。

**在同一次改动中接受 JSONC。** `opencode.json` 文件可能带注释，但加入能识别注释的解析器会增加依赖与第二条校验路径。目前导入只接受纯 JSON；卡片会指出 JSON 无效，而不是静默剥除内容。

## 后果

用户可以从 Host 默认文件、所选文件或粘贴文本迁移可用的 OpenCode 提供商映射，包括端点覆盖与明文密钥。被跳过的提供商会带原因保留在视野中，而不是消失。导入是单向且刻意不完整的：OpenCode 已保存的认证、请求头、费用、采样选项、内置目录以及 `reasoning: true` 的档位都没有页面自有的表示。不支持的协议与 JSONC 输入不会被导入。默认路径发现与文件系统拒绝由 Host 测试固定；翻译与跳过原因由解析器测试固定；来源加载、写入顺序、冲突处理与密钥重试由组件测试固定。
