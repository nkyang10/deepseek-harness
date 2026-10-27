/** Host read of the default OpenCode config through the filesystem seam. */
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { describe, expect, it, onTestFinished } from 'vitest'
import { OpencodeConfigController, opencodeConfigCandidates } from '../src/opencode-config.ts'

interface FakeRead {
  readonly stat?: { readonly type: 'file' | 'directory' | 'other'; readonly size?: number } | undefined
  readonly bytes?: Uint8Array
  readonly readError?: unknown
}

function bench(read: FakeRead = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('fs', {
    resolve: async (path: string) => ({ displayPath: path }),
    stat: async () => Object.hasOwn(read, 'stat') ? read.stat : { version: 'v1', type: 'file' },
    readBytes: async () => {
      if (read.readError !== undefined) throw read.readError
      return read.bytes ?? new TextEncoder().encode('{"provider":{}}')
    },
  } as never)
  return new OpencodeConfigController(ctx, { candidates: () => ['/tmp/opencode.json'] })
}

describe('opencodeConfigCandidates', () => {
  it('uses an explicit OPENCODE_CONFIG before the global locations', () => {
    expect(opencodeConfigCandidates({ OPENCODE_CONFIG: '/custom/opencode.json', XDG_CONFIG_HOME: '/xdg' }, '/home/u', 'linux'))
      .toEqual(['/custom/opencode.json'])
  })

  it('ignores blank overrides and uses XDG_CONFIG_HOME, then the home config, without duplicates', () => {
    expect(opencodeConfigCandidates({ OPENCODE_CONFIG: '   ', XDG_CONFIG_HOME: '/home/u/.config' }, '/home/u', 'linux'))
      .toEqual(['/home/u/.config/opencode/opencode.json'])
    expect(opencodeConfigCandidates({ XDG_CONFIG_HOME: '', OPENCODE_CONFIG: '' }, '/home/u', 'linux'))
      .toEqual(['/home/u/.config/opencode/opencode.json'])
  })

  it('adds Windows app-data fallbacks after the home config', () => {
    expect(opencodeConfigCandidates({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u', 'win32'))
      .toEqual([
        'C:\\Users\\u\\.config\\opencode\\opencode.json',
        'C:\\Users\\u\\AppData\\Roaming\\opencode\\opencode.json',
        'C:\\Users\\u\\AppData\\Local\\opencode\\opencode.json',
      ])
    expect(opencodeConfigCandidates({ APPDATA: '', LOCALAPPDATA: '   ' }, 'C:\\Users\\u', 'win32'))
      .toEqual(['C:\\Users\\u\\.config\\opencode\\opencode.json'])
  })
})

describe('OpencodeConfigController', () => {
  it('reads the first existing regular file and returns its display path', async () => {
    const controller = bench({ bytes: new TextEncoder().encode('{"provider":{"acme":{}}}') })
    await expect(controller.readDefault()).resolves.toEqual({
      path: '/tmp/opencode.json',
      content: '{"provider":{"acme":{}}}',
    })
  })

  it('reports a missing filesystem service', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const controller = new OpencodeConfigController(ctx)
    await expect(controller.readDefault()).rejects.toMatchObject({ code: 'opencode-config/unavailable' })
  })

  it('reports no candidate when every path is absent', async () => {
    const controller = bench({ stat: undefined })
    await expect(controller.readDefault()).rejects.toMatchObject({ code: 'opencode-config/not-found' })
  })

  it('resolves the process environment when no candidates are injected', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('fs', {
      resolve: async (path: string) => ({ displayPath: path }),
      stat: async () => undefined,
    } as never)
    const controller = new OpencodeConfigController(ctx)
    await expect(controller.readDefault()).rejects.toMatchObject({ code: 'opencode-config/not-found' })
  })

  it('refuses a directory candidate', async () => {
    const controller = bench({ stat: { type: 'directory' } })
    await expect(controller.readDefault()).rejects.toMatchObject({ code: 'opencode-config/not-file' })
  })

  it('refuses an oversized candidate', async () => {
    const controller = bench({ readError: new FsError('too large', 'FS_TOO_LARGE') })
    await expect(controller.readDefault()).rejects.toMatchObject({ code: 'opencode-config/too-large' })
  })

  it('reports a non-UTF-8 candidate', async () => {
    const controller = bench({ bytes: new Uint8Array([0xFF]) })
    await expect(controller.readDefault()).rejects.toMatchObject({ code: 'opencode-config/not-text' })
  })

  it('reports other filesystem failures and non-Error refusals', async () => {
    const error = bench({ readError: new Error('permission denied') }).readDefault()
    await expect(error).rejects.toMatchObject({ code: 'opencode-config/read-failed' })
    await expect(error).rejects.toThrow('permission denied')

    const refusal = bench({ readError: 'disk gone' }).readDefault()
    await expect(refusal).rejects.toMatchObject({ code: 'opencode-config/read-failed' })
    await expect(refusal).rejects.toThrow('disk gone')
  })

  it('continues past a candidate that disappears before the read', async () => {
    const controller = bench({ readError: new FsError('vanished', 'FS_NOT_FOUND') })
    await expect(controller.readDefault()).rejects.toMatchObject({ code: 'opencode-config/not-found' })
  })
})
