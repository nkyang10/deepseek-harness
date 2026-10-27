/**
 * Translate an OpenCode (`opencode.json`) provider configuration into pi-ai
 * provider profiles this page can write.
 *
 * OpenCode describes providers as a map keyed by provider id, each entry naming
 * an AI SDK package (`npm`), an endpoint and credential (`options`), and a map
 * of models. The page can only declare pi-ai routes, so the import keeps the
 * facts both formats share — provider id, display name, endpoint, protocol,
 * model ids, capacities, input modalities, and a literal API key — and reports
 * everything it cannot carry instead of writing a silently different route.
 *
 * The translation is deliberately one-way and best-effort: OpenCode's built-in
 * catalogs, stored auth records, headers, costs, and sampling options have no
 * page-owned home, so they are not imported. A provider whose protocol cannot
 * be inferred, whose custom route has no endpoint or models, or whose id
 * collides with one already configured is skipped with a reason the card names.
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { apiKeyFailure } from './apiKey.ts'
import { deriveKeyRef } from './store.ts'

/** Why one OpenCode provider could not become a pi-ai route. */
export type OpencodeSkipReason =
  /** The provider id is already configured on this page. */
  | 'existing'
  /** A second provider in the same document normalizes to the same route id. */
  | 'duplicate'
  /** The provider id has no characters usable as a settings key. */
  | 'route'
  /** The provider entry is not an object describing a provider. */
  | 'config'
  /** No supported pi-ai wire protocol could be inferred from `api`, `npm`, or the provider id. */
  | 'protocol'
  /** A route the catalog does not ship has no usable HTTP endpoint. */
  | 'base-url'
  /** A route the catalog does not ship declares no models. */
  | 'models'
  /** An explicitly declared model is malformed. */
  | 'model'
  /** The embedded API key cannot be stored through this page. */
  | 'credential'
  /** The provider entry yields no setting this page can write. */
  | 'no-settings'

/** One provider the import will write. */
export interface OpencodeImportProvider {
  /** Normalized pi-ai route id. */
  route: string
  /** The profile written at `providers.<route>`. */
  profile: Record<string, JsonValue>
  /** A literal key from `options.apiKey`, to store under `profile.apiKeyEnv`. */
  credential?: { ref: string; value: string }
}

/** One provider left out of the import, with the reason the card renders. */
export interface OpencodeImportSkip {
  /** Provider id as the document spelled it. */
  provider: string
  /** Why the provider was skipped. */
  reason: OpencodeSkipReason
}

/** The importable providers and the skipped ones. */
export interface OpencodeImportResult {
  providers: OpencodeImportProvider[]
  skipped: OpencodeImportSkip[]
}

/** What reading the pasted document produced. */
export type OpencodeParseOutcome =
  | { kind: 'ok'; result: OpencodeImportResult }
  /** The text is not JSON. */
  | { kind: 'invalid-json' }
  /** The JSON contains no recognizable OpenCode provider map. */
  | { kind: 'invalid-config' }

/** Facts about this page needed to translate a provider. */
export interface OpencodeParseOptions {
  /** Route ids already registered or configured. */
  taken?: readonly string[]
  /** Routes the installed pi-ai catalog ships, which may keep their catalog endpoint and models. */
  shipped?: readonly string[]
  /** Wire protocols the owning namespace's schema accepts. */
  protocols?: readonly string[]
}

/** The three protocols this page names today; an adapter that adds one keeps accepting it through the schema read. */
const DEFAULT_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

/**
 * AI SDK packages whose protocol maps to one pi-ai serves. Packages absent
 * here (Azure, Bedrock, Vertex, Google) authenticate in ways a profile cannot
 * describe with an endpoint and key, so a route using them is left out.
 */
const NPM_PROTOCOLS: Readonly<Record<string, string>> = {
  '@ai-sdk/openai-compatible': 'openai-completions',
  '@ai-sdk/openai': 'openai-completions',
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/deepseek': 'openai-completions',
  '@ai-sdk/xai': 'openai-completions',
  '@ai-sdk/cerebras': 'openai-completions',
  '@ai-sdk/groq': 'openai-completions',
  '@ai-sdk/togetherai': 'openai-completions',
  '@ai-sdk/fireworks': 'openai-completions',
  '@openrouter/ai-sdk-provider': 'openai-completions',
}

/**
 * Protocols of OpenCode providers configured without `npm`. OpenCode resolves
 * these from its own built-in catalog, so a document that only edits their
 * endpoint or key names no package at all.
 */
const ROUTE_PROTOCOLS: Readonly<Record<string, string>> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-completions',
  deepseek: 'openai-completions',
  'opencode-zen': 'openai-completions',
  'opencode-go': 'openai-completions',
  openrouter: 'openai-completions',
  groq: 'openai-completions',
  cerebras: 'openai-completions',
  xai: 'openai-completions',
  moonshotai: 'openai-completions',
  zai: 'openai-completions',
  minimax: 'openai-completions',
  deepinfra: 'openai-completions',
  nvidia: 'openai-completions',
  'fireworks-ai': 'openai-completions',
}

/** A credential reference is a POSIX shell identifier (mirrored from `dsh-credentials`). */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** OpenCode's environment-variable substitution form. */
const ENV_PLACEHOLDER = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/

/** An object from parsed JSON, without asserting through `unknown` for each read. */
type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A trimmed non-empty string, or undefined. */
function textAt(source: JsonObject, key: string): string | undefined {
  const value = source[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A positive whole number, or undefined. */
function countAt(source: JsonObject, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** The input modalities an OpenCode model declares, limited to the two this adapter serves. */
function inputModalities(value: JsonObject): string[] {
  const modalities = value['modalities']
  if (!isObject(modalities)) return []
  const input = modalities['input']
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string =>
    typeof item === 'string' && (item === 'text' || item === 'image'))
}

/** The first usable credential reference in an OpenCode provider's `env` list. */
function envRef(value: JsonObject): string | undefined {
  const env = value['env']
  if (!Array.isArray(env)) return undefined
  return env.find((name): name is string => typeof name === 'string' && REF_PATTERN.test(name))
}

/** Whether a string is an HTTP(S) URL. */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Turn an OpenCode provider id into the lowercase hyphenated route id this
 * page can write. OpenCode ids may contain dots (`llama.cpp`) or start with a
 * digit; both are outside the settings-key grammar, and leaving them out would
 * drop otherwise importable gateway configurations.
 * @param provider - the document's provider id.
 * @returns the normalized route id, or undefined when nothing usable remains.
 */
export function normalizeOpencodeRoute(provider: string): string | undefined {
  const collapsed = provider.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (collapsed.length === 0) return undefined
  return /^[a-z]/.test(collapsed) ? collapsed : `p-${collapsed}`
}

/** Strip an npm version suffix without mistaking the scope marker for one. */
function packageName(npm: string): string {
  const at = npm.lastIndexOf('@')
  return at > 0 ? npm.slice(0, at) : npm
}

/** The protocol a provider entry names, when the page accepts it. */
function protocolOf(
  provider: string,
  entry: JsonObject,
  protocols: readonly string[],
): string | undefined {
  const explicit = textAt(entry, 'api')
  if (explicit !== undefined && protocols.includes(explicit)) return explicit
  const npm = textAt(entry, 'npm')
  const inferred = npm === undefined ? ROUTE_PROTOCOLS[provider] : NPM_PROTOCOLS[packageName(npm)]
  return inferred !== undefined && protocols.includes(inferred) ? inferred : undefined
}

/**
 * Map one OpenCode model map to pi-ai model entries.
 * @param raw - the provider's `models` value.
 * @returns the model entries, or a failure when one entry is malformed.
 */
function importModels(raw: unknown): { models: Record<string, JsonValue>[] } | undefined {
  if (raw === undefined) return { models: [] }
  if (!isObject(raw)) return undefined
  const models: Record<string, JsonValue>[] = []
  const seen = new Set<string>()
  for (const [key, value] of Object.entries(raw)) {
    if (!isObject(value)) return undefined
    const id = textAt(value, 'id') ?? key.trim()
    if (id.length === 0 || seen.has(id)) return undefined
    seen.add(id)
    const model: Record<string, JsonValue> = { id }
    const name = textAt(value, 'name')
    if (name !== undefined) model['name'] = name
    const limit = value['limit']
    if (isObject(limit)) {
      const contextWindow = countAt(limit, 'context')
      const maxTokens = countAt(limit, 'output')
      if (contextWindow !== undefined) model['contextWindow'] = contextWindow
      if (maxTokens !== undefined) model['maxTokens'] = maxTokens
    }
    const declared = inputModalities(value)
    if (declared.length > 0) {
      // Text is the floor every request carries, so an image-only declaration
      // would describe a model this adapter can never address.
      model['input'] = declared.includes('text') ? declared : ['text', ...declared]
    } else if (value['attachment'] === true) {
      model['input'] = ['text', 'image']
    }
    // OpenCode's boolean says a model supports reasoning, but names no levels.
    // A `false` is the one fact this page can carry: it disables reasoning.
    if (value['reasoning'] === false) model['reasoningEfforts'] = false
    models.push(model)
  }
  return { models }
}

/**
 * Read the provider map out of a pasted OpenCode document. Both a complete
 * config object and the bare `provider` value are accepted.
 * @param document - parsed JSON.
 * @returns the provider map, or undefined when no map is recognizable.
 */
function providerMap(document: JsonObject): JsonObject | undefined {
  const nested = document['provider']
  if (nested !== undefined) return isObject(nested) ? nested : undefined
  const entries = Object.values(document)
  if (entries.length === 0 || !entries.every(isObject)) return undefined
  const looksLikeProviders = entries.some(entry =>
    ['npm', 'options', 'models', 'env', 'api', 'whitelist', 'blacklist'].some(key => key in entry))
  return looksLikeProviders ? document : undefined
}

/**
 * Translate an OpenCode provider configuration.
 * @param text - the pasted document.
 * @param options - known routes, shipped catalog routes, and accepted protocols.
 * @returns the importable and skipped providers, or why the document was unusable.
 */
export function parseOpencodeConfig(text: string, options: OpencodeParseOptions = {}): OpencodeParseOutcome {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { kind: 'invalid-json' }
  }
  if (!isObject(document)) return { kind: 'invalid-config' }
  const providers = providerMap(document)
  if (providers === undefined) return { kind: 'invalid-config' }

  const taken = new Set(options.taken ?? [])
  const shipped = new Set(options.shipped ?? [])
  const protocols = options.protocols ?? [...DEFAULT_PROTOCOLS]
  const imported: OpencodeImportProvider[] = []
  const skipped: OpencodeImportSkip[] = []
  const routes = new Set<string>()
  for (const [provider, value] of Object.entries(providers)) {
    if (!isObject(value)) {
      skipped.push({ provider, reason: 'config' })
      continue
    }
    const route = normalizeOpencodeRoute(provider)
    if (route === undefined) {
      skipped.push({ provider, reason: 'route' })
      continue
    }
    if (taken.has(route)) {
      skipped.push({ provider, reason: 'existing' })
      continue
    }
    if (routes.has(route)) {
      skipped.push({ provider, reason: 'duplicate' })
      continue
    }

    const api = protocolOf(provider, value, protocols)
    const modelResult = importModels(value['models'])
    if (modelResult === undefined) {
      skipped.push({ provider, reason: 'model' })
      continue
    }
    const models = modelResult.models
    if (api === undefined
      && (models.length > 0 || textAt(value, 'api') !== undefined || textAt(value, 'npm') !== undefined)) {
      skipped.push({ provider, reason: 'protocol' })
      continue
    }

    const rawOptions = value['options']
    const endpoint = isObject(rawOptions) ? textAt(rawOptions, 'baseURL') : undefined
    if (endpoint !== undefined && !isHttpUrl(endpoint)) {
      skipped.push({ provider, reason: 'base-url' })
      continue
    }
    if (endpoint === undefined && !shipped.has(route)) {
      skipped.push({ provider, reason: 'base-url' })
      continue
    }
    if (models.length === 0 && !shipped.has(route)) {
      skipped.push({ provider, reason: 'models' })
      continue
    }

    const profile: Record<string, JsonValue> = {}
    const displayName = textAt(value, 'name')
    if (displayName !== undefined) profile['displayName'] = displayName
    if (api !== undefined) profile['api'] = api
    if (endpoint !== undefined) profile['baseURL'] = endpoint

    let credential: OpencodeImportProvider['credential']
    const literalKey = isObject(rawOptions) ? rawOptions['apiKey'] : undefined
    if (literalKey !== undefined && typeof literalKey !== 'string') {
      skipped.push({ provider, reason: 'credential' })
      continue
    }
    const keyValue = literalKey?.trim() ?? ''
    const envMatch = literalKey === undefined ? null : ENV_PLACEHOLDER.exec(keyValue)
    if (envMatch !== null) {
      profile['apiKeyEnv'] = keyValue.slice('{env:'.length, -1)
    } else if (literalKey !== undefined && keyValue.length === 0) {
      // An empty literal is OpenCode's "no key configured", not a secret.
    } else if (literalKey !== undefined) {
      if (keyValue.includes('{') || apiKeyFailure(keyValue) !== undefined) {
        skipped.push({ provider, reason: 'credential' })
        continue
      }
      const ref = deriveKeyRef(route)
      profile['apiKeyEnv'] = ref
      credential = { ref, value: keyValue }
    } else {
      const env = envRef(value)
      if (env !== undefined) profile['apiKeyEnv'] = env
    }

    if (models.length > 0) profile['models'] = models
    if (Object.keys(profile).length === 0) {
      skipped.push({ provider, reason: 'no-settings' })
      continue
    }
    routes.add(route)
    imported.push({
      route,
      profile,
      ...credential === undefined ? {} : { credential },
    })
  }
  return { kind: 'ok', result: { providers: imported, skipped } }
}
