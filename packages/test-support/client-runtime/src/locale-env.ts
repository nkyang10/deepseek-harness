/**
 * Boot-locale pin for specs that assert localized copy. The UI opens on
 * English until a stored preference arrives, so a spec asserting the
 * product's Chinese copy passes that preference as the locale bootstrap
 * instead of inheriting the machine's locale.
 */

/**
 * Build a LocaleRuntime bootstrap pinning the initial locale to `primary`.
 * Pass it as the third constructor argument wherever the spec creates its
 * locale service.
 * @param primary - preferred BCP 47 tag; its primary subtag selects a shipped
 * locale (`zh`/`en`), anything else boots English.
 * @returns a bootstrap value for the LocaleRuntime constructor.
 */
export function bootLocale(primary: string): { readonly preference: string | null } {
  const [subtag = ''] = primary.split('-')
  return { preference: subtag.toLowerCase() === 'zh' ? 'zh' : 'en' }
}
