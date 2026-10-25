/** Loader-mounted Remote endpoint for Remote stream upgrade tests. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-typert-registry'

declare module '@deepseek-ai/cordis' {
  interface Context {
    streamUpgradeFixture: StreamUpgradeFixture
  }
}

/** Test producer; admission and dispatch use the real plugins. */
export default class StreamUpgradeFixture extends TypertRemoteService {
  static inject = ['typert']

  constructor(ctx: Context) {
    super(ctx, 'streamUpgradeFixture', { namespace: 'fixture' })
  }

  /** Echo the label through Gateway dispatch. */
  @Remote
  identity(label: string): object {
    return { label }
  }
}
