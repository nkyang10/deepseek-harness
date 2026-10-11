import { describe, expect, it } from 'vitest'
import { DESKTOP_WEB_HOST_ENV, DESKTOP_WEB_PORT_ENV, desktopWebUrl, detectPrimaryLanAddress, resolveDesktopWebBind } from '../src/web-bind.ts'

describe('desktop web bind resolution', () => {
  it('defaults to the primary LAN address on port 9445', async () => {
    expect(await resolveDesktopWebBind({}, async () => '192.168.1.162'))
      .toEqual({ host: '192.168.1.162', port: 9445 })
  })

  it('falls back to the loopback bind when no LAN interface is routed', async () => {
    expect(await resolveDesktopWebBind({}, async () => undefined))
      .toEqual({ host: '127.0.0.1', port: 9445 })
  })

  it('reads the configured host and port from the launch environment', async () => {
    expect(await resolveDesktopWebBind({ [DESKTOP_WEB_HOST_ENV]: '192.168.1.162', [DESKTOP_WEB_PORT_ENV]: '19387' }))
      .toEqual({ host: '192.168.1.162', port: 19387 })
  })

  it('keeps an explicit loopback bind despite a detectable LAN address', async () => {
    expect(await resolveDesktopWebBind({ [DESKTOP_WEB_HOST_ENV]: '127.0.0.1' }, async () => '192.168.1.162'))
      .toEqual({ host: '127.0.0.1', port: 9445 })
  })

  it.each(['0.0.0.0', '::', '::ffff:0.0.0.0'])('rejects the wildcard address %s before launch', async (host) => {
    await expect(resolveDesktopWebBind({ [DESKTOP_WEB_HOST_ENV]: host }))
      .rejects.toThrow(new RegExp(`${DESKTOP_WEB_HOST_ENV} .*wildcard`))
  })

  it.each(['-1', '65536', '19387.5', 'eighty'])('rejects the port %s', async (rawPort) => {
    await expect(resolveDesktopWebBind({ [DESKTOP_WEB_PORT_ENV]: rawPort }, async () => undefined))
      .rejects.toThrow(new RegExp(`${DESKTOP_WEB_PORT_ENV} .*0 through 65535`))
  })

  it('accepts the port bounds', async () => {
    expect((await resolveDesktopWebBind({ [DESKTOP_WEB_PORT_ENV]: '0' }, async () => undefined)).port).toBe(0)
    expect((await resolveDesktopWebBind({ [DESKTOP_WEB_PORT_ENV]: '65535' }, async () => undefined)).port).toBe(65535)
  })

  it('detects a routable non-loopback IPv4 address without sending a packet', async () => {
    const address = await detectPrimaryLanAddress()
    if (address !== undefined) expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/u)
  })
})

describe('desktop web URL', () => {
  it('names the loopback bind literally', () => {
    expect(desktopWebUrl({ protocol: 'http:', host: '127.0.0.1', port: 9445 }))
      .toBe('http://127.0.0.1:9445')
  })

  it('names a non-loopback bind so the shell window and LAN browsers share the listener', () => {
    expect(desktopWebUrl({ protocol: 'http:', host: '192.168.1.162', port: 9445 }))
      .toBe('http://192.168.1.162:9445')
  })

  it('brackets a compressed IPv6 bind and drops its zone', () => {
    expect(desktopWebUrl({ protocol: 'http:', host: 'fe80::1%eth0', port: 3080 }))
      .toBe('http://[fe80::1]:3080')
  })

  it('keeps the listener protocol', () => {
    expect(desktopWebUrl({ protocol: 'https:', host: '127.0.0.1', port: 3080 }))
      .toBe('https://127.0.0.1:3080')
  })
})
