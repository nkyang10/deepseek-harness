# Agent Note: OpenCode provider configuration import

Status: implemented

English | [中文](2026-10-27-opencode-provider-import.zh.md)

## Problem

Users already running OpenCode have a working provider map in `opencode.json`: gateways, endpoints, model lists, capacities, input modalities, and API keys. The Models page could describe the same pi-ai routes only by retyping each provider and its models. Requiring that retyping made migration error-prone and discouraged trying DSH alongside an existing OpenCode setup.

## Decision

The add card offers **Import from OpenCode** beside the catalog and custom-provider modes. It accepts the same `opencode.json` document through three sources: the Host's default OpenCode config file, a browser-selected file, and pasted text. All three fill one editable textarea, so parsing, preview, and writing have one path. The card translates the `provider` map into pi-ai profiles, writes every importable provider in one settings mutation, and then stores literal API keys through the credential seam. The card reports the imported count, every skipped provider, and each skip reason; it stays open after a profile write so a failed key can be retried alone.

The settings controller mounts a read-only `opencodeConfig` Remote namespace. `readDefault()` resolves `OPENCODE_CONFIG` when set, otherwise the global file under `XDG_CONFIG_HOME` or `~/.config/opencode/opencode.json`, with Windows `APPDATA` and `LOCALAPPDATA` fallbacks. The browser supplies no path, so the endpoint cannot read arbitrary files. The Host returns the first existing regular UTF-8 file up to 1 MiB and lists the candidates when none exists. A missing filesystem or namespace leaves the file and paste sources usable, and the card reports the default source as unavailable.

A provider key becomes `providers.<route>`. Routes are lowercased, runs of characters outside `[a-z0-9]` become `-`, leading and trailing dashes are removed, and an id that cannot start a settings key gains a `p-` prefix (`llama.cpp` → `llama-cpp`, `302.ai` → `p-302-ai`). The document's `name` becomes `displayName`, `options.baseURL` becomes `baseURL`, and `options.apiKey` becomes a write-only credential under the derived `<ROUTE>_API_KEY` reference. `{env:NAME}` and the first usable name in `provider.env` become `apiKeyEnv` instead.

The wire protocol comes from an explicit supported `api`, else the provider's `npm` package, else a known OpenCode provider id. Only protocols the page's schema accepts are written. `@ai-sdk/anthropic` maps to `anthropic-messages`; OpenAI-compatible packages and the listed gateway ids map to `openai-completions`. Providers using packages such as Azure, Bedrock, Vertex, or Google are skipped because their authentication and protocol facts cannot become an equivalent endpoint-plus-key profile.

A model map becomes `models`. The model key or its `id` is the model id; `name`, `limit.context`, and `limit.output` become the display name, `contextWindow`, and `maxTokens`. Input modalities keep the adapter's `text` and `image` values; `attachment: true` supplies text and image when modalities are absent. `reasoning: false` writes `reasoningEfforts: false`; `reasoning: true` writes nothing because OpenCode names no levels and the page must not invent them.

A route the installed catalog ships may inherit its endpoint and models. A route the page does not ship must declare an HTTP(S) endpoint and at least one valid model. The import skips a provider already configured, a later provider that normalizes to an imported route, unsupported protocols, malformed provider or model entries, unusable keys, and routes that cannot satisfy those requirements.

Profiles are written together at the card's opening revision so a conflict leaves the document untouched. Credential literals are stored after that mutation. When a key fails, the profile write remains committed, the card disables the pasted text, and **Retry keys** stores only references that have not succeeded. Closing after a committed write reloads the page snapshot; closing before any write discards the draft.

## Alternatives considered

**Read only the default path.** A fixed file location fails for `OPENCODE_CONFIG`, project configs, and users running DSH on a different machine from OpenCode. The file picker covers any location the browser can read, and paste covers remote or pasted documents. The default source stays a convenience rather than a requirement.

**Read OpenCode's auth store and built-in provider catalogs.** These live outside the config document in OpenCode-managed files and runtime registries. Importing them would couple DSH to another product's private storage and versioned catalogs. The textarea keeps every imported fact visible to the user.

**Extend the pi-ai schema to store OpenCode JSON verbatim.** Keeping the original block would preserve fields DSH cannot interpret, but it would make the settings document and the model runtime disagree about which fields matter. Translation into the existing profile schema keeps one authority.

**Write each provider in its own mutation.** Separate writes would leave a partially imported document after a failure and multiply revision races. One mutation makes the set atomic; credentials remain separate because they use a different seam.

**Map `reasoning: true` to guessed levels.** OpenCode's boolean says a model reasons but not which levels its endpoint accepts. Guessing would advertise levels that the provider rejects. The import keeps only the fact it can carry: `false` disables reasoning.

**Use the OpenCode provider key unchanged.** Keys such as `llama.cpp` and `302.ai` are valid OpenCode ids but invalid pi-ai settings keys and credential-reference stems. Normalization preserves the import instead of dropping those gateways, and the card reports colliding normalized ids rather than overwriting one.

**Accept JSONC in the same change.** `opencode.json` files may carry comments, but adding a comment-aware parser would add a dependency and a second validation path. The import currently accepts plain JSON; the card names invalid JSON rather than silently stripping content.

## Consequences

Users can migrate a working OpenCode provider map from the default Host file, a selected file, or pasted text, including endpoint overrides and literal keys. Skipped providers remain visible with a reason instead of disappearing. The import is one-way and deliberately incomplete: OpenCode's stored authentication, headers, costs, sampling options, built-in catalogs, and `reasoning: true` levels have no page-owned representation. Unsupported protocols and JSONC input are not imported. Default-path discovery and filesystem refusal are pinned by Host tests; translation and skip reasons by parser tests; source loading, mutation order, conflict handling, and key retry by component tests.
