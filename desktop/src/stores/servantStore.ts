import { create } from 'zustand'
import {
  servantsApi,
  type ServantInfo,
  type ServantInput,
} from '../api/servants'
import type { ServerMessage } from '../types/chat'
import { subscribeGlobalEvents } from './globalEventsChannel'

/**
 * 全局 `_events` 通道上的员工相关事件（事件契约 v1.5.0）：
 * - servant_turn_changed：回合翻转（状态灯 busy↔idle），局部 patch；
 * - servant_roster_changed：花名册条目增/删/字段更新（A6）。
 */
const SERVANT_TURN_CHANGED_SUBTYPE = 'servant_turn_changed'
const SERVANT_ROSTER_CHANGED_SUBTYPE = 'servant_roster_changed'

type ServantTurnChangedData = {
  sessionId?: unknown
  turnInProgress?: unknown
}

type ServantRosterChangedData = {
  sessionId?: unknown
  change?: unknown
  fields?: unknown
  item?: unknown
}

/** 结构性字段变化直接全量刷新（事件契约 §2 建议），高频字段走局部 patch。 */
const STRUCTURAL_ROSTER_FIELDS = new Set(['role', 'constraint', 'supervisor', 'enabled'])

type ServantStore = {
  /** 协作身份：sessionId → 身份信息（含未启用条目，供徽标与编辑回显） */
  bySessionId: Record<string, ServantInfo>
  isLoading: boolean

  fetchServants: () => Promise<void>
  setServant: (sessionId: string, input: ServantInput) => Promise<void>
  removeServant: (sessionId: string) => Promise<void>
  /**
   * 订阅全局事件通道（共享连接见 globalEventsChannel）：
   * - servant_turn_changed → 立即局部更新对应条目的 turnInProgress（不等轮询）；
   * - servant_roster_changed（A6）→ added/结构性字段变化触发全量刷新，
   *   running/title/lastActivityAt 局部 patch，removed 本地移除；
   * 重连成功时补一次全量刷新，填掉断线窗口内错过的事件。返回退订函数。
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

function parseRosterChangedData(data: unknown): {
  sessionId: string
  change: 'added' | 'updated' | 'removed'
  fields: string[]
  item: ServantInfo | null
} | null {
  if (!data || typeof data !== 'object') return null
  const record = data as ServantRosterChangedData
  if (typeof record.sessionId !== 'string') return null
  if (record.change !== 'added' && record.change !== 'updated' && record.change !== 'removed') {
    return null
  }
  const fields = Array.isArray(record.fields)
    ? record.fields.filter((field): field is string => typeof field === 'string')
    : []
  const item =
    record.item && typeof record.item === 'object' &&
    typeof (record.item as ServantInfo).sessionId === 'string'
      ? (record.item as ServantInfo)
      : null
  return { sessionId: record.sessionId, change: record.change, fields, item }
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
    return subscribeGlobalEvents(
      (msg: ServerMessage) => {
        if (msg.type !== 'system_notification') return

        if (msg.subtype === SERVANT_TURN_CHANGED_SUBTYPE) {
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
          return
        }

        if (msg.subtype === SERVANT_ROSTER_CHANGED_SUBTYPE) {
          const parsed = parseRosterChangedData(msg.data)
          if (!parsed) return

          // added / 结构性字段变化：直接全量刷新（契约 §2 建议，简单且不会错）
          if (
            parsed.change === 'added' ||
            (parsed.change === 'updated' && parsed.fields.some((f) => STRUCTURAL_ROSTER_FIELDS.has(f)))
          ) {
            void useServantStore.getState().fetchServants()
            return
          }

          set((s) => {
            const entry = s.bySessionId[parsed.sessionId]
            // updated/removed 只处理花名册已有的条目；未知 sessionId 忽略，
            // 等下次全量拉取（契约 §2）
            if (!entry) return s

            if (parsed.change === 'removed') {
              const next = { ...s.bySessionId }
              delete next[parsed.sessionId]
              return { bySessionId: next }
            }

            // updated：给了 item 快照就整体替换；没给（如 lastActivityAt 节流
            // 条）事件里不带新值，无法盲 patch——落到下面的全量刷新对齐。
            if (!parsed.item) return s
            return { bySessionId: { ...s.bySessionId, [parsed.sessionId]: parsed.item } }
          })
          if (parsed.change === 'updated' && !parsed.item) {
            // 无 item 快照的 updated：lastActivityAt 节流条（≥5s/会话）只是活性
            // 提示，本地容忍滞后，等下次全量/快照对齐——为它拉全量会比 20s 轮询
            // 更吵，违背 A6 初衷。其余无值字段（理论上不该出现）拉全量兜底。
            const onlyActivity = parsed.fields.every((f) => f === 'lastActivityAt')
            if (!onlyActivity) void useServantStore.getState().fetchServants()
          }
        }
      },
      // 重连成功 → 断线窗口内可能漏了事件，补一次全量刷新对齐真实状态
      () => { void useServantStore.getState().fetchServants() },
    )
  },
}))
