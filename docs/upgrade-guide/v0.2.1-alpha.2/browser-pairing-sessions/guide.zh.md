---
kind: upgrade-guide
description: "浏览器会话改为按设备配对且可撤销；本版本之前签发的 cookie 不再通过认证。"
---

# 浏览器配对取代每进程启动令牌
[English](guide.md) | 中文

## 变更

Web UI 的登录 URL 过去携带一个每次进程启动都会重新生成的启动令牌，其 cookie 只标识浏览器的 authority。因此分享该链接实际上只生效一次：下次重启就会失效，而且页面上没有任何提示。该令牌已替换为与 cookie 签名密钥并存的**持久配对码**，每个打开该链接的浏览器都会成为一个带独立标识的已列出会话。

由更早版本配对的浏览器，其 cookie 不携带任何会话标识，因此会收到 401，直到重新配对为止。在 Desktop 中，这意味着 shell 窗口会自行重新加载，其他浏览器则需要重新从 应用菜单 → 复制网页链接 / Application → Copy Web Link 打开该链接。`dsh web` 在启动时打印同一个 URL，再次打开即可配对。部署的其他部分不变：cookie 仍为 host-only、`HttpOnly`、`SameSite=Strict`，绑定同一 authority，默认仍为 30 天。

## 迁移

1. 在每个需要保持登录的浏览器中重新打开配对链接。链接与之前是同一个 URL，但其中的配对码不再随重启变化。
2. 在 应用菜单 → 已配对设备… / Application → Paired Devices… 下检查浏览器列表。每项显示其配对时提供的 `User-Agent` 与配对时间；撤销访问权限会立即终止该浏览器。
3. 如果链接已被过度传播，使用“更换配对码…”。此后此前复制的链接不再配对新浏览器，已配对的浏览器继续可用。

无需改动任何文件。配对码、会话列表与 cookie 签名密钥都保存在 `~/.dsh/.credentials.yaml` 中既有的 `client-connection/browser-session` 记录里；该记录在本次升级中保留其签名密钥，会话功能出现之前写入的记录会在下次启动时原地升级。
