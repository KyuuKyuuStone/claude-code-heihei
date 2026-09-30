import { create } from 'zustand'
import {
  sessionsApi,
  type BatchDeleteSessionsResponse,
  type BranchSessionResponse,
  type CreateSessionRepositoryOptions,
} from '../api/sessions'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useSettingsStore } from './settingsStore'
import { useTabStore } from './tabStore'
import type { LocalIndexStatus, SessionListItem } from '../types/session'
import type { PermissionMode } from '../types/settings'
import { isPlaceholderSessionTitle } from '../lib/sessionTitle'
import { invalidateRecentProjectsCache } from '../lib/recentProjectsCache'
import { subscribeGlobalEvents } from './globalEventsChannel'

/** C12：服务端会话列表失效广播（事件契约 v1.5.0 §3） */
const SESSION_LIST_INVALIDATED_SUBTYPE = 'session_list_invalidated'
const SESSION_LIST_INVALIDATED_DEBOUNCE_MS = 300

const SESSION_LIST_LIMIT = 400

type CreateSessionOptions = {
  repository?: CreateSessionRepositoryOptions
  permissionMode?: PermissionMode
}

type BranchSessionResult = Pick<BranchSessionResponse, 'sessionId' | 'title' | 'workDir'>

type SessionStore = {
  sessions: SessionListItem[]
  activeSessionId: string | null
  isLoading: boolean
  error: string | null
  indexStatus: LocalIndexStatus | null
  sessionListRequestId: number
  isBatchMode: boolean
  selectedSessionIds: Set<string>

  fetchSessions: (project?: string) => Promise<void>
  /**
   * C12（事件契约 v1.5.0 §3）：订阅 session_list_invalidated——服务端会话列表
   * 缓存失效（创建/删除/改标题/转录变更）时广播，前端 300ms 防抖后刷新列表，
   * 替代高频轮询；重连成功补一次全量刷新（断线窗口事件可能丢失）。
   * epoch 单调递增，仅用于合并 pending 刷新。返回退订函数。
   */
  subscribeSessionListEvents: () => () => void
  createSession: (workDir?: string, options?: CreateSessionOptions) => Promise<string>
  branchSession: (
    sourceSessionId: string,
    targetMessageId: string,
    options?: { title?: string },
  ) => Promise<BranchSessionResult>
  deleteSession: (id: string) => Promise<void>
  deleteSessions: (ids: string[]) => Promise<BatchDeleteSessionsResponse>
  enterBatchMode: () => void
  exitBatchMode: () => void
  toggleSessionSelected: (id: string) => void
  selectSessions: (ids: string[]) => void
  deselectSessions: (ids: string[]) => void
  clearSessionSelection: () => void
  renameSession: (id: string, title: string) => Promise<void>
  updateSessionTitle: (id: string, title: string) => void
  updateSessionMessageCount: (id: string, messageCount: number) => void
  updateSessionPermissionMode: (id: string, mode: PermissionMode) => void
  setActiveSession: (id: string | null) => void
}

let fetchSessionsRequestId = 0

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoading: false,
  error: null,
  indexStatus: null,
  sessionListRequestId: 0,
  isBatchMode: false,
  selectedSessionIds: new Set(),

  fetchSessions: async (project?: string) => {
    const requestId = ++fetchSessionsRequestId
    set({ isLoading: true, error: null, sessionListRequestId: requestId })
    try {
      const response = await sessionsApi.list(buildSessionListParams(project))
      if (requestId !== get().sessionListRequestId) return
      const raw = response.sessions
      const indexStatus = response.index ?? null
      useSessionRuntimeStore.getState().syncFromSessions(raw)
      let syncedSessions: SessionListItem[] = []
      set((state) => {
        if (requestId !== state.sessionListRequestId) return state
        const sessions = mergeSessionList(
          shouldRetainRenderedSessions(indexStatus)
            ? [...raw, ...state.sessions]
            : raw,
          state.sessions,
        )
        syncedSessions = sessions
        return {
          sessions,
          indexStatus,
          isLoading: indexStatus?.state === 'building' && sessions.length === 0,
        }
      })
      syncOpenSessionTabTitles(syncedSessions)
    } catch (err) {
      if (requestId !== get().sessionListRequestId) return
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  subscribeSessionListEvents: () => {
    // 300ms 防抖合并突发事件（服务端自身也有 250ms 合并，这里是第二道）；
    // 退订时必须清掉 pending 定时器，否则卸载后还会触发一次刷新。
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    let pendingEpoch = -1

    const scheduleRefresh = (epoch: number | null) => {
      if (epoch !== null && epoch <= pendingEpoch) return
      if (epoch !== null) pendingEpoch = epoch
      if (refreshTimer) return
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void get().fetchSessions()
      }, SESSION_LIST_INVALIDATED_DEBOUNCE_MS)
    }

    const unsubscribe = subscribeGlobalEvents(
      (msg) => {
        if (msg.type !== 'system_notification' || msg.subtype !== SESSION_LIST_INVALIDATED_SUBTYPE) {
          return
        }
        const epoch =
          msg.data && typeof msg.data === 'object' &&
          typeof (msg.data as { epoch?: unknown }).epoch === 'number'
            ? (msg.data as { epoch: number }).epoch
            : null
        scheduleRefresh(epoch)
      },
      () => {
        // 重连全量对齐（断线窗口的失效事件可能丢失）；不刷新防抖 pending，
        // 立即拉——重连本身就是低频事件。
        if (refreshTimer) {
          clearTimeout(refreshTimer)
          refreshTimer = null
        }
        pendingEpoch = -1
        void get().fetchSessions()
      },
    )

    return () => {
      unsubscribe()
      if (refreshTimer) {
        clearTimeout(refreshTimer)
        refreshTimer = null
      }
    }
  },

  createSession: async (workDir?: string, options?: CreateSessionOptions) => {
    const requestedPermissionMode = options?.permissionMode ?? getDefaultSessionPermissionMode()
    const { sessionId: id, workDir: resolvedWorkDir } = await sessionsApi.create({
      ...(workDir ? { workDir } : {}),
      ...(options?.repository ? { repository: options.repository } : {}),
      ...(requestedPermissionMode ? { permissionMode: requestedPermissionMode } : {}),
    })
    invalidateRecentProjectsCache()
    const now = new Date().toISOString()
    const optimisticSession: SessionListItem = {
      id,
      title: 'New Session',
      createdAt: now,
      modifiedAt: now,
      messageCount: 0,
      projectPath: '',
      workDir: resolvedWorkDir ?? workDir ?? null,
      projectRoot: resolvedWorkDir ?? workDir ?? null,
      workDirExists: true,
      permissionMode: requestedPermissionMode,
    }

    set((state) => ({
      sessions: state.sessions.some((session) => session.id === id)
        ? state.sessions
        : [optimisticSession, ...state.sessions],
      activeSessionId: id,
    }))

    void get().fetchSessions()
    return id
  },

  branchSession: async (sourceSessionId, targetMessageId, options) => {
    const result = await sessionsApi.branch(sourceSessionId, {
      targetMessageId,
      ...(options?.title ? { title: options.title } : {}),
    })
    invalidateRecentProjectsCache()
    const sourceSession = get().sessions.find((session) => session.id === sourceSessionId)
    const now = new Date().toISOString()
    const optimisticSession: SessionListItem = {
      id: result.sessionId,
      title: result.title || 'New Session',
      createdAt: now,
      modifiedAt: now,
      messageCount: 0,
      projectPath: sourceSession?.projectPath ?? '',
      projectRoot: sourceSession?.projectRoot ?? sourceSession?.workDir ?? result.workDir ?? null,
      workDir: result.workDir ?? sourceSession?.workDir ?? null,
      workDirExists: true,
    }

    set((state) => ({
      sessions: state.sessions.some((session) => session.id === result.sessionId)
        ? state.sessions.map((session) =>
            session.id === result.sessionId
              ? { ...session, ...optimisticSession }
              : session)
        : [optimisticSession, ...state.sessions],
      activeSessionId: result.sessionId,
    }))

    void get().fetchSessions()
    return {
      sessionId: result.sessionId,
      title: result.title,
      workDir: result.workDir,
    }
  },

  deleteSession: async (id: string) => {
    await sessionsApi.delete(id)
    invalidateRecentProjectsCache()
    useSessionRuntimeStore.getState().clearSelection(id)
    set((s) => ({
      sessions: s.sessions.filter((session) => session.id !== id),
      activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
      selectedSessionIds: removeIdsFromSet(s.selectedSessionIds, [id]),
    }))
  },

  deleteSessions: async (ids: string[]) => {
    const sessionIds = [...new Set(ids)].filter(Boolean)
    const result = await sessionsApi.batchDelete(sessionIds)
    if (result.successes.length > 0) {
      invalidateRecentProjectsCache()
    }
    for (const id of result.successes) {
      useSessionRuntimeStore.getState().clearSelection(id)
    }
    set((s) => ({
      sessions: s.sessions.filter((session) => !result.successes.includes(session.id)),
      activeSessionId: s.activeSessionId && result.successes.includes(s.activeSessionId)
        ? null
        : s.activeSessionId,
      selectedSessionIds: removeIdsFromSet(s.selectedSessionIds, result.successes),
    }))
    return result
  },

  enterBatchMode: () => set({ isBatchMode: true }),
  exitBatchMode: () => set({ isBatchMode: false, selectedSessionIds: new Set() }),
  toggleSessionSelected: (id) => set((s) => {
    const selectedSessionIds = new Set(s.selectedSessionIds)
    if (selectedSessionIds.has(id)) {
      selectedSessionIds.delete(id)
    } else {
      selectedSessionIds.add(id)
    }
    return { selectedSessionIds }
  }),
  selectSessions: (ids) => set((s) => {
    const selectedSessionIds = new Set(s.selectedSessionIds)
    for (const id of ids) selectedSessionIds.add(id)
    return { selectedSessionIds }
  }),
  deselectSessions: (ids) => set((s) => ({
    selectedSessionIds: removeIdsFromSet(s.selectedSessionIds, ids),
  })),
  clearSessionSelection: () => set({ selectedSessionIds: new Set() }),

  renameSession: async (id: string, title: string) => {
    await sessionsApi.rename(id, title)
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === id ? { ...session, title } : session,
      ),
    }))
  },

  updateSessionTitle: (id, title) => {
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === id ? { ...session, title } : session,
      ),
    }))
  },

  updateSessionMessageCount: (id, messageCount) => {
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === id ? { ...session, messageCount } : session,
      ),
    }))
  },

  updateSessionPermissionMode: (id, mode) => {
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === id ? { ...session, permissionMode: mode } : session,
      ),
    }))
  },

  setActiveSession: (id) => set({ activeSessionId: id }),
}))

function removeIdsFromSet(selected: Set<string>, ids: string[]): Set<string> {
  if (ids.length === 0) return selected
  const next = new Set(selected)
  for (const id of ids) next.delete(id)
  return next
}

function buildSessionListParams(project: string | undefined) {
  return project
    ? { project, limit: SESSION_LIST_LIMIT }
    : { limit: SESSION_LIST_LIMIT }
}

function getDefaultSessionPermissionMode(): PermissionMode | undefined {
  const mode = useSettingsStore.getState().permissionMode
  return mode === 'default' ? undefined : mode
}

function mergeSessionList(
  incoming: SessionListItem[],
  currentForTitle: SessionListItem[],
): SessionListItem[] {
  const currentById = new Map(currentForTitle.map((session) => [session.id, session]))
  const byId = new Map<string, SessionListItem>()

  for (const item of incoming) {
    const current = currentById.get(item.id)
    const candidate = preserveLocalTitle(current, item)
    const existing = byId.get(candidate.id)
    if (!existing || sessionModifiedTime(candidate) > sessionModifiedTime(existing)) {
      byId.set(candidate.id, candidate)
    }
  }

  return [...byId.values()].sort((a, b) => sessionModifiedTime(b) - sessionModifiedTime(a))
}

function shouldRetainRenderedSessions(indexStatus: LocalIndexStatus | null): boolean {
  return indexStatus?.mode === 'on' && indexStatus.state === 'building'
}

function sessionModifiedTime(session: SessionListItem): number {
  const timestamp = new Date(session.modifiedAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function preserveLocalTitle(
  current: SessionListItem | undefined,
  incoming: SessionListItem,
): SessionListItem {
  if (!current) return incoming
  if (isPlaceholderSessionTitle(incoming.title) && !isPlaceholderSessionTitle(current.title)) {
    return { ...incoming, title: current.title }
  }
  return incoming
}

function syncOpenSessionTabTitles(sessions: SessionListItem[]): void {
  const titleById = new Map(sessions.map((session) => [session.id, session.title]))
  const { tabs, updateTabTitle } = useTabStore.getState()
  for (const tab of tabs) {
    if (tab.type !== 'session') continue
    const title = titleById.get(tab.sessionId)
    if (title && title !== tab.title) {
      updateTabTitle(tab.sessionId, title)
    }
  }
}
