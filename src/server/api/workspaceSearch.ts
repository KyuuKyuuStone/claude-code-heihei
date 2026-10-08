import * as path from 'node:path'
import { ApiError } from '../middleware/errorHandler.js'
// G2 B-c 批：改从 L2 实现取（原 import api 同层文件 ⇒ layer-L4-no-same-layer）
import { searchFilesystemEntries } from '../services/filesystemSearch.js'

const WORKSPACE_SEARCH_RESULT_LIMIT = 200

export async function handleWorkspaceSearchRoute(workDir: string, url: URL): Promise<Response> {
  const query = url.searchParams.get('query')?.trim()
  if (!query) {
    throw ApiError.badRequest('query parameter is required for workspace search')
  }

  const entries = await searchFilesystemEntries(workDir, query, {
    includeFiles: true,
    includeDirectories: false,
    maxResults: WORKSPACE_SEARCH_RESULT_LIMIT + 1,
  })
  const truncated = entries.length > WORKSPACE_SEARCH_RESULT_LIMIT

  return Response.json({
    state: 'ok',
    query,
    truncated,
    entries: entries.slice(0, WORKSPACE_SEARCH_RESULT_LIMIT).map((entry) => ({
      name: entry.name,
      path: (entry.relativePath || path.relative(workDir, entry.path)).replace(/\\/g, '/'),
      isDirectory: entry.isDirectory,
    })),
  })
}
