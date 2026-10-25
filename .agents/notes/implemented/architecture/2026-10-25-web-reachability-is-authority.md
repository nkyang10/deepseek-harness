# Agent Note: Reachability is the Web authority

Status: implemented

English | [中文](2026-10-25-web-reachability-is-authority.zh.md)

## Problem

Browser pairing, launch tokens, and signed session cookies put a single owner credential in every browser request path, and every consumer of the Connection API — Web, desktop, and Node — carried exchange, storage, expiry, revocation, and device-listing machinery around it. The credential guarded what the listener's port already exposed: any process that could reach the socket could also read the printed launch token, so the credential delayed rather than blocked an on-host caller. The product trust model is now explicit: whoever reaches the listener speaks for the owner, and the operator owns port exposure through the bind address, firewall, and proxy.

## Decision

`dsh-client-connection` authenticates nothing. `admit(request)` applies the carrier fence (media type, `Host`, `Origin`, Fetch-Metadata; 403 on refusal) and yields `browserPeer`, one shared Peer with the owner principal and `interactions: 'answer'`. A disposed Connection service answers 401. `createPeer({ principal, interactions })` is in-process and is the only source of non-owner or non-answering Peers. No token, cookie, pairing code, `/connect` endpoint, logout, or revocation surface exists; the startup line prints the plain root URL. The `client-connection` plugin keeps `trustedHosts` and no longer accepts `cookieMaxAgeDays`. The fence stays a confused-deputy defense, never identity, and bind admission stays owned by [Bind one concrete Web address](2026-09-19-concrete-web-bind-address.md).

The archived [browser launch-token authentication](../../archived/architecture/2026-08-24-browser-token-authentication.md) and [durable browser pairing](../../archived/architecture/2026-10-17-durable-browser-pairing.md) records own the removed mechanisms' rationale. The [carrier-level browser-trust boundary](2026-07-28-api-browser-trust-boundary.md) owns the fence; [Peer principals](2026-10-12-peer-principal-and-remote-access.md) owns principals and interaction participation. The dead `client-connection/browser-session` credential record may remain in `$DSH_HOME/.credentials.yaml`; nothing reads it, and the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.3/web-browser-pairing-removed/guide.md) names it for cleanup.

## Alternatives considered

**Keep pairing as an option.** A second trust model needs a switch, and documentation, tests, and every Connection consumer must select and carry one behavior. An off-by-default credential is dead code; an on-by-default one keeps the machinery this change removed.

**Keep cookies and drop only pairing.** The cookie still names an identity the model says is meaningless (every admitted request is the owner), so it adds expiry, rotation, and revocation surfaces that decide nothing.

**Restrict the shipped listener to loopback.** Bind admission, `--trusted-host`, `--public-url`, and proxy deployments exist because operators serve reachable listeners; removing the credential and restricting the bind are independent decisions, and the bind stays configurable.

## Consequences

Any process or browser that reaches the listener port operates the complete tool-capable Host API, including on a non-loopback bind. Desktop Web and `dsh web` deployments therefore rely on network placement as access control, and the docs state this wherever they print or share a URL. `interactions: 'none'` Peers stay refused on `$events` and event results with `gateway/interactions-forbidden`, so removing authentication does not let a passive in-process Peer answer owner waterfalls.

## Verification

Connection host specs pin the 403-fence versus 401-disposed split, `browserPeer` sharing across every admitted request and stream, and `createPeer()` as the only Peer source. Gateway host specs pin `gateway/interactions-forbidden` for non-answering Peers. The Web e2e lane boots a built listener and proves an unpaired browser operates the Host while foreign `Host` and cross-site requests receive 403. Desktop startup pins that **Copy Web Link** copies the plain bind address. `verify-upgrade-guides` and the pairing gate cover the upgrade record.
