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
 * - servant_turn_changed：回合翻转（状态灯执行中↔待命），写入全局回合态映射；
 * - servant_roster_changed：花名册条目增/删/字段更新（A6）。
 *
 * 「一件事实一个权威源」（架构决策_侧栏运行指示统一数据源）：某会话是否正在跑回合
 * 的权威源是服务端 sessionRegistry 的回合态，前端只做订阅副本。副本落在
 * `turnInProgressBySessionId`——**所有 sessionId 都写，包括不在花名册里的会话**，
 * 不再像旧实现那样「条目不在花名册就丢弃事件」（那正是「派活后不转圈」的根因）。
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
  /**
   * 全局回合态副本：sessionId → 是否正在跑回合（turnInProgress）。所有会话都记录，
   * 含花名册外的会话。侧栏运行指示（执行中/待命）只读这里，按 sessionId 做局部
   * selector 订阅，避免事件风暴下整表重渲染。只有 true 才有意义地出现；缺省 = 未知/否。
   */
  turnInProgressBySessionId: Record<string, boolean>
  isLoading: boolean
  /**
   * v1.7.3 裁决（未登记会话可登记）：花名册拉取失败时置原始错误串——
   * store 只存 error（B8 口径），消费面板负责渲染（与「未登记（永久）」
   * 区分开，后者可放行登记、前者给重试）。
   */
  error: string | null

  fetchServants: () => Promise<void>
  setServant: (sessionId: string, input: ServantInput) => Promise<void>
  removeServant: (sessionId: string) => Promise<void>
  /**
   * 订阅全局事件通道（共享连接见 globalEventsChannel）：
   * - servant_turn_changed → 写入全局回合态映射（所有 sessionId），并同步花名册条目；
   * - servant_roster_changed（A6）→ added/结构性字段变化触发全量刷新，
   *   running/title/lastActivityAt 局部 patch，removed 本地移除；
   * 重连成功时先清空回合态映射再全量刷新，填掉断线窗口内错过的事件并防止卡 busy。
   * 返回退订函数。
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
  turnInProgressBySessionId: {},
  isLoading: false,
  error: null,

  fetchServants: async () => {
    set({ isLoading: true, error: null })
    try {
      const bySessionId = await fetchAll()
      set((s) => ({
        bySessionId,
        isLoading: false,
        // 冷启动/刷新：用花名册的权威回合态初始化员工部分；花名册外的 sessionId
        // 保留映射里已有的值（事件驱动写入的），不被这次刷新清掉。
        turnInProgressBySessionId: {
          ...s.turnInProgressBySessionId,
          ...Object.fromEntries(
            Object.values(bySessionId).map((info) => [info.sessionId, info.turnInProgress]),
          ),
        },
      }))
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : String(err) })
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
            // 全局副本：所有 sessionId 都写，含花名册外的会话（不再丢弃事件）
            const turnInProgressBySessionId =
              s.turnInProgressBySessionId[parsed.sessionId] === parsed.turnInProgress
                ? s.turnInProgressBySessionId
                : { ...s.turnInProgressBySessionId, [parsed.sessionId]: parsed.turnInProgress }
            // 花名册里有该条目时同步其字段（徽标/编辑回显仍读花名册）
            const entry = s.bySessionId[parsed.sessionId]
            const bySessionId =
              entry && entry.turnInProgress !== parsed.turnInProgress
                ? {
                    ...s.bySessionId,
                    [parsed.sessionId]: { ...entry, turnInProgress: parsed.turnInProgress },
                  }
                : s.bySessionId
            if (
              turnInProgressBySessionId === s.turnInProgressBySessionId &&
              bySessionId === s.bySessionId
            ) {
              return s
            }
            return { turnInProgressBySessionId, bySessionId }
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
      // 重连成功 → 断线窗口内可能漏了事件。先清空回合态映射再全量刷新重建初值，
      // 否则漏掉的 false 事件会让某会话永久卡在「执行中」（防卡 busy）。
      () => {
        useServantStore.setState({ turnInProgressBySessionId: {} })
        void useServantStore.getState().fetchServants()
      },
    )
  },
}))
