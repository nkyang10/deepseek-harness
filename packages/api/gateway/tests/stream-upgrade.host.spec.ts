/** Remote stream upgrade failure paths through real Loader, HTTP and WebSocket composition. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { RemoteStreamMuxServer } from '../src/stream-server.ts'
import StreamUpgradeFixture from './stream-upgrade-fixture.ts'

interface Host {
  readonly ctx: Context
  readonly origin: string
}
const roots: string[] = []
const hosts: Host[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  await Promise.all(sockets.splice(0).map(async (socket) => {
    if (socket.readyState === WebSocket.CLOSED) return
    if (socket.readyState === WebSocket.CONNECTING) {
      await once(socket, 'open').catch(() => {})
      const openedState: number = socket.readyState
      if (openedState === WebSocket.CLOSED) return
    }
    const closed = once(socket, 'close')
    socket.terminate()
    await closed
  }))
  await Promise.all(hosts.splice(0).map(host => host.ctx.fiber.dispose()))
  for (const root of roots.splice(0)) {
    if (!isAbsolute(root) || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-stream-upgrade-')) {
      throw new Error(`refusing unexpected fixture cleanup path: ${root}`)
    }
    await rm(root, { recursive: true, force: true })
  }
})

describe('Remote stream upgrade through Loader composition', () => {
  it('destroys the socket and keeps the Host serving when the WebSocket upgrade throws', async () => {
    const host = await boot()
    const failure = new Error('fixture WebSocket upgrade failure')
    const upgrade = vi.spyOn(RemoteStreamMuxServer.prototype, 'handleUpgrade').mockImplementationOnce(() => {
      throw failure
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await closedSocket(host)
      expect(report).toHaveBeenCalledWith('[api-gateway] Remote stream upgrade failed:', failure)
      await success(host, 'after-failure')
      await closeSocket(await openMux(host))
    } finally {
      upgrade.mockRestore()
      report.mockRestore()
    }
  })

  it('skips the upgrade when the carrier socket is destroyed before the route reads it', async () => {
    const host = await boot()
    const admit = host.ctx.connection.admit.bind(host.ctx.connection)
    const admitting = vi.spyOn(host.ctx.connection, 'admit').mockImplementationOnce((request) => {
      const result = admit(request)
      if (!(request instanceof IncomingMessage)) throw new Error('fixture expected a Node upgrade request')
      request.socket.destroy()
      return result
    })
    const upgrade = vi.spyOn(RemoteStreamMuxServer.prototype, 'handleUpgrade')
    try {
      await closedSocket(host)
      expect(upgrade).not.toHaveBeenCalled()
      await success(host, 'after-destroy')
    } finally {
      admitting.mockRestore()
      upgrade.mockRestore()
    }
  })
})

async function boot(): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stream-upgrade-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  const rows = [
    { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: '@deepseek-ai/dsh-client-connection' },
    { name: '@deepseek-ai/dsh-typert-registry' },
    { name: '@deepseek-ai/dsh-api-remote-access' },
    { name: '@deepseek-ai/dsh-api-gateway' },
    { name: '@fixture/stream-upgrade' },
  ]
  await writeFile(configPath, rows.map(row => `- ${JSON.stringify({ ...row, name: `cordis:${row.name}` })}`).join('\n') + '\n')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  try {
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include,
      '@deepseek-ai/dsh-host-webserver': WebServer,
      '@deepseek-ai/dsh-client-connection': Connection,
      '@deepseek-ai/dsh-typert-registry': TypertRegistry,
      '@deepseek-ai/dsh-api-remote-access': RemoteAccess,
      '@deepseek-ai/dsh-api-gateway': TypertGateway,
      '@fixture/stream-upgrade': StreamUpgradeFixture,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect(ctx.webServer.port).toBeGreaterThan(0)
    const host = { ctx, origin: `http://127.0.0.1:${ctx.webServer.port}` }
    hosts.push(host)
    return host
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

function muxSocket(host: Host): WebSocket {
  const socket = new WebSocket(`${host.origin.replace('http:', 'ws:')}/api/remote.mux`)
  socket.on('error', () => {})
  sockets.push(socket)
  return socket
}

async function openMux(host: Host): Promise<WebSocket> {
  const socket = muxSocket(host)
  await once(socket, 'open')
  return socket
}

async function closeSocket(socket: WebSocket): Promise<void> {
  socket.close()
  await once(socket, 'close')
}

async function closedSocket(host: Host): Promise<void> {
  const socket = muxSocket(host)
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  await Promise.race([closed, once(socket, 'error').then(() => {})])
  await closed
  expect(socket.readyState).toBe(WebSocket.CLOSED)
}

async function success(host: Host, label: string): Promise<void> {
  const endpoint = 'fixture/identity'
  const response = await fetch(`${host.origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args: { label } },
    }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ result: { ok: true, value: { label } } })
}
