/** Translation of OpenCode provider configuration into pi-ai provider profiles. */
import { describe, expect, it } from 'vitest'
import {
  normalizeOpencodeRoute,
  parseOpencodeConfig,
  type OpencodeImportResult,
} from '../src/client/opencode-import.ts'

function resultOf(text: string, options?: Parameters<typeof parseOpencodeConfig>[1]): OpencodeImportResult {
  const outcome = parseOpencodeConfig(text, options)
  expect(outcome.kind).toBe('ok')
  if (outcome.kind !== 'ok') throw new Error('unreachable')
  return outcome.result
}

describe('normalizeOpencodeRoute', () => {
  it('lowercases, hyphenates punctuation, and prefixes ids that cannot start a settings key', () => {
    expect(normalizeOpencodeRoute('llama.cpp')).toBe('llama-cpp')
    expect(normalizeOpencodeRoute('302.ai')).toBe('p-302-ai')
    expect(normalizeOpencodeRoute(' Acme_Gateway ')).toBe('acme-gateway')
  })

  it('refuses ids with no usable characters', () => {
    expect(normalizeOpencodeRoute('...')).toBeUndefined()
    expect(normalizeOpencodeRoute('')).toBeUndefined()
  })
})

describe('parseOpencodeConfig', () => {
  it('maps a custom OpenAI-compatible provider and all the model facts the page carries', () => {
    const result = resultOf(JSON.stringify({
      provider: {
        'acme-gateway': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Acme Gateway',
          env: ['ACME_API_KEY'],
          options: { baseURL: 'https://gateway.example/v1', apiKey: 'sk-acme' },
          models: {
            'acme-large': {
              name: 'Acme Large',
              attachment: true,
              reasoning: false,
              limit: { context: 128000, output: 8192 },
              modalities: { input: ['text', 'image', 'audio'] },
            },
          },
        },
      },
    }))

    expect(result.skipped).toEqual([])
    expect(result.providers).toHaveLength(1)
    const [provider] = result.providers
    expect(provider?.route).toBe('acme-gateway')
    expect(provider?.profile).toEqual({
      displayName: 'Acme Gateway',
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: 'ACME_GATEWAY_API_KEY',
      models: [{
        id: 'acme-large',
        name: 'Acme Large',
        contextWindow: 128000,
        maxTokens: 8192,
        input: ['text', 'image'],
        reasoningEfforts: false,
      }],
    })
    expect(provider?.credential).toEqual({ ref: 'ACME_GATEWAY_API_KEY', value: 'sk-acme' })
  })

  it('accepts a bare provider map and infers a protocol from the provider id', () => {
    const result = resultOf(JSON.stringify({
      anthropic: {
        options: { baseURL: 'https://anthropic.example/v1' },
        models: { 'claude-sonnet': {} },
      },
    }))

    expect(result.providers[0]?.profile).toEqual({
      api: 'anthropic-messages',
      baseURL: 'https://anthropic.example/v1',
      models: [{ id: 'claude-sonnet' }],
    })
  })

  it('falls back from an unsupported explicit api to a versioned npm package', () => {
    const result = resultOf(JSON.stringify({
      provider: {
        acme: {
          api: 'google-generative',
          npm: '@ai-sdk/openai@2.0.0',
          name: '   ',
          options: { baseURL: 'https://acme.test/v1' },
          models: { large: {} },
        },
      },
    }))

    expect(result.providers[0]?.profile).toEqual({
      api: 'openai-completions',
      baseURL: 'https://acme.test/v1',
      models: [{ id: 'large' }],
    })
  })

  it('lets an explicit supported api override the npm package', () => {
    const result = resultOf(JSON.stringify({
      provider: {
        acme: {
          api: 'openai-responses',
          npm: '@ai-sdk/anthropic',
          options: { baseURL: 'https://acme.test/v1' },
          models: { large: {} },
        },
      },
    }))

    expect(result.providers[0]?.profile['api']).toBe('openai-responses')
  })

  it('keeps a catalog route without an endpoint or model map', () => {
    const result = resultOf(JSON.stringify({
      provider: { openai: { options: { apiKey: '{env:OPENAI_API_KEY}' } } },
    }), { shipped: ['openai'] })

    expect(result.skipped).toEqual([])
    expect(result.providers[0]?.profile).toEqual({ api: 'openai-completions', apiKeyEnv: 'OPENAI_API_KEY' })
  })

  it('skips a catalog provider whose entry yields no setting this page can write', () => {
    const result = resultOf(JSON.stringify({
      provider: { 'catalog-route': { whitelist: ['model-a'] } },
    }), { shipped: ['catalog-route'] })

    expect(result.providers).toEqual([])
    expect(result.skipped).toEqual([{ provider: 'catalog-route', reason: 'no-settings' }])
  })

  it('reads provider.env when options carries no key, and leaves an empty literal key unset', () => {
    const result = resultOf(JSON.stringify({
      provider: {
        first: {
          npm: '@ai-sdk/openai',
          env: ['not valid', 'FIRST_KEY'],
          options: { baseURL: 'https://first.test/v1' },
          models: { one: {} },
        },
        second: {
          npm: '@ai-sdk/openai',
          options: { baseURL: 'https://second.test/v1', apiKey: '   ' },
          models: { two: {} },
        },
      },
    }))

    expect(result.providers[0]?.profile['apiKeyEnv']).toBe('FIRST_KEY')
    expect(result.providers[0]?.credential).toBeUndefined()
    expect(result.providers[1]?.profile['apiKeyEnv']).toBeUndefined()
    expect(result.providers[1]?.credential).toBeUndefined()
  })

  it('skips a malformed endpoint, a non-string key, and a non-object model map', () => {
    const result = resultOf(JSON.stringify({
      provider: {
        'bad-url': {
          npm: '@ai-sdk/openai',
          options: { baseURL: 'not a URL' },
          models: { one: {} },
        },
        'number-key': {
          npm: '@ai-sdk/openai',
          options: { baseURL: 'https://key.test', apiKey: 123 },
          models: { one: {} },
        },
        'list-models': {
          npm: '@ai-sdk/openai',
          options: { baseURL: 'https://list.test' },
          models: [],
        },
        'empty-model-id': {
          npm: '@ai-sdk/openai',
          options: { baseURL: 'https://empty-id.test' },
          models: { '  ': {} },
        },
        'duplicate-model-id': {
          npm: '@ai-sdk/openai',
          options: { baseURL: 'https://duplicate-id.test' },
          models: { first: {}, second: { id: 'first' } },
        },
        'bad-characters': {
          npm: '@ai-sdk/openai',
          options: { baseURL: 'https://chars.test', apiKey: 'sk with space' },
          models: { one: {} },
        },
        'unsupported-npm': {
          npm: '@ai-sdk/google',
          options: { baseURL: 'https://google.test' },
        },
        'unsupported-api': {
          api: 'google-generative',
          options: { baseURL: 'https://google-api.test' },
        },
      },
    }))

    expect(result.providers).toEqual([])
    expect(result.skipped).toEqual([
      { provider: 'bad-url', reason: 'base-url' },
      { provider: 'number-key', reason: 'credential' },
      { provider: 'list-models', reason: 'model' },
      { provider: 'empty-model-id', reason: 'model' },
      { provider: 'duplicate-model-id', reason: 'model' },
      { provider: 'bad-characters', reason: 'credential' },
      { provider: 'unsupported-npm', reason: 'protocol' },
      { provider: 'unsupported-api', reason: 'protocol' },
    ])
  })

  it('reads only usable capacities, modalities, and environment names', () => {
    const result = resultOf(JSON.stringify({
      provider: {
        acme: {
          npm: '@ai-sdk/openai',
          options: { baseURL: 'https://acme.test/v1' },
          models: {
            'bad-limits': { limit: { context: 'many', output: 0 } },
            fractional: { limit: { context: 1.5, output: 2 } },
            'bad-modalities': { modalities: [] },
            'bad-input': { modalities: { input: 'text' } },
            'mixed-input': { modalities: { input: ['audio', 5, 'image'] }, reasoning: true },
          },
        },
        openai: { env: 'OPENAI_API_KEY', options: 'gateway' },
      },
    }), { shipped: ['openai'] })

    expect(result.skipped).toEqual([])
    expect(result.providers[0]?.profile['models']).toEqual([
      { id: 'bad-limits' },
      { id: 'fractional', maxTokens: 2 },
      { id: 'bad-modalities' },
      { id: 'bad-input' },
      { id: 'mixed-input', input: ['text', 'image'] },
    ])
    expect(result.providers[1]?.profile).toEqual({ api: 'openai-completions' })
  })

  it('falls back to attachment for input modalities and keeps text when the document declares images only', () => {
    const result = resultOf(JSON.stringify({
      provider: {
        acme: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'https://acme.test/v1' },
          models: {
            attached: { attachment: true },
            images: { modalities: { input: ['image'] } },
            text: { modalities: { input: ['text'] } },
          },
        },
      },
    }))

    expect(result.providers[0]?.profile['models']).toEqual([
      { id: 'attached', input: ['text', 'image'] },
      { id: 'images', input: ['text', 'image'] },
      { id: 'text', input: ['text'] },
    ])
  })

  it('skips every provider whose facts cannot become an equivalent route', () => {
    const result = resultOf(JSON.stringify({
      provider: {
        existing: { npm: '@ai-sdk/openai' },
        google: { npm: '@ai-sdk/google', options: { baseURL: 'https://google.test' }, models: { gemini: {} } },
        'no-endpoint': { npm: '@ai-sdk/openai-compatible', models: { one: {} } },
        'no-models': { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://empty.test' } },
        'bad-endpoint': { npm: '@ai-sdk/openai', options: { baseURL: 'ftp://bad.test' }, models: { one: {} } },
        'bad-model': { npm: '@ai-sdk/openai', options: { baseURL: 'https://bad.test' }, models: { one: 'text' } },
        'bad-key': {
          npm: '@ai-sdk/openai',
          options: { baseURL: 'https://key.test', apiKey: '{file:secret}' },
          models: { one: {} },
        },
        '...': { npm: '@ai-sdk/openai' },
        broken: null,
        duplicate: { npm: '@ai-sdk/openai' },
        Duplicate: { npm: '@ai-sdk/openai' },
      },
    }), { taken: ['existing'] })

    expect(result.providers).toEqual([])
    expect(result.skipped).toEqual([
      { provider: 'existing', reason: 'existing' },
      { provider: 'google', reason: 'protocol' },
      { provider: 'no-endpoint', reason: 'base-url' },
      { provider: 'no-models', reason: 'models' },
      { provider: 'bad-endpoint', reason: 'base-url' },
      { provider: 'bad-model', reason: 'model' },
      { provider: 'bad-key', reason: 'credential' },
      { provider: '...', reason: 'route' },
      { provider: 'broken', reason: 'config' },
      { provider: 'duplicate', reason: 'base-url' },
      { provider: 'Duplicate', reason: 'base-url' },
    ])
  })

  it('skips a later provider that normalizes to an imported route', () => {
    const result = resultOf(JSON.stringify({
      provider: {
        Acme: {
          npm: '@ai-sdk/openai',
          options: { baseURL: 'https://acme.test/v1' },
          models: { one: {} },
        },
        'acme!': {
          npm: '@ai-sdk/openai',
          options: { baseURL: 'https://other.test/v1' },
          models: { two: {} },
        },
      },
    }))

    expect(result.providers.map(provider => provider.route)).toEqual(['acme'])
    expect(result.skipped).toEqual([{ provider: 'acme!', reason: 'duplicate' }])
  })

  it('refuses an endpoint-less custom route even when models are declared', () => {
    const result = resultOf(JSON.stringify({
      provider: { acme: { npm: '@ai-sdk/openai', models: { one: {} } } },
    }))

    expect(result.skipped).toEqual([{ provider: 'acme', reason: 'base-url' }])
  })

  it('rejects text that is not JSON or carries no provider map', () => {
    expect(parseOpencodeConfig('{ nope').kind).toBe('invalid-json')
    expect(parseOpencodeConfig('[]').kind).toBe('invalid-config')
    expect(parseOpencodeConfig('{}').kind).toBe('invalid-config')
    expect(parseOpencodeConfig('{"theme":"dark"}').kind).toBe('invalid-config')
    expect(parseOpencodeConfig('{"theme":{},"editor":{}}').kind).toBe('invalid-config')
    expect(parseOpencodeConfig('{"provider":[]}').kind).toBe('invalid-config')
  })
})
