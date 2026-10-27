/** Default OpenCode config reads through the optional Remote namespace. */
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createModelsOperations } from '../src/client/operations.ts'

function bench(readDefault: () => Promise<unknown> = async () => ({
  ok: false,
  error: new RemoteError('opencode-config/unavailable', 'no filesystem service', {}),
})) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  Object.assign(ctx, { remote: { opencodeConfig: { readDefault } } })
  return createModelsOperations(ctx)
}

describe('readOpencodeConfig', () => {
  it('returns the path and contents the Host read', async () => {
    const operations = bench(async () => ok({ path: '/home/u/.config/opencode/opencode.json', content: '{"provider":{}}' }))
    await expect(operations.readOpencodeConfig()).resolves.toEqual({
      kind: 'found',
      path: '/home/u/.config/opencode/opencode.json',
      content: '{"provider":{}}',
    })
  })

  it('reports the Host refusal diagnostic', async () => {
    const operations = bench(async () => ({
      ok: false,
      error: new RemoteError('opencode-config/not-found', 'no config', { candidates: [] }),
    }))
    await expect(operations.readOpencodeConfig()).resolves.toEqual({ kind: 'refused', message: 'no config' })
  })

  it('reports a Host without a filesystem service', async () => {
    await expect(bench().readOpencodeConfig()).resolves.toEqual({ kind: 'unavailable' })
  })
})
