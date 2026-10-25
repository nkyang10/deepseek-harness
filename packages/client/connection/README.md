---
description: "Browser-host wire layer for the web GUI: Remote RPC, event-stream delivery with reconnect, exact Fetch routes, the /api HTTP bridge, and the Host/Origin trust fence."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

## Summary

The package carries browser-to-Host Remote calls, exact Fetch responses, and connection generations. The Client plugin mounts `ctx.connection` with current-page loopback state, generic RPC, the active generation and its Host facts, observable recovery state, an immediate reconnect command, and the registration point for one generation source. A generation becomes visible when its source reports ready; source completion, failure, withdrawal, or an explicit stop clears it before `ConnectionController` applies its retry policy.

## Table of Contents

- [Use this package](#use-this-package)
- [Request trust and Peers](#request-trust-and-peers)
- [Connection generation](#connection-generation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `./client` import selects the standalone `lib/client.node.js` ESM bundle in Node and the `lib/client.browser.js` loader factory in browsers. The Web Host still serves the browser export at the logical `/plugins/.../client.js` URL. Import the Client entry for a non-page Cordis tree; the separate package root is the Host entry.

A static desktop page can provide `__DSH_TRANSPORT__.streamBaseUrl` for the HTTP origin of its owned Host. The Gateway uses that origin for its WebSocket while HTTP transport remains independently selected. Reachability of that origin is the access model: a page that can connect speaks for the owner.

Unary RPC requests use JSON. A Host handler may return byte attachments that it has already separated from the JSON-compatible result value, with each attachment naming its result-relative path. Connection writes these values as multipart parts. The JSON `metadata` part contains the RPC response envelope with `null` placeholders and an attachment table recording each path, codec, and part identifier. Paths use string keys and numeric array indices; no business field name is reserved. The Client validates the envelope, `rpcId`, attachment table, and parts, then restores each byte value as an `ArrayBuffer`-backed view. Results without attachments, including base64 strings, and failures remain JSON. Logical RPC carriers return decoded native values directly. Connection does not discover binary fields or depend on Typert; the handler that owns a result protocol performs any type-directed or runtime projection before returning. Binary parameters, events, and streamed binary results are unsupported.

The browser uses HTTP POST for Remote unary calls. API Gateway owns the `/api/remote.mux` WebSocket and its logical streams; shell-owned compositions provide equivalent Remote streams, including a stream's uplink, through `connection.rpc.open` without opening a WebSocket. The browser plugin reads the page transport, recovery settings, and location, then delegates to `installConnection(ctx, options)`. A composition that owns its carrier may call the same installer directly; the whole-client test tier does so. Non-page carriers supply `ClientTransportHooks.createWebSocket` and a `streamBaseUrl` naming the Host origin used for HTTP and the WebSocket; `ConnectionHandle.openWebSocket()` resolves the Mux path against that base and invokes the selected factory. Each invocation creates one Context-owned service, so several Client trees can use different carriers in one realm. The Host half always provides the carrier-neutral RPC and exact `GET`/`HEAD`/`POST` route registries. When a Web carrier is present it also owns the sole `/api` route, Fetch bridge, and Host/Origin trust checks; a shell-owned carrier dispatches the shared Fetch handler directly. Each exact route declares buffered or streaming request-body handling before the bridge reads any bytes. Typert Gateway claims generated Remote endpoints, feature packages register non-JSON responses such as Session-log downloads and raw file uploads, and unclaimed requests return 404. Loopback hostname classification remains package-internal to the browser-facing Client state. Browser raw-body transfer is provided by [`dsh-client-file-upload`](../file-upload/README.md).

-----

<a id="request-trust-and-peers"></a>
## Request trust and Peers

Reachability is the access model: every Web-carrier request that passes `src/api-request-trust.ts` speaks for the owner, and no browser credential exists. The `Host` must be loopback, equal the listener's bind IP literal on any port, or match a `trustedHosts` entry: exact on `host:port`, any port on port-less entries. Host and configured entries use the listener's scheme for WHATWG default-port normalization, not a forwarded header or `Origin`. An attached HTTP(S) `Origin` must name the same authority, with Host parsed under that Origin's scheme to support HTTPS proxies over HTTP upstreams; `sec-fetch-site: cross-site` is refused. Malformed configured authorities fail plugin load. `allowsRemoteAuthorities` reports whether `trustedHosts` permits a non-loopback authority; accepting the bind IP does not change that list. These checks defend DNS rebinding and cross-site browser requests; they never establish identity. A failed Host/Origin check returns 403. A request that arrives after the Connection service is disposed returns 401 before dispatch. `dsh web --host 0.0.0.0` is unsupported. Decision record: [browser request trust](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md).

Every request speaks for one Peer, a `PeerScope` whose `principal` names the caller, whose `interactions` governs participation in forwarded human interactions, and whose `signal` aborts when its scope ends. `ctx.connection.browserPeer` is shared by every request and WebSocket stream the Web carrier admits; it has owner principal and `interactions: 'answer'`. `ctx.connection.admit(request)` runs the trust check and returns that Peer or a rejection. The `/api` route and Gateway WebSocket upgrade use this admission; handlers receive the call's Peer. `ctx.connection.createPeer({ principal, interactions? })` creates an independent in-process Peer, disposed with the Context that read the service or earlier through its own `dispose()`; omitted interactions default to `answer`. The exported `Peer` class accepts the same options. `fetch(request, peer)` and the HTTP bridge take the Peer explicitly; an exact route answers 403 to a non-owner Peer. Method-level access for other principals belongs to [`dsh-api-remote-access`](../../api/remote-access/README.md).

A Peer with `interactions: 'none'` receives no forwarded human interactions: the Gateway refuses `$events` and its event-result endpoint for it with `gateway/interactions-forbidden`, and the Client registers no event stream for it. The declaration serves non-page Client trees and in-process Peers that consume RPC without answering questions; every Web-carrier caller receives the answering browser Peer. `invocation.peer.ctx` cannot register effects after its Peer has been disposed, and already-admitted unary calls retain request-level cancellation.

Shared HTTP requests pass through the `connection/request` waterfall before body transfer. A listener may refuse new requests or await `next()` through response completion; removing its owning fiber removes admission behavior. Desktop uses this hook to lock new API work during an approved installation without canceling already-admitted work. Client disconnection aborts the handler signal; the bridge stops socket writes and drains any remaining response chunks. WebSocket stream ownership remains with API Gateway.

<a id="connection-generation"></a>
## Connection generation

`installConnection` resolves `interactions` to `answer` for pages and `none` for non-page callers unless explicitly supplied. Only answering Clients register the internal `$events` logical stream as the sole generation source, independently of whether any `$on` listener exists. The Host attaches all incremental listeners in the API Remotes source factory, then sends one `{ type: 'ready', clientId, host: { home } }` item before events. `ConnectionController` publishes that generation and calls `onConnected` only after the ready item arrives, so baseline acquisition cannot race ahead of incremental observation.

An ended `$events` stream, a Remote stream error, a non-ready opening item, or a malformed event item invalidates the current generation. A pending handshake logs a slow-Host warning after 3 seconds and logs the readiness timeout and aborts after 15 seconds by default, including time spent waiting for the physical socket. The source must stop delivery, release resources, and settle after cancellation before a replacement starts; late readiness from a cancelled source cannot publish a generation. While the browser reports network availability, the controller publishes `connecting` and retries with 50%–100% jitter under caps of 500ms, 1s, 2s, 4s, 8s, and 10s, continuing at the final cap until recovery. Every retry asks Gateway to replace the physical WebSocket once and reopens `$events`.

`ctx.connection.reconnect()` interrupts active work, resets the sequence, and starts retry 1 immediately. Browser `offline` aborts active work, publishes `disconnected`, and suspends automatic attempts; the next `online` transition resets the sequence and starts at the 500ms tier. Only a ready item publishes `connected`. Gateway mux owns no independent retry schedule.

Set the Host Connection row's `config.recovery` to override retry caps, the growth factor, or handshake warning and cancellation times; the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-client-connection) lists accepted fields. The Host validates these values and injects them into each served page. The Client validates the bootstrap data before providing Connection and uses those defaults when Gateway starts its loop; explicit `start()` timing overrides take precedence. The growth factor must be finite and at least one. Readiness, failure, cancellation, or a hard deadline that occurs before the warning cancels that warning. Reload the page after changing Host recovery configuration.


<a id="model-experience"></a>
## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Buffered `/api` routes retain each request body in memory** — `maxRequestBodyBytes` (default 300 MiB, sized for the default 200 MiB aggregate image limit after base64 expansion plus envelope headroom) bounds ordinary image and RPC envelopes. Opt-in streaming routes receive backpressured chunks and bypass the aggregate cap; route implementations own persistence, cancellation, and any storage quota.
- **Any process that reaches the listener operates as owner** — there is no login, logout, or per-browser revocation, so access control ends at network reachability; a non-loopback deployment must confine the port with TLS, a firewall, or a reverse proxy that authorizes every request ([`dsh-host-webserver`](../../host/webserver/README.md)).


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
