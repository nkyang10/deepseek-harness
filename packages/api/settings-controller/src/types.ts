/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because the
     * stored document no longer parses. The details name only the reference,
     * never the value.
     */
    'credential/rejected': { readonly ref: string }
    /** The Host mounts no filesystem service for the default OpenCode config read. */
    'opencode-config/unavailable': {}
    /** No documented OpenCode config location exists; details list the candidates. */
    'opencode-config/not-found': { readonly candidates: readonly string[] }
    /** The first existing candidate is not a regular file. */
    'opencode-config/not-file': { readonly path: string }
    /** The first existing candidate exceeds the fixed read cap. */
    'opencode-config/too-large': { readonly path: string }
    /** The filesystem refused the read for a reason other than absence or size. */
    'opencode-config/read-failed': { readonly path: string }
    /** The first existing candidate is not UTF-8 text. */
    'opencode-config/not-text': { readonly path: string }
    /** The Host cannot reach the Connection service that owns the passcode verifier. */
    'web-access/unavailable': {}
    /** The passcode verifier could not be written or removed. */
    'web-access/rejected': { readonly operation: 'setPasscode' | 'clearPasscode' }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** One OpenCode configuration document read from the Host filesystem. */
export interface OpenCodeConfigFile {
  /** Absolute path the Host read, for the page to show. */
  readonly path: string
  /** UTF-8 file contents, still unparsed. */
  readonly content: string
}
