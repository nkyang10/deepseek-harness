# Agent Note: Durable browser pairing with revocable sessions

Status: implemented
Archived: 2026-10-25

English | [中文](2026-10-17-durable-browser-pairing.zh.md)

## Problem

Desktop's Web listener serves the LAN so a phone can reach the GUI ([configurable web bind](../../../../docs/upgrade-guide/v0.2.1-alpha.2/browser-pairing-sessions/guide.md)). That turned the browser launch token into a shareable artifact, and the token was regenerated on every Host start. A link handed to a phone therefore died at the next app restart with no signal: the browser received the same `401` it would have received for a wrong address, and the Desktop 401 body told the user to "reopen the URL printed by `dsh web`" — a CLI that is not running. Two operators shared a link and had no way to see who was connected or to cut one of them off.

The token was designed as a *process* credential, and rotating it per process was the point: a leaked URL expired by restarting the app. Keeping that property and making links durable are in direct conflict, so the decision is which lifetime the product should promise.

## Decision

The credential is split into a **durable pairing code** and **per-device sessions**, and both live in the existing `client-connection/browser-session` grant record beside the cookie signing secret.

The code is durable until its owner replaces it. It is what `authenticatedUrl()` puts in the query and what `Copy Web Link` copies, so a shared link keeps pairing across restarts — the failure this change exists to remove. `ctx.connection.rotatePairingCode()` replaces it; that is the escape hatch for a link that circulated too far, and it is deliberately separate from revocation because a leaked *code* and a unwanted *device* are different problems.

Each browser that exchanges the code becomes a `BrowserSession` with its own opaque `BrowserDeviceId`, and the signed cookie names that session instead of carrying its own lifetime. The session table is therefore the authority on who may talk to the Host: `revokeBrowserSession(id)` drops one row, and every cookie naming it stops verifying at once while other sessions and the code are untouched. Desktop exposes this through Paired Devices…, which lists each browser's presented `User-Agent` and pairing time and confirms before revoking.

Pairing a browser that already holds a session for the same authority reuses its identity and pairing time and refreshes only its expiry, so re-opening a link does not accumulate orphan rows.

`authorizeIndex` became asynchronous, because a successful pairing writes the session before it can mint the cookie. That propagated to `serveStatic` and the experimental inspector's DevTools route, both of which were already inside async handlers.

## Verification

`packages/client/connection/tests/browser-auth.host.spec.ts` covers the durable code across reactivation, distinct sessions per browser, identity retention on re-pairing, revocation of one browser while others and the code survive, rotation, last-seen reporting and expiry pruning, the record upgrade from the pre-session payload, unreadable stored rows failing loud, and pairing after the record is deleted failing loud. `node-half.host.spec.ts` keeps uniform 401/403 behavior across RPC, Fetch routes, and WebSocket upgrades. `apps/desktop/tests/host-process.spec.ts` pins IPC correlation, the per-kind deadline, and rejection of a malformed answer; `apps/desktop/tests/main-startup.spec.ts` pins the menu label, the device list, the cancelled and confirmed revocation paths, and that rotation is what Copy Web Link then copies.

## Consequences

- **The code outlives the process, so exposure outlives it too.** A 256-bit unguessable code resists brute force; the real risk is sharing, which is why the code is rotatable and every device it pairs is revocable. No attempt-limiting was added: it would add state to the index request path to defend against a threat the code's entropy already excludes.
- **`lastSeenAt` is published in memory first.** Request authentication is synchronous and must not await the credential file, so a touch updates the in-memory table and the durable write happens on the next pairing, revocation, rotation, or `listBrowserSessions()` — the only consumer of the value. `persist()` merges those observations forward by taking the newer of the file's and the activation's timestamp, so a concurrent structural change from another process is not clobbered.
- **Every pre-existing cookie stops verifying.** The old payload named no device, so accepting it would mean keeping a second authentication path. The record's signing secret is preserved across the upgrade and the code plus an empty table are written beside it, so re-pairing is the only user-visible effect.
- **A paired browser is identified by what it presented.** The `User-Agent` is the only human-readable fact the Host has, so two browsers behind the same string are indistinguishable in the list. A richer identity would require the browser to prove something, which plain HTTP pairing cannot ask for.

## Alternatives considered

**Keep the per-process token and accept dead links.** Cheapest, and it is what shipped first. Rejected: the user's only recovery was to find a URL nothing displayed, and the failure was indistinguishable from a wrong address.

**A stable shared password typed into the browser.** Familiar, but it grants standing access to anyone who learns it, offers no per-device identity to revoke, and would have to be stored and compared as a user secret. The pairing code has the same sharing property but pairs a device rather than authenticating a person, which is what revocation needs.

**Sliding expiry, refreshed on each request.** Would keep active browsers signed in indefinitely. Rejected: an unbounded session lifetime contradicts `cookieMaxAgeDays`, whose absolute semantics the previous decision fixed.

**Not persisting the session list, deriving liveness from cookie expiry alone.** Avoids the merge logic above. Rejected: revocation is impossible without a durable list, and revocation is the reason this change exists.
