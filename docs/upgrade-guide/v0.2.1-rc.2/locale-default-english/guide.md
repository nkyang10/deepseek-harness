---
kind: upgrade-guide
description: "The GUI language no longer follows the browser or operating system and defaults to English."
---

# Language defaults to English

English | [中文](guide.zh.md)

## Change

GUI language selection no longer reads browser or operating-system languages. A client with no stored `locale.preference` opens on English, in Web, Desktop, and the native shells; the Desktop application menu follows the same rule. Previously a Chinese browser or system language selected Chinese automatically. Users whose language was auto-detected return to English on first launch after upgrading; any explicit selection in Settings is unchanged.

## Migration

1. Chinese users select 中文 in Settings → General → Language; the choice persists as `locale.preference` for every browser on the same DSH home.
2. To set the language before first launch, store `locale.preference: zh` in the `locale` namespace of `$DSH_HOME/cordis.patch.yml`.
3. Confirm the migration by reloading: the UI, `<html lang>`, and the Desktop application menu show the selected language.
