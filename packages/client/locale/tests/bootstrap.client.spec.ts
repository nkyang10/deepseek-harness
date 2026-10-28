/** Native initialization precedes Client mounting and does not persist automatic locale choices. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, LocaleRuntime } from '../src/client/index.ts'
import { parseLocaleBootstrap } from '../src/client/bootstrap.ts'
import type { LocaleSettings } from '../src/locale-settings.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('native locale initialization', () => {
  it('reports a failed native read instead of silently choosing a language', async () => {
    const ctx = new Context()
    const error = new Error('native settings unavailable')
    vi.stubGlobal('__DSH_LOCALE__', { read: () => Promise.reject(error), onChange: vi.fn() })
    try {
      await expect(apply(ctx)).rejects.toBe(error)
      expect(ctx.get('locale')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('opens English without persisting an unstored choice, whatever the native languages are', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { languages: ['zh-CN'], language: 'zh-CN' })
    const ctx = new Context()
    const host = stubConfigForm<LocaleSettings>()
    try {
      const locale = new LocaleRuntime(ctx, host.scope, { preference: null })
      expect(locale.getSnapshot().active).toBe('en')
      expect(host.set).not.toHaveBeenCalled()
      locale.setLocale('en')
      expect(host.set).toHaveBeenCalledExactlyOnceWith('preference', 'en')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the stored choice while dictionaries and languages register', async () => {
    const ctx = new Context()
    try {
      const locale = new LocaleRuntime(ctx, undefined, { preference: 'en' })
      expect(locale.getSnapshot().active).toBe('en')
      locale.register('native-test', 'en', {})
      expect(locale.getSnapshot().active).toBe('en')
      locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' })
      expect(locale.getSnapshot().active).toBe('en')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps an external preference pending until its language registers', async () => {
    const ctx = new Context()
    try {
      const locale = new LocaleRuntime(ctx, undefined, { preference: 'ja' })
      expect(locale.getSnapshot().active).toBe('en')
      const remove = locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' })
      expect(locale.getSnapshot().active).toBe('ja')
      remove()
      expect(locale.getSnapshot().active).toBe('en')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('validates the preload response before reading its fields', () => {
    expect(parseLocaleBootstrap({ preference: null })).toEqual({ preference: null })
    expect(parseLocaleBootstrap({ preference: 'zh' }).preference).toBe('zh')
    for (const value of [null, {}, { preference: 42 }]) {
      expect(() => parseLocaleBootstrap(value)).toThrow('invalid native initialization data')
    }
  })
})
