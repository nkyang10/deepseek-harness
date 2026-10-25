# Agent Note: Web 监听器原生 HTTPS

Status: implemented

[English](2026-09-23-native-https-web-listener.md) | 中文

## Problem

浏览器直接访问的 Web 监听器需要在不依赖独立反向代理的情况下加密自身流量。公告 HTTPS URL 不会加密监听器，也不会建立证书信任。

## Decision

WebServer 通过 `tls: { certFile, keyFile }` 拥有可选 TLS，由 `dsh web` 的成对 `--tls-cert` 与 `--tls-key` flag 暴露。证书与不带口令的私钥 PEM 文件在绑定前加载；材料不可读、为空、无效或不匹配时激活失败，绝不回退到 HTTP。HTTP 仍为默认值。两种传输共用路由、升级与释放；释放也负责未完成的 TLS 握手。

`webServer.protocol` 决定绑定地址 URL 与非 loopback 明文 HTTP 警告。转发 header 与 `publicUrl` 都不控制加密。显式 Host 端口授权按监听器的 scheme 归一化，Origin 比较则按 Origin 的 HTTP(S) scheme 进行，以允许 HTTPS 代理保留 HTTP 上游。TLS 不授予额外的 Host authority；Host/Origin 栅栏在两种传输上完全相同（[决策](2026-07-28-api-browser-trust-boundary.zh.md)）。

API authority 校验不会把代理的上游传输等同于浏览器页面的 scheme。HTTPS 监听器可接受 authority 匹配的 HTTP Origin，但 `sec-fetch-site: cross-site` 仍会拒绝请求。这不表示支持以 HTTP 向公开浏览器前端提供页面、同时使用 TLS 上游。

默认端口遵循 URL 归一化，不为 443 端口另设写法。

证书签发、信任、续期与更换归操作者负责。每次激活只读取一次文件；更换后需重新加载监听器或重启进程。证书必须覆盖 TLS 客户端拨号的 hostname 或 IP。默认端口仍为 3080；`--port` 可选择其他端口，但受操作系统权限约束。

## Alternatives considered

**要求终止 TLS 的代理。** 仍然支持，但会为直接访问的监听器增加一个服务。

**根据 `publicUrl` 或转发 header 推导传输安全属性。** 公告不描述接收请求的 socket，请求 header 也不能建立可信代理身份。原生监听器状态使这一决策独立于代理策略。

**签发、续期或生成证书。** 这会增加证书生命周期与信任分发职责。自动生成证书本身不能建立浏览器信任。

**证书错误时回退到 HTTP。** 这会在操作者明确要求加密时暴露流量；激活必须失败。

## Consequences

直接 HTTPS 不需要终止 TLS 的代理。HTTP 监听器前的 HTTPS 代理仍负责外部传输加密。公开浏览器侧部署必须保持 HTTPS，使被放行的流量不会在传输中被读取（[可达性就是权威](2026-10-25-web-reachability-is-authority.zh.md)）。部署步骤归[公开部署指南](../../../../docs/user/guide/public-deployments.zh.md)所有。

本决策部分取代[具体绑定地址](2026-09-19-concrete-web-bind-address.zh.md)中仅支持 HTTP 的前提，该说明继续定义绑定准入并保持活跃。

## Testing

WebServer 套件覆盖校验证书的 HTTPS、无效材料与释放。Connection 覆盖精确端口授权；Web 启动拒绝未配对的 flag。已构建 CLI 的 `public-url.expected.e2e.ts` 经校验证书的 TLS 提供服务，并保留 HTTP 与代理用例；失败矩阵验证 TLS 材料不可读时进程退出且不打开监听器。Desktop 启动套件覆盖匹配的 WS/WSS scheme 推导及不同传输下的拒绝。
