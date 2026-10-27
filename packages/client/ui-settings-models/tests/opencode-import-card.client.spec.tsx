// @vitest-environment jsdom
/** The add card's OpenCode import panel: write ordering, skip reporting, and key retry. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { OpencodeImportCard } from '../src/client/OpencodeImportCard.tsx'
import type { ModelsOperations, OpenCodeConfigReadOutcome } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

function view(revision: number): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: { type: 'object' },
    value: {},
    autoGenerate: true,
    applies: 'live',
    secrets: [],
    revision,
  }
}

function bench(overrides: Partial<ModelsOperations> = {}) {
  const writeSettings = vi.fn().mockResolvedValue({ kind: 'written', view: view(2) })
  const storeCredential = vi.fn().mockResolvedValue(undefined)
  const readOpencodeConfig = vi.fn().mockResolvedValue({ kind: 'unavailable' })
  const onClose = vi.fn()
  const operations: ModelsOperations = {
    storeCredential,
    removeCredential: vi.fn().mockResolvedValue(undefined),
    writeSettings,
    discoverModels: vi.fn().mockResolvedValue({ kind: 'found', models: [] }),
    readOpencodeConfig,
    ...overrides,
  }
  const { container } = render(
    <OpencodeImportCard
      taken={['taken']}
      shipped={['openai']}
      protocols={['openai-completions', 'openai-responses', 'anthropic-messages']}
      revision={1}
      operations={operations}
      t={t}
      readOnly={false}
      onClose={onClose}
    />,
  )
  return { writeSettings, storeCredential, readOpencodeConfig, onClose, container }
}

const SAMPLE = JSON.stringify({
  provider: {
    anthropic: {
      options: { baseURL: 'https://anthropic.test/v1', apiKey: '{env:ANTHROPIC_API_KEY}' },
      models: { claude: {} },
    },
    acme: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Acme',
      options: { baseURL: 'https://acme.test/v1', apiKey: 'sk-acme' },
      models: { large: {} },
    },
  },
})

function jsonField(): HTMLTextAreaElement {
  return screen.getByLabelText<HTMLTextAreaElement>(en.importJsonLabel)
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) throw new Error('file input is absent')
  return input
}

function fileWithText(name: string, text: () => Promise<string>): File {
  const file = new File([], name)
  vi.spyOn(file, 'text').mockImplementation(text)
  return file
}

describe('OpencodeImportCard', () => {
  it('writes every profile in one mutation, then stores literal keys, and reports the import', async () => {
    const { writeSettings, storeCredential, onClose } = bench()
    fireEvent.change(jsonField(), { target: { value: SAMPLE } })
    fireEvent.click(screen.getByRole('button', { name: en.import }))

    await waitFor(() => { expect(storeCredential).toHaveBeenCalledWith('ACME_API_KEY', 'sk-acme') })
    expect(writeSettings).toHaveBeenCalledTimes(1)
    const [ns, ops, revision] = writeSettings.mock.calls[0] as [string, { op: string; path: string[]; value: unknown }[], number]
    expect(ns).toBe('llm-pi-ai')
    expect(revision).toBe(1)
    expect(ops.map(op => op.path)).toEqual([
      ['providers', 'anthropic'],
      ['providers', 'acme'],
    ])
    expect(screen.getByText(en.importedProviders.replace('{count}', '2'))).toBeTruthy()
    expect(screen.getByRole('button', { name: en.importDone })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.importDefault }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.importChooseFile }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('closes without writing from Cancel', () => {
    const { writeSettings, storeCredential, onClose } = bench()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(onClose).toHaveBeenCalledWith(false)
    expect(writeSettings).not.toHaveBeenCalled()
    expect(storeCredential).not.toHaveBeenCalled()
  })

  it('fills the textarea from the Host default file', async () => {
    bench({
      readOpencodeConfig: vi.fn().mockResolvedValue({
        kind: 'found',
        path: '/home/u/.config/opencode/opencode.json',
        content: SAMPLE,
      }),
    })
    fireEvent.click(screen.getByRole('button', { name: en.importDefault }))

    await waitFor(() => { expect(jsonField().value).toBe(SAMPLE) })
    expect(screen.getByText(en.importDefaultLoaded.replace('{path}', '/home/u/.config/opencode/opencode.json'))).toBeTruthy()
  })

  it('reports unavailable, refused, and throwing default reads', async () => {
    const readOpencodeConfig = vi.fn()
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({ kind: 'refused', message: 'no config' })
      .mockRejectedValueOnce(new Error('offline'))
    bench({ readOpencodeConfig })
    const button = () => screen.getByRole('button', { name: en.importDefault })

    fireEvent.click(button())
    expect(await screen.findByText(en.importDefaultUnavailable)).toBeTruthy()
    await waitFor(() => { expect(button().hasAttribute('disabled')).toBe(false) })

    fireEvent.click(button())
    expect(await screen.findByText(en.importDefaultReadFailed.replace('{message}', 'no config'))).toBeTruthy()
    await waitFor(() => { expect(button().hasAttribute('disabled')).toBe(false) })

    fireEvent.click(button())
    expect(await screen.findByText(en.importDefaultReadFailed.replace('{message}', 'offline'))).toBeTruthy()
    expect(jsonField().value).toBe('')
  })

  it('fills the textarea from a selected file, then reports a failed file read', async () => {
    const { container } = bench()
    const input = fileInput(container)
    const choose = screen.getByRole('button', { name: en.importChooseFile })
    const click = vi.spyOn(input, 'click')
    fireEvent.click(choose)
    expect(click).toHaveBeenCalledOnce()

    const selected = fileWithText('home-opencode.json', async () => SAMPLE)
    fireEvent.change(input, { target: { files: [selected] } })

    await waitFor(() => { expect(jsonField().value).toBe(SAMPLE) })
    expect(screen.getByText(en.importFileLoaded.replace('{name}', 'home-opencode.json'))).toBeTruthy()

    fireEvent.change(jsonField(), { target: { value: '{}' } })
    expect(screen.queryByText(en.importFileLoaded.replace('{name}', 'home-opencode.json'))).toBeNull()

    const rejected = fileWithText('broken.json', async () => { throw new Error('unreadable') })
    fireEvent.change(input, { target: { files: [rejected] } })
    expect(await screen.findByText(en.importFileReadFailed.replace('{message}', 'unreadable'))).toBeTruthy()

    const refusal: unknown = 'not text'
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercises the non-Error read diagnostic path
    const refused = fileWithText('refused.json', async () => Promise.reject(refusal))
    fireEvent.change(input, { target: { files: [refused] } })
    expect(await screen.findByText(en.importFileReadFailed.replace('{message}', 'not text'))).toBeTruthy()

    fireEvent.change(input, { target: { files: [] } })
    expect(jsonField().value).toBe('{}')
  })

  it('disables both sources and submit while a default read is pending', async () => {
    const pending = Promise.withResolvers<OpenCodeConfigReadOutcome>()
    bench({ readOpencodeConfig: vi.fn(() => pending.promise) })
    const defaultButton = screen.getByRole('button', { name: en.importDefault })
    fireEvent.click(defaultButton)

    expect(defaultButton.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.importChooseFile }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.import }).hasAttribute('disabled')).toBe(true)
    expect(jsonField().disabled).toBe(true)

    pending.resolve({ kind: 'found', path: '/tmp/opencode.json', content: SAMPLE })
    await waitFor(() => { expect(jsonField().value).toBe(SAMPLE) })
    expect(jsonField().disabled).toBe(false)
    expect(defaultButton.hasAttribute('disabled')).toBe(false)
  })

  it('reports skipped providers and writes nothing when none can be imported', async () => {
    const { writeSettings, storeCredential } = bench()
    fireEvent.change(jsonField(), {
      target: {
        value: JSON.stringify({
          provider: {
            taken: { npm: '@ai-sdk/openai' },
            google: { npm: '@ai-sdk/google', options: { baseURL: 'https://google.test' }, models: { gemini: {} } },
          },
        }),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: en.import }))

    expect(await screen.findByText(en.importNothing)).toBeTruthy()
    expect(screen.getByText(en.importSkipped.replace('{count}', '2'))).toBeTruthy()
    expect(screen.getByText(`taken: ${en.importSkipExisting}`)).toBeTruthy()
    expect(screen.getByText(`google: ${en.importSkipProtocol}`)).toBeTruthy()
    expect(writeSettings).not.toHaveBeenCalled()
    expect(storeCredential).not.toHaveBeenCalled()
  })

  it('refuses malformed text, malformed provider maps, and empty provider maps', async () => {
    bench()
    fireEvent.change(jsonField(), { target: { value: '{' } })
    fireEvent.click(screen.getByRole('button', { name: en.import }))
    expect(await screen.findByText(en.importInvalidJson)).toBeTruthy()

    fireEvent.change(jsonField(), { target: { value: '{"theme":"dark"}' } })
    fireEvent.click(screen.getByRole('button', { name: en.import }))
    expect(await screen.findByText(en.importInvalidConfig)).toBeTruthy()

    fireEvent.change(jsonField(), { target: { value: '{"provider":{}}' } })
    fireEvent.click(screen.getByRole('button', { name: en.import }))
    expect(await screen.findByText(en.importNothing)).toBeTruthy()
  })

  it('keeps a committed import open and retries only the failed key', async () => {
    const storeCredential = vi.fn()
      .mockResolvedValueOnce('credential rejected')
      .mockResolvedValueOnce('still rejected')
      .mockResolvedValueOnce(undefined)
    const { writeSettings, onClose } = bench({ storeCredential })
    fireEvent.change(jsonField(), { target: { value: SAMPLE } })
    fireEvent.click(screen.getByRole('button', { name: en.import }))

    expect(await screen.findByText(en.importKeyFailed.replace('{message}', 'acme: credential rejected'))).toBeTruthy()
    expect(jsonField().disabled).toBe(true)
    expect(screen.getByRole('button', { name: en.importRetry })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.importRetry }))
    await waitFor(() => { expect(storeCredential).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(en.importKeyFailed.replace('{message}', 'acme: still rejected'))).toBeTruthy()
    expect(writeSettings).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: en.importRetry }))
    await waitFor(() => { expect(storeCredential).toHaveBeenCalledTimes(3) })
    expect(await screen.findByRole('button', { name: en.importDone })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.importDone }))
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('shows the Host message when the settings provider refuses the write', async () => {
    const { storeCredential } = bench({
      writeSettings: vi.fn().mockResolvedValue({ kind: 'refused', message: 'profile rejected' }),
    })
    fireEvent.change(jsonField(), { target: { value: SAMPLE } })
    fireEvent.click(screen.getByRole('button', { name: en.import }))

    expect(await screen.findByText('profile rejected')).toBeTruthy()
    expect(storeCredential).not.toHaveBeenCalled()
  })

  it('reports a stale revision without storing keys', async () => {
    const { storeCredential } = bench({
      writeSettings: vi.fn().mockResolvedValue({ kind: 'conflict', message: 'stale' }),
    })
    fireEvent.change(jsonField(), { target: { value: SAMPLE } })
    fireEvent.click(screen.getByRole('button', { name: en.import }))

    expect(await screen.findByText(en.conflict)).toBeTruthy()
    expect(storeCredential).not.toHaveBeenCalled()
  })
})
