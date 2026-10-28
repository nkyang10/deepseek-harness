---
kind: upgrade-guide
description: "Pressing Enter during a running turn now steers by default instead of queueing."
---

# Busy Enter defaults to Steer

English | [中文](guide.zh.md)

## Change

The `ui-conversation` settings namespace now defaults `busyEnter` to `steer` instead of `queue`. A browser with no stored `busyEnter` value that presses plain Enter while the turn runs sends the draft as immediate steering rather than adding it to the queue. Cmd/Ctrl+Enter keeps using the complementary mode, and a stored preference is unaffected.

## Migration

1. To restore queueing, open Settings → General and select Queue in the busy-Enter row, or store `busyEnter: queue` for the `ui-conversation` namespace in `$DSH_HOME/cordis.patch.yml`.
2. Confirm the migration by sending a message while a turn runs: it enters QueueDock with the Queue behavior or the pending-steering surface with the Steer behavior.
