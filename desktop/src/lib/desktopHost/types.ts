import type {
  AppMode as SettingsAppMode,
  AppModeConfig as SettingsAppModeConfig,
} from '../../types/settings'
import type { Locale } from '../../i18n/locale'

export type DesktopHostKind = 'browser' | 'electron'

export type DesktopHostCapability =
  | 'appMode'
  | 'clipboard'
  | 'dialogs'
  | 'notifications'
  | 'previewWebview'
  | 'shell'
  | 'terminal'
  | 'updates'
  | 'windowControls'
  | 'zoom'

export type DesktopHostCapabilities = Record<DesktopHostCapability, boolean>

export type DesktopHostUnlisten = () => void

export type DialogFileFilter = {
  name: string
  extensions: string[]
}

export type DialogOpenOptions = {
  directory?: boolean
  multiple?: boolean
  title?: string
  defaultPath?: string
  filters?: DialogFileFilter[]
}

export type DialogSaveOptions = {
  title?: string
  defaultPath?: string
  filters?: DialogFileFilter[]
}

/**
 * What the renderer settled on, reported to the native shell so the window
 * background and the OS-drawn chrome can match it.
 */
export type AppliedAppearance = {
  isDark: boolean
  /** Base background of the applied theme, as a CSS hex color. */
  background: string
  /**
   * Base background of the user's light theme, also as a hex color. Carried
   * separately so a shell that cached this at night knows which light theme to
   * repaint when it next starts in the morning.
   */
  lightBackground: string
  /** Whether the renderer is tracking the OS setting rather than a fixed pick. */
  followSystem: boolean
}

export type NotificationPermissionState = 'granted' | 'denied' | 'default'

export type DesktopNotificationOptions = {
  title: string
  body?: string
  icon?: string
  id?: number
  extra?: Record<string, unknown>
  target?: unknown
}

export type DesktopUpdateDownloadEvent =
  | {
      event: 'Started'
      data: {
        contentLength?: number | null
      }
    }
  | {
      event: 'Progress'
      data: {
        chunkLength: number
      }
    }
  | {
      event: 'Finished'
    }

export type DesktopUpdate = {
  version: string
  body?: string | null
  download(onEvent?: (event: DesktopUpdateDownloadEvent) => void): Promise<void>
  install(): Promise<void>
  close(): Promise<void>
}

export type DesktopUpdateCheckOptions = {
  proxy?: string
}

export type TerminalSpawnOptions = {
  cwd?: string
  cols: number
  rows: number
}

export type TerminalSession = {
  session_id: number
  shell: string
  cwd: string
}

export type TerminalOutputEvent = {
  session_id: number
  data: string
}

export type TerminalExitEvent = {
  session_id: number
  code: number
  signal?: string | null
}

export type LocalModelStartInput = {
  modelPath: string
  ctxSize: number
  threads: number
  nGpuLayers: string
  batchSize?: number
  cacheTypeK?: string
  cacheTypeV?: string
  flashAttn?: boolean
  temperature?: number
  topK?: number
  topP?: number
  minP?: number
  repeatPenalty?: number
  maxPredict?: number
  /** 自定义引擎目录（如官方 CUDA 版），留空用内置引擎 */
  engineDir?: string
  /** 多模态投影文件（mmproj），配了视觉模型才能看图；留空纯文本 */
  mmprojPath?: string
}

export type LocalModelStatus = {
  state: 'stopped' | 'starting' | 'running' | 'error'
  port: number | null
  modelPath: string | null
  error: string | null
  logTail: string
}

export type LocalModelHardware = {
  cpuCores: number
  memoryGB: number
  gpu: { name: string; vramMB: number } | null
}

export type LocalModelBenchmarkStep = {
  label: string
  usage: number
  ngl: string
  threads: number
  tgTokensPerSec: number
}

export type LocalModelBenchmarkInput = {
  modelPath: string
  ctxSize: number
  threads: number
}

export type LocalModelBenchmarkContextFit = {
  kvBytesPerToken: number | null
  kvCacheGB: number | null
  availableVramGB: number
  /** 物理内存（GB）——纯 CPU 模式下 KV 缓存落在内存，按它算预算 */
  availableRamGB: number
  /** GPU 探测是否可用；false 时 fits 按内存预算算 */
  gpuUsable: boolean
  fits: boolean
}

export type LocalModelBenchmarkOutput = {
  modelParamsB: number | null
  modelSizeMB: number | null
  ppTokensPerSec: number
  maxTgTokensPerSec: number
  steps: LocalModelBenchmarkStep[]
  recommendedStep: LocalModelBenchmarkStep | null
  contextFit: LocalModelBenchmarkContextFit
  /** 上下文太小装不下 Claude Code 的真实负载时给出警告 */
  contextTooSmall: boolean
  /** 硬件提示（非致命）：如 GPU 不可用已自动降级到 CPU */
  note: string | null
  /** 本机最终采用的运行方式：cpu = 纯 CPU，gpu = 显卡全量，hybrid = GPU+CPU 混合 */
  mode: 'cpu' | 'gpu' | 'hybrid'
  error: string | null
}

export type LocalModelBenchmarkProgress = {
  current: number
  total: number
  label: string
}

export type PreviewBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type PreviewEvent = {
  type: string
  payload?: unknown
}

export type PreviewCaptureMessage = {
  v: 1
  type: 'capture'
  kind: 'full'
}

export type PreviewPickerMessage = {
  v: 1
  type: 'enter-picker' | 'exit-picker'
}

export type PreviewHostMessage = PreviewCaptureMessage | PreviewPickerMessage

export type AppModeConfig = SettingsAppModeConfig

export type AppModeSetInput = {
  mode: SettingsAppMode
  portableDir: string | null
}

export type DesktopHost = {
  kind: DesktopHostKind
  isDesktop: boolean
  capabilities: DesktopHostCapabilities
  runtime: {
    getServerUrl(): Promise<string>
    getLocalAccessToken(): Promise<string | null>
  }
  app: {
    getVersion(): Promise<string>
    getLocalePreference(): Promise<Locale | null>
    setLocalePreference(locale: Locale): Promise<void>
    getPreferredSystemLanguages(): Promise<string[]>
    onLocaleChanged(handler: (locale: Locale) => void): Promise<DesktopHostUnlisten>
  }
  commands: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
  }
  files: {
    getPathForFile(file: File): string
  }
  events: {
    listen<T>(eventName: string, handler: (payload: T) => void): Promise<DesktopHostUnlisten>
  }
  webview: {
    onDragDropEvent(handler: (event: unknown) => void): Promise<DesktopHostUnlisten>
  }
  shell: {
    open(target: string): Promise<void>
    openPath(path: string): Promise<void>
  }
  trace?: {
    openWindow(sessionId: string): Promise<void>
  }
  dialogs: {
    open(options?: DialogOpenOptions): Promise<string | string[] | null>
    save(options?: DialogSaveOptions): Promise<string | null>
  }
  updates: {
    check(options?: DesktopUpdateCheckOptions): Promise<DesktopUpdate | null>
    prepareInstall(): Promise<void>
    cancelInstall(): Promise<void>
    relaunch(): Promise<void>
  }
  notifications: {
    permissionState(): Promise<NotificationPermissionState>
    requestPermission(): Promise<NotificationPermissionState>
    send(options: DesktopNotificationOptions): Promise<void>
    onAction(handler: (payload: unknown) => void): Promise<DesktopHostUnlisten>
    ackAction(payload: unknown): Promise<boolean>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    startDragging(): Promise<void>
    requestAttention(): Promise<void>
    focus(): Promise<void>
    isMaximized(): Promise<boolean>
    onResized(handler: () => void): Promise<DesktopHostUnlisten>
    onNativeMenuNavigate(handler: (destination: string) => void): Promise<DesktopHostUnlisten>
  }
  terminal: {
    spawn(options: TerminalSpawnOptions): Promise<TerminalSession>
    write(sessionId: number, data: string): Promise<void>
    resize(sessionId: number, cols: number, rows: number): Promise<void>
    kill(sessionId: number): Promise<void>
    onOutput(handler: (event: TerminalOutputEvent) => void): Promise<DesktopHostUnlisten>
    onExit(handler: (event: TerminalExitEvent) => void): Promise<DesktopHostUnlisten>
    getBashPath(): Promise<string | null>
    setBashPath(path: string | null): Promise<void>
  }
  preview: {
    open(url: string, bounds?: PreviewBounds): Promise<void>
    navigate(url: string): Promise<void>
    setBounds(bounds: PreviewBounds): Promise<void>
    setVisible(visible: boolean): Promise<void>
    setZoom(level: number): Promise<void>
    close(): Promise<void>
    message(payload: PreviewHostMessage): Promise<void>
    onEvent(handler: (event: unknown) => void): Promise<DesktopHostUnlisten>
  }
  appMode: {
    get(): Promise<AppModeConfig>
    set(config: AppModeSetInput): Promise<void>
    prepareRestart(): Promise<void>
    restart(): Promise<void>
  }
  adapters: {
    restartSidecar(): Promise<void>
  }
  localModel: {
    start(input: LocalModelStartInput): Promise<LocalModelStatus>
    stop(): Promise<void>
    status(): Promise<LocalModelStatus>
    detectHardware(): Promise<LocalModelHardware>
    benchmark(input: LocalModelBenchmarkInput): Promise<LocalModelBenchmarkOutput>
    onBenchmarkProgress(handler: (progress: LocalModelBenchmarkProgress) => void): Promise<DesktopHostUnlisten>
  }
  zoom: {
    set(level: number): Promise<void>
  }
  appearance: {
    setApplied(state: AppliedAppearance): Promise<void>
  }
}

declare global {
  interface Window {
    desktopHost?: DesktopHost
  }
}
