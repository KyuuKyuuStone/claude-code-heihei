import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  canonicalizeFilesystemAccessPath,
  isWithinRegisteredFilesystemRoot,
} from './filesystemAccessRoots.js'
import {
  isSameOrInsidePathForPlatform,
  normalizeDriveRootPathForPlatform,
} from './windowsDrivePath.js'

export async function canonicalizeExistingFilesystemPath(
  filePath: string,
): Promise<string | null> {
  try {
    const canonicalPath = await fs.realpath(
      path.resolve(normalizeDriveRootPathForPlatform(filePath)),
    )
    return path.resolve(normalizeDriveRootPathForPlatform(canonicalPath))
  } catch {
    return null
  }
}
/**
 * 路径白名单闸门（2026-10-08 G2 批从 api/filesystem.ts 下沉 L2）：api/localFile.ts 与
 * api/filesystem.ts 都要用它，而 api 同层互相 import 触发 `layer-L4-no-same-layer`。
 * 纯路径判定、只向下依赖（filesystemAccessRoots / windowsDrivePath / node:os）⇒ 放 L2。
 */
function isWithinRoot(targetPath: string, rootPath: string): boolean {
  return isSameOrInsidePathForPlatform(targetPath, rootPath)
}

export function isAllowedFilesystemPath(targetPath: string): boolean {
  const resolvedPath = canonicalizeFilesystemAccessPath(targetPath)
  const homeDir = canonicalizeFilesystemAccessPath(os.homedir())
  const temporaryDir = canonicalizeFilesystemAccessPath('/tmp')

  if (isWithinRoot(resolvedPath, homeDir) || isWithinRoot(resolvedPath, temporaryDir)) {
    return true
  }

  if (isWithinRegisteredFilesystemRoot(resolvedPath)) {
    return true
  }

  // macOS reports /tmp as /private/tmp via native folder pickers and realpath().
  if (process.platform === 'darwin' && isWithinRoot(resolvedPath, canonicalizeFilesystemAccessPath('/private/tmp'))) {
    return true
  }

  return false
}
