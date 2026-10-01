import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { RotateCw } from 'lucide-react'
import { useSettingsStore, UI_ZOOM_DEFAULT, UI_ZOOM_MIN, UI_ZOOM_MAX, UI_ZOOM_STEP } from '../stores/settingsStore'
import { useTranslation, type TranslationKey } from '../i18n'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import {
  SettingsPageHeader,
  SettingsPill,
  SettingsSection,
} from '@/components/settings/SettingsSection'
import { Dropdown } from '@/components/ui/Dropdown'
import { Switch } from '@/components/ui/Switch'
import { PermissionModeSelector } from '../components/controls/PermissionModeSelector'
import { isDarkThemeMode, isLightThemeMode } from '../types/settings'
import type { ThemeMode, UpdateProxyMode, NetworkProxyMode, WebSearchMode, AppMode, ChatSendBehavior, OutputStyleSource } from '../types/settings'
import type { Locale } from '../i18n'
import { useSessionStore } from '../stores/sessionStore'
import { MarkdownRenderer } from '../components/markdown/MarkdownRenderer'
import { useSkillStore } from '../stores/skillStore'
import { SkillList } from '../components/skills/SkillList'
import { SkillDetail } from '../components/skills/SkillDetail'
import { usePluginStore } from '../stores/pluginStore'
import { PluginList } from '../components/plugins/PluginList'
import { PluginDetail } from '../components/plugins/PluginDetail'
import { ComputerUseSettings } from './ComputerUseSettings'
import { McpSettings } from './McpSettings'
import { TerminalSettings } from './TerminalSettings'
import { DiagnosticsSettings } from './DiagnosticsSettings'
import { TraceList } from './TraceList'
import { ActivitySettings } from './ActivitySettings'
import { LocalModelSettings } from './LocalModelSettings'
import { MemorySettings } from './MemorySettings'
import { useUIStore } from '../stores/uiStore'
import { AgentManager } from '../components/settings/AgentManager'
import { useUpdateStore } from '../stores/updateStore'
import { formatBytes } from '../lib/formatBytes'
import { isDesktopRuntime } from '../lib/desktopRuntime'
import { getDesktopHost } from '../lib/desktopHost'
import { publicAssetPath } from '../lib/publicAsset'
import { BrandSeal } from '../components/composite/BrandSeal'
import {
  getDesktopNotificationPermission,
  notifyDesktop,
  getDesktopNotificationPlatform,
  openDesktopNotificationSettings,
  requestDesktopNotificationPermission,
  type DesktopNotificationPermission,
} from '../lib/desktopNotifications'
import { ProviderSettings } from './settings/ProvidersSettings'
import { SETTINGS_CHECKBOX_INPUT_CLASS, SettingsCheckboxMark } from './settings/settingsShared'

const NETWORK_TIMEOUT_MIN_SECONDS = 30
const NETWORK_TIMEOUT_MAX_SECONDS = 1800
const NETWORK_TIMEOUT_STEP_SECONDS = 30
const BUILT_IN_OUTPUT_STYLE_TRANSLATION_KEYS = {
  default: {
    label: 'settings.general.outputStyleBuiltin.default.label',
    description: 'settings.general.outputStyleBuiltin.default.description',
  },
  Explanatory: {
    label: 'settings.general.outputStyleBuiltin.explanatory.label',
    description: 'settings.general.outputStyleBuiltin.explanatory.description',
  },
  Learning: {
    label: 'settings.general.outputStyleBuiltin.learning.label',
    description: 'settings.general.outputStyleBuiltin.learning.description',
  },
} satisfies Record<string, { label: TranslationKey; description: TranslationKey }>

export function Settings() {
  const activeTab = useUIStore((s) => s.activeSettingsTab)
  const setActiveTab = useUIStore((s) => s.setActiveSettingsTab)
  const pendingSettingsTab = useUIStore((s) => s.pendingSettingsTab)
  const t = useTranslation()

  useEffect(() => {
    if (!pendingSettingsTab) return
    setActiveTab(pendingSettingsTab)
    useUIStore.getState().setPendingSettingsTab(null)
  }, [pendingSettingsTab, setActiveTab])

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--color-surface)]">
      <div className="flex-1 flex overflow-hidden">
        {/* Tab navigation */}
        {/* Narrow enough that the rail is not a gutter of dead space, wide
            enough that the longest label in any locale — the Japanese
            "コンピューター操作" — still clears the truncation on TabButton.

            Paper, separated by the rule, the way every other secondary panel
            in the app is (the workbench, the diff split). It used to be
            `--color-surface-container-low`, which is the same value the tab
            strip's trough resolves to — so the Settings tab, the one tab whose
            content this rail *is*, was the only selected tab in the app whose
            paper fill met a different colour at its bottom edge. It read as a
            white card stranded on a grey panel. Nothing else changed to fix
            it: the tab is right, this was the odd one out. */}
        <div className="w-[220px] flex-shrink-0 flex flex-col overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-4">
          <div className="flex-1 flex flex-col gap-0.5">
            <TabButton icon="dns" label={t('settings.tab.providers')} active={activeTab === 'providers'} onClick={() => setActiveTab('providers')} />
            <TabButton icon="memory" label={t('settings.tab.localModel')} active={activeTab === 'localModel'} onClick={() => setActiveTab('localModel')} />
            <TabButton icon="tune" label={t('settings.tab.general')} active={activeTab === 'general'} onClick={() => setActiveTab('general')} />
            <TabButton icon="terminal" label={t('settings.tab.terminal')} active={activeTab === 'terminal'} onClick={() => setActiveTab('terminal')} />
            <TabButton icon="dns" label={t('settings.tab.mcp')} active={activeTab === 'mcp'} onClick={() => setActiveTab('mcp')} />
            <TabButton icon="smart_toy" label={t('settings.tab.agents')} active={activeTab === 'agents'} onClick={() => setActiveTab('agents')} />
            <TabButton icon="auto_awesome" label={t('settings.tab.skills')} active={activeTab === 'skills'} onClick={() => setActiveTab('skills')} />
            <TabButton icon="history_edu" label={t('settings.tab.memory')} active={activeTab === 'memory'} onClick={() => setActiveTab('memory')} />
            <TabButton icon="extension" label={t('settings.tab.plugins')} active={activeTab === 'plugins'} onClick={() => setActiveTab('plugins')} />
            <TabButton icon="mouse" label={t('settings.tab.computerUse')} active={activeTab === 'computerUse'} onClick={() => setActiveTab('computerUse')} />
            <TabButton icon="monitoring" label={t('settings.tab.activity')} active={activeTab === 'activity'} onClick={() => setActiveTab('activity')} />
            <TabButton icon="account_tree" label={t('settings.tab.trace')} active={activeTab === 'trace'} onClick={() => setActiveTab('trace')} />
            <TabButton icon="monitor_heart" label={t('settings.tab.diagnostics')} active={activeTab === 'diagnostics'} onClick={() => setActiveTab('diagnostics')} />
          </div>
          <div className="mt-2 border-t border-[var(--color-border-separator)] pt-2">
            <TabButton icon="info" label={t('settings.tab.about')} active={activeTab === 'about'} onClick={() => setActiveTab('about')} />
          </div>
        </div>

        {/* Tab content; trace embeds a full-bleed page that manages its own scroll */}
        <div className={activeTab === 'trace' ? 'flex-1 flex min-h-0 flex-col overflow-hidden' : 'flex-1 overflow-y-auto px-9 py-8'}>
          {activeTab === 'providers' && <ProviderSettings />}
          {activeTab === 'localModel' && <LocalModelSettings />}
          {activeTab === 'activity' && <ActivitySettings />}
          {activeTab === 'general' && <GeneralSettings />}
          {activeTab === 'terminal' && <TerminalSettings showPreferences />}
          {activeTab === 'mcp' && <McpSettings />}
          {activeTab === 'agents' && <AgentManager />}
          {activeTab === 'skills' && <SkillSettings />}
          {activeTab === 'memory' && <MemorySettings />}
          {activeTab === 'plugins' && <PluginSettings />}
          {activeTab === 'computerUse' && <ComputerUseSettings />}
          {activeTab === 'trace' && <TraceList />}
          {activeTab === 'diagnostics' && <DiagnosticsSettings />}
          {activeTab === 'about' && <AboutSettings />}
        </div>
      </div>
    </div>
  )
}

function TabButton({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)

  // The rail is taller than its viewport, and Settings remounts whenever the
  // tab is re-entered — from a trace tab's "back to list", say — with the
  // scroll position reset to the top. Without this the selected section can be
  // highlighted somewhere off-screen. `nearest` is a no-op when already visible.
  useEffect(() => {
    if (!active) return
    ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  return (
    <button
      ref={ref}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      // `ring-offset` has to name the rail's own fill — it is painted, not
      // transparent, so it tracks whatever the rail is.
      className={`w-full flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-[13.5px] text-left transition-[background-color,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] ${
        active
          ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      <span
        className={`material-symbols-outlined text-[18px] ${active ? 'text-[var(--color-brand)]' : 'text-[var(--color-text-tertiary)]'}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

// ─── General Settings ──────────────────────────────────────

export function GeneralSettings() {
  const {
    thinkingEnabled,
    setThinkingEnabled,
    permissionMode,
    setPermissionMode,
    autoDreamEnabled,
    setAutoDreamEnabled,
    locale,
    setLocale,
    setTheme,
    chatSendBehavior,
    setChatSendBehavior,
    outputStyle,
    outputStyles,
    outputStyleScope,
    outputStylesLoading,
    outputStyleError,
    fetchOutputStyles,
    setOutputStyle,
    skipWebFetchPreflight,
    setSkipWebFetchPreflight,
    desktopNotificationsEnabled,
    setDesktopNotificationsEnabled,
    webSearch,
    setWebSearch,
    network,
    setNetwork,
    traceCapture,
    setTraceCaptureEnabled,
    responseLanguage,
    setResponseLanguage,
    appMode,
    appModeRequiresRestart,
    fetchAppMode,
    setAppMode: setAppModeAction,
    uiZoom,
    setUiZoom,
  } = useSettingsStore()
  // Read the theme from the store that owns it. settingsStore keeps a copy for
  // its own consumers, but that copy is only refreshed on an explicit setTheme
  // — an OS flip updates uiStore alone and would leave this picker highlighting
  // a theme that is no longer on screen.
  const theme = useUIStore((s) => s.theme)
  const followSystemTheme = useUIStore((s) => s.followSystemTheme)
  const lightTheme = useUIStore((s) => s.lightTheme)
  const darkTheme = useUIStore((s) => s.darkTheme)
  const setFollowSystemTheme = useUIStore((s) => s.setFollowSystemTheme)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const t = useTranslation()
  const [webSearchDraft, setWebSearchDraft] = useState(webSearch)
  const [networkDraft, setNetworkDraft] = useState(network)
  const [networkTimeoutInput, setNetworkTimeoutInput] = useState(String(Math.round(network.aiRequestTimeoutMs / 1000)))
  const [networkSaveError, setNetworkSaveError] = useState<string | null>(null)
  const [isSavingNetwork, setIsSavingNetwork] = useState(false)
  const [notificationPermission, setNotificationPermission] = useState<DesktopNotificationPermission>('default')
  const [notificationActionRunning, setNotificationActionRunning] = useState(false)
  const [autoDreamConfirmOpen, setAutoDreamConfirmOpen] = useState(false)
  const [autoDreamActionRunning, setAutoDreamActionRunning] = useState(false)
  const [modeSwitchConfirmOpen, setModeSwitchConfirmOpen] = useState(false)
  const [pendingMode, setPendingMode] = useState<AppMode | null>(null)
  const [pendingPortableDir, setPendingPortableDir] = useState<string | null>(null)
  const [portableDirDraft, setPortableDirDraft] = useState('')
  const [modeActionRunning, setModeActionRunning] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)
  const [uiZoomDraft, setUiZoomDraft] = useState(uiZoom)
  const [isUiZoomDragging, setIsUiZoomDragging] = useState(false)
  const isUiZoomDraggingRef = useRef(false)
  const addToast = useUIStore((s) => s.addToast)
  const webSearchDirty = JSON.stringify(webSearchDraft) !== JSON.stringify(webSearch)
  const uiZoomPercent = Math.round(uiZoomDraft * 100)
  const uiZoomRangeProgress = `${Math.round(((uiZoomDraft - UI_ZOOM_MIN) / (UI_ZOOM_MAX - UI_ZOOM_MIN)) * 1000) / 10}%`
  const activeConfigDir = appMode.activeConfigDir ?? (appMode.mode === 'portable' ? appMode.portableDir : null)
  const configDirSource = appMode.configDirSource ?? (appMode.mode === 'portable' ? 'portable' : 'system')
  const isEnvironmentConfigDir = configDirSource === 'environment'
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  )
  const outputStyleWorkDir =
    activeSession?.workDirExists === false
      ? null
      : activeSession?.workDir ?? activeSession?.projectRoot ?? null

  useEffect(() => {
    setWebSearchDraft(webSearch)
  }, [webSearch])

  useEffect(() => {
    void fetchOutputStyles(outputStyleWorkDir)
  }, [fetchOutputStyles, outputStyleWorkDir])

  useEffect(() => {
    setNetworkDraft(network)
    setNetworkTimeoutInput(String(Math.round(network.aiRequestTimeoutMs / 1000)))
    setNetworkSaveError(null)
  }, [network])

  useEffect(() => {
    if (!isUiZoomDragging) {
      setUiZoomDraft(uiZoom)
    }
  }, [isUiZoomDragging, uiZoom])

  useEffect(() => {
    let cancelled = false
    getDesktopNotificationPermission().then((permission) => {
      if (!cancelled) setNotificationPermission(permission)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isDesktopRuntime()) return
    void fetchAppMode()
  }, [fetchAppMode])

  useEffect(() => {
    setPortableDirDraft(appMode.portableDir ?? '')
  }, [appMode.portableDir])

  const LANGUAGES: Array<{ value: Locale; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '简体中文' },
    { value: 'zh-TW', label: '繁體中文' },
    { value: 'jp', label: '日本語' },
    { value: 'kr', label: '한국어' },
  ]


  const RESPONSE_LANGUAGES: Array<{ value: string; label: string }> = [
    { value: '', label: t('settings.general.responseLangDefault') },
    { value: 'english', label: 'English' },
    { value: 'chinese', label: '中文 (Chinese)' },
    { value: 'japanese', label: '日本語 (Japanese)' },
    { value: 'korean', label: '한국어 (Korean)' },
    { value: 'spanish', label: 'Español (Spanish)' },
    { value: 'french', label: 'Français (French)' },
    { value: 'german', label: 'Deutsch (German)' },
    { value: 'portuguese', label: 'Português (Portuguese)' },
    { value: 'italian', label: 'Italiano (Italian)' },
    { value: 'russian', label: 'Русский (Russian)' },
    { value: 'dutch', label: 'Nederlands (Dutch)' },
    { value: 'polish', label: 'Polski (Polish)' },
    { value: 'turkish', label: 'Türkçe (Turkish)' },
    { value: 'hindi', label: 'हिन्दी (Hindi)' },
    { value: 'indonesian', label: 'Bahasa Indonesia' },
    { value: 'ukrainian', label: 'Українська (Ukrainian)' },
    { value: 'greek', label: 'Ελληνικά (Greek)' },
    { value: 'czech', label: 'Čeština (Czech)' },
    { value: 'danish', label: 'Dansk (Danish)' },
    { value: 'swedish', label: 'Svenska (Swedish)' },
    { value: 'norwegian', label: 'Norsk (Norwegian)' },
  ]
  const selectedResponseLanguageLabel =
    RESPONSE_LANGUAGES.find(({ value }) => value === responseLanguage)?.label ?? RESPONSE_LANGUAGES[0]!.label
  const outputStyleItems = outputStyles.map((style) => ({
    value: style.value,
    label: getOutputStyleLabel(style, t),
    description: `${getOutputStyleDescription(style, t)} · ${getOutputStyleSourceLabel(style.source, t)}`,
  }))
  const selectedOutputStyle =
    outputStyles.find((style) => style.value === outputStyle) ?? outputStyles[0]
  const selectedOutputStyleLabel = selectedOutputStyle
    ? getOutputStyleLabel(selectedOutputStyle, t)
    : outputStyle
  const selectedOutputStyleDescription = selectedOutputStyle
    ? getOutputStyleDescription(selectedOutputStyle, t)
    : ''
  const outputStyleScopeLabel = outputStyleScope === 'localSettings'
    ? t('settings.general.outputStyleScopeLocal')
    : t('settings.general.outputStyleScopeUser')
  const outputStyleScopeHint = outputStyleScope === 'localSettings'
    ? t('settings.general.outputStyleScopeLocalHint')
    : t('settings.general.outputStyleScopeUserHint')

  const THEMES: Array<{ value: ThemeMode; label: string }> = [
    { value: 'white', label: t('settings.general.appearance.white') },
    { value: 'paper', label: t('settings.general.appearance.paper') },
    { value: 'warm-classic', label: t('settings.general.appearance.warmClassic') },
    { value: 'celadon', label: t('settings.general.appearance.celadon') },
    { value: 'dark', label: t('settings.general.appearance.dark') },
    { value: 'ink-blue', label: t('settings.general.appearance.inkBlue') },
  ]
  // Split by ground, in the order THEMES already lists them, so the two rows
  // shown while following the system stay consistent with the flat picker.
  const LIGHT_THEMES = THEMES.filter(({ value }) => isLightThemeMode(value))
  const DARK_THEMES = THEMES.filter(({ value }) => isDarkThemeMode(value))

  const WEB_SEARCH_MODES: Array<{ value: WebSearchMode; label: string }> = [
    { value: 'auto', label: t('settings.general.webSearch.mode.auto') },
    { value: 'tavily', label: t('settings.general.webSearch.mode.tavily') },
    { value: 'brave', label: t('settings.general.webSearch.mode.brave') },
    { value: 'anthropic', label: t('settings.general.webSearch.mode.anthropic') },
    { value: 'disabled', label: t('settings.general.webSearch.mode.disabled') },
  ]

  const NETWORK_PROXY_MODES: Array<{ value: NetworkProxyMode; label: string; description: string }> = [
    {
      value: 'direct',
      label: t('settings.general.networkProxyModeDirect'),
      description: t('settings.general.networkProxyModeDirectDescription'),
    },
    {
      value: 'system',
      label: t('settings.general.networkProxyModeSystem'),
      description: t('settings.general.networkProxyModeSystemDescription'),
    },
    {
      value: 'manual',
      label: t('settings.general.networkProxyModeManual'),
      description: t('settings.general.networkProxyModeManualDescription'),
    },
  ]

  const CHAT_SEND_BEHAVIORS: Array<{ value: ChatSendBehavior; label: string; description: string }> = [
    {
      value: 'enter',
      label: t('settings.general.chatSendBehaviorEnter'),
      description: t('settings.general.chatSendBehaviorEnterDescription'),
    },
    {
      value: 'modifierEnter',
      label: t('settings.general.chatSendBehaviorModifier'),
      description: t('settings.general.chatSendBehaviorModifierDescription'),
    },
  ]

  const notificationStatusLabel: Record<DesktopNotificationPermission, string> = {
    granted: t('settings.general.notificationsStatusGranted'),
    denied: t('settings.general.notificationsStatusDenied'),
    default: t('settings.general.notificationsStatusDefault'),
    unsupported: t('settings.general.notificationsStatusUnsupported'),
  }

  const handleDesktopNotificationsToggle = async (enabled: boolean) => {
    await setDesktopNotificationsEnabled(enabled)
    if (!enabled) return

    setNotificationActionRunning(true)
    try {
      const permission = await requestDesktopNotificationPermission()
      setNotificationPermission(permission)
      if (permission === 'granted' && getDesktopNotificationPlatform() !== 'win32') {
        void notifyDesktop({
          title: t('settings.general.notificationsTestTitle'),
          body: t('settings.general.notificationsTestBody'),
        })
      }
    } finally {
      setNotificationActionRunning(false)
    }
  }

  const handleAutoDreamToggle = (enabled: boolean) => {
    if (enabled) {
      setAutoDreamConfirmOpen(true)
      return
    }
    void setAutoDreamEnabled(false)
  }

  const confirmAutoDreamEnable = async () => {
    setAutoDreamActionRunning(true)
    try {
      await setAutoDreamEnabled(true)
      setAutoDreamConfirmOpen(false)
    } finally {
      setAutoDreamActionRunning(false)
    }
  }

  const handleNotificationPermissionAction = async () => {
    setNotificationActionRunning(true)
    try {
      if (notificationPermission === 'denied') {
        await openDesktopNotificationSettings()
      } else {
        const permission = await requestDesktopNotificationPermission()
        setNotificationPermission(permission)
        if (permission === 'granted') {
          void notifyDesktop({
            title: t('settings.general.notificationsTestTitle'),
            body: t('settings.general.notificationsTestBody'),
          })
        }
        if (permission === 'denied') {
          await openDesktopNotificationSettings()
        }
      }
    } finally {
      setNotificationActionRunning(false)
    }
  }

  const networkProxyUrl = networkDraft.proxy.url.trim()
  const networkProxyError =
    networkDraft.proxy.mode === 'manual' && !networkProxyUrl
      ? t('settings.general.networkProxyUrlRequired')
      : networkDraft.proxy.mode === 'manual' && !isValidHttpProxyUrl(networkProxyUrl)
        ? t('settings.general.networkProxyUrlInvalid')
        : null
  const timeoutSeconds = Math.round(networkDraft.aiRequestTimeoutMs / 1000)
  const parsedNetworkTimeoutSeconds = (() => {
    const trimmed = networkTimeoutInput.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const seconds = Number(trimmed)
    if (!Number.isFinite(seconds) || seconds < NETWORK_TIMEOUT_MIN_SECONDS || seconds > NETWORK_TIMEOUT_MAX_SECONDS) return null
    return seconds
  })()
  const networkTimeoutError =
    networkTimeoutInput.trim().length === 0
      ? t('settings.general.networkTimeoutRequired')
      : parsedNetworkTimeoutSeconds === null
        ? t('settings.general.networkTimeoutRange', {
            min: String(NETWORK_TIMEOUT_MIN_SECONDS),
            max: String(NETWORK_TIMEOUT_MAX_SECONDS),
          })
        : null
  const networkDirty =
    networkDraft.aiRequestTimeoutMs !== network.aiRequestTimeoutMs ||
    networkDraft.proxy.mode !== network.proxy.mode ||
    networkDraft.proxy.url.trim() !== network.proxy.url.trim()

  const setNetworkTimeoutSeconds = (seconds: number) => {
    const nextSeconds = Math.min(Math.max(Math.round(seconds), NETWORK_TIMEOUT_MIN_SECONDS), NETWORK_TIMEOUT_MAX_SECONDS)
    setNetworkTimeoutInput(String(nextSeconds))
    setNetworkDraft((current) => ({
      ...current,
      aiRequestTimeoutMs: nextSeconds * 1000,
    }))
    setNetworkSaveError(null)
  }

  const saveNetworkSettings = async () => {
    if (networkProxyError) {
      setNetworkSaveError(networkProxyError)
      return
    }
    if (networkTimeoutError || parsedNetworkTimeoutSeconds === null) {
      setNetworkSaveError(networkTimeoutError ?? t('settings.general.networkTimeoutRange', {
        min: String(NETWORK_TIMEOUT_MIN_SECONDS),
        max: String(NETWORK_TIMEOUT_MAX_SECONDS),
      }))
      return
    }

    setIsSavingNetwork(true)
    setNetworkSaveError(null)
    try {
      await setNetwork({
        aiRequestTimeoutMs: parsedNetworkTimeoutSeconds * 1000,
        proxy: {
          mode: networkDraft.proxy.mode,
          url: networkDraft.proxy.mode === 'manual' ? networkProxyUrl : '',
        },
      })
      addToast({
        type: 'success',
        message: t('settings.general.networkSaved'),
      })
    } catch (error) {
      setNetworkSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingNetwork(false)
    }
  }

  const handleOutputStyleChange = async (value: string) => {
    try {
      await setOutputStyle(value, outputStyleWorkDir)
      addToast({
        type: 'success',
        message: t('settings.general.outputStyleSaved'),
      })
    } catch {
      // The store exposes outputStyleError below; keep the interaction local.
    }
  }

  const openPortableDirPicker = async () => {
    setModeError(null)
    const host = getDesktopHost()
    if (!host.capabilities.dialogs) {
      setModeError(t('settings.general.storagePickerError'))
      return
    }
    try {
      const selected = await host.dialogs.open({
        directory: true,
        multiple: false,
        title: t('settings.general.storageChooseDirTitle'),
      })
      if (typeof selected === 'string') {
        setPortableDirDraft(selected)
      }
    } catch {
      setModeError(t('settings.general.storagePickerError'))
    }
  }

  const openModeSwitchConfirm = (mode: AppMode) => {
    if (isEnvironmentConfigDir) {
      setModeError(t('settings.general.storageEnvironmentSwitchBlocked'))
      return
    }

    const portableDir = portableDirDraft.trim()
    if (mode === 'portable' && !portableDir) {
      setModeError(t('settings.general.storageNoDirError'))
      return
    }

    setModeError(null)
    setPendingMode(mode)
    setPendingPortableDir(mode === 'portable' ? portableDir : null)
    setModeSwitchConfirmOpen(true)
  }

  const closeModeSwitchConfirm = () => {
    if (modeActionRunning) return
    setModeSwitchConfirmOpen(false)
    setPendingMode(null)
    setPendingPortableDir(null)
  }

  const confirmModeSwitch = async () => {
    if (!pendingMode) return

    setModeActionRunning(true)
    setModeError(null)
    try {
      await setAppModeAction(pendingMode, pendingPortableDir)
      const host = getDesktopHost()
      await host.appMode.prepareRestart()
      await host.appMode.restart()
    } catch (error) {
      setModeError(
        error instanceof Error
          ? error.message
          : t('settings.general.storageRestartError'),
      )
      setModeSwitchConfirmOpen(false)
      setPendingMode(null)
      setPendingPortableDir(null)
      setModeActionRunning(false)
    }
  }

  const setUiZoomDraggingState = (dragging: boolean) => {
    isUiZoomDraggingRef.current = dragging
    setIsUiZoomDragging(dragging)
  }

  const commitUiZoom = (value: number) => {
    const nextZoom = Number.isFinite(value) ? value : UI_ZOOM_DEFAULT
    setUiZoomDraggingState(false)
    setUiZoomDraft(nextZoom)
    setUiZoom(nextZoom)
  }

  const uiZoomSection = (
    <SettingsSection
      title={t('settings.general.uiZoom')}
      description={t('settings.general.uiZoomDescription')}
      action={(
        <div className="flex flex-shrink-0 items-center gap-2">
          <span className="min-w-[48px] rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] px-2 py-1 text-center text-sm font-medium text-[var(--color-text-secondary)]">
            {uiZoomPercent}%
          </span>
          <Button
            variant="secondary"
            size="base"
            aria-label={t('settings.general.uiZoomReset')}
            title={t('settings.general.uiZoomReset')}
            onClick={() => {
              setIsUiZoomDragging(false)
              setUiZoomDraft(UI_ZOOM_DEFAULT)
              setUiZoom(UI_ZOOM_DEFAULT)
            }}
            icon={<RotateCw className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            100%
          </Button>
        </div>
      )}
    >
      <div className="mt-1 mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
        <span>{t('settings.general.uiZoomShortcutHint')}</span>
        <span className="inline-flex items-center gap-1">
          <span className="font-medium text-[var(--color-text-secondary)]">{t('settings.general.uiZoomShortcutMac')}</span>
          <kbd className="settings-zoom-kbd">⌘</kbd>
          <kbd className="settings-zoom-kbd">+</kbd>
          <span>/</span>
          <kbd className="settings-zoom-kbd">⌘</kbd>
          <kbd className="settings-zoom-kbd">-</kbd>
          <span>/</span>
          <kbd className="settings-zoom-kbd">⌘</kbd>
          <kbd className="settings-zoom-kbd">0</kbd>
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="font-medium text-[var(--color-text-secondary)]">{t('settings.general.uiZoomShortcutWindows')}</span>
          <kbd className="settings-zoom-kbd">Ctrl</kbd>
          <kbd className="settings-zoom-kbd">+</kbd>
          <span>/</span>
          <kbd className="settings-zoom-kbd">Ctrl</kbd>
          <kbd className="settings-zoom-kbd">-</kbd>
          <span>/</span>
          <kbd className="settings-zoom-kbd">Ctrl</kbd>
          <kbd className="settings-zoom-kbd">0</kbd>
        </span>
        <span>{t('settings.general.uiZoomShortcutResetHint')}</span>
      </div>
      <div
        className={`settings-zoom-control flex items-center gap-3 ${isUiZoomDragging ? 'is-dragging' : ''}`}
        style={{ '--settings-zoom-range-progress': uiZoomRangeProgress } as CSSProperties}
      >
        <span className="w-9 text-right text-xs text-[var(--color-text-tertiary)]">{Math.round(UI_ZOOM_MIN * 100)}%</span>
        <div className="settings-zoom-range-wrap flex-1">
          <div className="settings-zoom-preview" aria-hidden="true">
            {uiZoomPercent}%
          </div>
          <input
            type="range"
            aria-label={t('settings.general.uiZoom')}
            min={UI_ZOOM_MIN}
            max={UI_ZOOM_MAX}
            step={UI_ZOOM_STEP}
            value={uiZoomDraft}
            onPointerDown={() => {
              setUiZoomDraggingState(true)
            }}
            onPointerUp={(e) => commitUiZoom(e.currentTarget.valueAsNumber)}
            onPointerCancel={() => {
              setUiZoomDraggingState(false)
              setUiZoomDraft(uiZoom)
            }}
            onChange={(e) => {
              const nextZoom = Number.isFinite(e.currentTarget.valueAsNumber)
                ? e.currentTarget.valueAsNumber
                : UI_ZOOM_DEFAULT
              setUiZoomDraft(nextZoom)
              if (!isUiZoomDraggingRef.current) {
                setUiZoom(nextZoom)
              }
            }}
            onBlur={(e) => {
              if (uiZoomDraft !== uiZoom) {
                commitUiZoom(e.currentTarget.valueAsNumber)
              } else {
                setUiZoomDraggingState(false)
              }
            }}
            className="settings-zoom-range w-full"
          />
        </div>
        <span className="w-9 text-xs text-[var(--color-text-tertiary)]">{Math.round(UI_ZOOM_MAX * 100)}%</span>
      </div>
    </SettingsSection>
  )

  return (
    <div className="max-w-xl">
      {/* No page header here on purpose: the only title it could carry is the nav
          label verbatim, with no description to add. The pane opens on its first
          section instead. */}
      {/* Appearance selector */}
      <SettingsSection
        title={t('settings.general.appearanceTitle')}
        description={t('settings.general.appearanceDescription')}
      >
        <div className="mb-4 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
          <Switch
            checked={followSystemTheme}
            onChange={setFollowSystemTheme}
            label={t('settings.general.appearance.followSystem')}
            description={t('settings.general.appearance.followSystemHint')}
          />
        </div>
        {followSystemTheme ? (
          // The OS decides which ground; what is left to choose is the palette
          // on each one, so the picker splits into the two grounds.
          <div className="flex flex-col gap-4">
            <div>
              <p className="mb-2 text-[12.5px] text-[var(--color-text-tertiary)]">
                {t('settings.general.appearance.lightThemeLabel')}
              </p>
              <div className="flex flex-wrap gap-2">
                {LIGHT_THEMES.map(({ value, label }) => (
                  <SettingsPill
                    key={value}
                    selected={lightTheme === value}
                    onClick={() => void setTheme(value)}
                  >
                    {label}
                  </SettingsPill>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-[12.5px] text-[var(--color-text-tertiary)]">
                {t('settings.general.appearance.darkThemeLabel')}
              </p>
              <div className="flex flex-wrap gap-2">
                {DARK_THEMES.map(({ value, label }) => (
                  <SettingsPill
                    key={value}
                    selected={darkTheme === value}
                    onClick={() => void setTheme(value)}
                  >
                    {label}
                  </SettingsPill>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {THEMES.map(({ value, label }) => (
              <SettingsPill
                key={value}
                selected={theme === value}
                onClick={() => void setTheme(value)}
              >
                {label}
              </SettingsPill>
            ))}
          </div>
        )}
      </SettingsSection>

      {/* Language selector */}
      <SettingsSection
        title={t('settings.general.languageTitle')}
        description={t('settings.general.languageDescription')}
      >
        <div className="flex flex-wrap gap-2">
          {LANGUAGES.map(({ value, label }) => (
            <SettingsPill
              key={value}
              selected={locale === value}
              onClick={() => setLocale(value)}
            >
              {label}
            </SettingsPill>
          ))}
        </div>
      </SettingsSection>

      {/* Response Language */}
      <SettingsSection
        title={t('settings.general.responseLangTitle')}
        description={t('settings.general.responseLangDescription')}
      >
        <Dropdown<string>
          items={RESPONSE_LANGUAGES}
          value={responseLanguage}
          onChange={(value) => void setResponseLanguage(value)}
          width="100%"
          maxHeight={320}
          className="block w-full"
          trigger={
            <Button
              variant="secondary"
              size="md"
              block
              className="h-10 gap-3"
              aria-label={t('settings.general.responseLangTitle')}
            >
              <span className="min-w-0 flex-1 truncate text-left">{selectedResponseLanguageLabel}</span>
              <span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-text-secondary)]">expand_more</span>
            </Button>
          }
        />
      </SettingsSection>

      {/* Output style */}
      <SettingsSection
        title={t('settings.general.outputStyleTitle')}
        description={t('settings.general.outputStyleDescription')}
      >
        <Card radius="xl" surface="low" padding="none" className="px-4 py-4">
        <Dropdown<string>
          items={outputStyleItems}
          value={outputStyle}
          onChange={(value) => void handleOutputStyleChange(value)}
          width="100%"
          maxHeight={360}
          className="block w-full"
          trigger={
            <Button
              variant="secondary"
              size="md"
              block
              className="h-auto min-h-10 gap-3 py-2"
              aria-label={t('settings.general.outputStyleSelectLabel')}
              disabled={outputStylesLoading}
              icon={<span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-text-secondary)]">format_paint</span>}
            >
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate font-medium">
                  {outputStylesLoading
                    ? t('settings.general.outputStyleLoading')
                    : selectedOutputStyleLabel}
                </span>
                {selectedOutputStyleDescription && (
                  <span className="mt-0.5 block truncate text-xs text-[var(--color-text-tertiary)]">
                    {selectedOutputStyleDescription}
                  </span>
                )}
              </span>
              <span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-text-secondary)]">expand_more</span>
            </Button>
          }
        />
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
          <span className="inline-flex items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-medium text-[var(--color-text-secondary)]">
            {outputStyleScopeLabel}
          </span>
          {selectedOutputStyle && (
            <span className="inline-flex items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1">
              {getOutputStyleSourceLabel(selectedOutputStyle.source, t)}
            </span>
          )}
          <span className="min-w-0 flex-1 leading-5">{outputStyleScopeHint}</span>
        </div>
        <p className="mt-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.general.outputStyleRestartHint')}
        </p>
        {outputStyleError && (
          <p className="mt-2 text-xs leading-5 text-[var(--color-error)]">
            {outputStyleError}
          </p>
        )}
      </Card>
      </SettingsSection>

      <SettingsSection
        title={t('settings.general.defaultPermissionTitle')}
        description={t('settings.general.defaultPermissionDescription')}
      >
        <Card radius="xl" surface="low" padding="none" className="px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.general.defaultPermissionLabel')}
              </div>
              <div className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">
                {t('settings.general.defaultPermissionHint')}
              </div>
            </div>
            <PermissionModeSelector
              value={permissionMode}
              onChange={(mode) => void setPermissionMode(mode)}
              workDir={t('settings.general.defaultPermissionScope')}
              menuPlacement="bottom"
            />
          </div>
        </Card>
      </SettingsSection>

      <SettingsSection
        title={t('settings.general.thinkingTitle')}
        description={t('settings.general.thinkingDescription')}
      >
        <label className="relative flex items-start gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 cursor-pointer hover:border-[var(--color-border-focus)] transition-colors">
          <input
            type="checkbox"
            aria-label={t('settings.general.thinkingEnabled')}
            checked={thinkingEnabled}
            onChange={(e) => void setThinkingEnabled(e.target.checked)}
            className={SETTINGS_CHECKBOX_INPUT_CLASS}
          />
          <SettingsCheckboxMark checked={thinkingEnabled} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.general.thinkingEnabled')}
            </div>
            <div className="text-xs text-[var(--color-text-tertiary)] mt-1 leading-5">
              {t('settings.general.thinkingHint')}
            </div>
          </div>
        </label>
      </SettingsSection>

      <SettingsSection
        title={t('settings.general.autoDreamTitle')}
        description={t('settings.general.autoDreamDescription')}
      >
        <label className="relative flex items-start gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 cursor-pointer hover:border-[var(--color-border-focus)] transition-colors">
          <input
            type="checkbox"
            aria-label={t('settings.general.autoDreamEnabled')}
            checked={autoDreamEnabled}
            onChange={(e) => handleAutoDreamToggle(e.target.checked)}
            className={SETTINGS_CHECKBOX_INPUT_CLASS}
          />
          <SettingsCheckboxMark checked={autoDreamEnabled} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.general.autoDreamEnabled')}
            </div>
            <div className="text-xs text-[var(--color-text-tertiary)] mt-1 leading-5">
              {autoDreamEnabled
                ? t('settings.general.autoDreamHintOn')
                : t('settings.general.autoDreamHintOff')}
            </div>
          </div>
        </label>
      </SettingsSection>

      <SettingsSection
        title={t('settings.general.traceTitle')}
        description={t('settings.general.traceDescription')}
      >
        <label className="relative flex items-start gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 cursor-pointer hover:border-[var(--color-border-focus)] transition-colors">
          <input
            type="checkbox"
            aria-label={t('settings.general.traceEnabled')}
            checked={traceCapture.enabled}
            onChange={(e) => void setTraceCaptureEnabled(e.target.checked)}
            className={SETTINGS_CHECKBOX_INPUT_CLASS}
          />
          <SettingsCheckboxMark checked={traceCapture.enabled} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.general.traceEnabled')}
            </div>
            <div className="text-xs text-[var(--color-text-tertiary)] mt-1 leading-5">
              {traceCapture.enabled ? t('settings.general.traceHintOn') : t('settings.general.traceHintOff')}
            </div>
            {traceCapture.storageDir && (
              <div className="mt-2 truncate rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-secondary)]">
                {traceCapture.storageDir}
              </div>
            )}
          </div>
        </label>
      </SettingsSection>

      <SettingsSection
        title={t('settings.general.notificationsTitle')}
        description={t('settings.general.notificationsDescription')}
      >
        <Card radius="xl" surface="low" padding="none" className="px-4 py-3">
          <label className="relative flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              aria-label={t('settings.general.notificationsEnabled')}
              checked={desktopNotificationsEnabled}
              onChange={(e) => void handleDesktopNotificationsToggle(e.target.checked)}
              className={SETTINGS_CHECKBOX_INPUT_CLASS}
            />
            <SettingsCheckboxMark checked={desktopNotificationsEnabled} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.general.notificationsEnabled')}
              </div>
              <div className="text-xs text-[var(--color-text-tertiary)] mt-1 leading-5">
                {desktopNotificationsEnabled
                  ? t('settings.general.notificationsHintOn')
                  : t('settings.general.notificationsHintOff')}
              </div>
            </div>
          </label>
          {desktopNotificationsEnabled && (
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--color-border-separator)] pt-3">
              <div className="min-w-0 text-xs text-[var(--color-text-tertiary)]">
                {t('settings.general.notificationsStatus')}: {notificationStatusLabel[notificationPermission]}
              </div>
              {notificationPermission !== 'granted' && notificationPermission !== 'unsupported' && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="px-3 whitespace-nowrap"
                  disabled={notificationActionRunning}
                  onClick={() => void handleNotificationPermissionAction()}
                >
                  {notificationPermission === 'denied'
                    ? t('settings.general.notificationsOpenSettings')
                    : t('settings.general.notificationsAuthorize')}
                </Button>
              )}
            </div>
          )}
        </Card>
      </SettingsSection>

      <SettingsSection
        title={t('settings.general.chatSendBehaviorTitle')}
        description={t('settings.general.chatSendBehaviorDescription')}
      >
        <Card radius="xl" surface="low" padding="none" className="grid grid-cols-2 gap-2 p-2">
          {CHAT_SEND_BEHAVIORS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => void setChatSendBehavior(option.value)}
              aria-pressed={chatSendBehavior === option.value}
              className={`rounded-[var(--radius-lg)] border px-3 py-2 text-left transition-colors ${
                chatSendBehavior === option.value
                  ? 'border-[var(--color-brand)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <div className="text-xs font-semibold">{option.label}</div>
              <div className="mt-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                {option.description}
              </div>
            </button>
          ))}
        </Card>
      </SettingsSection>

      {uiZoomSection}

      <SettingsSection
        title={t('settings.general.networkTitle')}
        description={t('settings.general.networkDescription')}
      >
        <Card radius="xl" surface="low" padding="none" className="px-4 py-4">
          <div className="grid grid-cols-2 gap-2">
            {NETWORK_PROXY_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                onClick={() => {
                  setNetworkDraft((current) => ({
                    ...current,
                    proxy: { ...current.proxy, mode: mode.value },
                  }))
                  setNetworkSaveError(null)
                }}
                aria-pressed={networkDraft.proxy.mode === mode.value}
                className={`rounded-[var(--radius-lg)] border px-3 py-2 text-left transition-colors ${
                  networkDraft.proxy.mode === mode.value
                    ? 'border-[var(--color-brand)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                }`}
              >
                <div className="text-xs font-semibold">{mode.label}</div>
                <div className="mt-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                  {mode.description}
                </div>
              </button>
            ))}
          </div>

          {networkDraft.proxy.mode === 'manual' && (
            <div className="mt-4">
              <Input
                id="network-proxy-url"
                label={t('settings.general.networkProxyUrl')}
                value={networkDraft.proxy.url}
                placeholder="http://127.0.0.1:7890"
                autoComplete="off"
                onChange={(event) => {
                  setNetworkDraft((current) => ({
                    ...current,
                    proxy: { ...current.proxy, url: event.target.value },
                  }))
                  setNetworkSaveError(null)
                }}
              />
              <p className={`mt-1 text-[11px] leading-4 ${networkProxyError ? 'text-[var(--color-error)]' : 'text-[var(--color-text-tertiary)]'}`}>
                {networkProxyError ?? t('settings.general.networkProxyUrlHint')}
              </p>
            </div>
          )}

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <label htmlFor="network-timeout-seconds" className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.general.networkTimeout')}
              </label>
              <span className="rounded-[var(--radius-md)] bg-[var(--color-surface)] px-2 py-1 text-xs font-medium text-[var(--color-text-secondary)]">
                {t('settings.general.networkTimeoutValue', { seconds: String(timeoutSeconds) })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-10 w-10 px-0"
                aria-label={t('settings.general.networkTimeoutDecrease')}
                onClick={() => setNetworkTimeoutSeconds((parsedNetworkTimeoutSeconds ?? timeoutSeconds) - NETWORK_TIMEOUT_STEP_SECONDS)}
              >
                -30
              </Button>
              <div className="relative min-w-0 flex-1">
                <input
                  id="network-timeout-seconds"
                  type="number"
                  min={NETWORK_TIMEOUT_MIN_SECONDS}
                  max={NETWORK_TIMEOUT_MAX_SECONDS}
                  step={1}
                  inputMode="numeric"
                  value={networkTimeoutInput}
                  aria-invalid={networkTimeoutError ? true : undefined}
                  aria-describedby="network-timeout-help"
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value
                    if (!/^\d*$/.test(nextValue)) return
                    setNetworkTimeoutInput(nextValue)
                    const seconds = Number(nextValue)
                    if (nextValue.length > 0 && seconds >= NETWORK_TIMEOUT_MIN_SECONDS && seconds <= NETWORK_TIMEOUT_MAX_SECONDS) {
                      setNetworkDraft((current) => ({
                        ...current,
                        aiRequestTimeoutMs: seconds * 1000,
                      }))
                    }
                    setNetworkSaveError(null)
                  }}
                  className={`h-10 w-full rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-3 pr-12 text-sm text-[var(--color-text-primary)] outline-none transition-colors duration-150 placeholder:text-[var(--color-text-tertiary)] ${
                    networkTimeoutError
                      ? 'border-[var(--color-error)] focus:shadow-[var(--shadow-error-ring)]'
                      : 'border-[var(--color-border)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)]'
                  }`}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-tertiary)]">
                  {t('settings.general.networkTimeoutUnit')}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-10 w-10 px-0"
                aria-label={t('settings.general.networkTimeoutIncrease')}
                onClick={() => setNetworkTimeoutSeconds((parsedNetworkTimeoutSeconds ?? timeoutSeconds) + NETWORK_TIMEOUT_STEP_SECONDS)}
              >
                +30
              </Button>
            </div>
            <p
              id="network-timeout-help"
              className={`mt-2 text-xs leading-5 ${networkTimeoutError ? 'text-[var(--color-error)]' : 'text-[var(--color-text-tertiary)]'}`}
            >
              {networkTimeoutError ?? t('settings.general.networkTimeoutHint')}
            </p>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="min-w-0 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
              {t('settings.general.networkScopeHint')}
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="min-w-[72px] px-4 whitespace-nowrap"
              disabled={!networkDirty || !!networkProxyError || !!networkTimeoutError || isSavingNetwork}
              loading={isSavingNetwork}
              onClick={() => void saveNetworkSettings()}
            >
              {t('settings.general.networkSave')}
            </Button>
          </div>

          {networkSaveError && (
            <p className="mt-2 text-[11px] leading-4 text-[var(--color-error)]">
              {networkSaveError}
            </p>
          )}
        </Card>
      </SettingsSection>

      <SettingsSection
        title={t('settings.general.webFetchPreflightTitle')}
        description={t('settings.general.webFetchPreflightDescription')}
      >
        <label className="relative flex items-start gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 cursor-pointer hover:border-[var(--color-border-focus)] transition-colors">
          <input
            type="checkbox"
            aria-label={t('settings.general.webFetchPreflightEnabled')}
            checked={skipWebFetchPreflight}
            onChange={(e) => void setSkipWebFetchPreflight(e.target.checked)}
            className={SETTINGS_CHECKBOX_INPUT_CLASS}
          />
          <SettingsCheckboxMark checked={skipWebFetchPreflight} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.general.webFetchPreflightEnabled')}
            </div>
            <div className="text-xs text-[var(--color-text-tertiary)] mt-1 leading-5">
              {t('settings.general.webFetchPreflightHint')}
            </div>
          </div>
        </label>
      </SettingsSection>

      <SettingsSection
        title={t('settings.general.webSearchTitle')}
        description={t('settings.general.webSearchDescription')}
      >
        <Card radius="xl" surface="low" padding="none" className="px-4 py-4">
          <div className="grid grid-cols-5 gap-1.5 mb-4">
            {WEB_SEARCH_MODES.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setWebSearchDraft({ ...webSearchDraft, mode: value })}
                className={`h-9 px-2 text-xs font-semibold rounded-[var(--radius-lg)] border transition-all truncate ${
                  (webSearchDraft.mode ?? 'auto') === value
                    ? 'bg-[var(--color-brand)] text-[var(--color-on-primary)] border-[var(--color-brand)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                }`}
                title={label}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3">
            <Input
              id="web-search-tavily-key"
              type="password"
              label={t('settings.general.webSearchTavilyKey')}
              value={webSearchDraft.tavilyApiKey ?? ''}
              placeholder="tvly-..."
              autoComplete="off"
              onChange={(event) =>
                setWebSearchDraft({
                  ...webSearchDraft,
                  tavilyApiKey: event.target.value,
                })
              }
            />
            <div className="-mt-1 flex items-center justify-between gap-3 text-xs text-[var(--color-text-tertiary)]">
              <span>{t('settings.general.webSearchTavilyFreeHint')}</span>
              <a
                href="https://app.tavily.com/home"
                target="_blank"
                rel="noreferrer"
                aria-label={t('settings.general.webSearchTavilyApiKeyLink')}
                className="font-medium text-[var(--color-brand)] hover:underline whitespace-nowrap"
              >
                {t('settings.general.webSearchGetApiKey')}
              </a>
            </div>
            <Input
              id="web-search-brave-key"
              type="password"
              label={t('settings.general.webSearchBraveKey')}
              value={webSearchDraft.braveApiKey ?? ''}
              placeholder={t('settings.general.webSearchBravePlaceholder')}
              autoComplete="off"
              onChange={(event) =>
                setWebSearchDraft({
                  ...webSearchDraft,
                  braveApiKey: event.target.value,
                })
              }
            />
            <div className="-mt-1 flex items-center justify-between gap-3 text-xs text-[var(--color-text-tertiary)]">
              <span>{t('settings.general.webSearchBraveFreeHint')}</span>
              <a
                href="https://api-dashboard.search.brave.com/app/keys"
                target="_blank"
                rel="noreferrer"
                aria-label={t('settings.general.webSearchBraveApiKeyLink')}
                className="font-medium text-[var(--color-brand)] hover:underline whitespace-nowrap"
              >
                {t('settings.general.webSearchGetApiKey')}
              </a>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-xs text-[var(--color-text-tertiary)] leading-5">
              {t('settings.general.webSearchHint')}
            </p>
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                className="min-w-[72px] px-4 whitespace-nowrap"
                disabled={!webSearchDirty}
                onClick={() => void setWebSearch(webSearchDraft)}
              >
                {t('settings.general.webSearchSave')}
              </Button>
            </div>
          </div>
        </Card>
      </SettingsSection>

      {isDesktopRuntime() && (
        <div className="mt-8 border-t border-[var(--color-border)] pt-8">
          <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.storageTitle')}</h2>
          <p className="text-sm text-[var(--color-text-tertiary)] mb-3">{t('settings.general.storageDescription')}</p>

          <Card radius="xl" surface="low" padding="none" className="px-4 py-4">
            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => {
                  if (isEnvironmentConfigDir) {
                    setModeError(t('settings.general.storageEnvironmentSwitchBlocked'))
                    return
                  }
                  if (appMode.mode !== 'default') {
                    openModeSwitchConfirm('default')
                  }
                }}
                aria-pressed={appMode.mode === 'default' && !isEnvironmentConfigDir}
                className={`flex items-start gap-3 rounded-[var(--radius-lg)] border px-3 py-3 text-left transition-all ${
                  appMode.mode === 'default' && !isEnvironmentConfigDir
                    ? 'border-[var(--color-brand)] bg-[var(--color-surface)] shadow-[var(--shadow-focus-ring)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-focus)]'
                }`}
              >
                <span className="material-symbols-outlined mt-0.5 text-[20px] text-[var(--color-text-secondary)]">settings_applications</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.general.storageSystemTitle')}</span>
                  <span className="mt-1 block text-xs leading-5 text-[var(--color-text-tertiary)]">{t('settings.general.storageSystemDescription')}</span>
                </span>
              </button>

              <div
                className={`rounded-[var(--radius-lg)] border px-3 py-3 transition-all ${
                  appMode.mode === 'portable' && !isEnvironmentConfigDir
                    ? 'border-[var(--color-brand)] bg-[var(--color-surface)] shadow-[var(--shadow-focus-ring)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)]'
                }`}
              >
                <div className="mb-3 flex items-start gap-3">
                  <span className="material-symbols-outlined mt-0.5 text-[20px] text-[var(--color-text-secondary)]">drive_file_move</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.general.storagePortableTitle')}</div>
                    <div className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">{t('settings.general.storagePortableDescription')}</div>
                  </div>
                </div>

                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      id="portable-data-dir"
                      label={t('settings.general.storagePortableDirLabel')}
                      value={portableDirDraft}
                      placeholder={t('settings.general.storagePortableDirPlaceholder')}
                      onChange={(event) => {
                        setPortableDirDraft(event.target.value)
                        setModeError(null)
                      }}
                      className="w-full font-mono text-xs"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-10 flex-shrink-0 px-3 whitespace-nowrap"
                    onClick={() => void openPortableDirPicker()}
                  >
                    {t('settings.general.storageChooseDir')}
                  </Button>
                </div>

                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={modeActionRunning || (appMode.mode === 'portable' && portableDirDraft.trim() === (appMode.portableDir ?? ''))}
                    onClick={() => openModeSwitchConfirm('portable')}
                  >
                    {t('settings.general.storageApplyPortable')}
                  </Button>
                </div>
              </div>
            </div>

            {activeConfigDir && (
              <div className="mt-3 rounded-[var(--radius-lg)] border border-[var(--color-border-separator)] bg-[var(--color-surface)] px-3 py-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">{t('settings.general.storageActiveDir')}</div>
                <div className="mt-1 break-all font-mono text-xs text-[var(--color-text-secondary)]">{activeConfigDir}</div>
              </div>
            )}

            {isEnvironmentConfigDir && (
              <div className="mt-3 rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-5 text-[var(--color-on-warning-container)]">
                {t('settings.general.storageEnvironmentHint')}
              </div>
            )}

            {appModeRequiresRestart && (
              <div className="mt-3 rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-5 text-[var(--color-on-warning-container)]">
                {t('settings.general.storageRestartHint')}
              </div>
            )}

            <div className="mt-3 text-xs leading-5 text-[var(--color-text-tertiary)]">
              {t('settings.general.storageMoveHint')}
            </div>

            {modeError && (
              <div className="mt-3 text-xs text-[var(--color-error)]">
                {modeError}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Confirm dialog for mode switch */}
      <ConfirmDialog
        open={modeSwitchConfirmOpen}
        onClose={closeModeSwitchConfirm}
        onConfirm={() => void confirmModeSwitch()}
        title={t('settings.general.modeSwitchTitle')}
        body={(
          <div className="space-y-3 text-sm leading-6 text-[var(--color-text-secondary)]">
            <p>
              {pendingMode === 'portable'
                ? t('settings.general.storageSwitchPortableBody')
                : t('settings.general.storageSwitchDefaultBody')}
            </p>
            {pendingMode === 'portable' && pendingPortableDir && (
              <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)] px-3 py-2 font-mono text-xs break-all text-[var(--color-text-secondary)]">
                {pendingPortableDir}
              </div>
            )}
            <p>{t('settings.general.storageSwitchRestartBody')}</p>
          </div>
        )}
        confirmLabel={t('settings.general.modeSwitchConfirm')}
        cancelLabel={t('common.cancel')}
        confirmVariant="primary"
        loading={modeActionRunning}
      />
      <ConfirmDialog
        open={autoDreamConfirmOpen}
        onClose={() => {
          if (!autoDreamActionRunning) setAutoDreamConfirmOpen(false)
        }}
        onConfirm={() => void confirmAutoDreamEnable()}
        title={t('settings.general.autoDreamConfirmTitle')}
        body={(
          <div className="space-y-2">
            <p>{t('settings.general.autoDreamConfirmKeepRunning')}</p>
            <p>{t('settings.general.autoDreamConfirmTokenCost')}</p>
          </div>
        )}
        confirmLabel={t('settings.general.autoDreamConfirmEnable')}
        cancelLabel={t('common.cancel')}
        confirmVariant="primary"
        loading={autoDreamActionRunning}
      />
    </div>
  )
}

function getBuiltInOutputStyleTranslationKeys(style: {
  value: string
  source: OutputStyleSource
}) {
  if (style.source !== 'built-in') return null
  return BUILT_IN_OUTPUT_STYLE_TRANSLATION_KEYS[
    style.value as keyof typeof BUILT_IN_OUTPUT_STYLE_TRANSLATION_KEYS
  ] ?? null
}

function getOutputStyleLabel(
  style: {
    value: string
    label: string
    source: OutputStyleSource
  },
  t: (key: TranslationKey) => string,
) {
  const keys = getBuiltInOutputStyleTranslationKeys(style)
  return keys ? t(keys.label) : style.label
}

function getOutputStyleDescription(
  style: {
    value: string
    description: string
    source: OutputStyleSource
  },
  t: (key: TranslationKey) => string,
) {
  const keys = getBuiltInOutputStyleTranslationKeys(style)
  return keys ? t(keys.description) : style.description
}

function getOutputStyleSourceLabel(
  source: OutputStyleSource,
  t: (key: TranslationKey) => string,
) {
  switch (source) {
    case 'built-in':
      return t('settings.general.outputStyleSourceBuiltIn')
    case 'userSettings':
      return t('settings.general.outputStyleSourceUser')
    case 'projectSettings':
      return t('settings.general.outputStyleSourceProject')
    case 'localSettings':
      return t('settings.general.outputStyleSourceLocal')
    case 'policySettings':
      return t('settings.general.outputStyleSourcePolicy')
    case 'plugin':
      return t('settings.general.outputStyleSourcePlugin')
  }
}


// ─── Skill Settings ──────────────────────────────────────

function SkillSettings() {
  const selectedSkill = useSkillStore((s) => s.selectedSkill)
  const t = useTranslation()

  if (selectedSkill) {
    return (
      <div className="w-full min-w-0">
        <SkillDetail />
      </div>
    )
  }

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader
        title={t('settings.skills.title')}
        description={t('settings.skills.description')}
      />
      <SkillList />
    </div>
  )
}

function PluginSettings() {
  const selectedPlugin = usePluginStore((s) => s.selectedPlugin)
  const t = useTranslation()

  if (selectedPlugin) {
    return (
      <div className="w-full min-w-0">
        <PluginDetail />
      </div>
    )
  }

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader
        title={t('settings.plugins.title')}
        description={t('settings.plugins.description')}
      />
      <PluginList />
    </div>
  )
}

// ─── About Settings ──────────────────────────────────────

const GITHUB_REPO = 'https://github.com/KyuuKyuuStone/claude-code-heihei'
const GITHUB_ISSUES = `${GITHUB_REPO}/issues`
const GITHUB_RELEASES = `${GITHUB_REPO}/releases`
const AUTHOR_GITHUB = 'https://github.com/KyuuKyuuStone'

function isValidHttpProxyUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function AboutSettings() {
  const t = useTranslation()
  const [version, setVersion] = useState('')
  const updateProxy = useSettingsStore((s) => s.updateProxy)
  const setUpdateProxy = useSettingsStore((s) => s.setUpdateProxy)
  const updateStatus = useUpdateStore((s) => s.status)
  const availableVersion = useUpdateStore((s) => s.availableVersion)
  const releaseNotes = useUpdateStore((s) => s.releaseNotes)
  const progressPercent = useUpdateStore((s) => s.progressPercent)
  const downloadedBytes = useUpdateStore((s) => s.downloadedBytes)
  const totalBytes = useUpdateStore((s) => s.totalBytes)
  const error = useUpdateStore((s) => s.error)
  const checkedAt = useUpdateStore((s) => s.checkedAt)
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates)
  const installUpdate = useUpdateStore((s) => s.installUpdate)
  const initialize = useUpdateStore((s) => s.initialize)
  const [showUpdateProxyAdvanced, setShowUpdateProxyAdvanced] = useState(false)
  const [updateProxyDraft, setUpdateProxyDraft] = useState(updateProxy)
  const [updateProxySaveError, setUpdateProxySaveError] = useState<string | null>(null)
  const [isSavingUpdateProxy, setIsSavingUpdateProxy] = useState(false)

  useEffect(() => {
    let cancelled = false

    getDesktopHost().app.getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value)
      })
      .catch(() => {
        if (!cancelled) setVersion('')
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    setUpdateProxyDraft(updateProxy)
    setUpdateProxySaveError(null)
  }, [updateProxy])

  const openUrl = (url: string) => {
    void getDesktopHost().shell.open(url).catch(() => window.open(url, '_blank'))
  }

  const checkedAtText =
    checkedAt
      ? new Date(checkedAt).toLocaleString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          month: 'short',
          day: 'numeric',
        })
      : null
  const updateProxyModes: Array<{ value: UpdateProxyMode; label: string; description: string }> = [
    {
      value: 'system',
      label: t('update.proxyModeSystem'),
      description: t('update.proxyModeSystemDescription'),
    },
    {
      value: 'manual',
      label: t('update.proxyModeManual'),
      description: t('update.proxyModeManualDescription'),
    },
  ]
  const manualProxyUrl = updateProxyDraft.url.trim()
  const manualProxyError =
    updateProxyDraft.mode === 'manual' && !manualProxyUrl
      ? t('update.proxyUrlRequired')
      : updateProxyDraft.mode === 'manual' && !isValidHttpProxyUrl(manualProxyUrl)
        ? t('update.proxyUrlInvalid')
        : null
  const updateProxyDirty =
    updateProxyDraft.mode !== updateProxy.mode ||
    updateProxyDraft.url.trim() !== updateProxy.url.trim()

  const saveUpdateProxy = async () => {
    if (manualProxyError) {
      setUpdateProxySaveError(manualProxyError)
      return
    }

    setIsSavingUpdateProxy(true)
    setUpdateProxySaveError(null)
    try {
      await setUpdateProxy({
        mode: updateProxyDraft.mode,
        url: manualProxyUrl,
      })
    } catch (error) {
      setUpdateProxySaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingUpdateProxy(false)
    }
  }

  const hasKnownProgress = typeof totalBytes === 'number' && totalBytes > 0
  const downloadedText = formatBytes(downloadedBytes)
  const updateDescription = (() => {
    if (updateStatus === 'checking') return t('update.checking')
    if (error) return t('update.failed', { error })
    if (updateStatus === 'downloading') {
      return hasKnownProgress
        ? t('update.progress', { progress: String(progressPercent) })
        : t('update.progressBytes', { downloaded: downloadedText })
    }
    if (updateStatus === 'downloaded') return t('update.downloaded')
    if (updateStatus === 'installing') return t('update.installing')
    if (updateStatus === 'restarting') return t('update.restarting')
    if (updateStatus === 'available' && availableVersion) return t('update.newVersion', { version: availableVersion })
    if (updateStatus === 'up-to-date') return t('update.upToDate', { version: version || t('update.currentVersionUnknown') })
    return t('update.idle')
  })()

  return (
    <div className="w-full min-w-0 max-w-2xl mx-auto flex flex-col items-center py-6">
      {/* Logo + App Name + Version */}
      <BrandSeal size="xl" className="mb-4" />
      <h1 className="text-xl font-bold text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>Claude Code Heihei</h1>
      {version && (
        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
          <span>{t('settings.about.version')} {version}</span>
          <span className="text-[var(--color-border)]">·</span>
          <Button variant="link" size="xs" onClick={() => openUrl(GITHUB_RELEASES)}>
            {t('settings.about.changelog')}
          </Button>
        </div>
      )}

      {/* GitHub Repo */}
      <div className="mt-6 w-full">
        <button
          onClick={() => openUrl(GITHUB_REPO)}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
        >
          <img src={publicAssetPath('icons/github.svg')} alt="GitHub" className="w-5 h-5 opacity-70" />
          <div className="flex-1 text-left">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">KyuuKyuuStone/claude-code-heihei</div>
            <div className="text-xs text-[var(--color-text-tertiary)]">{t('settings.about.starHint')}</div>
          </div>
        </button>
      </div>

      <Card radius="xl" surface="low" padding="none" className="mt-4 w-full p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.about.updates')}</div>
            <div className="text-xs text-[var(--color-text-tertiary)] mt-1">
              {t('settings.about.updatesDesc')}
            </div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void checkForUpdates()}
            loading={updateStatus === 'checking'}
          >
            {t('update.checkNow')}
          </Button>
        </div>

        <div className="mt-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                {t('settings.about.version')}
              </div>
              <div className="text-sm font-medium text-[var(--color-text-primary)] mt-1">
                {version || t('update.currentVersionUnknown')}
              </div>
            </div>

            {availableVersion && (
              <div className="text-right">
                <div className="text-xs uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                  {t('update.availableLabel')}
                </div>
                <div className="text-sm font-medium text-[var(--color-text-primary)] mt-1">
                  {availableVersion}
                </div>
              </div>
            )}
          </div>

          <p className={`mt-3 text-sm ${error ? 'text-[var(--color-error)]' : 'text-[var(--color-text-secondary)]'}`}>
            {updateDescription}
          </p>

          {checkedAtText && (
            <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
              {t('update.checkedAt', { time: checkedAtText })}
            </p>
          )}

          <div className="mt-3 border-t border-[var(--color-border-separator)] pt-3">
            <button
              type="button"
              onClick={() => setShowUpdateProxyAdvanced((value) => !value)}
              className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-md)] text-left text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
              aria-expanded={showUpdateProxyAdvanced}
            >
              <span>{t('update.proxyAdvanced')}</span>
              <span className="material-symbols-outlined text-[18px]">
                {showUpdateProxyAdvanced ? 'expand_less' : 'expand_more'}
              </span>
            </button>

            {showUpdateProxyAdvanced && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  {updateProxyModes.map((mode) => (
                    <button
                      key={mode.value}
                      type="button"
                      onClick={() => {
                        setUpdateProxyDraft((current) => ({ ...current, mode: mode.value }))
                        setUpdateProxySaveError(null)
                      }}
                      aria-pressed={updateProxyDraft.mode === mode.value}
                      className={`rounded-[var(--radius-lg)] border px-3 py-2 text-left transition-colors ${
                        updateProxyDraft.mode === mode.value
                          ? 'border-[var(--color-brand)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                          : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      <div className="text-xs font-semibold">{mode.label}</div>
                      <div className="mt-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                        {mode.description}
                      </div>
                    </button>
                  ))}
                </div>

                {updateProxyDraft.mode === 'manual' && (
                  <div>
                    <Input
                      id="update-proxy-url"
                      label={t('update.proxyUrl')}
                      value={updateProxyDraft.url}
                      placeholder="http://127.0.0.1:7890"
                      autoComplete="off"
                      onChange={(event) => {
                        setUpdateProxyDraft((current) => ({ ...current, url: event.target.value }))
                        setUpdateProxySaveError(null)
                      }}
                    />
                    <p className={`mt-1 text-[11px] leading-4 ${manualProxyError ? 'text-[var(--color-error)]' : 'text-[var(--color-text-tertiary)]'}`}>
                      {manualProxyError ?? t('update.proxyUrlHint')}
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                    {t('update.proxyScopeHint')}
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="min-w-[72px] px-4 whitespace-nowrap"
                    disabled={!updateProxyDirty || !!manualProxyError || isSavingUpdateProxy}
                    loading={isSavingUpdateProxy}
                    onClick={() => void saveUpdateProxy()}
                  >
                    {t('update.proxySave')}
                  </Button>
                </div>

                {updateProxySaveError && (
                  <p className="text-[11px] leading-4 text-[var(--color-error)]">
                    {updateProxySaveError}
                  </p>
                )}
              </div>
            )}
          </div>

          {(updateStatus === 'downloading' || updateStatus === 'restarting') && (
            <div className="mt-3">
              <div className="h-1.5 bg-[var(--color-surface-container-low)] rounded-full overflow-hidden">
                {hasKnownProgress || updateStatus === 'restarting' ? (
                  <div
                    className="h-full bg-[var(--color-text-accent)] transition-all duration-300"
                    style={{ width: `${Math.min(progressPercent, 100)}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 rounded-full bg-[var(--color-text-accent)] animate-pulse" />
                )}
              </div>
              {!hasKnownProgress && updateStatus === 'downloading' && downloadedBytes > 0 && (
                <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
                  {downloadedText}
                </p>
              )}
            </div>
          )}

          {releaseNotes && availableVersion && (
            <div className="mt-3 rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)] px-3 py-3">
              <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                {t('update.releaseNotes')}
              </div>
              <MarkdownRenderer
                content={releaseNotes}
                variant="document"
                className="mt-2 text-[13px] leading-6 text-[var(--color-text-secondary)] [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_p]:text-[13px] [&_p]:leading-6"
              />
            </div>
          )}

          {availableVersion && (
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                onClick={() => void installUpdate()}
                loading={updateStatus === 'downloading' || updateStatus === 'installing' || updateStatus === 'restarting'}
                disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
              >
                {updateStatus === 'downloaded'
                  ? t('update.installAndRestart')
                  : updateStatus === 'installing'
                    ? t('update.installing')
                    : updateStatus === 'restarting'
                      ? t('update.restarting')
                      : t('update.now')}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* Divider */}
      <div className="w-full border-t border-[var(--color-border-separator)] my-6" />

      {/* Author */}
      <div className="w-full">
        <h3 className="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-3">{t('settings.about.author')}</h3>
        <button
          onClick={() => openUrl(AUTHOR_GITHUB)}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-[var(--radius-lg)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
        >
          <img src={publicAssetPath('icons/github.svg')} alt="GitHub" className="w-4 h-4 opacity-60" />
          <span className="text-sm text-[var(--color-text-primary)]">KyuuKyuuStone</span>
          <span className="text-xs text-[var(--color-text-tertiary)] ml-auto">GitHub</span>
        </button>
      </div>

      <div className="mt-6 w-full">
        <button
          onClick={() => openUrl(GITHUB_ISSUES)}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
        >
          <span className="material-symbols-outlined text-[20px] text-[var(--color-text-tertiary)]">feedback</span>
          <div className="flex-1 text-left">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.about.feedback')}</div>
            <div className="text-xs text-[var(--color-text-tertiary)]">{t('settings.about.feedbackDesc')}</div>
          </div>
        </button>
      </div>
    </div>
  )
}
