---
kind: upgrade-guide
description: "Connection 不再接受 `passcode` 配置键；所有者口令只能通过设置页写成加盐 scrypt 校验记录。"
---

# Connection 的 `passcode` 配置已由设置页口令控件取代

[English](guide.md) | 中文

## 变更

Connection 不再接受 `cordis.yml`、patch、overlay 或 settings 中的 `passcode` 配置键，口令最小长度也从八个字符改为十二个字符。所有者口令只能通过“设置 → 通用 → 远程访问”写入，并以加盐 scrypt 校验记录的形式保存在凭据库中；明文从不持久化。已有的明文 `passcode:` 值会被忽略，不会迁移。浏览器登录页、配对链接、会话 cookie 与按对端地址限流的行为保持不变。

## 迁移

1. 从 `cordis.yml`、profile patch 和 settings 的 Connection 配置中删除 `passcode`。不要迁移旧的明文值。
2. 打开“设置 → 通用 → 远程访问”，输入至少十二个字符的口令并保存。若配对浏览器与配对链接已满足需要，可以留空。
3. 用未认证浏览器打开根 URL 确认迁移：已设置口令时显示口令表单，清除后回到配对链接登录页。此时凭据库保存 `client-connection/passcode-verifier` 记录，其中只有 salt 与 hash 字段，不含明文口令。
