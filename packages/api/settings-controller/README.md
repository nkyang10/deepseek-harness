---
description: "Host Remote owner for settings, credential, OpenCode config, and write-only Web passcode surfaces, including redacted reads, writes, credential references, native document opening, and the default OpenCode config read."
kind: "package-reference"
---
# Settings Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-settings-controller` exposes generated `ctx.remote.settings`, `ctx.remote.credentials`, `ctx.remote.opencodeConfig`, and `ctx.remote.webAccess` namespaces for browser configuration surfaces. It returns redacted settings and credential metadata, supports settings and credential writes without returning secret values, opens provider-owned settings or Agent preset locations on the Host desktop, reads the Host's default OpenCode config file without accepting a browser-supplied path, and writes the Connection passcode as a one-way verifier without returning it. When a provider is absent, the namespace remains registered and returns an actionable configuration error.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in a profile that serves browser configuration. The entry registers all four namespaces independently of their providers so a missing provider produces a named configuration error at invocation. Its generated descriptors enter the strict Typert registry, while the settings and credential Definitions remain plain Cordis Services with no wire obligations of their own.

`describe(refs)` answers one map keyed by the requested names, so a settings page describing every reference its rows carry settles those rows together. It accepts at most 64 names per call, reports an invalid name or empty write value as `bad-request`, and copies each answer field by field — a provider returning more than `CredentialInfo` declares cannot widen what crosses. Valid `set(ref, value)` and `unset(ref)` calls report a provider refusal as `credential-rejected`, carrying the provider's message with only the reference in its details. Secret values cross in this direction only: no method here returns one.

`settings.describe()` returns deployment facts and every namespace under `redactSecrets: true`. `settings.update`, `settings.replace`, and `settings.mutate` expose the settings service's three write operations and return the namespace's new redacted view; stale writes use `settings-conflict` and other provider refusals use `settings-rejected`.

`settings.openSettingsDocument()` prepares the provider-owned document and opens it with the native text editor; it accepts no browser-supplied filesystem target.

`opencodeConfig.readDefault()` reads the first existing file from OpenCode's documented global locations: `OPENCODE_CONFIG` when set, otherwise `XDG_CONFIG_HOME` or `~/.config/opencode/opencode.json`, with Windows `APPDATA` and `LOCALAPPDATA` fallbacks. It returns the path and UTF-8 contents, refuses non-regular, non-text, or files larger than 1 MiB, and reports an actionable error listing the candidates when none exists. The browser supplies no path, so this namespace cannot read arbitrary files.

`webAccess.status()` reports only whether an owner passcode verifier is stored. `webAccess.setPasscode(passcode)` derives a fresh salt-and-scrypt verifier in Connection and replaces the stored record; `webAccess.clearPasscode()` removes it without revoking paired browsers. No method returns the passcode or verifier. A missing Connection service reports `web-access-unavailable`, and a refused verifier write reports `web-access-rejected` with the operation named.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-settings-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as settings, credential, OpenCode config, and Web passcode reads or writes are browser and Host state and register no prompt, tool, or session event.

#### KV Cache effect

No direct effect; reading or writing these configuration values does not alter model requests already in flight.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The batch bound is fixed at 64 references and is not a deployment-configurable field.
- OpenCode config discovery follows environment and platform conventions rather than a Config field; the 1 MiB read cap is a fixed Host bound.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
