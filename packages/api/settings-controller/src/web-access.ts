/**
 * Host owner of the `webAccess` Remote namespace: the write-only passcode
 * control a configuration page uses without ever reading the secret back.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/web-access.ts
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `webAccess` Remote namespace. */
    webAccessController: WebAccessController
  }
}

/**
 * Host service backing the generated `ctx.remote.webAccess` namespace. The
 * passcode verifier and its hashing belong to Connection; this controller only
 * transports the write-only facts a configuration page needs.
 */
export class WebAccessController extends TypertRemoteService {
  /** @param ctx - Host context where the Connection service may be mounted. */
  constructor(ctx: Context) {
    super(ctx, 'webAccessController', { namespace: 'webAccess' })
  }

  /**
   * Report whether the owner has configured a Web login passcode.
   * @returns the presence fact only; the verifier never crosses the wire.
   */
  @Remote('status')
  async status(): Promise<{ configured: boolean }> {
    return { configured: await this.provider().passcodeSet() }
  }

  /**
   * Replace the owner passcode with a one-way verifier.
   * @param passcode - owner-chosen passcode, at least twelve characters.
   * @returns fulfillment after the verifier is durable.
   */
  @Remote('setPasscode')
  async setPasscode(passcode: string): Promise<void> {
    try {
      await this.provider().setPasscode(passcode)
    } catch (error: unknown) {
      throw new RemoteError('web-access/rejected', messageOf(error), { operation: 'setPasscode' }, { cause: error })
    }
  }

  /**
   * Remove the stored passcode verifier without revoking paired browsers.
   * @returns fulfillment after the record is removed.
   */
  @Remote('clearPasscode')
  async clearPasscode(): Promise<void> {
    try {
      await this.provider().clearPasscode()
    } catch (error: unknown) {
      throw new RemoteError('web-access/rejected', messageOf(error), { operation: 'clearPasscode' }, { cause: error })
    }
  }

  private provider(): HostConnectionHandle {
    const connection = this.ctx.get('connection')
    if (connection === undefined) {
      throw new RemoteError(
        'web-access/unavailable',
        'connection service is absent: mount @deepseek-ai/dsh-client-connection in this composition',
        {},
      )
    }
    return connection
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default WebAccessController
