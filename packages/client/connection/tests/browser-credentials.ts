import type { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'

const SESSION_RECORD_KEY = 'client-connection/browser-session'

/** Mutable credential-record double keyed by the branded record address. */
export class RecordCredentials {
  readonly records = new Map<string, CredentialRecord>()
  discardWrites = false
  reads = 0
  modifies = 0

  /** The browser-session record existing tests inspect through the former single-record double. */
  get record(): CredentialRecord | undefined {
    return this.records.get(SESSION_RECORD_KEY)
  }

  set record(value: CredentialRecord | undefined) {
    if (value === undefined) this.records.delete(SESSION_RECORD_KEY)
    else this.records.set(SESSION_RECORD_KEY, value)
  }

  readRecord(key: unknown): Promise<CredentialRecord | undefined> {
    this.reads += 1
    return Promise.resolve(this.records.get(String(key)))
  }

  async modifyRecord(
    key: unknown,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.modifies += 1
    const address = String(key)
    const next = await mutate(this.records.get(address))
    if (this.discardWrites) return undefined
    if (next !== undefined) this.records.set(address, next)
    return this.records.get(address)
  }

  deleteRecord(key: unknown): Promise<void> {
    this.records.delete(String(key))
    return Promise.resolve()
  }
}

/** Provide the record operations Connection needs during authentication setup. */
export function provideBrowserCredentials(ctx: Context): void {
  ctx.provide('credentials', new RecordCredentials() as unknown as CredentialProvider)
}
