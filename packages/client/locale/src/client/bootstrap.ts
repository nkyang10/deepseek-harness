/** Locale initialization supplied by a native shell before its Client tree mounts. */

/** The existing Host preference for one page load. */
export interface LocaleBootstrap {
  /** Stored locale.preference; null keeps the English default. */
  readonly preference: string | null
}

/** Optional page-global bridge named __DSH_LOCALE__; ordinary browsers omit it. */
export interface LocaleBridge {
  /** Read current initialization data through the shell's isolated preload. @returns unvalidated IPC data. */
  read(): Promise<unknown>
  /** Publish the resolved Client locale without writing another preference. @param locale - active registered locale id. */
  onChange(locale: string): void
}

/**
 * Validate initialization data returned over the preload IPC bridge.
 * @param value - untrusted IPC response.
 * @returns language initialization with no persistence side effects.
 */
export function parseLocaleBootstrap(value: unknown): LocaleBootstrap {
  if (typeof value !== 'object' || value === null
    || !('preference' in value) || (value.preference !== null && typeof value.preference !== 'string')) {
    throw new TypeError('locale: invalid native initialization data')
  }
  return { preference: value.preference }
}
