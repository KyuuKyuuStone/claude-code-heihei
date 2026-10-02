import { create } from 'zustand'
import type { ApiErrorWithKind, ApiFailureKind } from '../api/client'
import { collabTasksApi, type CollabTask, type CollabTaskStatus } from '../api/collabTasks'
import type { ServerMessage } from '../types/chat'
import type { WebSocketConnectionState } from '../api/websocket'
import { subscribeGlobalEvents } from './globalEventsChannel'

const COLLAB_TASK_CHANGED_SUBTYPE = 'collab_task_changed'
export const TASK_EVENT_DEBOUNCE_MS = 150

type CollabTaskStore = {
  dispatchedBySessionId: Record<string, true>
  tasksById: Record<string, CollabTask>
  activeProjectDir: string | null
  activeProjectSessionId: string | null
  isLoading: boolean
  error: string | null
  /** [defect] 裁决十四：与 sessionStore.errorKind 同构，供展示层 describeApiFailure 映射。 */
  errorKind?: ApiFailureKind
  connectionState: WebSocketConnectionState
  serverReady: boolean
  refreshDispatched: () => Promise<void>
  refreshForSession: (sessionId: string, options?: { clear?: boolean }) => Promise<void>
  refreshForProject: (projectDir: string, options?: { clear?: boolean }) => Promise<void>
  clearProjectTasks: () => void
  checkServerIdentity: (retryIfInFlight?: boolean) => Promise<void>
  setConnectionState: (state: WebSocketConnectionState) => void
  subscribeTaskEvents: () => () => void
}

let dispatchInFlight: Promise<void> | null = null
let dispatchTrailing = false
let dispatchGeneration = 0
let taskGeneration = 0
let identityCheckInFlight: Promise<void> | null = null
let identityCheckTrailing = false
let identityCheckGeneration = 0

export function resetCollabTaskRefreshForTests(): void {
  dispatchGeneration += 1
  taskGeneration += 1
  identityCheckGeneration += 1
  identityCheckInFlight = null
  identityCheckTrailing = false
  dispatchInFlight = null
  dispatchTrailing = false
}

function toTaskMap(tasks: CollabTask[]): Record<string, CollabTask> {
  return Object.fromEntries(tasks.map((task) => [task.id, task]))
}

async function loadDispatched(): Promise<Record<string, true>> {
  const { tasks } = await collabTasksApi.listDispatched()
  return Object.fromEntries(tasks.map((task) => [task.toSessionId, true]))
}

export const useCollabTaskStore = create<CollabTaskStore>((set, get) => ({
  dispatchedBySessionId: {},
  tasksById: {},
  activeProjectDir: null,
  activeProjectSessionId: null,
  isLoading: false,
  error: null, errorKind: undefined,
  connectionState: 'disconnected',
  serverReady: false,

  refreshDispatched: () => {
    if (dispatchInFlight) { dispatchTrailing = true; return dispatchInFlight }
    const startedAt = dispatchGeneration
    let request: Promise<void> | null = null
    const isOwner = () => dispatchInFlight === request
    request = (async () => {
      try {
        const next = await loadDispatched()
        if (startedAt === dispatchGeneration) set({ dispatchedBySessionId: next })
        else if (isOwner()) dispatchTrailing = true
      } catch { /* keep last successful snapshot */ }
      finally {
        if (isOwner()) {
          dispatchInFlight = null
          if (dispatchTrailing) { dispatchTrailing = false; void get().refreshDispatched() }
        }
      }
    })()
    dispatchInFlight = request
    return request
  },

  refreshForSession: async (sessionId, options) => {
    const requestId = ++taskGeneration
    set({ activeProjectSessionId: sessionId, activeProjectDir: null, error: null, errorKind: undefined, isLoading: true, ...(options?.clear ? { tasksById: {} } : {}) })
    try {
      const { tasks, projectDir } = await collabTasksApi.listForSession(sessionId)
      if (requestId !== taskGeneration) return
      set({ tasksById: toTaskMap(tasks), activeProjectDir: typeof projectDir === 'string' ? projectDir : null, error: null, errorKind: undefined })
      void get().refreshDispatched()
    } catch (error) {
      if (requestId === taskGeneration) set({ errorKind: (error as ApiErrorWithKind).kind, error: error instanceof Error ? error.message : '任务列表加载失败' })
    } finally { if (requestId === taskGeneration) set({ isLoading: false }) }
  },

  refreshForProject: async (projectDir, options) => {
    const requestId = ++taskGeneration
    set({ activeProjectSessionId: null, activeProjectDir: projectDir, error: null, errorKind: undefined, isLoading: Object.keys(get().tasksById).length === 0 || Boolean(options?.clear), ...(options?.clear ? { tasksById: {} } : {}) })
    try {
      const { tasks } = await collabTasksApi.listForProject(projectDir)
      if (requestId !== taskGeneration) return
      set({ tasksById: toTaskMap(tasks), error: null, errorKind: undefined })
      void get().refreshDispatched()
    } catch (error) {
      if (requestId === taskGeneration) set({ errorKind: (error as ApiErrorWithKind).kind, error: error instanceof Error ? error.message : '任务列表加载失败' })
    } finally { if (requestId === taskGeneration) set({ isLoading: false }) }
  },

  clearProjectTasks: () => {
    taskGeneration += 1
    set({ tasksById: {}, activeProjectSessionId: null, activeProjectDir: null, isLoading: false, error: null, errorKind: undefined })
  },

  checkServerIdentity: (retryIfInFlight = false) => {
    if (identityCheckInFlight) {
      if (retryIfInFlight) identityCheckTrailing = true
      return identityCheckInFlight
    }
    const requestId = ++identityCheckGeneration
    const request = Promise.resolve().then(async () => {
      try {
        const identity = await collabTasksApi.whoami()
        if (requestId === identityCheckGeneration) set({ serverReady: identity.app === 'cc-heihei' })
      } catch {
        if (requestId === identityCheckGeneration) set({ serverReady: false })
      } finally {
        if (identityCheckInFlight === request) {
          identityCheckInFlight = null
          if (identityCheckTrailing) {
            identityCheckTrailing = false
            void get().checkServerIdentity()
          }
        }
      }
    })
    identityCheckInFlight = request
    return request
  },

  setConnectionState: (connectionState) => {
    const wasConnected = get().connectionState === 'connected'
    set({ connectionState })
    if (connectionState === 'connected' && !wasConnected) void get().checkServerIdentity(true)
  },

  subscribeTaskEvents: () => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        const { activeProjectSessionId, activeProjectDir } = get()
        if (activeProjectSessionId) void get().refreshForSession(activeProjectSessionId)
        else if (activeProjectDir) void get().refreshForProject(activeProjectDir)
        void get().refreshDispatched()
      }, TASK_EVENT_DEBOUNCE_MS)
    }
    const unsubscribe = subscribeGlobalEvents((message: ServerMessage) => {
      if (message.type !== 'system_notification' || message.subtype !== COLLAB_TASK_CHANGED_SUBTYPE) return
      if (!message.data || typeof message.data !== 'object') return
      const data = message.data as { taskId?: unknown; projectDir?: unknown; status?: unknown }
      if (typeof data.taskId !== 'string' || typeof data.projectDir !== 'string') return
      const state = get()
      const existing = state.tasksById[data.taskId]
      const belongsToActiveProject = !state.activeProjectDir || data.projectDir === state.activeProjectDir
      if (belongsToActiveProject && existing && isTaskStatus(data.status)) set((current) => {
        const task = current.tasksById[data.taskId as string]
        return task ? { tasksById: { ...current.tasksById, [task.id]: { ...task, status: data.status as CollabTaskStatus } } } : current
      })
      scheduleRefresh()
    }, () => {
      dispatchGeneration += 1
      taskGeneration += 1
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = null
      set({ tasksById: {}, dispatchedBySessionId: {} })
      const { activeProjectSessionId, activeProjectDir } = get()
      if (activeProjectSessionId) void get().refreshForSession(activeProjectSessionId, { clear: true })
      else if (activeProjectDir) void get().refreshForProject(activeProjectDir, { clear: true })
      void get().refreshDispatched()
      // 探活由 setConnectionState 的 connected 边沿统一触发（下方 :150），此处
      // 不再重复发起——同一次重连原本会同 tick 双路径触发两次（第二次被
      // in-flight 去重吞掉，属冗余触发源）。
    }, (state) => get().setConnectionState(state))
    // 订阅时若通道已连接（面板是后挂载的订阅方）立即探活；否则等 WS
    // connected 边沿统一触发——避免首订户挂载时「立即探 + 边沿探」双发。
    if (get().connectionState === 'connected') void get().checkServerIdentity()
    return () => { unsubscribe(); if (refreshTimer) clearTimeout(refreshTimer) }
  },
}))

function isTaskStatus(value: unknown): value is CollabTaskStatus {
  return value === 'dispatched' || value === 'accepted' || value === 'in_progress' || value === 'delivered' || value === 'verified' || value === 'rework' || value === 'failed' || value === 'cancelled'
}
