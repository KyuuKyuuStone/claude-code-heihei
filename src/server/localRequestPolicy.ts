/**
 * 本机请求策略 —— 判定请求是「本机受信」（桌面外壳/本机进程/loopback 页面）还是
 * 「远程」客户端，并据此决定受保护能力路径是否放行。
 *
 * 前身是「H5 访问特性」专用策略。该特性已整体删除（用户拍板），但其中
 * 「本机受信 vs 远程」判定与「远程一律拒绝」的拦截**必须保留**——那是服务端唯一的
 * 非本机访问边界（服务默认监听 0.0.0.0）。故本模块收窄保留该部分。
 */

export type RequestKind = 'local-trusted' | 'internal-sdk' | 'remote'
export type RequestContext = {
  clientAddress: string | null
  localAccessTokenConfigured?: boolean
  localAccessAuthorized?: boolean
  internalSdkAuthorized?: boolean
}

// 与 cors.ts 的本地桌面源白名单保持同一份（含 dev 模式渲染层源，见
// cors.ts 中 getLocalDesktopOrigins 的注释）
import { isLocalDesktopOrigin } from './middleware/cors.js'
const PROXY_TRACE_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'via',
] as const
const PREVIEW_STATIC_DESTINATIONS = new Set([
  'audio',
  'font',
  'image',
  'manifest',
  'script',
  'style',
  'track',
  'video',
  'worker',
])
const PREVIEW_REFERER_PARENT_EXTENSIONS = new Set([
  '.css',
  '.cjs',
  '.js',
  '.mjs',
])

export function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHost(normalized.slice('::ffff:'.length))
  }
  return normalized === 'localhost' || normalized === '::1' || isLoopbackIPv4(normalized)
}

function isLoopbackIPv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts[0] !== '127') {
    return false
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false
    }

    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

function isLoopbackBrowserOrigin(origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return false
  }

  return isLoopbackHost(parsed.hostname)
}

function pathnameDirectory(pathname: string): string {
  const slash = pathname.lastIndexOf('/')
  return slash < 0 ? '/' : pathname.slice(0, slash + 1)
}

function pathnameExtension(pathname: string): string {
  const fileName = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = fileName.lastIndexOf('.')
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase()
}

function filesystemCapabilityScope(pathname: string): {
  kind: 'preview-fs' | 'local-file'
  root: string
} | null {
  if (pathname.startsWith('/preview-fs/')) {
    const sessionEnd = pathname.indexOf('/', '/preview-fs/'.length)
    if (sessionEnd < 0) return null
    return {
      kind: 'preview-fs',
      root: pathname.slice(0, sessionEnd + 1),
    }
  }
  if (pathname.startsWith('/local-file/')) {
    return { kind: 'local-file', root: '/local-file/' }
  }
  return null
}

/**
 * Preview HTML is sandboxed but keeps its server origin so module scripts,
 * styles, fonts and media can load. Trust only passive/static resource loads
 * that stay below the referring document's filesystem directory. Ordinary
 * fetch/XHR, navigations and every non-filesystem capability remain outside
 * this exception.
 */
function isSameOriginFilesystemAsset(
  request: Request,
  url: URL,
  origin: string | null,
): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  if (request.headers.get('Sec-Fetch-Site') !== 'same-origin') return false
  if (!PREVIEW_STATIC_DESTINATIONS.has(request.headers.get('Sec-Fetch-Dest') ?? '')) {
    return false
  }
  let refererUrl: URL
  try {
    refererUrl = new URL(request.headers.get('Referer') ?? '')
  } catch {
    return false
  }
  if (refererUrl.origin !== url.origin) return false
  if (origin) {
    try {
      if (new URL(origin).origin !== url.origin) return false
    } catch {
      return false
    }
  }

  const requestScope = filesystemCapabilityScope(url.pathname)
  const refererScope = filesystemCapabilityScope(refererUrl.pathname)
  if (
    !requestScope ||
    !refererScope ||
    requestScope.kind !== refererScope.kind ||
    requestScope.root !== refererScope.root
  ) {
    return false
  }

  const refererDirectory = pathnameDirectory(refererUrl.pathname)
  if (url.pathname.startsWith(refererDirectory)) return true

  // A stylesheet or module may load a sibling fonts/chunks directory. Permit
  // one parent only for those nested dependency referrers; the HTML entry
  // point itself never receives this broader scope.
  if (!PREVIEW_REFERER_PARENT_EXTENSIONS.has(pathnameExtension(refererUrl.pathname))) {
    return false
  }
  const parentDirectory = pathnameDirectory(refererDirectory.slice(0, -1))
  return parentDirectory.startsWith(requestScope.root) &&
    url.pathname.startsWith(parentDirectory)
}

/**
 * A cross-site subresource load (`<img>`, `<script>`, `no-cors` fetch) reaches
 * us without an `Origin` header, so it would otherwise be indistinguishable
 * from a genuine local navigation. Fetch Metadata is what tells them apart:
 * a top-level navigation carries `Sec-Fetch-Mode: navigate`, a subresource
 * does not. Clients that send no Fetch Metadata at all (curl, adapters, the
 * CLI subprocess) stay trusted — they are not a browser CSRF vector.
 */
function isCrossSiteSubresource(headers: Headers): boolean {
  const site = headers.get('Sec-Fetch-Site')
  if (site !== 'cross-site' && site !== 'same-site') {
    return false
  }

  const mode = headers.get('Sec-Fetch-Mode')
  return mode !== null && mode !== 'navigate'
}

function isLocalDesktopOrNavigationOrigin(
  request: Request,
  origin: string | null,
  context: RequestContext,
): boolean {
  if (!origin) return !isCrossSiteSubresource(request.headers)
  if (isLocalDesktopOrigin(origin)) return true

  // A configured process credential distinguishes the Electron renderer from
  // arbitrary pages served by another loopback process. Keep tokenless
  // navigation, OAuth callbacks and CLI/adapters working above, but never
  // grant an Origin-bearing browser page that credential by locality alone.
  if (context.localAccessTokenConfigured) return false

  return isLoopbackBrowserOrigin(origin)
}

function hasProxyTraceHeaders(headers: Headers): boolean {
  return PROXY_TRACE_HEADERS.some((header) => headers.has(header))
}

function isLocalTrustedRequest(
  request: Request,
  url: URL,
  context: RequestContext,
  origin: string | null,
): boolean {
  // The process token the desktop shell injects is the strongest credential we
  // have: it identifies the app's own components (renderer, adapters, the CLI
  // subprocess) regardless of how they reach us.
  if (context.localAccessAuthorized === true) return true
  if (isSameOriginFilesystemAsset(request, url, origin)) return true
  if (
    filesystemCapabilityScope(url.pathname) &&
    request.headers.get('Sec-Fetch-Site') === 'same-origin' &&
    PREVIEW_STATIC_DESTINATIONS.has(request.headers.get('Sec-Fetch-Dest') ?? '')
  ) {
    // Classic scripts, styles and images often omit Origin. Once Fetch
    // Metadata identifies a browser filesystem subresource, it must satisfy
    // the same Referer capability/directory boundary above instead of falling
    // back to broad loopback trust.
    return false
  }

  // Its *absence* must not demote loopback, though. Plenty of legitimate local
  // traffic can never carry that token — the OAuth success page the system
  // browser opens, `/preview-fs` links, a `curl` against the local API. Gating
  // loopback behind the token turned all of those into 401/403 (issue: "Missing
  // access token" on the local OAuth success page). Loopback stays trusted
  // on its own; the Host, proxy-trace and Origin checks below are what keep a
  // remote client from claiming it.
  const clientAddress = context.clientAddress
  if (!clientAddress) return false
  if (hasProxyTraceHeaders(request.headers)) return false

  return isLoopbackHost(clientAddress) &&
    isLoopbackHost(url.hostname) &&
    isLocalDesktopOrNavigationOrigin(request, origin, context)
}

function isFilesystemCapabilityPath(pathname: string): boolean {
  return pathname.startsWith('/local-file/') ||
    pathname.startsWith('/preview-fs/')
}

export function classifyRequest(
  request: Request,
  url: URL,
  context: RequestContext,
): RequestKind {
  const origin = request.headers.get('Origin')
  const localTrusted = isLocalTrustedRequest(request, url, context, origin)
  if (isFilesystemCapabilityPath(url.pathname)) {
    return localTrusted ? 'local-trusted' : 'remote'
  }

  if (url.pathname.startsWith('/sdk/') && (localTrusted || context.internalSdkAuthorized)) {
    return 'internal-sdk'
  }

  if (localTrusted) {
    return 'local-trusted'
  }

  return 'remote'
}

/**
 * 远程（非本机受信）客户端访问受保护能力路径 → 拒绝。
 *
 * 这是服务端唯一的非本机访问边界：服务默认监听 0.0.0.0，桌面外壳 / 本机进程 /
 * loopback 页面之外的一律拒绝。`explicitAuthRequired`（部署侧 SERVER_AUTH_REQUIRED
 * 或 authRequired）打开时不拦——那时改走通用令牌鉴权（原行为，保留）。
 */
export function shouldBlockRemoteAccess({
  request,
  url,
  explicitAuthRequired,
  context,
}: {
  request: Request
  url: URL
  explicitAuthRequired: boolean
  context: RequestContext
}): boolean {
  if (explicitAuthRequired) {
    return false
  }

  if (!isProtectedCapabilityPath(url.pathname)) {
    return false
  }

  return classifyRequest(request, url, context) === 'remote'
}

function isProtectedCapabilityPath(pathname: string): boolean {
  return pathname.startsWith('/api/') ||
    isFilesystemCapabilityPath(pathname) ||
    pathname.startsWith('/proxy/') ||
    pathname.startsWith('/ws/') ||
    pathname.startsWith('/sdk/')
}
