import {
  getBaseUrl,
  getDefaultBaseUrl,
  hasExplicitDefaultBaseUrl,
  setAuthToken,
  setBaseUrl,
} from '../api/client'
import { getDesktopHost } from './desktopHost'

// 键值兼容保留、勿改：老版本 H5 流程写过的 localStorage 条目仍按此键读取，
// 改名会让既有浏览器会话丢失记忆的服务地址（值本身不含 token 语义）。
export const H5_SERVER_URL_STORAGE_KEY = 'cc-heihei-h5-server-url'

function getDetectedDesktopHost() {
  return getDesktopHost()
}

/**
 * Server-readiness signal.
 *
 * The api client points at the default base URL until `initializeDesktopServerUrl`
 * resolves the real (dynamic) server URL and confirms `/health`. Background pollers
 * that fire on app mount (e.g. scheduled-task desktop notifications) must wait for
 * this, otherwise their first requests hit an uninitialized base URL and fail with
 * `TypeError: Failed to fetch` — a benign startup race that nonetheless pollutes the
 * diagnostics panel with `client_api_request_failed` warnings.
 */
let resolveServerReady: (() => void) | null = null
let serverReadyPromise: Promise<void> | null = null

/** Resolve once the desktop/browser server URL is initialized and healthy. */
export function whenDesktopServerReady(): Promise<void> {
  if (!serverReadyPromise) {
    serverReadyPromise = new Promise<void>((resolve) => {
      resolveServerReady = resolve
    })
  }
  return serverReadyPromise
}

function markDesktopServerReady() {
  whenDesktopServerReady() // ensure the promise exists before resolving it
  resolveServerReady?.()
}

export function isDesktopRuntime() {
  return getDetectedDesktopHost().isDesktop
}

/**
 * Synchronously return the running local server's base URL (e.g.
 * `http://127.0.0.1:<port>`).
 *
 * The api client caches the resolved base after startup: `initializeDesktopServerUrl`
 * calls `invoke('get_server_url')` (desktop) or resolves a browser URL, then
 * `setBaseUrl(...)`. Until that runs, `getBaseUrl()` returns the default
 * (`http://127.0.0.1:3456` or `VITE_DESKTOP_SERVER_URL`).
 */
export function getServerBaseUrl(): string {
  return getBaseUrl()
}

export async function initializeDesktopServerUrl() {
  const fallbackUrl = getDefaultBaseUrl()
  const host = getDetectedDesktopHost()

  if (!host.isDesktop) {
    return initializeBrowserServerUrl(fallbackUrl)
  }

  try {
    const [serverUrl, localAccessToken] = await Promise.all([
      host.runtime.getServerUrl(),
      // The process token only *raises* what the shell may do; loopback is
      // trusted without it. Losing it must not take the whole app down with it.
      host.runtime.getLocalAccessToken().catch((error) => {
        console.warn('[desktop] local access token unavailable, continuing on loopback trust', error)
        return null
      }),
    ])
    setBaseUrl(serverUrl)
    setAuthToken(localAccessToken)
    await waitForHealth(serverUrl)
    markDesktopServerReady()
    return serverUrl
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `desktop server startup failed: ${String(error)}`
    console.error('[desktop] Failed to initialize desktop server URL', error)
    throw new Error(message || `desktop server startup failed (fallback would be ${fallbackUrl})`)
  }
}

async function initializeBrowserServerUrl(fallbackUrl: string) {
  const query = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : null
  const queryUrl = query?.get('serverUrl') ?? null
  const storedServerUrl = readStoredServerUrl()
  const configuredUrl = getConfiguredBrowserServerUrl(fallbackUrl)
  const sameOriginUrl = getSameOriginServerUrl()
  const requestedUrl =
    normalizeServerUrl(queryUrl) ??
    configuredUrl ??
    storedServerUrl ??
    fallbackUrl
  const requestedImplicitSameOrigin =
    !queryUrl &&
    !hasExplicitDefaultBaseUrl() &&
    !!sameOriginUrl &&
    requestedUrl === sameOriginUrl

  // Browser clients carry no token: the server trusts loopback and rejects
  // anything else with its generic auth, so there is no client-side gate here.
  setBaseUrl(requestedUrl)
  setAuthToken(null)
  try {
    await waitForHealth(requestedUrl)
  } catch (error) {
    if (shouldFallbackFromLoopbackDevOrigin({
      error,
      requestedUrl,
      fallbackUrl,
      requestedImplicitSameOrigin,
    })) {
      setBaseUrl(fallbackUrl)
      setAuthToken(null)
      await waitForHealth(fallbackUrl)
      markDesktopServerReady()
      return fallbackUrl
    }
    throw error
  }

  rememberStoredServerUrl(requestedUrl)
  markDesktopServerReady()
  return requestedUrl
}

async function waitForHealth(serverUrl: string) {
  let lastError: unknown

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${serverUrl}/health`, {
        cache: 'no-store',
      })
      if (response.ok) {
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.toLowerCase().includes('application/json')) {
          lastError = new Error(`healthcheck returned non-JSON response from ${serverUrl}/health`)
          break
        } else {
          const body = await response.json().catch(() => null)
          if (body && typeof body === 'object' && 'status' in body && body.status === 'ok') {
            return
          }
          lastError = new Error(`healthcheck returned invalid response from ${serverUrl}/health`)
        }
      } else {
        lastError = new Error(`healthcheck returned ${response.status}`)
      }
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(
    lastError instanceof Error
      ? `Server healthcheck failed: ${lastError.message}`
      : 'Server healthcheck failed',
  )
}

function normalizeServerUrl(value: string | null | undefined) {
  const trimmed = value?.trim()
  if (!trimmed) return null

  try {
    return new URL(trimmed).toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function getSameOriginServerUrl() {
  if (typeof window === 'undefined') {
    return null
  }

  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
    return null
  }

  return normalizeServerUrl(window.location.origin)
}

function getConfiguredBrowserServerUrl(fallbackUrl: string) {
  if (hasExplicitDefaultBaseUrl()) {
    return normalizeServerUrl(fallbackUrl)
  }

  return getSameOriginServerUrl()
}

function shouldFallbackFromLoopbackDevOrigin({
  error,
  requestedUrl,
  fallbackUrl,
  requestedImplicitSameOrigin,
}: {
  error: unknown
  requestedUrl: string
  fallbackUrl: string
  requestedImplicitSameOrigin: boolean
}) {
  if (!requestedImplicitSameOrigin || requestedUrl === fallbackUrl) {
    return false
  }

  if (!isLoopbackServerUrl(requestedUrl) || !isLoopbackServerUrl(fallbackUrl)) {
    return false
  }

  return error instanceof Error &&
    error.message.includes('healthcheck returned non-JSON response')
}

export function isLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || isLoopbackIPv4(normalized)
}

function isLoopbackServerUrl(serverUrl: string) {
  try {
    return isLoopbackHostname(new URL(serverUrl).hostname)
  } catch {
    return false
  }
}

function isLoopbackIPv4(hostname: string) {
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

function readStoredServerUrl() {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return normalizeServerUrl(window.localStorage.getItem(H5_SERVER_URL_STORAGE_KEY))
  } catch {
    return null
  }
}

function rememberStoredServerUrl(serverUrl: string) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, serverUrl)
  } catch {
    // Ignore storage failures.
  }
}
