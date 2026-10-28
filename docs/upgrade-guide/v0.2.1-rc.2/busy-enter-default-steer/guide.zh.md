---
kind: upgrade-guide
description: "回合运行中按下 Enter 现在默认 Steer（立即转向），而不是排队。"
---

# 忙碌时 Enter 默认改为 Steer

[English](guide.md) | 中文

## 变更

`ui-conversation` settings 命名空间的 `busyEnter` 默认值现在为 `steer`，不再是 `queue`。没有已存储 `busyEnter` 值的浏览器在回合运行中按下普通 Enter 时，草稿会作为立即转向发送，而不再加入队列。Cmd/Ctrl+Enter 仍使用互补模式；已存储的偏好不受影响。

## 迁移

1. 若要恢复排队行为，打开“设置 → 通用”，在忙碌时 Enter 行为项中选择“排队”，或在 `$DSH_HOME/cordis.patch.yml` 的 `ui-conversation` 命名空间存储 `busyEnter: queue`。
2. 通过在回合运行中发送一条消息确认迁移结果：Steer 行为进入 pending-steering 表面，Queue 行为进入 QueueDock。
