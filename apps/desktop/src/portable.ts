/**
 * Portable-mode ownership: packaged Windows applications redirect every Desktop data
 * root beside the executable and keep this installation from claiming the
 * machine-wide surfaces an installed dsh owns.
 *
 * Development launches keep the shared roots an npm-installed dsh also uses. A
 * packaged Windows copy can be unpacked, used, and deleted without touching the user's
 * `~/.dsh` or `%APPDATA%` data, and without stealing the `dsh` protocol handler or
 * the `dsh` PATH command from an official installation.
 *
 * @module dsh-desktop/portable
 */

import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'

/** Directory beside the executable that holds every portable data root. */
export const PORTABLE_DATA_DIR = 'data'

/** Suffix that keeps a portable window visually distinct from an installed copy. */
export const PORTABLE_WINDOW_TITLE_SUFFIX = ' (Portable)'

/**
 * Add the portable suffix once to a Desktop window title.
 * @param title - Current title supplied by Electron or the renderer.
 * @returns the same title when already marked, otherwise the suffixed title.
 */
export function markPortableWindowTitle(title: string): string {
  return title.endsWith(PORTABLE_WINDOW_TITLE_SUFFIX) ? title : `${title}${PORTABLE_WINDOW_TITLE_SUFFIX}`
}

/**
 * Keep a Desktop window title marked as portable through its first display and
 * subsequent renderer title updates.
 * @param window - Window created by the portable Desktop application.
 * @returns No value; listeners remain attached for the window's lifetime.
 */
export function markPortableWindow(window: BrowserWindow): void {
  const mark = (title: string): void => {
    if (!window.isDestroyed()) window.setTitle(markPortableWindowTitle(title))
  }
  window.once('ready-to-show', () => { mark(window.title) })
  window.on('page-title-updated', (event, title) => {
    event.preventDefault()
    mark(title)
  })
}

/** Portable-owned roots, resolved before Electron or the Host reads them. */
export interface PortablePaths {
  /** Harness home for profiles, sessions, credentials, storages, and the runtime root. */
  readonly dshHome: string
  /** Electron user data for settings, shortcuts, and renderer profiles. */
  readonly userData: string
  /** Desktop log directory, kept with the other portable data. */
  readonly logs: string
}

/**
 * Whether this launch must use the executable-relative portable roots.
 * @param options - Running application mode and host platform.
 * @returns true for packaged Windows applications.
 */
export function isPortableLaunch(options: { platform: NodeJS.Platform; packaged: boolean }): boolean {
  return options.platform === 'win32' && options.packaged
}

/**
 * Resolve the portable roots under the executable directory.
 * @param exePath - Absolute path of the running executable.
 * @returns absolute Harness home, Electron user data, and log directories.
 */
export function resolvePortablePaths(exePath: string): PortablePaths {
  const root = resolve(dirname(exePath), PORTABLE_DATA_DIR)
  return {
    dshHome: join(root, 'dsh-home'),
    userData: join(root, 'electron-data'),
    logs: join(root, 'logs'),
  }
}

/** Minimal Electron application operations needed to redirect the data roots. */
export interface PortableApplication {
  readonly isPackaged: boolean
  getPath(name: 'exe'): string
  setPath(name: string, path: string): void
}

/**
 * Apply portable ownership before anything resolves a data root: create the
 * directory, publish `DSH_HOME` to this process, and repoint Electron.
 * Creating the data directory fails loud, because a read-only executable
 * location cannot host portable data.
 * @param application - Electron application singleton.
 * @param platform - Host platform used to distinguish packaged Windows builds.
 * @returns the applied portable roots, or undefined for an ordinary launch.
 * @throws when a packaged Windows launch cannot create its data directory.
 */
export function applyPortablePaths(
  application: PortableApplication,
  platform: NodeJS.Platform = process.platform,
): PortablePaths | undefined {
  if (!isPortableLaunch({ platform, packaged: application.isPackaged })) return undefined
  const paths = resolvePortablePaths(application.getPath('exe'))
  mkdirSync(dirname(paths.dshHome), { recursive: true })
  process.env.DSH_HOME = paths.dshHome
  application.setPath('userData', paths.userData)
  application.setPath('logs', paths.logs)
  return paths
}
