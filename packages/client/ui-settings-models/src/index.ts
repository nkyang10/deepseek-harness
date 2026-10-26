/** Host configuration and page bootstrap for Models credential onboarding. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { type Config, ONBOARDING_CONFIG_GLOBAL } from './onboarding-config.ts'

export { Config } from './onboarding-config.ts'

/**
 * Publish the credential-onboarding choice before browser plugins activate.
 * @param ctx - Host context collecting the page's initialization data.
 * @param config - plugin options with schema defaults applied by the Loader.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table, source) => {
    // A LAN peer is a secondary device on a Host its operator already
    // configures locally; its page enters the signed-in flow directly, and
    // credential entry stays available from the Models page.
    const credentialOnboarding = config.credentialOnboarding && source !== 'lan'
    table.push({
      kind: 'global',
      name: ONBOARDING_CONFIG_GLOBAL,
      value: { credentialOnboarding },
    })
  })
}
