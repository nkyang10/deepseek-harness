/** Paired-browser session inspection for the shared Web Host. */

import type { Context } from '@deepseek-ai/cordis'
import type { BrowserDeviceId, BrowserSession } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-connection'

/** What the shell asked the Host to do to the paired browsers. */
export type BrowserSessionsAction = 'list' | 'revoke' | 'rotate'

/** One action's outcome, always carrying the sessions as they stand afterwards. */
export interface BrowserSessionsResult {
  /** The paired browsers after the action, in pairing order. */
  sessions: readonly BrowserSession[]
  /**
   * The pairing URL, present only after `rotate`: the shell replaces its
   * startup URL with it so a copied link stops pairing new browsers.
   */
  url?: string
}

/**
 * Register paired-browser control on the owning Host context.
 * @param ctx - Booted Desktop profile context; disposal closes the control.
 * @returns Controller listing, revoking, and re-pairing the deployment's browsers.
 */
export function installDesktopBrowserSessions(
  ctx: Context,
  applicationUrl: () => string,
): (action: BrowserSessionsAction, deviceId?: string) => Promise<BrowserSessionsResult> {
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  return async (action, deviceId) => {
    if (stopped) throw new Error('desktop pairing: Host is stopping')
    if (action === 'rotate') {
      await ctx.connection.rotatePairingCode()
      return { sessions: await ctx.connection.listBrowserSessions(), url: applicationUrl() }
    }
    if (action === 'revoke') {
      if (deviceId === undefined) throw new Error('desktop pairing: revoking requires a session id')
      await ctx.connection.revokeBrowserSession(deviceId as BrowserDeviceId)
    }
    return { sessions: await ctx.connection.listBrowserSessions() }
  }
}
