import React from 'react'
import ReactDOM from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './theme/globals.css'
import { initializeAppZoom } from './lib/appZoom'
import { initializeTouchH5 } from './lib/touchH5'
import { runDesktopPersistenceMigrations } from './lib/persistenceMigrations'
import { getDesktopHost } from './lib/desktopHost'
import { initializeLocale } from './i18n/locale'

declare global {
  interface Window {
    __CC_HEIHEI_BOOTSTRAPPED__?: boolean
    __CC_HEIHEI_SHOW_STARTUP_ERROR__?: (reason: unknown) => void
  }
}

type DesktopBootstrapModules = [
  { App: React.ComponentType },
  { ErrorBoundary: React.ComponentType<{ children: React.ReactNode }> },
  { installClientDiagnosticsCapture: () => void },
  { initializeTheme: () => void },
]

function loadDesktopBootstrapModules() {
  return Promise.all([
    import('./App'),
    import('./components/ErrorBoundary'),
    import('./lib/diagnosticsCapture'),
    import('./stores/uiStore'),
  ])
}

export async function bootstrapDesktopApp(
  root: HTMLElement | null = document.getElementById('root'),
  loadModules: () => Promise<DesktopBootstrapModules> = loadDesktopBootstrapModules,
) {
  try {
    await initializeLocale(getDesktopHost().app)
    const [{ App }, { ErrorBoundary }, { installClientDiagnosticsCapture }, { initializeTheme }] = await loadModules()
    initializeTheme()
    installClientDiagnosticsCapture()

    if (!root) {
      throw new Error('Desktop root element not found')
    }

    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    )
    window.__CC_HEIHEI_BOOTSTRAPPED__ = true
  } catch (error) {
    console.error('[desktop] Failed to bootstrap app', error)
    if (root) {
      if (window.__CC_HEIHEI_SHOW_STARTUP_ERROR__) {
        window.__CC_HEIHEI_SHOW_STARTUP_ERROR__(error)
      } else {
        // v1.7.1 P0：根崩溃屏无 React/i18n 上下文（ErrorState 不可用）——最小
        // 可行做法：双语静态标题给语境 + 原始错误串保留（结构化错误此处拿不到）。
        root.textContent = ''
        const heading = document.createElement('div')
        heading.textContent =
          '应用启动失败 — 以下为技术信息，可复制反馈 / Startup failed — technical details below'
        heading.style.cssText = 'font-weight:600;margin-bottom:8px'
        const body = document.createElement('pre')
        body.textContent = error instanceof Error ? error.message : String(error)
        body.style.cssText =
          'white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:12px;line-height:1.6;text-align:left;max-width:640px;margin:0'
        root.appendChild(heading)
        root.appendChild(body)
      }
    }
  }
}

runDesktopPersistenceMigrations()
initializeTouchH5()
void initializeAppZoom()

void bootstrapDesktopApp()
