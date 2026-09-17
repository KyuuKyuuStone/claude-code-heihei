import { create } from 'zustand'
import { settingsApi } from '../api/settings'
import { modelsApi } from '../api/models'
import { tracesApi } from '../api/traces'
import {
  type AppMode,
  type AppModeConfig,
  type ChatSendBehavior,
  type DesktopTerminalSettings,
  type DesktopTerminalStartupShell,
  type NetworkSettings,
  type OutputStyleOption,
  type OutputStylesResponse,
  type PermissionMode,
  type EffortLevel,
  type ModelInfo,
  type ThemeMode,
  type UpdateProxyMode,
  type UpdateProxySettings,
  type WebSearchSettings,
} from '../types/settings'
import type { TraceCaptureSettings } from '../types/trace'
import { getDesktopHost } from '../lib/desktopHost'
import type { Locale } from '../i18n'
import {
  APP_ZOOM_CONTROL_STEP,
  DEFAULT_APP_ZOOM,
  MAX_APP_ZOOM,
  MIN_APP_ZOOM,
  applyAppZoomLevel,
  normalizeAppZoomLevel,
  readStoredAppZoomLevel,
} from '../lib/appZoom'
import { useUIStore } from './uiStore'
import {
  applyDocumentLocale,
  getInitialLocale,
  LOCALE_STORAGE_KEY,
  subscribeLocaleChanges,
} from '../i18n/locale'

export const UI_ZOOM_MIN = MIN_APP_ZOOM
export const UI_ZOOM_MAX = MAX_APP_ZOOM
export const UI_ZOOM_STEP = APP_ZOOM_CONTROL_STEP
export const UI_ZOOM_DEFAULT = DEFAULT_APP_ZOOM
let desktopNotificationsSaveQueue: Promise<void> = Promise.resolve()

type SettingsStore = {
  permissionMode: PermissionMode
  currentModel: ModelInfo | null
  effortLevel: EffortLevel
  thinkingEnabled: boolean
  autoDreamEnabled: boolean
  autoModeOptInAccepted: boolean
  availableModels: ModelInfo[]
  activeProviderName: string | null
  locale: Locale
  // No `theme` here on purpose: uiStore owns it. A copy in this store went
  // stale the moment the OS flipped the appearance without going through
  // setTheme, and the Settings picker highlighted a theme that was no longer
  // on screen. Read `useUIStore(s => s.theme)` instead.
  chatSendBehavior: ChatSendBehavior
  outputStyle: string
  outputStyles: OutputStyleOption[]
  outputStyleScope: OutputStylesResponse['scope']
  outputStyleWorkDir: string | null
  outputStylesLoading: boolean
  outputStyleError: string | null
  skipWebFetchPreflight: boolean
  desktopNotificationsEnabled: boolean
  desktopTerminal: DesktopTerminalSettings
  webSearch: WebSearchSettings
  updateProxy: UpdateProxySettings
  network: NetworkSettings
  traceCapture: TraceCaptureSettings
  responseLanguage: string
  uiZoom: number
  isLoading: boolean
  error: string | null

  appMode: AppModeConfig
  appModeRequiresRestart: boolean

  fetchAll: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setModel: (modelId: string) => Promise<void>
  setEffort: (level: EffortLevel) => Promise<void>
  setThinkingEnabled: (enabled: boolean) => Promise<void>
  setAutoDreamEnabled: (enabled: boolean) => Promise<void>
  acceptAutoModeOptIn: () => Promise<void>
  setLocale: (locale: Locale) => void
  setTheme: (theme: ThemeMode) => Promise<void>
  setChatSendBehavior: (behavior: ChatSendBehavior) => Promise<void>
  fetchOutputStyles: (workDir?: string | null) => Promise<void>
  setOutputStyle: (outputStyle: string, workDir?: string | null) => Promise<void>
  setSkipWebFetchPreflight: (enabled: boolean) => Promise<void>
  setDesktopNotificationsEnabled: (enabled: boolean) => Promise<void>
  setDesktopTerminal: (settings: DesktopTerminalSettings) => Promise<void>
  setWebSearch: (settings: WebSearchSettings) => Promise<void>
  setUpdateProxy: (settings: UpdateProxySettings) => Promise<void>
  setNetwork: (settings: NetworkSettings) => Promise<void>
  setTraceCaptureEnabled: (enabled: boolean) => Promise<void>
  setResponseLanguage: (language: string) => Promise<void>
  fetchAppMode: () => Promise<void>
  setAppMode: (mode: AppMode, portableDir?: string | null) => Promise<void>
  setUiZoom: (zoom: number) => void
}

type NetworkSettingsInput = Partial<Omit<NetworkSettings, 'proxy'>> & {
  proxy?: Partial<NetworkSettings['proxy']>
}

const DEFAULT_DESKTOP_TERMINAL_SETTINGS: DesktopTerminalSettings = {
  startupShell: 'system',
  customShellPath: '',
}
let desktopTerminalSaveQueue: Promise<void> = Promise.resolve()
let desktopTerminalSaveVersion = 0
let lastPersistedDesktopTerminal = DEFAULT_DESKTOP_TERMINAL_SETTINGS

const DEFAULT_UPDATE_PROXY_SETTINGS: UpdateProxySettings = {
  mode: 'system',
  url: '',
}

const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  aiRequestTimeoutMs: 600_000,
  proxy: {
    mode: 'system',
    url: '',
  },
}

const DEFAULT_OUTPUT_STYLE = 'default'
const DEFAULT_OUTPUT_STYLE_OPTIONS: OutputStyleOption[] = [
  {
    value: DEFAULT_OUTPUT_STYLE,
    label: 'Default',
    description: 'Claude completes coding tasks efficiently and provides concise responses',
    source: 'built-in',
  },
]

const DEFAULT_TRACE_CAPTURE_SETTINGS: TraceCaptureSettings = {
  enabled: true,
  storageDir: '',
}

const initialLocale = getInitialLocale()
applyDocumentLocale(initialLocale)

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  permissionMode: 'default',
  currentModel: null,
  effortLevel: 'max',
  thinkingEnabled: true,
  autoDreamEnabled: false,
  autoModeOptInAccepted: false,
  availableModels: [],
  activeProviderName: null,
  locale: initialLocale,
  chatSendBehavior: 'enter',
  outputStyle: DEFAULT_OUTPUT_STYLE,
  outputStyles: DEFAULT_OUTPUT_STYLE_OPTIONS,
  outputStyleScope: 'userSettings',
  outputStyleWorkDir: null,
  outputStylesLoading: false,
  outputStyleError: null,
  skipWebFetchPreflight: true,
  desktopNotificationsEnabled: false,
  desktopTerminal: DEFAULT_DESKTOP_TERMINAL_SETTINGS,
  webSearch: { mode: 'auto', tavilyApiKey: '', braveApiKey: '' },
  updateProxy: DEFAULT_UPDATE_PROXY_SETTINGS,
  network: DEFAULT_NETWORK_SETTINGS,
  traceCapture: DEFAULT_TRACE_CAPTURE_SETTINGS,
  responseLanguage: '',
  uiZoom: readStoredAppZoomLevel(),
  isLoading: false,
  error: null,

  appMode: {
    mode: 'default',
    portableDir: null,
    activeConfigDir: null,
    configDirSource: 'system',
  },
  appModeRequiresRestart: false,
  setUiZoom: (zoom: number) => {
    const level = normalizeAppZoomLevel(zoom)
    set({ uiZoom: level })
    void applyAppZoomLevel(level)
  },

  fetchAll: async () => {
    set({ isLoading: true, error: null })
    try {
      const [{ mode }, modelsRes, { model }, { level }, userSettings, traceCapture] = await Promise.all([
        settingsApi.getPermissionMode(),
        modelsApi.list(),
        modelsApi.getCurrent(),
        modelsApi.getEffort(),
        settingsApi.getUser(),
        loadTraceCaptureSettings(),
      ])
      const desktopTerminal = normalizeDesktopTerminalSettings(userSettings.desktopTerminal)
      lastPersistedDesktopTerminal = desktopTerminal
      // Nothing to do for the theme here: uiStore already applied it at
      // startup, and re-applying would re-persist and re-report it on every
      // provider switch.
      set({
        permissionMode: mode,
        // 服务端响应异常可能缺 models 字段,兜底为空数组防止下游渲染崩溃
        availableModels: modelsRes.models ?? [],
        activeProviderName: modelsRes.provider?.name ?? null,
        currentModel: model,
        effortLevel: level,
        thinkingEnabled: userSettings.alwaysThinkingEnabled !== false,
        autoDreamEnabled: userSettings.autoDreamEnabled === true,
        autoModeOptInAccepted: userSettings.skipAutoPermissionPrompt === true,
        chatSendBehavior: normalizeChatSendBehavior(userSettings.chatSendBehavior),
        outputStyle: normalizeOutputStyle(userSettings.outputStyle),
        skipWebFetchPreflight: userSettings.skipWebFetchPreflight !== false,
        desktopNotificationsEnabled: userSettings.desktopNotificationsEnabled === true,
        desktopTerminal,
        webSearch: normalizeWebSearchSettings(userSettings.webSearch),
        updateProxy: normalizeUpdateProxySettings(userSettings.updateProxy),
        network: normalizeNetworkSettings(userSettings.network),
        traceCapture,
        responseLanguage: typeof userSettings.language === 'string' ? userSettings.language : '',
        isLoading: false,
        error: null,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load desktop settings'
      set({ isLoading: false, error: message })
      throw error
    }
  },

  setPermissionMode: async (mode) => {
    const prev = get().permissionMode
    set({ permissionMode: mode })
    try {
      await settingsApi.setPermissionMode(mode)
    } catch {
      set({ permissionMode: prev })
    }
  },

  setModel: async (modelId) => {
    await modelsApi.setCurrent(modelId)
    const { model } = await modelsApi.getCurrent()
    set({ currentModel: model })
  },

  setEffort: async (level) => {
    const prev = get().effortLevel
    set({ effortLevel: level })
    try {
      await modelsApi.setEffort(level)
    } catch {
      set({ effortLevel: prev })
    }
  },

  setThinkingEnabled: async (enabled) => {
    const prev = get().thinkingEnabled
    set({ thinkingEnabled: enabled })
    try {
      await settingsApi.updateUser({ alwaysThinkingEnabled: enabled })
    } catch {
      set({ thinkingEnabled: prev })
    }
  },

  setAutoDreamEnabled: async (enabled) => {
    const prev = get().autoDreamEnabled
    set({ autoDreamEnabled: enabled })
    try {
      await settingsApi.updateUser({ autoDreamEnabled: enabled })
    } catch (error) {
      set({ autoDreamEnabled: prev })
      throw error
    }
  },

  acceptAutoModeOptIn: async () => {
    const previous = get().autoModeOptInAccepted
    set({ autoModeOptInAccepted: true })
    try {
      await settingsApi.updateUser({ skipAutoPermissionPrompt: true })
    } catch (error) {
      set({ autoModeOptInAccepted: previous })
      throw error
    }
  },

  setLocale: (locale) => {
    set({ locale })
    applyDocumentLocale(locale)
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* noop */ }
    void getDesktopHost().app.setLocalePreference(locale).catch((error) => {
      console.error('[desktop] Failed to persist locale preference', error)
    })
  },

  // Kept as the Settings page's entry point; uiStore owns the state.
  setTheme: async (theme) => {
    useUIStore.getState().setTheme(theme)
  },

  setChatSendBehavior: async (behavior) => {
    const prev = get().chatSendBehavior
    const next = normalizeChatSendBehavior(behavior)
    set({ chatSendBehavior: next })
    try {
      await settingsApi.updateUser({ chatSendBehavior: next })
    } catch (error) {
      set({ chatSendBehavior: prev })
      throw error
    }
  },

  fetchOutputStyles: async (workDir) => {
    set({ outputStylesLoading: true, outputStyleError: null })
    try {
      const response = await settingsApi.getOutputStyles(workDir)
      set({
        outputStyle: normalizeOutputStyle(response.outputStyle),
        outputStyles: normalizeOutputStyleOptions(response.styles),
        outputStyleScope: response.scope,
        outputStyleWorkDir: response.workDir,
        outputStylesLoading: false,
        outputStyleError: null,
      })
    } catch (error) {
      set({
        outputStylesLoading: false,
        outputStyleError: getErrorMessage(error, 'Failed to load output styles.'),
      })
      throw error
    }
  },

  setOutputStyle: async (outputStyle, workDir) => {
    const prev = {
      outputStyle: get().outputStyle,
      outputStyleScope: get().outputStyleScope,
      outputStyleWorkDir: get().outputStyleWorkDir,
      outputStyleError: get().outputStyleError,
    }
    set({
      outputStyle,
      outputStyleError: null,
    })
    try {
      const result = await settingsApi.setOutputStyle(outputStyle, workDir)
      set({
        outputStyle: normalizeOutputStyle(result.outputStyle),
        outputStyleScope: result.scope,
        outputStyleWorkDir: result.workDir,
        outputStyleError: null,
      })
    } catch (error) {
      set({
        outputStyle: prev.outputStyle,
        outputStyleScope: prev.outputStyleScope,
        outputStyleWorkDir: prev.outputStyleWorkDir,
        outputStyleError: getErrorMessage(error, 'Failed to save output style.'),
      })
      throw error
    }
  },

  setSkipWebFetchPreflight: async (enabled) => {
    const prev = get().skipWebFetchPreflight
    set({ skipWebFetchPreflight: enabled })
    try {
      await settingsApi.updateUser({ skipWebFetchPreflight: enabled })
    } catch {
      set({ skipWebFetchPreflight: prev })
    }
  },

  setDesktopNotificationsEnabled: async (enabled) => {
    const prev = get().desktopNotificationsEnabled
    set({ desktopNotificationsEnabled: enabled })
    const save = desktopNotificationsSaveQueue
      .catch(() => undefined)
      .then(async () => {
        if (get().desktopNotificationsEnabled !== enabled) return
        await settingsApi.updateUser({ desktopNotificationsEnabled: enabled })
      })

    desktopNotificationsSaveQueue = save

    try {
      await save
    } catch {
      if (get().desktopNotificationsEnabled === enabled) {
        set({ desktopNotificationsEnabled: prev })
      }
    }
  },

  setDesktopTerminal: async (settings) => {
    const next = normalizeDesktopTerminalSettings(settings)
    const saveVersion = ++desktopTerminalSaveVersion
    set({ desktopTerminal: next })
    const save = desktopTerminalSaveQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await settingsApi.updateUser({ desktopTerminal: next })
          lastPersistedDesktopTerminal = next
        } catch (error) {
          if (saveVersion === desktopTerminalSaveVersion) {
            set({ desktopTerminal: lastPersistedDesktopTerminal })
          }
          throw error
        }
      })

    desktopTerminalSaveQueue = save
    await save
  },

  setWebSearch: async (webSearch) => {
    const prev = get().webSearch
    const next = normalizeWebSearchSettings(webSearch)
    set({ webSearch: next })
    try {
      await settingsApi.updateUser({ webSearch: next })
    } catch {
      set({ webSearch: prev })
    }
  },

  setUpdateProxy: async (settings) => {
    const prev = get().updateProxy
    const next = normalizeUpdateProxySettings(settings)
    set({ updateProxy: next })
    try {
      await settingsApi.updateUser({ updateProxy: next })
    } catch (error) {
      set({ updateProxy: prev })
      throw error
    }
  },

  setNetwork: async (settings) => {
    const prev = get().network
    const next = normalizeNetworkSettings(settings)
    set({ network: next })
    try {
      await settingsApi.updateUser({ network: next })
    } catch (error) {
      set({ network: prev })
      throw error
    }
  },

  setTraceCaptureEnabled: async (enabled) => {
    const prev = get().traceCapture
    set({ traceCapture: { ...prev, enabled } })
    try {
      const next = await tracesApi.updateSettings({ enabled })
      set({ traceCapture: normalizeTraceCaptureSettings(next) })
    } catch (error) {
      set({ traceCapture: prev })
      throw error
    }
  },

  setResponseLanguage: async (language) => {
    const prev = get().responseLanguage
    set({ responseLanguage: language })
    try {
      await settingsApi.updateUser({ language: language || undefined })
    } catch {
      set({ responseLanguage: prev })
    }
  },

  fetchAppMode: async () => {
    const host = getDesktopHost()
    if (!host.isDesktop) return
    try {
      const result: AppModeConfig = await host.appMode.get()
      set({ appMode: result })
    } catch { /* silently ignore - not in Tauri or command unavailable */ }
  },

  setAppMode: async (mode, portableDir) => {
    const host = getDesktopHost()
    if (!host.isDesktop) return
    const prev = get().appMode
    const selectedCustomDir = mode === 'portable' ? portableDir?.trim() || null : null
    if (mode === 'portable' && !selectedCustomDir) {
      throw new Error('Choose an absolute custom data directory')
    }
    const newMode: AppModeConfig = {
      ...prev,
      mode,
      portableDir: selectedCustomDir,
    }
    set({ appMode: newMode, appModeRequiresRestart: true })
    try {
      await host.appMode.set({
        mode,
        portableDir: newMode.portableDir || null,
      })
    } catch (error) {
      set({ appMode: prev, appModeRequiresRestart: false })
      throw error
    }
  },
}))

subscribeLocaleChanges((locale) => {
  useSettingsStore.setState({ locale })
  applyDocumentLocale(locale)
})

function normalizeWebSearchSettings(settings: WebSearchSettings | undefined): WebSearchSettings {
  return {
    mode: settings?.mode ?? 'auto',
    tavilyApiKey: settings?.tavilyApiKey ?? '',
    braveApiKey: settings?.braveApiKey ?? '',
  }
}

function normalizeChatSendBehavior(value: unknown): ChatSendBehavior {
  return value === 'modifierEnter' ? 'modifierEnter' : 'enter'
}

function normalizeOutputStyle(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : DEFAULT_OUTPUT_STYLE
}

function normalizeOutputStyleOptions(styles: OutputStyleOption[] | undefined): OutputStyleOption[] {
  if (!Array.isArray(styles) || styles.length === 0) return DEFAULT_OUTPUT_STYLE_OPTIONS
  const normalized = styles
    .filter((style): style is OutputStyleOption =>
      typeof style?.value === 'string' &&
      style.value.trim().length > 0 &&
      typeof style.label === 'string' &&
      typeof style.description === 'string',
    )
    .map(style => ({
      ...style,
      value: style.value.trim(),
      label: style.label.trim() || style.value.trim(),
      description: style.description.trim(),
    }))
  return normalized.length > 0 ? normalized : DEFAULT_OUTPUT_STYLE_OPTIONS
}

function isUpdateProxyMode(value: unknown): value is UpdateProxyMode {
  return value === 'system' || value === 'manual'
}

function normalizeUpdateProxySettings(
  settings: Partial<UpdateProxySettings> | undefined,
): UpdateProxySettings {
  const mode = isUpdateProxyMode(settings?.mode)
    ? settings.mode
    : DEFAULT_UPDATE_PROXY_SETTINGS.mode
  return {
    mode,
    url: typeof settings?.url === 'string' ? settings.url.trim() : '',
  }
}

function normalizeNetworkSettings(
  settings: NetworkSettingsInput | undefined,
): NetworkSettings {
  const timeout = typeof settings?.aiRequestTimeoutMs === 'number' && Number.isFinite(settings.aiRequestTimeoutMs)
    ? Math.min(Math.max(Math.round(settings.aiRequestTimeoutMs), 30_000), 1_800_000)
    : DEFAULT_NETWORK_SETTINGS.aiRequestTimeoutMs
  const proxyMode = settings?.proxy?.mode === 'manual'
    ? 'manual'
    : settings?.proxy?.mode === 'direct'
      ? 'direct'
      : 'system'

  return {
    aiRequestTimeoutMs: timeout,
    proxy: {
      mode: proxyMode,
      url: proxyMode === 'manual' && typeof settings?.proxy?.url === 'string'
        ? settings.proxy.url.trim()
        : '',
    },
  }
}

function normalizeTraceCaptureSettings(
  settings: TraceCaptureSettings | undefined,
): TraceCaptureSettings {
  return {
    enabled: settings?.enabled !== false,
    storageDir: typeof settings?.storageDir === 'string' ? settings.storageDir : '',
  }
}

function normalizeDesktopTerminalSettings(
  settings: Partial<DesktopTerminalSettings> | undefined,
): DesktopTerminalSettings {
  const startupShell = isDesktopTerminalStartupShell(settings?.startupShell)
    ? settings.startupShell
    : DEFAULT_DESKTOP_TERMINAL_SETTINGS.startupShell

  return {
    startupShell,
    customShellPath: typeof settings?.customShellPath === 'string'
      ? settings.customShellPath
      : DEFAULT_DESKTOP_TERMINAL_SETTINGS.customShellPath,
  }
}

async function loadTraceCaptureSettings(): Promise<TraceCaptureSettings> {
  try {
    return normalizeTraceCaptureSettings(await tracesApi.getSettings())
  } catch {
    return DEFAULT_TRACE_CAPTURE_SETTINGS
  }
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

function isDesktopTerminalStartupShell(value: unknown): value is DesktopTerminalStartupShell {
  return value === 'system'
    || value === 'pwsh'
    || value === 'powershell'
    || value === 'cmd'
    || value === 'custom'
}
