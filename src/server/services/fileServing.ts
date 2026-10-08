/**
 * 文件直传（G2 B-c 批从 api/previewFs.ts 下沉 L2）。
 *
 * 动机：api/localFile.ts 需要 `serveFileWithRange`，而 api 同层互相 import 触发
 * `layer-L4-no-same-layer`。这里放**纯文件服务**（内容类型判定 / Range 解析 / 流式响应），
 * 不含任何路由或会话解析 ⇒ api/previewFs.ts 与 api/localFile.ts 都向下引用。
 *
 * `PREVIEW_HTML_CSP` 也在此（previewFs 的 HTML 改写路径仍要用它；本模块内它是
 * serveFileWithRange 的响应头来源，故一并下沉并导出供 previewFs 引用）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  // Video — served inline via <video> with HTTP byte-range streaming.
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  // Audio.
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
}
export function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}
/**
 * The general 2 GiB limit applies only to files streamed through `Bun.file`.
 * HTML documents are transformed before serving and therefore use a much
 * smaller independent memory bound.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
export const PREVIEW_HTML_CSP = [
  'sandbox allow-scripts allow-same-origin allow-modals allow-downloads allow-popups',
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')
export interface ParsedRange {
  start: number
  end: number
}
/**
 * Parse a single HTTP `Range` header against a known file `size`.
 *
 * Supports the common single-range forms:
 *   - `bytes=start-end`  (explicit closed range)
 *   - `bytes=start-`     (open-ended → to EOF)
 *   - `bytes=-N`         (suffix → last N bytes)
 *
 * Returns inclusive `{ start, end }` byte offsets clamped to `[0, size-1]`,
 * `null` when the header is absent/unparseable (caller should fall back to a
 * full 200 response), or `'unsatisfiable'` when the range cannot be satisfied
 * (caller should reply 416). Multi-range requests (comma-separated) are not
 * supported and fall back to a full response.
 */
export function parseRange(
  rangeHeader: string | null | undefined,
  size: number,
): ParsedRange | null | 'unsatisfiable' {
  if (!rangeHeader) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) return null

  const startRaw = match[1]
  const endRaw = match[2]

  // `bytes=-N` suffix form: the last N bytes.
  if (startRaw === '') {
    if (endRaw === '') return null // `bytes=-` is malformed → ignore.
    const suffixLen = Number(endRaw)
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return 'unsatisfiable'
    if (size === 0) return 'unsatisfiable'
    const start = Math.max(0, size - suffixLen)
    return { start, end: size - 1 }
  }

  const start = Number(startRaw)
  if (!Number.isFinite(start)) return null

  // start beyond EOF is unsatisfiable.
  if (start >= size) return 'unsatisfiable'

  let end: number
  if (endRaw === '') {
    end = size - 1 // open-ended → EOF
  } else {
    end = Number(endRaw)
    if (!Number.isFinite(end)) return null
    if (end < start) return 'unsatisfiable'
    end = Math.min(end, size - 1) // clamp to EOF
  }

  return { start, end }
}
/**
 * Stream a single resolved absolute file as an HTTP response, honouring a
 * `Range` header (206 partial / 416 unsatisfiable) and falling back to a full
 * 200 otherwise. The body is streamed straight from disk via `Bun.file(...)`,
 * never buffered into memory, so this is safe for large media.
 *
 * Callers are responsible for any path-sandboxing BEFORE invoking this — it
 * trusts `target` to already be authorised. It returns 404 when the path is
 * missing or not a regular file, and 413 above {@link MAX_FILE_BYTES}.
 */
export async function serveFileWithRange(
  target: string,
  reqHeaders?: Headers,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const responseHeaders = (
    ['.html', '.htm'].includes(path.extname(target).toLowerCase())
      ? { 'Content-Security-Policy': PREVIEW_HTML_CSP, ...extraHeaders }
      : extraHeaders
  )
  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    return new Response('not found', { status: 404 })
  }
  if (!stat.isFile()) return new Response('not a file', { status: 404 })
  if (stat.size > MAX_FILE_BYTES) return new Response('too large', { status: 413 })

  const size = stat.size
  const contentType = contentTypeForPath(target)
  // Stream straight from disk via Bun.file — never buffer whole media into
  // memory. Bun's file blob is an acceptable Response body.
  const file = Bun.file(target)

  const range = parseRange(reqHeaders?.get('range'), size)

  if (range === 'unsatisfiable') {
    return new Response('range not satisfiable', {
      status: 416,
      headers: {
        'Content-Range': `bytes */${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        ...responseHeaders,
      },
    })
  }

  if (range) {
    const { start, end } = range
    // `slice(start, end + 1)` — Bun's slice end is exclusive, range end is
    // inclusive — streams just the requested window.
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Cache-Control': 'no-cache',
        ...responseHeaders,
      },
    })
  }

  // No (or unparseable) Range header → stream the whole file as 200.
  return new Response(file, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      ...responseHeaders,
    },
  })
}
