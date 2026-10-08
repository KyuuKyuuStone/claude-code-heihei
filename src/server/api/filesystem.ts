/**
 * Filesystem browser & search API — supports directory browsing and file search
 * for the DirectoryPicker component and @-triggered file search popup.
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import ignore from 'ignore'
import {
  canonicalizeExistingFilesystemPath,
  isAllowedFilesystemPath,
} from '../services/filesystemPathSecurity.js'
import { normalizeDriveRootPathForPlatform } from '../services/windowsDrivePath.js'
// G2 B-c 批：搜索家族下沉 L2（api 同层 import 违规已清）。本文件 import 实际用到的
// 两个 + 类型，并按名再导出原先的导出面（FilesystemEntry / searchFilesystemEntries /
// getProjectSearchFiles）。
import {
  isVcsMetadataDirectoryName,
  searchFilesystemEntries,
} from '../services/filesystemSearch.js'
import type { FilesystemEntry } from '../services/filesystemSearch.js'
export { getProjectSearchFiles, searchFilesystemEntries } from '../services/filesystemSearch.js'
export type { FilesystemEntry } from '../services/filesystemSearch.js'

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}

// G2 批：isAllowedFilesystemPath（及其私有 isWithinRoot）已下沉 L2
// `services/filesystemPathSecurity.ts` —— api/localFile.ts 也要用它，api 同层互相
// import 触发 layer-L4-no-same-layer。本文件 import 引用并**按名再导出**（导出面不变：
// localFile.test.ts 等既有 import 路径不受影响）。
export { isAllowedFilesystemPath }

export async function handleFilesystemRoute(pathname: string, url: URL): Promise<Response> {
  if (pathname === '/api/filesystem/browse') {
    return handleBrowse(url)
  }

  if (pathname === '/api/filesystem/file') {
    return handleServeFile(url)
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
}

async function handleServeFile(url: URL): Promise<Response> {
  const filePath = url.searchParams.get('path')
  if (!filePath) {
    return json({ error: 'Missing path parameter' }, 400)
  }

  const resolvedPath = path.resolve(normalizeDriveRootPathForPlatform(filePath))
  const canonicalPath = await canonicalizeExistingFilesystemPath(resolvedPath)
  if (!canonicalPath) {
    if (!isAllowedFilesystemPath(resolvedPath)) {
      return json({ error: 'Access denied: path outside allowed directory' }, 403)
    }
    return json({ error: 'File not found' }, 404)
  }
  if (!isAllowedFilesystemPath(canonicalPath)) {
    return json({ error: 'Access denied: path outside allowed directory' }, 403)
  }

  const ext = path.extname(canonicalPath).toLowerCase()
  const mimeType = IMAGE_MIME_TYPES[ext]

  if (!mimeType) {
    return json({ error: 'Unsupported file type' }, 400)
  }

  try {
    const stat = fs.statSync(canonicalPath)
    if (!stat.isFile()) {
      return json({ error: 'Not a file' }, 400)
    }
    // Limit to 50MB
    if (stat.size > 50 * 1024 * 1024) {
      return json({ error: 'File too large' }, 400)
    }

    const data = fs.readFileSync(canonicalPath)
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(stat.size),
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return json({ error: 'File not found' }, 404)
  }
}

async function handleBrowse(url: URL): Promise<Response> {
  const targetPath = url.searchParams.get('path') || os.homedir() || '/'
  const resolvedPath = path.resolve(normalizeDriveRootPathForPlatform(targetPath))
  const canonicalPath = await canonicalizeExistingFilesystemPath(resolvedPath)
  if (!canonicalPath) {
    if (!isAllowedFilesystemPath(resolvedPath)) {
      return json({ error: 'Access denied: path outside allowed directory' }, 403)
    }
    return json({ error: 'Cannot read directory: path not found', path: resolvedPath }, 404)
  }
  if (!isAllowedFilesystemPath(canonicalPath)) {
    return json({ error: 'Access denied: path outside allowed directory' }, 403)
  }

  const searchQuery = url.searchParams.get('search') || ''
  const includeFiles = url.searchParams.get('includeFiles') === 'true'
  const maxResults = Math.min(parseInt(url.searchParams.get('maxResults') || '200', 10), 200)

  try {
    const stat = fs.statSync(canonicalPath)
    if (!stat.isDirectory()) {
      return json({ error: 'Not a directory', path: canonicalPath }, 400)
    }

    if (searchQuery) {
      const results = await searchFilesystemEntries(canonicalPath, searchQuery, {
        includeFiles,
        maxResults,
      })

      return json({
        currentPath: canonicalPath,
        parentPath: path.dirname(canonicalPath),
        entries: results,
        query: searchQuery,
      })
    }

    const entries = fs.readdirSync(canonicalPath, { withFileTypes: true })

    // Browse mode: show dot-prefixed project entries while keeping VCS internals hidden.
    const filtered = entries.filter((e) => {
      if (e.isDirectory()) return !isVcsMetadataDirectoryName(e.name)
      return includeFiles
    })

    const entries_list = filtered
      .map((e) => ({
        name: e.name,
        path: path.join(canonicalPath, e.name),
        isDirectory: e.isDirectory(),
        relativePath: e.name,
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

    return json({
      currentPath: canonicalPath,
      parentPath: path.dirname(canonicalPath),
      entries: entries_list,
    })
  } catch (err) {
    return json({ error: `Cannot read directory: ${err}`, path: canonicalPath }, 500)
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
