/** General Settings control for the owner-configured Web login passcode. */
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './WebAccessRow.module.css'

/** The Connection entry id whose Config carries the passcode. */
export const CONNECTION_SETTINGS_NAMESPACE = 'connection'

/** Mirror the Host schema minimum; the Host remains the validating authority. */
const MIN_PASSCODE_LENGTH = 8

/** Write-only passcode field and the settings mirror that reports its presence. */
export interface WebAccessRowInjected {
  hooks: { settings: SettingsDescribeFace }
  savePasscode(value: string): Promise<boolean>
  clearPasscode(): Promise<boolean>
}

/** Closed failure copy for this row. */
type WebAccessError = 'tooShort' | 'saveFailed'

/**
 * Render the remote-access passcode control.
 * @param props - settings mirror, writers, and localized copy.
 * @returns the General Settings row.
 */
export function WebAccessRow({ useSettings, savePasscode, clearPasscode, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & InjectFace<WebAccessRowInjected>) {
  const snapshot = useSettings(value => value)
  const connection = snapshot.view?.namespaces.find(row => row.ns === CONNECTION_SETTINGS_NAMESPACE)
  const configured = connection?.secrets.some(secret =>
    secret.path.length === 1 && secret.path[0] === 'passcode' && secret.set) === true
  const writable = snapshot.view?.writable === true && connection !== undefined
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<WebAccessError>()

  const save = (): void => {
    if (value.length < MIN_PASSCODE_LENGTH) {
      setError('tooShort')
      return
    }
    setError(undefined)
    setBusy(true)
    void savePasscode(value)
      .then((accepted) => {
        if (accepted) setValue('')
        else setError('saveFailed')
      })
      .catch(() => { setError('saveFailed') })
      .finally(() => { setBusy(false) })
  }

  const clear = (): void => {
    setError(undefined)
    setBusy(true)
    void clearPasscode()
      .then((accepted) => { if (!accepted) setError('saveFailed') })
      .catch(() => { setError('saveFailed') })
      .finally(() => { setBusy(false) })
  }

  return <div className={css.row}>
    <div className={css.copy}>
      <div className={css.title}>{t('webAccess.title')}</div>
      <div className={css.description}>{t('webAccess.description')}</div>
      {configured && <div className={css.status}>{t('webAccess.configured')}</div>}
      {error !== undefined && <div className={css.error} role="alert">{t(`webAccess.${error}`)}</div>}
    </div>
    <div className={css.controls}>
      <form className={css.form} onSubmit={(event) => { event.preventDefault(); save() }}>
        <Input
          type="password"
          value={value}
          onChange={(event) => { setValue(event.currentTarget.value) }}
          placeholder={t('webAccess.placeholder')}
          aria-label={t('webAccess.title')}
          autoComplete="new-password"
          disabled={busy || !writable}
        />
        <Button type="submit" variant="primary" size="sm" disabled={busy || !writable || value.length === 0}>
          {t('webAccess.save')}
        </Button>
      </form>
      {configured && <Button type="button" variant="outline" size="sm" disabled={busy || !writable} onClick={clear}>
        {t('webAccess.clear')}
      </Button>}
    </div>
  </div>
}
