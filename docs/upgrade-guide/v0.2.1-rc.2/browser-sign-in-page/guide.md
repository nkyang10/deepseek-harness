---
kind: upgrade-guide
description: "An unauthenticated request to the served app root now returns a styled HTML sign-in page instead of a plain-text 401 body."
---

# Unauthenticated browser sign-in page replaces the plain-text 401

English | [中文](guide.zh.md)

## Change

`authorizeIndex` no longer answers an unauthenticated browser request to the served app root with the plain-text 401 body. A `GET` or `HEAD` of the root (`/`, `./`) now returns `text/html`: when the owner set a `passcode`, the styled passcode form as before; when no passcode is configured, a self-contained sign-in page that points the visitor to the application's pairing link and names the passcode as the option the owner can enable. Both pages are served with the same no-script, no-frame CSP and no referrer.

Only the browser root is affected. `GET /connect` and its `POST`, every `/api` RPC and WebSocket stream, and a root form `POST` while no passcode is configured still return the `text/plain` 401 body.

Clients that request the root in a browser-like way observe the change. A client that read the previous plain-text 401 body from the root now receives HTML instead.

## Migration

1. Browser users need no action: the root now renders a styled page in place of the raw text.
2. Programmatic clients that read the root's plain-text body must instead target the machine endpoints, whose responses are unchanged: `GET /connect?...` for the pairing exchange and the `/api` RPC surface both keep `text/plain`.
3. Confirm the migration by requesting the root unauthenticated and reading `content-type: text/html`, then requesting `/connect` or an `/api` method and reading `content-type: text/plain`.
