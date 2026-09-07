/**
 * CORS middleware for desktop and temporary open H5 access.
 */

export function corsHeaders(origin?: string | null): Record<string, string> {
  const allowedOrigin = origin || 'http://localhost:3000'
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function baseCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export type CorsResolution = {
  allowed: boolean
  rejected: boolean
  headers: Record<string, string>
}

export type CorsResolutionOptions = {
  h5Enabled?: boolean
  isOriginAllowed?: (origin: string) => Promise<boolean>
}

/**
 * 额外视为"本地桌面"的源白名单。
 *
 * electron:dev 下渲染层从 vite dev server（ELECTRON_RENDERER_URL，如
 * http://localhost:1420）加载，带 http Origin 而非 file://；不放行的话，
 * 一旦配置了本地访问令牌，带 Origin 的请求会被 H5 访问策略当作浏览器
 * 页面拦截——而 CORS 预检（OPTIONS）无法携带令牌，必然失败，dev 模式
 * 全部 API 请求报 Failed to fetch。该变量仅由开发脚本注入并随 sidecar
 * env 继承；打包运行的普通用户没有它，行为不变。安全性不受影响：
 * 源必须精确匹配开发者自己配置的 dev server，其他 loopback 页面照旧被拦。
 */
type CachedLocalDesktopOrigins = { envUrl: string | undefined; origins: Set<string> }
let cachedLocalDesktopOrigins: CachedLocalDesktopOrigins | null = null

function getLocalDesktopOrigins(): Set<string> {
  const envUrl = process.env.ELECTRON_RENDERER_URL
  if (!cachedLocalDesktopOrigins || cachedLocalDesktopOrigins.envUrl !== envUrl) {
    const origins = new Set<string>(['file://'])
    if (envUrl) {
      try {
        const origin = new URL(envUrl).origin
        if (origin.startsWith('http')) origins.add(origin)
      } catch {
        // 非法的 ELECTRON_RENDERER_URL 直接忽略
      }
    }
    cachedLocalDesktopOrigins = { envUrl, origins }
  }
  return cachedLocalDesktopOrigins.origins
}

export function isLocalDesktopOrigin(origin: string | null): boolean {
  return getLocalDesktopOrigins().has(origin)
}

function isLocalOrigin(origin?: string | null): boolean {
  if (!origin) {
    return true
  }

  return isLocalDesktopOrigin(origin) || isLoopbackBrowserOrigin(origin)
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

  const hostname = parsed.hostname
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .toLowerCase()

  return hostname === 'localhost' || hostname === '::1' || isLoopbackIPv4(hostname)
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

export async function resolveCors(
  origin?: string | null,
  _requestOrigin?: string | null,
  options: CorsResolutionOptions = {},
): Promise<CorsResolution> {
  if (!origin) {
    return {
      allowed: true,
      rejected: false,
      headers: corsHeaders(origin),
    }
  }

  if (!options.h5Enabled || isLocalOrigin(origin)) {
    return {
      allowed: true,
      rejected: false,
      headers: {
        ...baseCorsHeaders(),
        'Access-Control-Allow-Origin': origin,
      },
    }
  }

  if (options.isOriginAllowed && await options.isOriginAllowed(origin)) {
    return {
      allowed: true,
      rejected: false,
      headers: {
        ...baseCorsHeaders(),
        'Access-Control-Allow-Origin': origin,
      },
    }
  }

  return {
    allowed: false,
    rejected: true,
    headers: baseCorsHeaders(),
  }
}
