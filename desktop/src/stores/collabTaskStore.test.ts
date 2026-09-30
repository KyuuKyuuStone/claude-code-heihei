import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiListDispatchedMock = vi.hoisted(() => vi.fn())
const apiListForSessionMock = vi.hoisted(() => vi.fn())
const apiListForProjectMock = vi.hoisted(() => vi.fn())
const apiWhoamiMock = vi.hoisted(() => vi.fn())

vi.mock('../api/collabTasks', () => ({
  collabTasksApi: {
    listDispatched: apiListDispatchedMock,
    listForSession: apiListForSessionMock,
    listForProject: apiListForProjectMock,
    whoami: apiWhoamiMock,
  },
}))

const wsManagerMock = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: unknown) => void>()
  const stateHandlers = new Set<(state: string) => void>()
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage(_id: string, handler: (msg: unknown) => void) {
      messageHandlers.add(handler)
      return () => { messageHandlers.delete(handler) }
    },
    onConnectionState(_id: string, handler: (state: string) => void) {
      stateHandlers.add(handler)
      return () => { stateHandlers.delete(handler) }
    },
    emitMessage(msg: unknown) {
      for (const handler of messageHandlers) handler(msg)
    },
    emitState(state: string) {
      for (const handler of stateHandlers) handler(state)
    },
    reset() {
      messageHandlers.clear()
      stateHandlers.clear()
    },
  }
})

vi.mock('../api/websocket', () => ({
  wsManager: wsManagerMock,
  buildSessionWebSocketUrl: vi.fn(),
}))

import { TASK_EVENT_DEBOUNCE_MS, resetCollabTaskRefreshForTests, useCollabTaskStore } from './collabTaskStore'
import { resetGlobalEventsChannelForTests } from './globalEventsChannel'
import type { CollabTask } from '../api/collabTasks'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function makeTask(overrides: Partial<CollabTask> = {}): CollabTask {
  return {
    id: 'task-1',
    projectDir: '/workspace/alpha',
    fromSessionId: 'supervisor',
    toSessionId: 'sess-1',
    title: 'Do the thing',
    content: 'Details',
    status: 'dispatched',
    deliverables: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('collabTaskStore', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    wsManagerMock.reset()
    resetGlobalEventsChannelForTests()
    resetCollabTaskRefreshForTests()
    useCollabTaskStore.setState({ dispatchedBySessionId: {}, tasksById: {}, activeProjectDir: null, activeProjectSessionId: null, isLoading: false, error: null, connectionState: 'disconnected', serverReady: false })
    apiWhoamiMock.mockResolvedValue({ app: 'cc-heihei' })
    apiListForSessionMock.mockResolvedValue({ tasks: [], projectDir: '/workspace/alpha' })
    apiListForProjectMock.mockResolvedValue({ tasks: [] })
    apiListDispatchedMock.mockResolvedValue({ tasks: [] })
  })

  it('discards stale session responses when a newer session request finishes first', async () => {
    const oldResponse = deferred<{ tasks: CollabTask[]; projectDir: string }>()
    const newResponse = deferred<{ tasks: CollabTask[]; projectDir: string }>()
    apiListForSessionMock.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise)

    const oldRequest = useCollabTaskStore.getState().refreshForSession('session-old')
    const newRequest = useCollabTaskStore.getState().refreshForSession('session-new')
    newResponse.resolve({ tasks: [makeTask({ id: 'new-task' })], projectDir: '/workspace/new' })
    await newRequest
    oldResponse.resolve({ tasks: [makeTask({ id: 'old-task' })], projectDir: '/workspace/old' })
    await oldRequest

    expect(useCollabTaskStore.getState().tasksById).toEqual({ 'new-task': expect.objectContaining({ id: 'new-task' }) })
    expect(useCollabTaskStore.getState().activeProjectDir).toBe('/workspace/new')
  })

  it('aggregates dispatched tasks by target session', async () => {
    apiListDispatchedMock.mockResolvedValue({
      tasks: [makeTask(), makeTask({ id: 'task-2', toSessionId: 'sess-2' })],
    })

    await useCollabTaskStore.getState().refreshDispatched()

    expect(useCollabTaskStore.getState().dispatchedBySessionId).toEqual({
      'sess-1': true,
      'sess-2': true,
    })
  })

  it('keeps the previous copy when the fetch fails (no false "none pending")', async () => {
    useCollabTaskStore.setState({ dispatchedBySessionId: { keep: true } })
    apiListDispatchedMock.mockRejectedValue(new Error('offline'))

    await useCollabTaskStore.getState().refreshDispatched()

    expect(useCollabTaskStore.getState().dispatchedBySessionId).toEqual({ keep: true })
  })

  it('refreshes (debounced) on collab_task_changed and ignores other subtypes', async () => {
    apiListDispatchedMock.mockResolvedValue({ tasks: [makeTask()] })
    const unsubscribe = useCollabTaskStore.getState().subscribeTaskEvents()

    // 无关 subtype 不触发
    wsManagerMock.emitMessage({ type: 'system_notification', subtype: 'session_list_invalidated', data: {} })
    expect(apiListDispatchedMock).not.toHaveBeenCalled()

    wsManagerMock.emitMessage({
      type: 'system_notification',
      subtype: 'collab_task_changed',
      data: { taskId: 'task-1', projectDir: '/workspace/alpha', change: 'created', status: 'dispatched' },
    })
    // 防抖窗口内不立即拉，避免状态流转连发时拉取风暴
    expect(apiListDispatchedMock).not.toHaveBeenCalled()

    await vi.waitFor(() => {
      expect(useCollabTaskStore.getState().dispatchedBySessionId).toEqual({ 'sess-1': true })
    })
    expect(apiListDispatchedMock).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('reloads the active session when a task event arrives', async () => {
    useCollabTaskStore.setState({ activeProjectSessionId: 'session-alpha', activeProjectDir: '/workspace/alpha' })
    const unsubscribe = useCollabTaskStore.getState().subscribeTaskEvents()

    wsManagerMock.emitMessage({
      type: 'system_notification',
      subtype: 'collab_task_changed',
      data: { taskId: 'new-task', projectDir: '/workspace/alpha', change: 'created', status: 'dispatched' },
    })

    await vi.waitFor(() => expect(apiListForSessionMock).toHaveBeenCalledWith('session-alpha'))
    expect(apiListForSessionMock).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('does not patch another project event locally but still reloads the active session', async () => {
    const activeTask = makeTask({ status: 'dispatched' })
    useCollabTaskStore.setState({
      activeProjectSessionId: 'session-alpha',
      activeProjectDir: '/workspace/alpha',
      tasksById: { 'task-1': activeTask },
    })
    const unsubscribe = useCollabTaskStore.getState().subscribeTaskEvents()

    wsManagerMock.emitMessage({
      type: 'system_notification',
      subtype: 'collab_task_changed',
      data: { taskId: 'task-1', projectDir: '/workspace/beta', change: 'status', status: 'verified' },
    })
    expect(useCollabTaskStore.getState().tasksById['task-1']).toBe(activeTask)

    await vi.waitFor(() => expect(apiListForSessionMock).toHaveBeenCalledWith('session-alpha'))
    expect(apiListForSessionMock).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('rechecks server identity after initial failure when the first connection arrives', async () => {
    apiWhoamiMock.mockRejectedValueOnce(new Error('server restarting')).mockResolvedValueOnce({ app: 'cc-heihei' })
    const unsubscribe = useCollabTaskStore.getState().subscribeTaskEvents()
    await vi.waitFor(() => expect(apiWhoamiMock).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(useCollabTaskStore.getState().serverReady).toBe(false))

    useCollabTaskStore.getState().setConnectionState('connected')
    useCollabTaskStore.getState().setConnectionState('connected')
    await vi.waitFor(() => expect(useCollabTaskStore.getState().serverReady).toBe(true))
    expect(apiWhoamiMock).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('clears dispatched state and refreshes on reconnect', async () => {
    useCollabTaskStore.setState({ dispatchedBySessionId: { stale: true } })
    apiListDispatchedMock.mockResolvedValue({ tasks: [] })
    const unsubscribe = useCollabTaskStore.getState().subscribeTaskEvents()

    wsManagerMock.emitState('reconnecting')
    wsManagerMock.emitState('connected')

    await vi.waitFor(() => expect(useCollabTaskStore.getState().dispatchedBySessionId).toEqual({}))
    expect(apiListDispatchedMock).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('coalesces a connection probe that overlaps the initial identity check', async () => {
    const firstProbe = deferred<{ app: string }>()
    apiWhoamiMock.mockReturnValueOnce(firstProbe.promise).mockResolvedValueOnce({ app: 'cc-heihei' })
    const unsubscribe = useCollabTaskStore.getState().subscribeTaskEvents()
    await vi.waitFor(() => expect(apiWhoamiMock).toHaveBeenCalledTimes(1))

    useCollabTaskStore.getState().setConnectionState('connected')
    expect(apiWhoamiMock).toHaveBeenCalledTimes(1)
    firstProbe.resolve({ app: 'wrong-app' })
    await vi.waitFor(() => expect(useCollabTaskStore.getState().serverReady).toBe(true))
    expect(apiWhoamiMock).toHaveBeenCalledTimes(2)
    unsubscribe()
  })


  describe('in-flight race (裁决：并发旧快照不得覆盖新状态)', () => {
    it('coalesces concurrent refreshes into a single trailing refresh', async () => {
      const first = deferred<{ tasks: CollabTask[] }>()
      const second = deferred<{ tasks: CollabTask[] }>()
      apiListDispatchedMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

      const p1 = useCollabTaskStore.getState().refreshDispatched()
      const p2 = useCollabTaskStore.getState().refreshDispatched()

      // 在途合并：第二次调用不发并发请求，只登记 trailing
      expect(apiListDispatchedMock).toHaveBeenCalledTimes(1)

      first.resolve({ tasks: [makeTask({ toSessionId: 'sess-stale' })] })
      await p1
      // trailing：当前请求结束后最多再拉一次
      await vi.waitFor(() => expect(apiListDispatchedMock).toHaveBeenCalledTimes(2))

      second.resolve({ tasks: [makeTask({ toSessionId: 'sess-new' })] })
      await vi.waitFor(() => {
        expect(useCollabTaskStore.getState().dispatchedBySessionId).toEqual({ 'sess-new': true })
      })
      await p2
    })

    it('merges an event arriving mid-flight into one trailing refresh (stale snapshot is corrected)', async () => {
      const slow = deferred<{ tasks: CollabTask[] }>()
      apiListDispatchedMock
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValueOnce({ tasks: [makeTask({ toSessionId: 'sess-new' })] })

      const unsubscribe = useCollabTaskStore.getState().subscribeTaskEvents()
      const inFlightCall = useCollabTaskStore.getState().refreshDispatched()

      wsManagerMock.emitMessage({
        type: 'system_notification',
        subtype: 'collab_task_changed',
        data: { taskId: 'task-1', projectDir: '/workspace/alpha', change: 'status', status: 'accepted' },
      })
      // 防抖到期时首个请求仍在途 → 被合并，不发第二个并发请求
      await new Promise((resolve) => setTimeout(resolve, TASK_EVENT_DEBOUNCE_MS + 40))
      expect(apiListDispatchedMock).toHaveBeenCalledTimes(1)

      // 旧快照（会话仍在待接单）先返回，紧接着 trailing 拉到最新状态（已接单）
      slow.resolve({ tasks: [makeTask({ toSessionId: 'sess-stale' })] })
      await inFlightCall

      await vi.waitFor(() => {
        expect(useCollabTaskStore.getState().dispatchedBySessionId).toEqual({ 'sess-new': true })
      })
      expect(apiListDispatchedMock).toHaveBeenCalledTimes(2)
      unsubscribe()
    })

    it('drops an in-flight stale snapshot when a reconnect clears the copy', async () => {
      const slow = deferred<{ tasks: CollabTask[] }>()
      apiListDispatchedMock.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ tasks: [] })

      const unsubscribe = useCollabTaskStore.getState().subscribeTaskEvents()
      useCollabTaskStore.setState({ dispatchedBySessionId: { 'sess-old': true } })

      const inFlightCall = useCollabTaskStore.getState().refreshDispatched()
      wsManagerMock.emitState('reconnecting')
      wsManagerMock.emitState('connected')

      // 重连前发起的旧响应返回：必须作废，不能把清空结果覆盖回旧快照
      slow.resolve({ tasks: [makeTask({ toSessionId: 'sess-stale' })] })
      await inFlightCall

      await vi.waitFor(() => {
        expect(useCollabTaskStore.getState().dispatchedBySessionId).toEqual({})
      })
      expect(apiListDispatchedMock).toHaveBeenCalledTimes(2)
      unsubscribe()
    })

    it('isolates state from an in-flight request left over before reset', async () => {
      const orphanDeferred = deferred<{ tasks: CollabTask[] }>()
      const freshDeferred = deferred<{ tasks: CollabTask[] }>()
      apiListDispatchedMock
        .mockReturnValueOnce(orphanDeferred.promise)
        .mockReturnValueOnce(freshDeferred.promise)

      // 模拟上一用例超时中断、遗留未完成的在途请求
      const orphan = useCollabTaskStore.getState().refreshDispatched()
      expect(apiListDispatchedMock).toHaveBeenCalledTimes(1)

      resetCollabTaskRefreshForTests()
      useCollabTaskStore.setState({ dispatchedBySessionId: {} })

      const fresh = useCollabTaskStore.getState().refreshDispatched()
      expect(apiListDispatchedMock).toHaveBeenCalledTimes(2)

      // 孤儿请求此刻才返回：不得写入状态
      orphanDeferred.resolve({ tasks: [makeTask({ toSessionId: 'sess-orphan' })] })
      await orphan
      expect(useCollabTaskStore.getState().dispatchedBySessionId).toEqual({})

      // 也不得扰动模块级在途状态：仍应合并进当前请求，而非因孤儿收尾误发新请求
      const merged = useCollabTaskStore.getState().refreshDispatched()
      expect(merged).toBe(fresh)
      expect(apiListDispatchedMock).toHaveBeenCalledTimes(2)

      freshDeferred.resolve({ tasks: [makeTask({ toSessionId: 'sess-after' })] })
      await merged
      expect(useCollabTaskStore.getState().dispatchedBySessionId).toEqual({ 'sess-after': true })
    })
  })
})
