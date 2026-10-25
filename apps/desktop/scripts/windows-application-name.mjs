/** Windows executable names shared by Desktop packaging and packaged-runtime validation. */

/** Electron executable shipped by installed Windows Desktop packages. */
export const WINDOWS_APPLICATION_EXECUTABLE_NAME = 'DeepSeek Harness'

/** Electron executable shipped by unsigned Windows Desktop portable folders. */
export const PORTABLE_WINDOWS_APPLICATION_EXECUTABLE_NAME = 'DeepSeek Harness Portable'

/**
 * Select the Windows executable name for one packaging mode.
 * @param portable - Whether the build is the folder-based portable distribution.
 * @returns the basename without `.exe` used by electron-builder and packaged-runtime validation.
 */
export function windowsApplicationExecutableName(portable) {
  return portable ? PORTABLE_WINDOWS_APPLICATION_EXECUTABLE_NAME : WINDOWS_APPLICATION_EXECUTABLE_NAME
}
