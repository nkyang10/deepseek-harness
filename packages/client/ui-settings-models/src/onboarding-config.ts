/** Public page-bootstrap options shared by the Host and Client halves. */

import z from '@deepseek-ai/schemastery'

/** Onboarding options after schema defaults are applied. */
export interface Config {
  /**
   * Offer the browser API-key step when no native shell owns credential
   * onboarding. Pages rendered for a LAN client never receive the automatic
   * step; credential entry there stays available from the Models page.
   */
  credentialOnboarding: boolean
}

/** Validate Host configuration and its public page-bootstrap payload. */
export const Config: z<Partial<Config>, Config> = z.object({
  credentialOnboarding: z.boolean().default(true),
})

/** Page-global key carrying only the public onboarding options. */
export const ONBOARDING_CONFIG_GLOBAL = '__DSH_MODELS_ONBOARDING__'
