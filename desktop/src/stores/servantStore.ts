import { create } from 'zustand'
import {
  servantsApi,
  type ServantInfo,
  type ServantInput,
} from '../api/servants'
import { wsManager } from '../api/websocket'
import type { ServerMessage } from '../types/chat'

/**
 * 服务端 ws/handler 的全局事件通道（保留会话 ID）。连接它不绑定任何真实会话，
 * 只接收跨会话事件——当前仅 servant_turn_changed（回合翻转广播）。
 */
const GLOBAL_EVENTS_SESSION_ID = '_events'
const SERVANT_TURN_CHANGED_SUBTYPE = 'servant_turn_changed'

type ServantTurnChangedData = {
  sessionId?: unknown
  turnInProgress?: unknown
}

type ServantStore = {
  /** 协作身份：sessionId → 身份信息（含未启用条目，供徽标与编辑回显） */
  bySessionId: Record<string, ServantInfo>
  isLoading: boolean

  fetchServants: () => Promise<void>
  setServant: (sessionId: string, input: ServantInput) => Promise<void>
  removeServant: (sessionId: string) => Promise<void>
  /**
   * 订阅全局事件通道：收到 servant_turn_changed 立即局部更新对应条目的
   * turnInProgress（不等 20s 花名册轮询）；重连成功时补一次全量刷新，
   * 填掉断线窗口内错过的事件。返回退订函数（断开通道并停止更新）。
   */
  subscribeTurnEvents: () => () => void
}

async function fetchAll(): Promise<Record<string, ServantInfo>> {
  const { servants } = await servantsApi.list({ all: true })
  return Object.fromEntries(servants.map((s) => [s.sessionId, s]))
}

function parseTurnChangedData(data: unknown): { sessionId: string; turnInProgress: boolean } | null {
  if (!data || typeof data !== 'object') return null
  const record = data as ServantTurnChangedData
  if (typeof record.sessionId !== 'string' || typeof record.turnInProgress !== 'boolean') {
    return null
  }
  return { sessionId: record.sessionId, turnInProgress: record.turnInProgress }
}

export const useServantStore = create<ServantStore>((set) => ({
  bySessionId: {},
  isLoading: false,

  fetchServants: async () => {
    set({ isLoading: true })
    try {
      set({ bySessionId: await fetchAll(), isLoading: false })
    } catch {
      set({ isLoading: false })
    }
  },

  setServant: async (sessionId, input) => {
    await servantsApi.set(sessionId, input)
    // 以服务端为准整体刷新
    set({ bySessionId: await fetchAll() })
  },

  removeServant: async (sessionId) => {
    await servantsApi.remove(sessionId)
    set((s) => {
      const next = { ...s.bySessionId }
      delete next[sessionId]
      return { bySessionId: next }
    })
  },

  subscribeTurnEvents: () => {
    wsManager.connect(GLOBAL_EVENTS_SESSION_ID)

    const offMessage = wsManager.onMessage(GLOBAL_EVENTS_SESSION_ID, (msg: ServerMessage) => {
      if (msg.type !== 'system_notification' || msg.subtype !== SERVANT_TURN_CHANGED_SUBTYPE) {
        return
      }
      const parsed = parseTurnChangedData(msg.data)
      if (!parsed) return
      set((s) => {
        const entry = s.bySessionId[parsed.sessionId]
        // 未登记的会话不在花名册内，忽略；等下次轮询带上
        if (!entry || entry.turnInProgress === parsed.turnInProgress) return s
        return {
          bySessionId: {
            ...s.bySessionId,
            [parsed.sessionId]: { ...entry, turnInProgress: parsed.turnInProgress },
          },
        }
      })
    })

    // 重连成功 → 断线窗口内可能漏了翻转事件，补一次全量刷新对齐真实状态
    let wasReconnecting = false
    const offState = wsManager.onConnectionState(GLOBAL_EVENTS_SESSION_ID, (state) => {
      if (state === 'reconnecting') {
        wasReconnecting = true
        return
      }
      if (state === 'connected' && wasReconnecting) {
        wasReconnecting = false
        void useServantStore.getState().fetchServants()
      }
    })

    return () => {
      offMessage()
      offState()
      wsManager.disconnect(GLOBAL_EVENTS_SESSION_ID)
    }
  },
}))
