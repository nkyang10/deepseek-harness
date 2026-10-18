import { Context } from '@deepseek-ai/cordis'
import type { BrowserDeviceId, BrowserSession } from '@deepseek-ai/dsh-client-connection'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installDesktopBrowserSessions } from '../src/browser-sessions.ts'

let ctx: Context
let control: ReturnType<typeof installDesktopBrowserSessions>
let sessions: BrowserSession[]
const revoked: string[] = []
let rotations = 0
let pairingUrl = 'http://192.168.1.162:9445/?token=first'

function session(id: string): BrowserSession {
  return { id: id as BrowserDeviceId, userAgent: `${id}/1.0`, pairedAt: 1, lastSeenAt: 2, expiresAt: 3 }
}

beforeEach(() => {
  sessions = [session('phone'), session('laptop')]
  revoked.length = 0
  rotations = 0
  pairingUrl = 'http://192.168.1.162:9445/?token=first'
  ctx = new Context()
  ctx.provide('connection', {
    listBrowserSessions: () => Promise.resolve(sessions),
    revokeBrowserSession: (id: BrowserDeviceId) => {
      revoked.push(id)
      sessions = sessions.filter(entry => entry.id !== id)
      return Promise.resolve()
    },
    rotatePairingCode: () => {
      rotations += 1
      pairingUrl = 'http://192.168.1.162:9445/?token=second'
      return Promise.resolve()
    },
  } as never)
  control = installDesktopBrowserSessions(ctx, () => pairingUrl)
})

afterEach(async () => { await ctx.fiber.dispose() })

describe('Desktop Host paired browsers', () => {
  it('reports the paired browsers without changing them', async () => {
    expect(await control('list')).toEqual({ sessions })
    expect(revoked).toEqual([])
    expect(rotations).toBe(0)
  })

  it('revokes exactly the named session and reports what remains', async () => {
    expect(await control('revoke', 'phone')).toEqual({ sessions: [session('laptop')] })
    expect(revoked).toEqual(['phone'])
  })

  it('refuses a revocation that names no session', async () => {
    await expect(control('revoke')).rejects.toThrow(/requires a session id/u)
    expect(revoked).toEqual([])
  })

  it('replaces the pairing code and returns the URL that carries it', async () => {
    expect(await control('rotate')).toEqual({ sessions, url: 'http://192.168.1.162:9445/?token=second' })
    expect(rotations).toBe(1)
    expect(revoked).toEqual([])
  })

  it('refuses every action after disposal', async () => {
    await ctx.fiber.dispose()
    await expect(control('list')).rejects.toThrow('Host is stopping')
    await expect(control('revoke', 'phone')).rejects.toThrow('Host is stopping')
    await expect(control('rotate')).rejects.toThrow('Host is stopping')
  })
})
