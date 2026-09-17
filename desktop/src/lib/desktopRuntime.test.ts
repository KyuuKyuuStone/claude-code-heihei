import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  defaultBaseUrl: 'http://127.0.0.1:3456',
  explicitDefaultBaseUrl: false,
  setBaseUrl: vi.fn(),
  setAuthToken: vi.fn(),
}))

vi.mock('../api/client', () => ({
  getDefaultBaseUrl: () => clientMocks.defaultBaseUrl,
  hasExplicitDefaultBaseUrl: () => clientMocks.explicitDefaultBaseUrl,
  setAuthToken: clientMocks.setAuthToken,
  setBaseUrl: clientMocks.setBaseUrl,
}))

import {
  H5_SERVER_URL_STORAGE_KEY,
  initializeDesktopServerUrl,
  isDesktopRuntime,
  isLoopbackHostname,
} from './desktopRuntime'
import { browserHost } from './desktopHost/browserHost'

function healthOkResponse() {
  return Response.json({ status: 'ok' })
}

describe('desktopRuntime browser bootstrap', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    clientMocks.defaultBaseUrl = 'http://127.0.0.1:3456'
    clientMocks.explicitDefaultBaseUrl = false
    vi.useRealTimers()
    window.localStorage.clear()
    window.history.pushState({}, '', '/')
    Reflect.deleteProperty(window, 'desktopHost')
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it('treats IPv6 loopback as local', () => {
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('::1')).toBe(true)
    expect(isLoopbackHostname('127.0.1.1')).toBe(true)
    expect(isLoopbackHostname('127.example.com')).toBe(false)
    expect(isLoopbackHostname('127.bad.0.1')).toBe(false)
  })

  it('connects to a query-selected loopback server without any token', async () => {
    window.history.pushState({}, '', '/?serverUrl=http%3A%2F%2F%5B%3A%3A1%5D%3A3456')
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe('http://[::1]:3456')

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://[::1]:3456')
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
  })

  it('connects to a query-selected remote server directly, with no token flow', async () => {
    window.history.pushState({}, '', '/?serverUrl=https%3A%2F%2Fpublic.example.com%2Fapp')
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe('https://public.example.com/app')

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('https://public.example.com/app')
    // No client-side token gate: auth is the server's job (loopback trusted,
    // everything else rejected with its generic 403).
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(window.localStorage.getItem(H5_SERVER_URL_STORAGE_KEY)).toBe('https://public.example.com/app')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('uses the current browser origin when the shell is served by the desktop server', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe(window.location.origin)

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(window.location.origin)
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(globalThis.fetch).toHaveBeenCalledWith(`${window.location.origin}/health`, {
      cache: 'no-store',
    })
  })

  it('uses an injected desktop host server URL before browser fallback', async () => {
    const serverUrl = 'http://127.0.0.1:59231'
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      runtime: {
        getServerUrl: vi.fn().mockResolvedValue(serverUrl),
        getLocalAccessToken: vi.fn().mockResolvedValue('desktop-local-token'),
      },
    }
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe(serverUrl)

    expect(window.desktopHost.runtime.getServerUrl).toHaveBeenCalledTimes(1)
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(serverUrl)
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith('desktop-local-token')
    expect(globalThis.fetch).toHaveBeenCalledWith(`${serverUrl}/health`, {
      cache: 'no-store',
    })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('still starts when the desktop host cannot resolve the local access token', async () => {
    // The token only raises what the shell may do — loopback is trusted without
    // it — so losing it must degrade rather than block startup.
    const serverUrl = 'http://127.0.0.1:59232'
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      runtime: {
        getServerUrl: vi.fn().mockResolvedValue(serverUrl),
        getLocalAccessToken: vi.fn().mockRejectedValue(new Error('ipc channel missing')),
      },
    }
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe(serverUrl)

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(serverUrl)
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(consoleWarn).toHaveBeenCalled()

    consoleWarn.mockRestore()
  })

  it('classifies the runtime using the desktop host boundary', () => {
    expect(isDesktopRuntime()).toBe(false)

    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
    }

    expect(isDesktopRuntime()).toBe(true)
  })

  it('normalizes injected desktop host startup failures', async () => {
    const error = new Error('electron sidecar failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      runtime: {
        getServerUrl: vi.fn().mockRejectedValue(error),
        getLocalAccessToken: vi.fn().mockResolvedValue('desktop-local-token'),
      },
    }

    await expect(initializeDesktopServerUrl()).rejects.toThrow('electron sidecar failed')
    expect(consoleError).toHaveBeenCalledWith(
      '[desktop] Failed to initialize desktop server URL',
      error,
    )

    consoleError.mockRestore()
  })

  it('falls back to the default backend when a loopback dev origin serves a Vite SPA fallback', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn((input) => {
      if (String(input) === `${window.location.origin}/health`) {
        return Promise.resolve(new Response('<!doctype html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }))
      }
      return Promise.resolve(healthOkResponse())
    }) as typeof fetch

    const startup = expect(initializeDesktopServerUrl()).resolves.toBe('http://127.0.0.1:3456')
    await vi.runAllTimersAsync()

    await startup
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://127.0.0.1:3456')
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(globalThis.fetch).toHaveBeenCalledWith(`${window.location.origin}/health`, {
      cache: 'no-store',
    })
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:3456/health', {
      cache: 'no-store',
    })
  })

  it('does not fall back when an explicit Vite desktop server URL returns a SPA fallback', async () => {
    vi.useFakeTimers()
    clientMocks.defaultBaseUrl = 'http://127.0.0.1:55189'
    clientMocks.explicitDefaultBaseUrl = true
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<!doctype html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ) as typeof fetch

    const startup = expect(initializeDesktopServerUrl()).rejects.toThrow(
      'Server healthcheck failed: healthcheck returned non-JSON response from http://127.0.0.1:55189/health',
    )
    await vi.runAllTimersAsync()

    await startup
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://127.0.0.1:55189')
  })

  it('does not fall back from a loopback dev origin to a non-loopback default backend', async () => {
    vi.useFakeTimers()
    clientMocks.defaultBaseUrl = 'https://public.example.com'
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<!doctype html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ) as typeof fetch

    const startup = expect(initializeDesktopServerUrl()).rejects.toThrow(
      `Server healthcheck failed: healthcheck returned non-JSON response from ${window.location.origin}/health`,
    )
    await vi.runAllTimersAsync()

    await startup
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(window.location.origin)
  })

  it('does not fall back from a loopback dev origin to an invalid default backend', async () => {
    vi.useFakeTimers()
    clientMocks.defaultBaseUrl = 'not-a-url'
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<!doctype html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ) as typeof fetch

    const startup = expect(initializeDesktopServerUrl()).rejects.toThrow(
      `Server healthcheck failed: healthcheck returned non-JSON response from ${window.location.origin}/health`,
    )
    await vi.runAllTimersAsync()

    await startup
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(window.location.origin)
  })

  it('prefers an explicit Vite desktop server URL over the dev server origin', async () => {
    clientMocks.defaultBaseUrl = 'http://127.0.0.1:55189'
    clientMocks.explicitDefaultBaseUrl = true
    window.history.pushState({}, '', '/')
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe('http://127.0.0.1:55189')

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://127.0.0.1:55189')
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:55189/health', {
      cache: 'no-store',
    })
  })

  it('prefers an explicit Vite desktop server URL over a remembered server URL', async () => {
    clientMocks.defaultBaseUrl = 'http://127.0.0.1:55189'
    clientMocks.explicitDefaultBaseUrl = true
    window.history.pushState({}, '', '/')
    window.localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, 'http://192.168.0.102:3456')
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe('http://127.0.0.1:55189')

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://127.0.0.1:55189')
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
  })
})
