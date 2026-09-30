import { create } from 'zustand'
import { sessionsApi } from '../api/sessions'
import { dropSession as dropVirtualHeightSession } from '../components/chat/virtualHeightCache'
import { destroyTerminalRuntime } from '../lib/terminalRuntime'
import { useSessionRuntimeStore } from './sessionRuntimeStore'

const TAB_STORAGE_KEY = 'cc-heihei-open-tabs'

export const SETTINGS_TAB_ID = '__settings__'
export const SCHEDULED_TAB_ID = '__scheduled__'
export const MARKET_TAB_ID = '__market__'
export const TRACE_LIST_TAB_ID = '__traces__'
export const COLLAB_TASKS_TAB_ID = '__collab-tasks__'
export const TERMINAL_TAB_PREFIX = '__terminal__'
export const TRACE_TAB_PREFIX = '__trace__'
export const WORKBENCH_TAB_PREFIX = '__workbench__'
export const SUBAGENT_TAB_PREFIX = '__subagent__'

export type TabType = 'session' | 'settings' | 'scheduled' | 'market' | 'terminal' | 'trace' | 'traces' | 'collab-tasks' | 'workbench' | 'subagent'
type PersistentSpecialTabType = 'settings' | 'scheduled' | 'market' | 'traces' | 'collab-tasks'

export type Tab = {
  sessionId: string
  title: string
  type: TabType
  status: 'idle' | 'running' | 'error'
  terminalCwd?: string
  terminalRuntimeId?: string
  traceSessionId?: string
  workbenchSessionId?: string
  sourceSessionId?: string
  sourceTurnKey?: string
  sourceElementId?: string
  subagentToolUseId?: string
  subagentTaskId?: string
}

export type WorkbenchTabOrigin = { sourceSessionId?: string; sourceTurnKey?: string; sourceElementId?: string }
type TabPersistence = { openTabs: Array<{ sessionId: string; title: string; type?: TabType; traceSessionId?: string }>; activeTabId: string | null }

type TabStore = {
  tabs: Tab[]
  activeTabId: string | null
  openTab: (sessionId: string, title: string, type?: TabType) => void
  openTracesTab: (title?: string) => string
  openCollabTasksTab: (title?: string) => string
  openTraceTab: (sessionId: string, title?: string) => string
  openTerminalTab: (cwd?: string, terminalRuntimeId?: string) => string
  openWorkbenchTab: (sessionId: string, title?: string, origin?: WorkbenchTabOrigin) => string
  returnFromWorkbench: (tabId: string) => void
  openSubagentTab: (sourceSessionId: string, toolUseId: string, title?: string, taskId?: string) => string
  closeTab: (sessionId: string) => void
  setActiveTab: (sessionId: string) => void
  updateTabTitle: (sessionId: string, title: string) => void
  updateTabStatus: (sessionId: string, status: Tab['status']) => void
  replaceTabSession: (oldSessionId: string, newSessionId: string) => void
  moveTab: (fromIndex: number, toIndex: number) => void
  saveTabs: () => void
  restoreTabs: () => Promise<void>
}

const PERSISTENT_SPECIAL_TAB_IDS: Record<PersistentSpecialTabType, string> = {
  settings: SETTINGS_TAB_ID,
  scheduled: SCHEDULED_TAB_ID,
  market: MARKET_TAB_ID,
  traces: TRACE_LIST_TAB_ID,
  'collab-tasks': COLLAB_TASKS_TAB_ID,
}

function getPersistentSpecialTabType(tab: Pick<Tab, 'sessionId'> & { type?: TabType }): PersistentSpecialTabType | null {
  if (tab.sessionId === SETTINGS_TAB_ID) return 'settings'
  if (tab.sessionId === SCHEDULED_TAB_ID) return 'scheduled'
  if (tab.sessionId === MARKET_TAB_ID) return 'market'
  if (tab.sessionId === TRACE_LIST_TAB_ID) return 'traces'
  if (tab.sessionId === COLLAB_TASKS_TAB_ID || tab.type === 'collab-tasks') return 'collab-tasks'
  if (tab.type === 'settings' || tab.type === 'scheduled' || tab.type === 'market' || tab.type === 'traces') return tab.type
  return null
}

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  openTab: (sessionId, title, type) => {
    const tabs = get().tabs
    set({ tabs: tabs.some((tab) => tab.sessionId === sessionId) ? tabs.map((tab) => tab.sessionId === sessionId ? { ...tab, title, type: type ?? tab.type ?? 'session' } : tab) : [...tabs, { sessionId, title, type: type ?? 'session', status: 'idle' }], activeTabId: sessionId })
    get().saveTabs()
  },
  openTracesTab: (title = 'Traces') => {
    const id = TRACE_LIST_TAB_ID
    const tabs = get().tabs
    set({ tabs: tabs.some((tab) => tab.sessionId === id) ? tabs.map((tab) => tab.sessionId === id ? { ...tab, title, type: 'traces' } : tab) : [...tabs, { sessionId: id, title, type: 'traces', status: 'idle' }], activeTabId: id })
    get().saveTabs()
    return id
  },
  openCollabTasksTab: (title = '协作任务台账') => {
    const id = COLLAB_TASKS_TAB_ID
    const tabs = get().tabs
    set({ tabs: tabs.some((tab) => tab.sessionId === id) ? tabs.map((tab) => tab.sessionId === id ? { ...tab, title, type: 'collab-tasks' } : tab) : [...tabs, { sessionId: id, title, type: 'collab-tasks', status: 'idle' }], activeTabId: id })
    get().saveTabs()
    return id
  },
  openTraceTab: (sessionId, title = 'Trace') => {
    const id = `${TRACE_TAB_PREFIX}${sessionId}`
    const tabs = get().tabs
    set({ tabs: tabs.some((tab) => tab.sessionId === id) ? tabs.map((tab) => tab.sessionId === id ? { ...tab, title, type: 'trace', traceSessionId: sessionId } : tab) : [...tabs, { sessionId: id, title, type: 'trace', status: 'idle', traceSessionId: sessionId }], activeTabId: id })
    get().saveTabs()
    return id
  },
  openTerminalTab: (cwd, terminalRuntimeId) => {
    const nextIndex = Math.max(0, ...get().tabs.filter((tab) => tab.type === 'terminal').map((tab) => Number(/^Terminal (\d+)$/.exec(tab.title)?.[1] ?? 0))) + 1
    const id = `${TERMINAL_TAB_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set({ tabs: [...get().tabs, { sessionId: id, title: `Terminal ${nextIndex}`, type: 'terminal', status: 'idle', terminalCwd: cwd, terminalRuntimeId }], activeTabId: id })
    get().saveTabs()
    return id
  },
  openWorkbenchTab: (sessionId, title = 'Workbench', origin) => {
    const id = `${WORKBENCH_TAB_PREFIX}${sessionId}`
    const tab: Tab = { sessionId: id, title, type: 'workbench', status: 'idle', workbenchSessionId: sessionId, sourceSessionId: origin?.sourceSessionId ?? sessionId, ...(origin?.sourceTurnKey ? { sourceTurnKey: origin.sourceTurnKey } : {}), ...(origin?.sourceElementId ? { sourceElementId: origin.sourceElementId } : {}) }
    const tabs = get().tabs
    set({ tabs: tabs.some((item) => item.sessionId === id) ? tabs.map((item) => item.sessionId === id ? tab : item) : [...tabs, tab], activeTabId: id })
    get().saveTabs()
    return id
  },
  returnFromWorkbench: (id) => {
    const tab = get().tabs.find((item) => item.sessionId === id)
    if (tab?.type !== 'workbench') return
    if (tab.sourceSessionId && get().tabs.some((item) => item.sessionId === tab.sourceSessionId)) get().setActiveTab(tab.sourceSessionId)
    get().closeTab(id)
  },
  openSubagentTab: (sourceSessionId, toolUseId, title = 'SubAgent', taskId) => {
    const id = `${SUBAGENT_TAB_PREFIX}${sourceSessionId}__${toolUseId}`
    const tab: Tab = { sessionId: id, title, type: 'subagent', status: 'idle', sourceSessionId, subagentToolUseId: toolUseId, ...(taskId ? { subagentTaskId: taskId } : {}) }
    const tabs = get().tabs
    set({ tabs: tabs.some((item) => item.sessionId === id) ? tabs.map((item) => item.sessionId === id ? tab : item) : [...tabs, tab], activeTabId: id })
    get().saveTabs()
    return id
  },
  closeTab: (sessionId) => {
    const { tabs, activeTabId } = get()
    const index = tabs.findIndex((tab) => tab.sessionId === sessionId)
    if (index < 0) return
    const nextTabs = tabs.filter((tab) => tab.sessionId !== sessionId)
    const nextActive = activeTabId === sessionId ? nextTabs[Math.min(index, nextTabs.length - 1)]?.sessionId ?? null : activeTabId
    set({ tabs: nextTabs, activeTabId: nextActive })
    get().saveTabs()
    const closed = tabs[index]
    if (closed?.type === 'terminal') destroyTerminalRuntime(closed.terminalRuntimeId ?? closed.sessionId)
    dropVirtualHeightSession(sessionId)
  },
  setActiveTab: (id) => { set({ activeTabId: id }); get().saveTabs() },
  updateTabTitle: (id, title) => { set((state) => ({ tabs: state.tabs.map((tab) => tab.sessionId === id ? { ...tab, title } : tab) })); get().saveTabs() },
  updateTabStatus: (id, status) => set((state) => ({ tabs: state.tabs.map((tab) => tab.sessionId === id ? { ...tab, status } : tab) })),
  replaceTabSession: (oldId, newId) => { set((state) => ({ tabs: state.tabs.map((tab) => tab.sessionId === oldId ? { ...tab, sessionId: newId } : tab), activeTabId: state.activeTabId === oldId ? newId : state.activeTabId })); get().saveTabs() },
  moveTab: (from, to) => {
    if (from === to) return
    const tabs = [...get().tabs]
    if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length) return
    const [moved] = tabs.splice(from, 1)
    tabs.splice(to, 0, moved!)
    set({ tabs })
    get().saveTabs()
  },
  saveTabs: () => {
    const { tabs, activeTabId } = get()
    const persistable = tabs.filter((tab) => tab.type !== 'terminal' && tab.type !== 'workbench' && tab.type !== 'subagent')
    const active = tabs.find((tab) => tab.sessionId === activeTabId)
    const persistedActiveTabId = activeTabId && persistable.some((tab) => tab.sessionId === activeTabId) ? activeTabId : active?.type === 'workbench' && active.sourceSessionId && persistable.some((tab) => tab.sessionId === active.sourceSessionId) ? active.sourceSessionId : persistable[0]?.sessionId ?? null
    try { localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify({ openTabs: persistable.map((tab) => ({ sessionId: tab.sessionId, title: tab.title, type: tab.type, ...(tab.traceSessionId ? { traceSessionId: tab.traceSessionId } : {}) })), activeTabId: persistedActiveTabId })) } catch { /* noop */ }
  },
  restoreTabs: async () => {
    try {
      const started = get()
      const raw = localStorage.getItem(TAB_STORAGE_KEY)
      if (!raw) return
      const data = JSON.parse(raw) as TabPersistence
      if (!data.openTabs?.length) { set({ tabs: [], activeTabId: null }); localStorage.removeItem(TAB_STORAGE_KEY); return }
      const { sessions } = await sessionsApi.list({ limit: 200 })
      if (get().tabs !== started.tabs || get().activeTabId !== started.activeTabId) return
      useSessionRuntimeStore.getState().syncFromSessions(sessions)
      const ids = new Set(sessions.map((session) => session.id))
      const tabs: Tab[] = data.openTabs.filter((tab) => getPersistentSpecialTabType(tab) || (tab.type === 'trace' ? Boolean(tab.traceSessionId && ids.has(tab.traceSessionId)) : tab.type !== 'terminal' && ids.has(tab.sessionId))).map((tab) => {
        const special = getPersistentSpecialTabType(tab)
        if (special) return { sessionId: PERSISTENT_SPECIAL_TAB_IDS[special], title: tab.title, type: special, status: 'idle' as const }
        if (tab.type === 'trace' && tab.traceSessionId) return { sessionId: `${TRACE_TAB_PREFIX}${tab.traceSessionId}`, title: sessions.find((session) => session.id === tab.traceSessionId)?.title || tab.title, type: 'trace' as const, status: 'idle' as const, traceSessionId: tab.traceSessionId }
        return { sessionId: tab.sessionId, title: sessions.find((session) => session.id === tab.sessionId)?.title || tab.title, type: 'session' as const, status: 'idle' as const }
      })
      if (!tabs.length) { set({ tabs: [], activeTabId: null }); localStorage.removeItem(TAB_STORAGE_KEY); return }
      const activeTabId = data.activeTabId && tabs.some((tab) => tab.sessionId === data.activeTabId) ? data.activeTabId : tabs[0]!.sessionId
      set({ tabs, activeTabId })
    } catch { /* noop */ }
  },
}))
