---
kind: upgrade-guide
description: "Connection no longer accepts a `passcode` config key; the owner passcode is written only through Settings as a salted scrypt verifier."
---

# Connection `passcode` config is replaced by the Settings passcode control

English | [中文](guide.zh.md)

## Change

Connection no longer accepts a `passcode` config key in `cordis.yml`, patches, overlays, or settings, and its minimum length is now twelve characters instead of eight. The owner passcode is written only through Settings → General → Remote access and stored as a salted scrypt verifier in the credential store; the plaintext is never persisted. Existing plaintext `passcode:` values are ignored and are not migrated. Browser login pages, pairing links, session cookies, and per-peer throttling behave as before.

## Migration

1. Remove `passcode` from Connection config in `cordis.yml`, profile patches, and settings. Do not migrate the old plaintext value.
2. Open Settings → General → Remote access, enter a passcode of at least twelve characters, and save it. Leave it unset when paired browsers and the pairing link suffice.
3. Confirm the migration by opening the root URL in an unauthenticated browser: a configured passcode shows the passcode form, and clearing it returns the pairing-link sign-in page. The credential store then holds `client-connection/passcode-verifier` with salt and hash fields but no plaintext passcode.
