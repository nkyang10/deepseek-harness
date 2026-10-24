import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { PORTABLE_DATA_DIR, applyPortablePaths, isPortableLaunch, resolvePortablePaths } from '../src/portable.ts'

let root: string
let exePath: string
const originalHome = process.env.DSH_HOME

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-desktop-portable-'))
  exePath = join(root, 'DeepSeek Harness.exe')
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  })
})

function application(paths: Record<string, string> = {}, isPackaged = true) {
  return {
    isPackaged,
    getPath: (name: 'exe'): string => name === 'exe' ? exePath : paths[name] ?? `desktop-test-${name}`,
    setPath: vi.fn((name: string, path: string) => { paths[name] = path }),
  }
}

it('makes packaged Windows applications portable without an opt-in file', () => {
  expect(isPortableLaunch({ platform: 'win32', packaged: true })).toBe(true)
})

it.each([
  ['win32', false],
  ['darwin', true],
  ['linux', true],
] as const)('leaves packaged=%s %s launches on the shared roots', (platform, packaged) => {
  expect(isPortableLaunch({ platform, packaged })).toBe(false)
  expect(applyPortablePaths(application({}, packaged), platform)).toBeUndefined()
  expect(existsSync(join(root, PORTABLE_DATA_DIR))).toBe(false)
})

it('resolves every portable root under the executable directory', () => {
  const paths = resolvePortablePaths(exePath)
  const base = resolve(root, PORTABLE_DATA_DIR)
  expect(paths).toEqual({ dshHome: join(base, 'dsh-home'), userData: join(base, 'electron-data'), logs: join(base, 'logs') })
})

it('redirects the Harness home and Electron paths for a packaged Windows launch', () => {
  const app = application()
  const paths = applyPortablePaths(app, 'win32')
  expect(paths).toBeDefined()
  expect(process.env.DSH_HOME).toBe(paths?.dshHome)
  expect(app.setPath).toHaveBeenCalledWith('userData', paths?.userData)
  expect(app.setPath).toHaveBeenCalledWith('logs', paths?.logs)
  // The Harness home itself is created lazily by its owners; its parent must exist for them.
  expect(existsSync(join(root, PORTABLE_DATA_DIR))).toBe(true)
  expect(existsSync(paths?.dshHome ?? '')).toBe(false)
})

it('reuses an existing portable data directory without touching other files', () => {
  mkdirSync(resolve(root, PORTABLE_DATA_DIR, 'dsh-home'), { recursive: true })
  const existingFile = resolve(root, PORTABLE_DATA_DIR, 'dsh-home', 'keep.txt')
  writeFileSync(existingFile, 'keep\n')
  expect(applyPortablePaths(application(), 'win32')?.dshHome).toBe(resolve(root, PORTABLE_DATA_DIR, 'dsh-home'))
  expect(existsSync(existingFile)).toBe(true)
})

it('fails loud when the executable location cannot host portable data', () => {
  const blocker = join(root, PORTABLE_DATA_DIR)
  writeFileSync(blocker, 'not a directory\n')
  expect(() => applyPortablePaths(application(), 'win32')).toThrow()
})
