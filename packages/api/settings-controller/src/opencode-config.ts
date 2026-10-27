/**
 * Host owner of the `opencodeConfig` Remote namespace: reads the OpenCode
 * configuration file the Host already has, so a browser settings page can
 * import it without asking the user to locate the file.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/opencode-config
 */

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { OpenCodeConfigFile } from './types.ts'

/**
 * Upper bound on one default OpenCode config read. OpenCode config files carry
 * provider declarations, not model payloads; a file far above this size is not
 * a config the import can use and must not be buffered into the Host.
 */
const MAX_OPENCODE_CONFIG_BYTES = 1024 * 1024

/** Optional Host-owned collaborators of {@link OpencodeConfigController}. */
export interface OpencodeConfigControllerInternals {
  /**
   * Resolve the default config file paths in precedence order.
   * @returns candidate absolute paths.
   */
  readonly candidates?: () => readonly string[]
}

/** @param error - a rejected filesystem operation. @returns its message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the OpenCode configuration paths in OpenCode's own precedence order.
 * The explicit `OPENCODE_CONFIG` path wins when set; otherwise the global file
 * under `XDG_CONFIG_HOME` or the home directory is the default. Windows also
 * gets `APPDATA` and `LOCALAPPDATA` fallbacks for installations that place the
 * global file there.
 * @param env - Host environment carrying OpenCode's path overrides.
 * @param home - Host home directory.
 * @param platform - Host platform, selecting the Windows fallbacks.
 * @returns absolute candidate paths, deduplicated in read order.
 */
export function opencodeConfigCandidates(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform,
): readonly string[] {
  const paths = platform === 'win32' ? win32 : posix
  const explicit = env.OPENCODE_CONFIG?.trim()
  if (explicit !== undefined && explicit !== '') return [paths.resolve(explicit)]

  const candidates: string[] = []
  const xdg = env.XDG_CONFIG_HOME?.trim()
  if (xdg !== undefined && xdg !== '') candidates.push(paths.join(xdg, 'opencode', 'opencode.json'))
  candidates.push(paths.join(home, '.config', 'opencode', 'opencode.json'))
  if (platform === 'win32') {
    for (const name of ['APPDATA', 'LOCALAPPDATA'] as const) {
      const base = env[name]?.trim()
      if (base !== undefined && base !== '') candidates.push(paths.join(base, 'opencode', 'opencode.json'))
    }
  }
  return [...new Set(candidates)]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `opencodeConfig` Remote namespace. */
    opencodeConfigController: OpencodeConfigController
  }
}

/**
 * Host service backing the generated `ctx.remote.opencodeConfig` namespace. It
 * only reads files the Host resolves from OpenCode's documented configuration
 * locations; the browser supplies no path, so this namespace cannot be used as
 * a general filesystem read.
 */
export class OpencodeConfigController extends TypertRemoteService {
  private readonly candidates: () => readonly string[]

  /**
   * Register the read-only OpenCode configuration namespace.
   * @param ctx - Host context where the filesystem service may be mounted.
   * @param internals - deterministic candidate paths for Host tests.
   */
  constructor(ctx: Context, internals: OpencodeConfigControllerInternals = {}) {
    super(ctx, 'opencodeConfigController', { namespace: 'opencodeConfig' })
    this.candidates = internals.candidates
      ?? (() => opencodeConfigCandidates(process.env, homedir(), process.platform))
  }

  /**
   * Read the first existing default OpenCode config file.
   * @returns the absolute path read and its UTF-8 contents.
   * @throws RemoteError when the filesystem is absent, no candidate exists, the
   *   first existing candidate is not a regular text file, or it exceeds the read cap.
   */
  @Remote
  async readDefault(): Promise<OpenCodeConfigFile> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) {
      throw new RemoteError(
        'opencode-config/unavailable',
        'filesystem service is absent: mount @deepseek-ai/dsh-fs to read the default OpenCode config',
        {},
      )
    }

    const candidates = this.candidates()
    for (const path of candidates) {
      const target = await fs.resolve(path)
      const info = await fs.stat(target)
      if (info === undefined) continue
      if (info.type !== 'file') {
        throw new RemoteError('opencode-config/not-file', `default OpenCode config "${path}" is not a regular file`, { path })
      }
      let bytes: Uint8Array
      try {
        bytes = await fs.readBytes(target, undefined, MAX_OPENCODE_CONFIG_BYTES)
      } catch (error) {
        if (error instanceof FsError && error.code === 'FS_NOT_FOUND') continue
        if (error instanceof FsError && error.code === 'FS_TOO_LARGE') {
          throw new RemoteError(
            'opencode-config/too-large',
            `default OpenCode config "${path}" exceeds ${String(MAX_OPENCODE_CONFIG_BYTES)} bytes`,
            { path },
            { cause: error },
          )
        }
        throw new RemoteError(
          'opencode-config/read-failed',
          `default OpenCode config "${path}" could not be read: ${messageOf(error)}`,
          { path },
          { cause: error },
        )
      }
      let content: string
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch (error) {
        throw new RemoteError(
          'opencode-config/not-text',
          `default OpenCode config "${path}" is not UTF-8 text`,
          { path },
          { cause: error },
        )
      }
      return { path: target.displayPath, content }
    }

    throw new RemoteError(
      'opencode-config/not-found',
      `no OpenCode config found at ${candidates.join(', ')}`,
      { candidates },
    )
  }
}
