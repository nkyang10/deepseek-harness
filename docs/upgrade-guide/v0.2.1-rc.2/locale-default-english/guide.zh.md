---
kind: upgrade-guide
description: "GUI 语言不再跟随浏览器或操作系统，默认使用英文。"
---

# 语言默认改为英文

[English](guide.md) | 中文

## 变更

GUI 语言选择不再读取浏览器或操作系统语言。没有已存储 `locale.preference` 的客户端在 Web、桌面应用和原生壳中都以英文打开；桌面应用菜单遵循同一规则。此前，中文浏览器或系统语言会自动选中中文。语言此前被自动检测的用户在升级后首次启动时会回到英文；设置中的显式选择不受影响。

## 迁移

1. 中文用户在“设置 → 通用 → 语言”中选择“中文”；该选择会以 `locale.preference` 持久化，并对共享同一 DSH home 的所有浏览器生效。
2. 若要在首次启动前设置语言，在 `$DSH_HOME/cordis.patch.yml` 的 `locale` 命名空间存储 `locale.preference: zh`。
3. 通过重新加载确认迁移结果：界面、`<html lang>` 和桌面应用菜单显示所选语言。
