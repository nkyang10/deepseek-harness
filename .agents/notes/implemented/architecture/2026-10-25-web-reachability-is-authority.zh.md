# Agent Note：可达性就是 Web 的权威

Status: implemented

[English](2026-10-25-web-reachability-is-authority.md) | 中文

## 问题

浏览器配对、启动令牌与签名会话 cookie 把一份唯一的 owner 凭据放进每个浏览器请求路径，而 Connection API 的每个消费者——Web、桌面端、Node——都围绕它携带交换、存储、过期、吊销与设备列表机制。这份凭据保护的东西其实早已被监听端口暴露：任何能抵达 socket 的进程也能读到打印出的启动令牌，凭据只是推迟而非阻止机内调用者。产品信任模型现已明确：谁能抵达监听器，谁就代表 owner 发言；端口暴露由运维通过绑定地址、防火墙与代理掌管。

## 决定

`dsh-client-connection` 不做任何认证。`admit(request)` 施加载体栅栏（媒体类型、`Host`、`Origin`、Fetch-Metadata；拒绝返回 403）并交出 `browserPeer`——一个共享 Peer，携带 owner principal 与 `interactions: 'answer'`。已 dispose 的 Connection 服务应答 401。`createPeer({ principal, interactions })` 只在进程内，是非 owner 或不参与应答 Peer 的唯一来源。不存在令牌、cookie、配对码、`/connect` 端点、登出或吊销面；启动行打印朴素的根 URL。`client-connection` 插件保留 `trustedHosts`，不再接受 `cookieMaxAgeDays`。栅栏始终是混淆代理防御，而非身份；绑定准入仍归[绑定一个具体 Web 地址](2026-09-19-concrete-web-bind-address.zh.md)掌管。

已归档的[浏览器启动令牌认证](../../archived/architecture/2026-08-24-browser-token-authentication.md)与[持久浏览器配对](../../archived/architecture/2026-10-17-durable-browser-pairing.md)记录保存被移除机制的取舍理由。[载体级浏览器信任栅栏](2026-07-28-api-browser-trust-boundary.zh.md)掌管栅栏；[Peer principal](2026-10-12-peer-principal-and-remote-access.zh.md)掌管 principal 与应答参与。失效的 `client-connection/browser-session` 凭据记录可以留在 `$DSH_HOME/.credentials.yaml`；没有任何代码读取它，[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.3/web-browser-pairing-removed/guide.zh.md)点名供清理。

## 考虑过的替代方案

**把配对保留为可选。** 第二套信任模型需要一个开关，而文档、测试与每个 Connection 消费者都必须选定并承担一种行为。默认关闭的凭据是死代码；默认开启的则保留了本次变更删除的机制。

**只删配对、保留 cookie。** cookie 仍然标识一个在模型看来毫无意义的身份（每个被放行的请求都是 owner），于是它增加了什么都不决定的过期、轮换与吊销面。

**把随附监听器限制在 loopback。** 绑定准入、`--trusted-host`、`--public-url` 与代理部署的存在，正因为运维需要可抵达的监听器；移除凭据与限制绑定是两个独立决定，绑定保持可配置。

## 后果

任何抵达监听端口的进程或浏览器都能操作完整的具备工具能力的 Host API，包括在非 loopback 绑定上。因此桌面端 Web 与 `dsh web` 部署把网络位置当作访问控制，文档在每一处打印或分享 URL 的地方都写明这一点。`interactions: 'none'` 的 Peer 在 `$events` 与事件应答上仍被 `gateway/interactions-forbidden` 拒绝，所以移除认证并不会让进程内的被动 Peer 应答 owner 的 waterfall。

## 验证

Connection host spec 钉住 403-栅栏与 401-已dispose 的区分、`browserPeer` 在每个被放行请求与流上的共享，以及 `createPeer()` 作为唯一 Peer 来源。Gateway host spec 钉住对不参与应答的 Peer 返回 `gateway/interactions-forbidden`。Web e2e 通道用构建出的监听器证明未配对的浏览器能操作 Host，而外来 `Host` 与跨站请求收到 403。桌面端启动测试钉住**复制 Web 链接**复制朴素绑定地址。`verify-upgrade-guides` 与配对门禁覆盖升级记录。
