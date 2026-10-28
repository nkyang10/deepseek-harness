---
kind: upgrade-guide
description: "DeepSeek session-log upload is disabled by default and must be opted into."
---

# Session-log upload defaults to off

English | [中文](guide.zh.md)

## Change

The `dsh-session-log-deepseek` plugin's `enabled` configuration now defaults to `false`, and shipped profiles mount the plugin with that default. A deployment without a stored value no longer sends the `dsh_session_log` contribution with DeepSeek requests; previously upload ran unless the user opted out. Sessions recorded while disabled remain local, and re-enabling resumes the unaccepted suffix.

## Migration

1. To keep uploading, turn on Settings → General → **Upload Session Log when using the official model API** in Web, or set the `dsh-session-log-deepseek` plugin's `enabled: true` in `cordis.yml` or a patch layer.
2. Confirm the migration by sending a request and checking that the outgoing DeepSeek request carries the `dsh_session_log` field, or that it is absent after leaving upload off.
