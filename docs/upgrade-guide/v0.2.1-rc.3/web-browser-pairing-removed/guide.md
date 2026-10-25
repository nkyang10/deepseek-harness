---
kind: upgrade-guide
description: "Web browser access drops pairing codes and session cookies; every request the Host/Origin fence admits operates the Host as its owner."
---

# Web access drops browser pairing

English | [中文](guide.zh.md)

## Change

`dsh web`, the desktop Web listener, and the Web profile no longer issue pairing codes or browser session cookies. The startup line is now the plain `dsh web: http://127.0.0.1:PORT`, the `/connect` token-exchange endpoint is gone, and every request the Host/Origin fence admits operates the Host as its owner; the fence still refuses foreign `Host` and cross-site `Origin` values with 403. Anyone or any process that can reach the listener port therefore has full operation of the Host. The `client-connection` plugin's `cookieMaxAgeDays` config key is removed, the desktop menus "Paired Devices…" and "Replace Pairing Code…" are gone, and "Copy Web Link" copies the plain address.

## Migration

1. Delete `cookieMaxAgeDays` from any `client-connection` entry in your `cordis.yml`, patches, or overlays; the key is no longer read.
2. Re-share or re-bookmark the printed address. A previously shared tokenized URL carries no privilege anymore and just loads the application.
3. Limit reachability, which is now the access control: keep the default loopback bind, or restrict the interface with a firewall or an authenticating reverse proxy before binding a routable address.
4. Optionally delete the stale `client-connection/browser-session` record from `~/.dsh/.credentials.yaml`; nothing reads it.

Start with `dsh --profile web` and confirm the printed line carries no token, then open that address in a browser profile that never paired. The application loads and operates without any sign-in step.
