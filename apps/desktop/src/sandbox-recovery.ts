/**
 * Recovery for packaged Windows launches where something on the machine refuses
 * to create Chromium's sandboxed child processes: every launch decision is
 * appended to `startup.log` under the Desktop logs directory, a blocked child
 * launch is recorded, and the next child launch uses `--no-sandbox` once.
 *
 * The unsandboxed fallback weakens renderer isolation, so it applies exactly one
 * launch at a time and only after a recorded `launch-failed`; the marker and the
 * log give the user and support a reproducible trace to investigate the blocker.
 *
 * @module dsh-desktop/sandbox-recovery
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Environment variable marking the single relaunch permitted without the renderer sandbox. */
export const SANDBOX_FALLBACK_ENV = 'DSH_SANDBOX_FALLBACK'

const MARKER_FILE = 'sandbox-launch-failure'
const STARTUP_LOG_FILE = 'startup.log'

/** One recorded blocked child launch. */
interface SandboxFailureRecord {
  readonly at: string
  readonly type: string
  readonly reason: string
}

/** Electron application operations the recovery uses, kept narrow for tests. */
export interface SandboxRecoveryApplication {
  readonly isPackaged: boolean
  readonly commandLine: { appendSwitch(name: string, value?: string): void }
  getPath(name: 'logs'): string
  on(event: 'child-process-gone',
    listener: (event: unknown, details: { type: string; reason: string; exitCode: number }) => void): void
  relaunch(): void
  exit(code?: number): void
}

function startupLogPath(logsDir: string): string {
  return join(logsDir, STARTUP_LOG_FILE)
}

/**
 * Append one timestamped diagnostics line to `startup.log` beside crash reports.
 * @param logsDir - Electron logs directory, portable-owned when the copy is portable.
 * @param line - Diagnostics sentence for the launch under investigation.
 */
export function logStartupLine(logsDir: string, line: string): void {
  try {
    mkdirSync(dirname(startupLogPath(logsDir)), { recursive: true })
    appendFileSync(startupLogPath(logsDir), `${new Date().toISOString()} ${line}\n`)
  } catch (error) {
    // Startup diagnostics never add a second failure to the launch under investigation.
    void error
  }
}

function readMarker(path: string): SandboxFailureRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object'
      && typeof (parsed as { at?: unknown }).at === 'string'
      && typeof (parsed as { type?: unknown }).type === 'string'
      && typeof (parsed as { reason?: unknown }).reason === 'string') {
      const record = parsed as { at: string; type: string; reason: string }
      return { at: record.at, type: record.type, reason: record.reason }
    }
  } catch (error) {
    // A missing or corrupt marker means no recorded sandbox failure.
    void error
  }
  return undefined
}

/**
 * Apply the recorded sandbox verdict before the first child process launches:
 * an unsandboxed fallback launch clears the marker and disables the sandbox, a
 * launch with a recorded failure relaunches once without the sandbox, and a
 * clean launch only records its start in `startup.log`.
 * @param application - Electron application singleton after portable paths are applied.
 * @param platform - Host platform; only packaged Windows builds recover here.
 */
export function planSandboxRecovery(
  application: SandboxRecoveryApplication,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!application.isPackaged || platform !== 'win32') return
  const logsDir = application.getPath('logs')
  const marker = join(logsDir, MARKER_FILE)
  if (process.env[SANDBOX_FALLBACK_ENV] === '1') {
    application.commandLine.appendSwitch('no-sandbox')
    logStartupLine(logsDir, `launch mode=unsandboxed-fallback recorded=${JSON.stringify(readMarker(marker)) ?? 'none'}`)
    try {
      rmSync(marker, { force: true })
    } catch (error) {
      // A marker that survives only makes the next launch repeat the fallback.
      void error
    }
    return
  }
  logStartupLine(logsDir, 'launch mode=sandboxed')
  const recorded = readMarker(marker)
  if (recorded === undefined) return
  logStartupLine(logsDir, `blocked child recorded earlier: ${recorded.type} ${recorded.reason} at ${recorded.at}; relaunching unsandboxed once`)
  process.env[SANDBOX_FALLBACK_ENV] = '1'
  application.relaunch()
  application.exit(0)
}

/**
 * Record sandboxed child launch failures, trigger the one fallback relaunch, and log
 * an unsandboxed failure without looping.
 * @param application - Electron application singleton after portable paths are applied.
 * @param platform - Host platform; only packaged Windows builds recover here.
 */
export function watchSandboxLaunchFailures(
  application: SandboxRecoveryApplication,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!application.isPackaged || platform !== 'win32') return
  const logsDir = application.getPath('logs')
  const startedUnsandboxed = process.env[SANDBOX_FALLBACK_ENV] === '1'
  let relaunchScheduled = false
  application.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'launch-failed') return
    if (relaunchScheduled) {
      logStartupLine(logsDir, `ignored extra blocked child while relaunch is scheduled: type=${details.type}`)
      return
    }
    if (startedUnsandboxed) {
      logStartupLine(logsDir, `unsandboxed launch also failed: type=${details.type} exitCode=${String(details.exitCode)}`)
      return
    }
    const record: SandboxFailureRecord = { at: new Date().toISOString(), type: details.type, reason: details.reason }
    logStartupLine(logsDir, `blocked child launch: type=${details.type} exitCode=${String(details.exitCode)}; relaunching unsandboxed once`)
    try {
      writeFileSync(join(logsDir, MARKER_FILE), JSON.stringify(record))
    } catch (error) {
      // A lost marker only costs the next launch its automatic fallback decision.
      void error
    }
    process.env[SANDBOX_FALLBACK_ENV] = '1'
    relaunchScheduled = true
    application.relaunch()
    application.exit(0)
  })
}
