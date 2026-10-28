---
kind: upgrade-guide
description: "DeepSeek 会话日志上传默认关闭，需要用户主动开启。"
---

# 会话日志上传默认关闭

[English](guide.md) | 中文

## 变更

`dsh-session-log-deepseek` 插件的 `enabled` 配置默认值现在为 `false`，随附 profile 也以该默认值挂载插件。没有已存储值的部署不再随 DeepSeek 请求发送 `dsh_session_log` 贡献；此前上传默认开启，由用户选择退出。关闭期间记录的会话保留在本地，重新开启后会继续上传尚未确认的后缀。

## 迁移

1. 若要继续上传，在 Web 中打开“设置 → 通用 → **在使用官方模型 API 时上传 Session Log**”，或在 `cordis.yml` 或 patch 层中将 `dsh-session-log-deepseek` 插件的 `enabled` 设为 `true`。
2. 通过发送一次请求确认迁移结果：开启上传时，发出的 DeepSeek 请求携带 `dsh_session_log` 字段；保持关闭时该字段不存在。
