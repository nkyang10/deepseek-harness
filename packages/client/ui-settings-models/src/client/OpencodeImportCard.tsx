/**
 * The add card's OpenCode import panel. The document can come from the Host's
 * default OpenCode config file, a browser-selected file, or pasted text; all
 * three fill the same textarea and then go through
 * {@link parseOpencodeConfig} into pi-ai provider profiles.
 *
 * The panel writes every importable provider in one settings mutation, then
 * stores each literal key through the credential seam. A key failure after the
 * profile write keeps the panel open and retries only the credentials, because
 * the profile write's revision has already been superseded. The result stays on
 * screen with the providers that were skipped and why; the footer then commits
 * the dismissal rather than writing again.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { EditorFooter } from './EditorFooter.tsx'
import type { ModelsOperations } from './operations.ts'
import type { ModelsKey } from './locales.ts'
import {
  parseOpencodeConfig,
  type OpencodeImportProvider,
  type OpencodeImportResult,
  type OpencodeSkipReason,
} from './opencode-import.ts'
import styles from './ModelsSection.module.css'

/** The settings namespace a hand-declared provider is written into. */
const NS = 'llm-pi-ai'

/** Copy key naming each skip reason. */
const SKIP_KEYS: Readonly<Record<OpencodeSkipReason, ModelsKey>> = {
  existing: 'importSkipExisting',
  duplicate: 'importSkipDuplicate',
  route: 'importSkipRoute',
  config: 'importSkipConfig',
  protocol: 'importSkipProtocol',
  'base-url': 'importSkipBaseUrl',
  models: 'importSkipModels',
  model: 'importSkipModel',
  credential: 'importSkipCredential',
  'no-settings': 'importSkipEmpty',
}

/** @param error - a rejected browser read. @returns its message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Props of {@link OpencodeImportCard}. */
export interface OpencodeImportCardProps {
  /** Route ids already configured, so the import refuses to shadow one. */
  taken: readonly string[]
  /** Routes the installed pi-ai catalog ships; their endpoints and models may stay inherited. */
  shipped: readonly string[]
  /** Wire protocols the adapter can serve, in the order it reports them. */
  protocols: readonly string[]
  /** Revision of the `llm-pi-ai` user section this card opened at. */
  revision: number
  /** The Host operations this card writes through. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: ModelsKey) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Close the panel; `changed` reports whether any provider was created. */
  onClose: (changed: boolean) => void
  /** Called once per change with whether the import is in flight. */
  onBusyChange?: (busy: boolean) => void
}

/**
 * Render the OpenCode import panel.
 * @param props - known routes, protocols, wire face, and copy.
 * @returns the import panel.
 */
export function OpencodeImportCard(props: OpencodeImportCardProps): ReactNode {
  const { taken, shipped, protocols, operations, t, onBusyChange } = props
  const [text, setText] = useState('')
  const [writing, setWriting] = useState(false)
  const [sourceBusy, setSourceBusy] = useState(false)
  const busy = writing || sourceBusy
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [sourceFailure, setSourceFailure] = useState<string | undefined>(undefined)
  const [sourceNote, setSourceNote] = useState<string | undefined>(undefined)
  const [result, setResult] = useState<OpencodeImportResult | undefined>(undefined)
  /** The profiles landed; only outstanding keys can still be retried. */
  const [committed, setCommitted] = useState(false)
  const [revision, setRevision] = useState(() => props.revision)
  const [imported, setImported] = useState<readonly OpencodeImportProvider[]>([])
  /** Credential references whose literal values have been stored. */
  const [storedRefs, setStoredRefs] = useState<ReadonlySet<string>>(() => new Set())
  const fileInput = useRef<HTMLInputElement>(null)
  const disabled = props.readOnly || busy
  const sourcesDisabled = disabled || committed
  const pendingKeys = imported.filter(provider =>
    provider.credential !== undefined && !storedRefs.has(provider.credential.ref))
  const submitLabelKey: ModelsKey = committed
    ? pendingKeys.length > 0 ? 'importRetry' : 'importDone'
    : 'import'
  const submitDisabled = disabled || (!committed && text.trim().length === 0)

  /** Store every outstanding literal key, returning the first failure message. */
  const storeKeys = async (providers: readonly OpencodeImportProvider[]): Promise<string | undefined> => {
    const next = new Set(storedRefs)
    let firstFailure: string | undefined
    for (const provider of providers) {
      const credential = provider.credential
      if (credential === undefined || next.has(credential.ref)) continue
      const stored = await operations.storeCredential(credential.ref, credential.value)
      if (stored === undefined) {
        next.add(credential.ref)
        continue
      }
      firstFailure ??= t('importKeyFailed').replace('{message}', () => `${provider.route}: ${stored}`)
    }
    setStoredRefs(next)
    return firstFailure
  }

  /** Replace the editable document with one loaded source and clear stale outcomes. */
  const acceptSource = (content: string, note: string): void => {
    setText(content)
    setResult(undefined)
    setFailure(undefined)
    setSourceFailure(undefined)
    setSourceNote(note)
  }

  const loadDefault = async (): Promise<void> => {
    setSourceBusy(true)
    setSourceFailure(undefined)
    setSourceNote(undefined)
    try {
      const read = await operations.readOpencodeConfig()
      if (read.kind === 'unavailable') {
        setSourceFailure(t('importDefaultUnavailable'))
        return
      }
      if (read.kind === 'refused') {
        setSourceFailure(t('importDefaultReadFailed').replace('{message}', () => read.message))
        return
      }
      acceptSource(read.content, t('importDefaultLoaded').replace('{path}', () => read.path))
    } catch (error) {
      setSourceFailure(t('importDefaultReadFailed').replace('{message}', () => messageOf(error)))
    } finally {
      setSourceBusy(false)
    }
  }

  const loadFile = async (file: File): Promise<void> => {
    setSourceBusy(true)
    setSourceFailure(undefined)
    setSourceNote(undefined)
    try {
      acceptSource(await file.text(), t('importFileLoaded').replace('{name}', () => file.name))
    } catch (error) {
      setSourceFailure(t('importFileReadFailed').replace('{message}', () => messageOf(error)))
    } finally {
      setSourceBusy(false)
    }
  }

  const run = async (): Promise<void> => {
    setWriting(true)
    setFailure(undefined)
    setSourceFailure(undefined)
    setSourceNote(undefined)
    try {
      if (!committed) {
        setResult(undefined)
        const parsed = parseOpencodeConfig(text, { taken, shipped, protocols })
        if (parsed.kind !== 'ok') {
          setFailure(t(parsed.kind === 'invalid-json' ? 'importInvalidJson' : 'importInvalidConfig'))
          return
        }
        setResult(parsed.result)
        if (parsed.result.providers.length === 0) return
        const written = await operations.writeSettings(
          NS,
          parsed.result.providers.map(provider => ({
            op: 'set',
            path: ['providers', provider.route],
            value: provider.profile,
          })),
          revision,
        )
        if (written.kind !== 'written') {
          setFailure(written.kind === 'conflict' ? t('conflict') : written.message)
          return
        }
        setCommitted(true)
        setImported(parsed.result.providers)
        setRevision(written.view.revision)
        setResult(parsed.result)
        const keyFailure = await storeKeys(parsed.result.providers)
        if (keyFailure !== undefined) setFailure(keyFailure)
        return
      }
      const keyFailure = await storeKeys(imported)
      if (keyFailure !== undefined) setFailure(keyFailure)
    } finally {
      setWriting(false)
    }
  }

  const skipped = result?.skipped ?? []
  const importedCount = result?.providers.length ?? 0
  return (
    <div className={styles['editor']}>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('importJsonLabel')}</span>
        <div className={styles['importSources']}>
          <button
            type="button"
            className={`${styles['secondaryButton']} ${styles['importSourceButton']}`}
            disabled={sourcesDisabled}
            onClick={() => { void loadDefault() }}
          >
            {t('importDefault')}
          </button>
          <button
            type="button"
            className={`${styles['secondaryButton']} ${styles['importSourceButton']}`}
            disabled={sourcesDisabled}
            onClick={() => { fileInput.current?.click() }}
          >
            {t('importChooseFile')}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            disabled={sourcesDisabled}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) void loadFile(file)
            }}
          />
          <span className={styles['importSourceHint']}>{t('importSourceHint')}</span>
        </div>
        {sourceNote === undefined
          ? null
          : <p className={styles['savedNotice']} role="status" aria-live="polite">{sourceNote}</p>}
        {sourceFailure === undefined ? null : <p className={styles['error']} role="alert">{sourceFailure}</p>}
        <textarea
          className={`${styles['input']} ${styles['importText']}`}
          value={text}
          placeholder={t('importPlaceholder')}
          aria-label={t('importJsonLabel')}
          disabled={disabled || committed}
          onChange={(event) => {
            setText(event.target.value)
            setFailure(undefined)
            setSourceFailure(undefined)
            setSourceNote(undefined)
          }}
        />
      </div>
      <p className={styles['advancedHint']}>{t('importDescription')}</p>
      {result === undefined || !committed || importedCount === 0
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {t('importedProviders').replace('{count}', () => String(importedCount))}
          </p>
        )}
      {result === undefined || importedCount > 0
        ? null
        : <p className={styles['error']}>{t('importNothing')}</p>}
      {skipped.length === 0
        ? null
        : (
          <>
            <p className={styles['advancedHint']}>
              {t('importSkipped').replace('{count}', () => String(skipped.length))}
            </p>
            <ul className={styles['importSkips']}>
              {skipped.map((skip, index) => (
                <li key={`${skip.provider}:${String(index)}`}>
                  {`${skip.provider}: ${t(SKIP_KEYS[skip.reason])}`}
                </li>
              ))}
            </ul>
          </>
        )}
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      <EditorFooter
        t={t}
        busy={writing}
        submitDisabled={submitDisabled}
        submitLabelKey={submitLabelKey}
        submitBusyLabelKey="importing"
        cancelLabelKey={committed ? 'close' : 'cancel'}
        onCancel={() => { props.onClose(committed) }}
        onSubmit={() => {
          if (committed && pendingKeys.length === 0) props.onClose(true)
          else void run()
        }}
      />
    </div>
  )
}
