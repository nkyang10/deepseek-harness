# Agent Note: Durable browser pairing with revocable sessions

Status: implemented

English | [中文](2026-10-17-durable-browser-pairing.zh.md)

## Problem

Desktop's Web listener serves the LAN so a phone can reach the GUI ([configurable web bind](../../../../docs/upgrade-guide/v0.2.1-alpha.2/browser-pairing-sessions/guide.md)). That turned the browser launch token into a shareable artifact, and the token was regenerated on every Host start. A link handed to a phone therefore died at the next app restart with no signal: the browser received the same `401` it would have received for a wrong address, and the Desktop 401 body told the user to "reopen the URL printed by `dsh web`" — a CLI that is not running. Two operators shared a link and had no way to see who was connected or to cut one of them off.

The token was designed as a *process* credential, and rotating it per process was the point: a leaked URL expired by restarting the app. Keeping that property and making links durable are in direct conflict, so the decision is which lifetime the product should promise.

## Decision

The credential is split into a **durable pairing code** and **per-device sessions**, and both live in the existing `client-connection/browser-session` grant record beside the cookie signing secret.

The code is durable until its owner replaces it. It is what `authenticatedUrl()` puts in the query and what `Copy Web Link` copies, so a shared link keeps pairing across restarts — the failure this change exists to remove. `ctx.connection.rotatePairingCode()` replaces it; that is the escape hatch for a link that circulated too far, and it is deliberately separate from revocation because a leaked *code* and a unwanted *device* are different problems.

Each browser that exchanges the code becomes a `BrowserSession` with its own opaque `BrowserDeviceId`, and the signed cookie names that session instead of carrying its own lifetime. The session table is therefore the authority on who may talk to the Host: `revokeBrowserSession(id)` drops one row, and every cookie naming it stops verifying at once while other sessions and the code are untouched. Desktop exposes this through Paired Devices…, which lists each browser's presented `User-Agent` and pairing time and confirms before revoking.

Pairing a browser that already holds a session for the same authority reuses its identity and pairing time and refreshes only its expiry, so re-opening a link does not accumulate orphan rows.

The same pairing path accepts an owner-configured **passcode** on a served login page. A matching form POST mints an ordinary per-device session cookie, so the passcode selects who may pair rather than authenticating a standing principal; revocation remains per device. Because the passcode is human-chosen, its POST passes the Host/Origin fence before browser authentication, failures are counted per direct peer address, and the tenth consecutive failure blocks that peer for one minute. A WebView or sandboxed page may submit that form with an opaque `null` Origin; the passcode POST accepts it after the Host fence, while `/api` requests still refuse opaque origins. The owner writes a twelve-to-1024-character passcode through Settings, which stores only a salted scrypt verifier in the `client-connection/passcode-verifier` grant record; the passcode itself is never persisted, and the durable pairing link keeps working beside it. The verifier's fixed cost parameters are validated exactly and a malformed record fails loud.

`authorizeIndex` is asynchronous, because a successful passcode submission derives its key and a successful pairing writes the session before either can mint the cookie. That propagated to `serveStatic` and the experimental inspector's DevTools route, both of which were already inside async handlers.

## Verification

`packages/client/connection/tests/browser-auth.host.spec.ts` covers the durable code across reactivation, distinct sessions per browser, identity retention on re-pairing, revocation of one browser while others and the code survive, rotation, last-seen reporting and expiry pruning, the record upgrade from the pre-session payload, unreadable stored rows failing loud, and pairing after the record is deleted failing loud. It also covers passcode page rendering, verifier creation and restart, matching and malformed submissions, verifier read and write failures, the KDF failure path, per-peer throttling and recovery, and the authenticated route around the page. `packages/api/settings-controller/tests/web-access.host.spec.ts` covers status, set, clear, and refusal mapping through the generated Remote namespace; the Web row and inject wiring are covered by `packages/client/ui-settings-general` tests. `node-half.host.spec.ts` keeps uniform 401/403 behavior across RPC, Fetch routes, and WebSocket upgrades, including the passcode POST trust fence and its opaque-origin opt-in. `packages/host/frontend-static/tests/frontend-static.spec.ts` pins the served login form, the pairing redirect, the authenticated POST redirect, and the fixed form-body bound through the real Loader composition. `apps/desktop/tests/host-process.spec.ts` pins IPC correlation, the per-kind deadline, and rejection of a malformed answer; `apps/desktop/tests/main-startup.spec.ts` pins the menu label, the device list, the cancelled and confirmed revocation paths, and that rotation is what Copy Web Link then copies.

## Consequences

- **The code outlives the process, so exposure outlives it too.** A 256-bit unguessable code resists brute force; the real risk is sharing, which is why the code is rotatable and every device it pairs is revocable. No attempt-limiting was added: it would add state to the index request path to defend against a threat the code's entropy already excludes.
- **`lastSeenAt` is published in memory first.** Request authentication is synchronous and must not await the credential file, so a touch updates the in-memory table and the durable write happens on the next pairing, revocation, rotation, or `listBrowserSessions()` — the only consumer of the value. `persist()` merges those observations forward by taking the newer of the file's and the activation's timestamp, so a concurrent structural change from another process is not clobbered.
- **Every pre-existing cookie stops verifying.** The old payload named no device, so accepting it would mean keeping a second authentication path. The record's signing secret is preserved across the upgrade and the code plus an empty table are written beside it, so re-pairing is the only user-visible effect.
- **A paired browser is identified by what it presented.** The `User-Agent` is the only human-readable fact the Host has, so two browsers behind the same string are indistinguishable in the list. A richer identity would require the browser to prove something, which plain HTTP pairing cannot ask for.
- **The passcode is a lower-entropy credential with a bounded guessing window.** Ten consecutive failures per direct peer address block that address for one minute; the count clears on success. A distributed attacker is not bounded by one address, so a deployment that exposes the passcode beyond a trusted network still relies on TLS and on the passcode's own length. The stored verifier uses fixed scrypt cost parameters (N=65536, r=8, p=2), a 16-byte salt, and a 32-byte derived key; a stolen credential record cannot be replayed as a passcode, and a malformed record fails loud rather than accepting attacker-chosen parameters. The login page carries a no-script/no-frame CSP and no referrer, and its markup contains only fixed error tokens.

## Alternatives considered

**Keep the per-process token and accept dead links.** Cheapest, and it is what shipped first. Rejected: the user's only recovery was to find a URL nothing displayed, and the failure was indistinguishable from a wrong address.

**A stable shared password that authenticates every request without pairing.** Familiar, but it grants standing access to anyone who learns it and offers no per-device identity to revoke. The shipped passcode avoids that form: it only opens the pairing exchange, so a correct submission still mints a revocable per-device session. Its human-chosen entropy is why the form POST is trust-fenced and failure-throttled.

**Sliding expiry, refreshed on each request.** Would keep active browsers signed in indefinitely. Rejected: an unbounded session lifetime contradicts `cookieMaxAgeDays`, whose absolute semantics the previous decision fixed.

**Not persisting the session list, deriving liveness from cookie expiry alone.** Avoids the merge logic above. Rejected: revocation is impossible without a durable list, and revocation is the reason this change exists.
