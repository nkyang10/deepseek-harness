---
kind: upgrade-guide
description: "Browser sessions are now per-device and revocable; cookies minted before this release no longer authenticate."
---

# Browser pairing replaces the per-process launch token

English | [中文](guide.zh.md)

## Change

The Web UI's login URL carried a launch token that was regenerated every time the process started, and its cookie identified only the browser's authority. Sharing that link therefore worked exactly once: the next restart invalidated it, and nothing on the page said so. The token has been replaced by a **durable pairing code** stored beside the cookie signing secret, and each browser that opens the link becomes a listed **session** with its own identifier.

A browser paired by an earlier release holds a cookie that names no session, so it is refused with 401 until it pairs again. In Desktop that means the shell window reloads itself and any other browser must reopen the link from 应用菜单 → 复制网页链接 / Application → Copy Web Link. `dsh web` prints the same URL at startup; opening it again pairs the browser. Nothing else about the deployment changes: the cookie is still host-only, `HttpOnly`, `SameSite=Strict`, bound to the same authority, and still 30 days by default.

## Migration

1. Reopen the pairing link in each browser you want to keep signed in. The link is the same URL as before, but the code inside it no longer changes per restart.
2. Review the browsers under 应用菜单 → 已配对设备… / Application → Paired Devices…. Each entry shows the `User-Agent` it presented and when it paired; Revoke Access ends that one browser immediately.
3. Use Replace Pairing Code… if a link has circulated further than intended. Previously copied links then stop pairing new browsers, and browsers already paired keep working.

No file changes are required. The pairing code, the session list, and the cookie signing secret all live in the existing `client-connection/browser-session` record in `~/.dsh/.credentials.yaml`; that record keeps its signing secret across this upgrade, and a record written before sessions existed is upgraded in place on the next start.
