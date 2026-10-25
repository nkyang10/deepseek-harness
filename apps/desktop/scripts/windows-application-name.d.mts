/** Windows executable names shared by Desktop packaging and packaged-runtime validation. */

export const WINDOWS_APPLICATION_EXECUTABLE_NAME: 'DeepSeek Harness'

export const PORTABLE_WINDOWS_APPLICATION_EXECUTABLE_NAME: 'DeepSeek Harness Portable'

/**
 * Select the Windows executable name for one packaging mode.
 * @param portable - Whether the build is the folder-based portable distribution.
 * @returns the basename without `.exe` used by electron-builder and packaged-runtime validation.
 */
export function windowsApplicationExecutableName(portable: boolean): 'DeepSeek Harness' | 'DeepSeek Harness Portable'
