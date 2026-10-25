/**
 * Desktop Web bind resolution: the launch arguments the Host passes to the Web
 * application and the URL the shell reports from the listener's own facts.
 *
 * The bind defaults to serving the LAN: the primary local interface address
 * (the one the default route uses) on port 9445. The layered environment
 * (`~/.dsh/.env`) overrides either value — `DSH_DESKTOP_WEB_HOST=127.0.0.1`
 * restores a loopback-only GUI — and a wildcard address is rejected before
 * launch because binding every interface by accident is not a supported shape.
 */

import { createSocket } from 'node:dgram'
import { isLoopbackHost, isWildcardHost, normalizeBindAddress } from '@deepseek-ai/dsh-host-webserver'

/** Environment name of the Web listener's bind address. */
export const DESKTOP_WEB_HOST_ENV = 'DSH_DESKTOP_WEB_HOST'

/** Environment name of the Web listener's port; zero requests an OS-assigned port. */
export const DESKTOP_WEB_PORT_ENV = 'DSH_DESKTOP_WEB_PORT'

/** The fallback loopback bind when no LAN interface can be detected. */
const DEFAULT_BIND_HOST = '127.0.0.1'

/** The default LAN listen port. */
const DEFAULT_WEB_PORT = 9445

/** Resolved Web listener bind for one desktop Host launch. */
export interface DesktopWebBind {
  /** Concrete IPv4 or IPv6 literal of one local interface. */
  readonly host: string
  /** Listen port; zero requests an OS-assigned port. */
  readonly port: number
}

/**
 * The local address the operating system routes toward the default gateway —
 * the interface LAN peers reach — without sending any packet: a connected UDP
 * socket's source address is the egress interface's, and `connect` only
 * selects the route.
 * @returns the primary LAN IPv4 address, or undefined when the host has no
 * routed non-loopback interface.
 */
export function detectPrimaryLanAddress(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    const settle = (value: string | undefined): void => {
      socket.close()
      resolve(value)
    }
    socket.once('error', () => { settle(undefined) })
    socket.connect(9, '192.0.2.1', () => {
      const address = socket.address().address
      settle(!isWildcardHost(address) && !isLoopbackHost(address) ? address : undefined)
    })
  })
}

/**
 * Resolve the Web bind from the launch environment. An explicit
 * `DSH_DESKTOP_WEB_HOST` wins; otherwise the primary LAN address serves the
 * network, falling back to loopback-only when detection finds no route.
 * @param env - the launch environment snapshot (layered `.env` values applied).
 * @param detectLanHost - the primary-LAN-address detector, replaceable in tests.
 * @returns the bind address and port the Web application should receive.
 * @throws when the configured host is a wildcard address or the port is not an integer in `0..65535`.
 */
export async function resolveDesktopWebBind(
  env: NodeJS.ProcessEnv,
  detectLanHost: () => Promise<string | undefined> = detectPrimaryLanAddress,
): Promise<DesktopWebBind> {
  const configuredHost = env[DESKTOP_WEB_HOST_ENV]
  if (configuredHost !== undefined && isWildcardHost(configuredHost)) {
    throw new Error(
      `dsh desktop host: ${DESKTOP_WEB_HOST_ENV} ${JSON.stringify(configuredHost)} is an unspecified (wildcard) address,`
      + ' which is not supported: binding every interface would expose the GUI to the network;'
      + ' name one concrete local IPv4 or IPv6 address instead',
    )
  }
  const host = configuredHost ?? await detectLanHost() ?? DEFAULT_BIND_HOST
  const rawPort = env[DESKTOP_WEB_PORT_ENV] ?? String(DEFAULT_WEB_PORT)
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`dsh desktop host: ${DESKTOP_WEB_PORT_ENV} ${JSON.stringify(rawPort)} must be an integer from 0 through 65535`)
  }
  return { host, port }
}

/**
 * The Web application URL from the listener's own facts, replacing the
 * launcher's former loopback literal so the shell window and LAN browsers
 * share the listener.
 * @param webServer - the running Web listener's protocol, bind address, and port.
 * @returns the application URL.
 * @throws when the listener has not bound a port yet.
 */
export function desktopWebUrl(webServer: { readonly protocol: 'http:' | 'https:'; readonly host: string; readonly port: number | undefined }): string {
  const address = normalizeBindAddress(webServer.host)
  const host = address.includes(':') ? `[${address}]` : address
  if (webServer.port === undefined) throw new Error('dsh desktop host: the Web listener has not bound a port yet')
  return `${webServer.protocol}//${host}:${String(webServer.port)}`
}
