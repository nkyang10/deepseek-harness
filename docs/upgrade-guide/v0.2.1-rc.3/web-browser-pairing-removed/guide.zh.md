---
kind: upgrade-guide
description: "Web 浏览器访问取消配对码与会话 cookie；被 Host/Origin 栅栏放行的每个请求都以 owner 身份操作这个 Host。"
---

# Web 访问取消浏览器配对

[English](guide.md) | 中文

## 变更

`dsh web`、桌面端 Web 监听器与 Web profile 不再签发配对码或浏览器会话 cookie。启动行现在是朴素的 `dsh web: http://127.0.0.1:PORT`，`/connect` 令牌交换端点已移除，被 Host/Origin 栅栏放行的每个请求都以 owner 身份操作这个 Host；栅栏仍以 403 拒绝外来 `Host` 与跨站 `Origin` 值。因此，任何能抵达监听端口的进程或人都获得对这个 Host 的完全操作权。`client-connection` 插件的 `cookieMaxAgeDays` 配置键被移除，桌面端「已配对设备…」与「更换配对码…」菜单消失，「复制 Web 链接」复制的是朴素地址。

## 迁移

1. 从你的 `cordis.yml`、patch 或 overlay 中删除 `client-connection` 条目里的 `cookieMaxAgeDays`；这个键已不再被读取。
2. 重新分享或重新收藏打印出的地址。此前分享的带令牌 URL 不再带有任何特权，只会直接加载应用。
3. 限制可达性——它如今就是访问控制：保持默认的 loopback 绑定，或在绑定可路由地址前用防火墙或带认证的逆向代理限制接口。
4. 可选：删除 `~/.dsh/.credentials.yaml` 中残留的 `client-connection/browser-session` 记录；没有任何代码读取它。

用 `dsh --profile web` 启动并确认打印行不含令牌，然后用一个从未配对过的浏览器配置打开该地址。应用会直接加载并可操作，无需任何登录步骤。
