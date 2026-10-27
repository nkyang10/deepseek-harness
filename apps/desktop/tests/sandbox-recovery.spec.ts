import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SANDBOX_FALLBACK_ENV, logStartupLine, planSandboxRecovery, watchSandboxLaunchFailures,
  type SandboxRecoveryApplication } from '../src/sandbox-recovery.ts'

let logsDir: string
let goneListeners: Array<(event: unknown, details: { type: string; reason: string; exitCode: number }) => void>
let envState: string | undefined

function application(isPackaged = true): SandboxRecoveryApplication {
  return {
    isPackaged,
    commandLine: { appendSwitch: vi.fn() },
    getPath: () => logsDir,
    on: (_event, listener) => { goneListeners.push(listener) },
    relaunch: vi.fn(),
    exit: vi.fn(),
  }
}

beforeEach(() => {
  logsDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-sandbox-'))
  goneListeners = []
  envState = process.env[SANDBOX_FALLBACK_ENV]
  delete process.env.DSH_SANDBOX_FALLBACK
})

afterEach(() => {
  rmSync(logsDir, { recursive: true, force: true })
  if (envState === undefined) delete process.env.DSH_SANDBOX_FALLBACK
  else process.env[SANDBOX_FALLBACK_ENV] = envState
})

function startupLog(): string {
  return readFileSync(join(logsDir, 'startup.log'), 'utf8')
}

it('logs the sandboxed launch and starts nothing else when no failure was recorded', () => {
  const app = application()
  planSandboxRecovery(app, 'win32')
  expect(startupLog()).toContain('launch mode=sandboxed')
  expect(app.relaunch).not.toHaveBeenCalled()
  expect(app.exit).not.toHaveBeenCalled()
})

it('applies no recovery to unpackaged or non-Windows launches', () => {
  planSandboxRecovery(application(false), 'win32')
  planSandboxRecovery(application(), 'darwin')
  expect(() => readFileSync(join(logsDir, 'startup.log'), 'utf8')).toThrow()
})

it('relaunches once when a blocked child launch was recorded by a previous run', () => {
  writeFileSync(join(logsDir, 'sandbox-launch-failure'),
    JSON.stringify({ at: '2026-10-27T00:00:00.000Z', type: 'GPU', reason: 'launch-failed' }))
  const app = application()
  planSandboxRecovery(app, 'win32')
  expect(process.env[SANDBOX_FALLBACK_ENV]).toBe('1')
  expect(app.relaunch).toHaveBeenCalledTimes(1)
  expect(app.exit).toHaveBeenCalledWith(0)
  expect(startupLog()).toContain('GPU launch-failed')
})

it('disables the sandbox and clears the marker on the fallback launch', () => {
  const marker = join(logsDir, 'sandbox-launch-failure')
  writeFileSync(marker, JSON.stringify({ at: '2026-10-27T00:00:00.000Z', type: 'GPU', reason: 'launch-failed' }))
  process.env[SANDBOX_FALLBACK_ENV] = '1'
  const app = application()
  planSandboxRecovery(app, 'win32')
  expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('no-sandbox')
  expect(app.relaunch).not.toHaveBeenCalled()
  expect(() => readFileSync(marker, 'utf8')).toThrow()
  expect(startupLog()).toContain('mode=unsandboxed-fallback')
})

it('records a blocked child launch and relaunches unsandboxed exactly once', () => {
  const app = application()
  watchSandboxLaunchFailures(app, 'win32')
  goneListeners[0]!({}, { type: 'GPU', reason: 'launch-failed', exitCode: 0 })
  expect(JSON.parse(readFileSync(join(logsDir, 'sandbox-launch-failure'), 'utf8')).type).toBe('GPU')
  expect(process.env[SANDBOX_FALLBACK_ENV]).toBe('1')
  expect(app.relaunch).toHaveBeenCalledTimes(1)
  expect(app.exit).toHaveBeenCalledWith(0)
  goneListeners[0]!({}, { type: 'Renderer', reason: 'launch-failed', exitCode: 18 })
  expect(app.relaunch).toHaveBeenCalledTimes(1)
  expect(startupLog()).toContain('ignored extra blocked child')
})

it('only logs further blocked launches during the unsandboxed fallback', () => {
  process.env[SANDBOX_FALLBACK_ENV] = '1'
  const app = application()
  watchSandboxLaunchFailures(app, 'win32')
  goneListeners[0]!({}, { type: 'Renderer', reason: 'launch-failed', exitCode: 1 })
  expect(app.relaunch).not.toHaveBeenCalled()
  expect(startupLog()).toContain('unsandboxed launch also failed')
})

it('ignores ordinary child exits', () => {
  const app = application()
  watchSandboxLaunchFailures(app, 'win32')
  goneListeners[0]!({}, { type: 'Renderer', reason: 'clean-exit', exitCode: 0 })
  expect(app.relaunch).not.toHaveBeenCalled()
})

it('keeps startup log failures non-fatal', () => {
  // startup.log taken by a directory makes every append fail; diagnostics must stay silent.
  mkdirSync(join(logsDir, 'startup.log'))
  expect(() => logStartupLine(logsDir, 'line')).not.toThrow()
})
