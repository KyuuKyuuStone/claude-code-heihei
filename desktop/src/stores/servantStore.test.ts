import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiListMock = vi.hoisted(() => vi.fn())
const apiSetMock = vi.hoisted(() => vi.fn())
const apiRemoveMock = vi.hoisted(() => vi.fn())
const apiSendMock = vi.hoisted(() => vi.fn())

vi.mock('../api/servants', () => ({
  servantsApi: {
    list: apiListMock,
    set: apiSetMock,
    remove: apiRemoveMock,
    sendMessage: apiSendMock,
  },
}))

const wsManagerMock = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: unknown) => void>()
  const stateHandlers = new Set<(state: string) => void>()
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    // 普通函数而非 vi.fn：beforeEach 的 resetAllMocks 会清空 vi.fn 实现
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

import type { ServantInfo } from '../api/servants'
import { useServantStore } from './servantStore'

function makeServant(overrides: Partial<ServantInfo> = {}): ServantInfo {
  return {
    sessionId: 'sess-1',
    role: '后端',
    enabled: true,
    updatedAt: 1000,
    title: 'API 服务',
    running: false,
    turnInProgress: false,
    ...overrides,
  }
}

describe('servantStore', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    wsManagerMock.reset()
    useServantStore.setState({ bySessionId: {}, isLoading: false })
  })

  it('fetches the roster into a sessionId map', async () => {
    apiListMock.mockResolvedValue({
      servants: [makeServant(), makeServant({ sessionId: 'sess-2', role: '前端' })],
    })

    await useServantStore.getState().fetchServants()

    const map = useServantStore.getState().bySessionId
    expect(Object.keys(map)).toHaveLength(2)
    expect(map['sess-1']?.role).toBe('后端')
    expect(map['sess-2']?.role).toBe('前端')
    expect(useServantStore.getState().isLoading).toBe(false)
  })

  it('removes the entry when setServant disables it', async () => {
    useServantStore.setState({ bySessionId: { 'sess-1': makeServant() } })
    apiSetMock.mockResolvedValue({})
    apiListMock.mockResolvedValue({ servants: [] })

    await useServantStore
      .getState()
      .setServant('sess-1', { role: '后端', enabled: false })

    expect(apiSetMock).toHaveBeenCalledWith('sess-1', {
      role: '后端',
      enabled: false,
    })
    expect(useServantStore.getState().bySessionId['sess-1']).toBeUndefined()
  })

  it('refreshes the roster after enabling a servant', async () => {
    apiSetMock.mockResolvedValue({})
    apiListMock.mockResolvedValue({ servants: [makeServant()] })

    await useServantStore
      .getState()
      .setServant('sess-1', { role: '后端', enabled: true })

    expect(useServantStore.getState().bySessionId['sess-1']?.role).toBe('后端')
  })

  it('forwards runtime model/effort fields to the API unchanged', async () => {
    apiSetMock.mockResolvedValue({})
    apiListMock.mockResolvedValue({ servants: [makeServant()] })

    await useServantStore.getState().setServant('sess-1', {
      role: '后端',
      enabled: true,
      runtimeProviderId: null,
      runtimeModelId: 'claude-sonnet-4',
      effortLevel: 'high',
    })

    expect(apiSetMock).toHaveBeenCalledWith('sess-1', {
      role: '后端',
      enabled: true,
      runtimeProviderId: null,
      runtimeModelId: 'claude-sonnet-4',
      effortLevel: 'high',
    })
  })

  it('removes a servant', async () => {
    useServantStore.setState({ bySessionId: { 'sess-1': makeServant() } })
    apiRemoveMock.mockResolvedValue({ ok: true })

    await useServantStore.getState().removeServant('sess-1')

    expect(apiRemoveMock).toHaveBeenCalledWith('sess-1')
    expect(useServantStore.getState().bySessionId).toEqual({})
  })

  describe('subscribeTurnEvents (方案B: 事件驱动即时更新)', () => {
    it('patches turnInProgress immediately on servant_turn_changed', () => {
      useServantStore.setState({ bySessionId: { 'sess-1': makeServant() } })
      const unsubscribe = useServantStore.getState().subscribeTurnEvents()

      expect(wsManagerMock.connect).toHaveBeenCalledWith('_events')

      wsManagerMock.emitMessage({
        type: 'system_notification',
        subtype: 'servant_turn_changed',
        data: { sessionId: 'sess-1', turnInProgress: true },
      })

      expect(useServantStore.getState().bySessionId['sess-1']?.turnInProgress).toBe(true)

      wsManagerMock.emitMessage({
        type: 'system_notification',
        subtype: 'servant_turn_changed',
        data: { sessionId: 'sess-1', turnInProgress: false },
      })

      expect(useServantStore.getState().bySessionId['sess-1']?.turnInProgress).toBe(false)
      unsubscribe()
    })

    it('ignores events for sessions not in the roster and malformed payloads', () => {
      useServantStore.setState({ bySessionId: { 'sess-1': makeServant() } })
      const unsubscribe = useServantStore.getState().subscribeTurnEvents()

      wsManagerMock.emitMessage({
        type: 'system_notification',
        subtype: 'servant_turn_changed',
        data: { sessionId: 'sess-unknown', turnInProgress: true },
      })
      expect(useServantStore.getState().bySessionId['sess-unknown']).toBeUndefined()

      wsManagerMock.emitMessage({
        type: 'system_notification',
        subtype: 'servant_turn_changed',
        data: { sessionId: 123 },
      })
      wsManagerMock.emitMessage({ type: 'system_notification', subtype: 'other', data: {} })
      expect(useServantStore.getState().bySessionId['sess-1']?.turnInProgress).toBe(false)
      unsubscribe()
    })

    it('refetches the roster after a reconnect to fill the gap', async () => {
      apiListMock.mockResolvedValue({ servants: [makeServant()] })
      const unsubscribe = useServantStore.getState().subscribeTurnEvents()

      // 首次连接不补拉（连接前无断线窗口）
      wsManagerMock.emitState('connected')
      expect(apiListMock).not.toHaveBeenCalled()

      // 断线重连成功 → 补一次全量刷新
      wsManagerMock.emitState('reconnecting')
      wsManagerMock.emitState('connected')
      await vi.waitFor(() => {
        expect(apiListMock).toHaveBeenCalledTimes(1)
      })
      unsubscribe()
    })

    it('unsubscribe disconnects the channel and stops updates', () => {
      useServantStore.setState({ bySessionId: { 'sess-1': makeServant() } })
      const unsubscribe = useServantStore.getState().subscribeTurnEvents()

      unsubscribe()
      expect(wsManagerMock.disconnect).toHaveBeenCalledWith('_events')

      wsManagerMock.emitMessage({
        type: 'system_notification',
        subtype: 'servant_turn_changed',
        data: { sessionId: 'sess-1', turnInProgress: true },
      })
      expect(useServantStore.getState().bySessionId['sess-1']?.turnInProgress).toBe(false)
    })
  })
})
