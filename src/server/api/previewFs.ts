import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  isSameOrInsidePathForPlatform,
  normalizeDriveRootPathForPlatform,
} from '../services/windowsDrivePath.js'
import { canonicalizeExistingFilesystemPath } from '../services/filesystemPathSecurity.js'
// G2 B-c 批：文件直传家族下沉 L2（api 同层 import 违规已清）。
// 仍 import 实际用到的三个；其余按名再导出以保持导出面不变（previewFs.test.ts 等）。
import {
  contentTypeForPath,
  PREVIEW_HTML_CSP,
  serveFileWithRange,
} from '../services/fileServing.js'
export { contentTypeForPath, parseRange, serveFileWithRange } from '../services/fileServing.js'
export type { ParsedRange } from '../services/fileServing.js'

export type ResolveWorkDir = (sessionId: string) => Promise<string | null>

const PREFIX = '/preview-fs/'

const MAX_TRANSFORMED_HTML_BYTES = 10 * 1024 * 1024
const ROOT_RELATIVE_HTML_ATTR_RE = /\b(src|href)=(["'])\/(?!\/)([^"']*)\2/gi

/**
 * Serve a single file from a session's sandboxed workspace directory.
 *
 * URL shape: `/preview-fs/<sessionId>/<relPath>` where `<relPath>` may itself
 * contain `/` separators. The WHATWG URL parser collapses `..` segments before
 * this handler runs, so a traversal attempt such as
 * `/preview-fs/s1/../../etc/passwd` arrives with its pathname normalized to
 * `/etc/passwd` — i.e. the `/preview-fs/` prefix is gone. We treat any request
 * that lost the prefix as a sandbox escape and return 403. Requests that keep
 * the prefix are additionally re-validated against the resolved work-dir root.
 */
export async function handlePreviewFs(
  url: URL,
  resolveWorkDir: ResolveWorkDir,
  reqHeaders?: Headers,
): Promise<Response> {
  if (!url.pathname.startsWith(PREFIX)) {
    return new Response('forbidden', { status: 403 })
  }

  const rest = url.pathname.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return new Response('bad request', { status: 400 })

  const sessionId = decodeURIComponent(rest.slice(0, slash))
  const relRaw = decodeURIComponent(rest.slice(slash + 1))

  const workDir = await resolveWorkDir(sessionId)
  if (!workDir) return new Response('no workdir', { status: 404 })

  const root = path.resolve(normalizeDriveRootPathForPlatform(workDir))
  const target = path.resolve(root, relRaw)
  if (!isSameOrInsidePathForPlatform(target, root)) {
    return new Response('forbidden', { status: 403 })
  }

  const [canonicalRoot, canonicalTarget] = await Promise.all([
    canonicalizeExistingFilesystemPath(root),
    canonicalizeExistingFilesystemPath(target),
  ])
  if (!canonicalRoot || !canonicalTarget) {
    return new Response('not found', { status: 404 })
  }
  if (!isSameOrInsidePathForPlatform(canonicalTarget, canonicalRoot)) {
    return new Response('forbidden', { status: 403 })
  }

  return servePreviewFsFile(canonicalTarget, url.pathname, reqHeaders)
}

function previewHtmlBasePath(pathname: string): string {
  const slash = pathname.lastIndexOf('/')
  if (slash < 0) return '/'
  return pathname.slice(0, slash + 1)
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function rewritePreviewHtml(content: string, basePath: string): string {
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`
  const rewrittenRootAssets = content.replace(
    ROOT_RELATIVE_HTML_ATTR_RE,
    (_match, attr: string, quote: string, value: string) =>
      `${attr}=${quote}${normalizedBase}${value}${quote}`,
  )

  if (/<base\b/i.test(rewrittenRootAssets)) {
    return rewrittenRootAssets
  }

  return rewrittenRootAssets.replace(
    /<head\b[^>]*>/i,
    (head) => `${head}<base href="${escapeHtmlAttribute(normalizedBase)}">`,
  )
}

async function servePreviewFsFile(
  target: string,
  requestPathname: string,
  reqHeaders?: Headers,
): Promise<Response> {
  const ext = path.extname(target).toLowerCase()
  const isHtml = ext === '.html' || ext === '.htm'
  if (!isHtml) {
    return serveFileWithRange(target, reqHeaders)
  }
  if (reqHeaders?.has('range')) {
    return serveFileWithRange(target, reqHeaders, {
      'Content-Security-Policy': PREVIEW_HTML_CSP,
    })
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    return new Response('not found', { status: 404 })
  }
  if (!stat.isFile()) return new Response('not a file', { status: 404 })
  if (stat.size > MAX_TRANSFORMED_HTML_BYTES) {
    return new Response('too large', { status: 413 })
  }

  const content = await fs.promises.readFile(target, 'utf8')
  const transformed = rewritePreviewHtml(content, previewHtmlBasePath(requestPathname))
  const transformedBytes = Buffer.byteLength(transformed)
  if (transformedBytes > MAX_TRANSFORMED_HTML_BYTES) {
    return new Response('too large', { status: 413 })
  }

  return new Response(transformed, {
    status: 200,
    headers: {
      'Content-Type': contentTypeForPath(target),
      'Content-Length': String(transformedBytes),
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': PREVIEW_HTML_CSP,
    },
  })
}

