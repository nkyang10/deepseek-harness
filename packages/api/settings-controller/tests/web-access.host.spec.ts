import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import * as ConnectionPlugin from '../../../client/connection/src/index.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import WebAccessController from '../src/web-access.ts'

async function boot(withConnection = true): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  if (withConnection) {
    await ctx.plugin({ name: ConnectionPlugin.name, inject: ConnectionPlugin.inject, apply: ConnectionPlugin.apply })
  }
  await ctx.plugin(WebAccessController)
  return ctx
}

describe('the webAccess Remote namespace a configuration surface calls', () => {
  it('publishes the webAccess namespace from its own service key', async () => {
    const ctx = await boot()
    const binding = ctx.webAccessController.typertRemote
    expect(binding.serviceKey).toBe('webAccessController')
    expect(binding.namespace).toBe('webAccess')
    expect(remoteMethods(ctx.webAccessController)).toEqual([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'setPasscode', invocation: { kind: 'direct' } },
      { method: 'clearPasscode', invocation: { kind: 'direct' } },
    ])
  })

  it('reports, writes, and clears the passcode verifier through Connection', async () => {
    const ctx = await boot()
    const set = vi.spyOn(ctx.connection, 'setPasscode')
    const clear = vi.spyOn(ctx.connection, 'clearPasscode')

    expect(await ctx.webAccessController.status()).toEqual({ configured: false })
    await ctx.webAccessController.setPasscode('correct-horse')
    expect(set).toHaveBeenCalledExactlyOnceWith('correct-horse')
    expect(await ctx.webAccessController.status()).toEqual({ configured: true })
    await ctx.webAccessController.clearPasscode()
    expect(clear).toHaveBeenCalledOnce()
    expect(await ctx.webAccessController.status()).toEqual({ configured: false })
  })

  it('reports an unavailable Connection service and a rejected verifier write', async () => {
    const absent = await boot(false)
    await expect(absent.webAccessController.status())
      .rejects.toMatchObject({ code: 'web-access/unavailable' })

    const present = await boot()
    await expect(present.webAccessController.setPasscode('short'))
      .rejects.toMatchObject({ code: 'web-access/rejected', details: { operation: 'setPasscode' } })
    vi.spyOn(present.connection, 'clearPasscode').mockRejectedValueOnce('credential store is read-only')
    await expect(present.webAccessController.clearPasscode())
      .rejects.toMatchObject({
        code: 'web-access/rejected',
        message: 'credential store is read-only',
        details: { operation: 'clearPasscode' },
      })
  })
})
