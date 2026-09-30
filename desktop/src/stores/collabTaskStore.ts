import { create } from 'zustand'
import { collabTasksApi } from '../api/collabTasks'
import type { ServerMessage } from '../types/chat'
import { subscribeGlobalEvents } from './globalEventsChannel'

/**
 * 全局 `_events` 通道上的任务台账事件（事件契约 v1.5.2）：
 * - collab_task_changed：任务台账变化，data = { taskId, projectDir, change, status }。
 *   事件里**不带 toSessionId**，无法在前端直接定位归属会话，故收到即防抖重拉
 *   dispatched 列表（台账是唯一权威源，前端只做副本，不自行推断）。
 */
const COLLAB_TASK_CHANGED_SUBTYPE = 'collab_task_changed'

/** 突发事件合并窗口（本地第二道防抖，避免状态流转连发时拉取风暴）。 */
export const TASK_EVENT_DEBOUNCE_MS = 150

type CollabTaskStore = {
  /**
   * 会话 → 是否存在 dispatched（待接单）任务。派生自台账 GET ?status=dispatched，
   * 前端只做只读副本。按 sessionId 做局部 selector 订阅，避免整表重渲染。
   */
  dispatchedBySessionId: Record<string, true>

  /** 冷启动/重连/事件触发时重拉台账，重建 dispatched 副本。 */
  refreshDispatched: () => Promise<void>
  /**
   * 订阅全局事件通道（共享连接见 globalEventsChannel）：
   * - collab_task_changed → 防抖重拉 dispatched；
   * - 重连成功 → 清空副本后重拉（断线窗口内可能漏事件），防残留待接单。
   * 返回退订函数。
   */
  subscribeTaskEvents: () => () => void
}

async function fetchDispatched(): Promise<Record<string, true>> {
  const { tasks } = await collabTasksApi.listDispatched()
  const next: Record<string, true> = {}
  for (const task of tasks) next[task.toSessionId] = true
  return next
}

/**
 * 在途请求状态（模块级，非响应式）：同一时刻最多一个台账拉取在飞。
 * 竞态背景：L1 拉取在途时事件到来会发起 L2，两个请求的响应若乱序返回，
 * 旧快照可能后写覆盖新状态——已接单的任务会短暂回退成「待接单」。因此把并发
 * 收敛成「在途合并 + trailing」：在途期间到达的刷新只登记一次，等当前请求
 * 结束后最多再拉一次，保证最后一次写入对应最新事件之后。
 */
let inFlight: Promise<void> | null = null
let trailingRequested = false
/**
 * 重连/清空的代数计数：重连会先清空副本，若在途的旧响应随后返回并写入，
 * 会把清空结果覆盖回旧快照（残留待接单）。代数变更即作废在途响应。
 * 单调递增，不回退——比较只用相等性，重置为旧值会让已作废的请求「复活」。
 */
let generation = 0

/**
 * 测试隔离：清空在途请求与 trailing 标记，并将代数 +1 作废所有在途请求。
 * 代数只增不减：若沿用 reset 前代数值，上一用例超时中断、迟到的响应会被
 * 误判为「当前代数」而写入新用例的状态。
 */
export function resetCollabTaskRefreshForTests(): void {
  generation += 1
  inFlight = null
  trailingRequested = false
}

export const useCollabTaskStore = create<CollabTaskStore>((set) => ({
  dispatchedBySessionId: {},

  refreshDispatched: () => {
    // 在途合并：已有请求在飞时不再并发拉取，只登记一次 trailing。
    if (inFlight) {
      trailingRequested = true
      return inFlight
    }

    const startedGeneration = generation
    let request: Promise<void> | null = null
    // 自身是否仍是在途请求：reset（测试隔离）或被重连清空后，迟到的响应不得再动共享状态
    const isOwner = () => inFlight === request
    request = (async () => {
      try {
        const next = await fetchDispatched()
        // 期间发生过重连清空 → 这份是旧快照，丢弃并由 trailing 重新对齐
        if (startedGeneration === generation) {
          set({ dispatchedBySessionId: next })
        } else if (isOwner()) {
          trailingRequested = true
        }
      } catch {
        // 拉取失败：保留现状，等下次事件/重连/挂载兜底，不误清空（避免假「无待接单」）
      } finally {
        if (isOwner()) {
          inFlight = null
          // trailing：请求期间有新事件到达，结束后最多再拉一次
          if (trailingRequested) {
            trailingRequested = false
            void useCollabTaskStore.getState().refreshDispatched()
          }
        }
      }
    })()
    inFlight = request
    return inFlight
  },

  subscribeTaskEvents: () => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = () => {
      if (refreshTimer) return
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void useCollabTaskStore.getState().refreshDispatched()
      }, TASK_EVENT_DEBOUNCE_MS)
    }

    const unsubscribe = subscribeGlobalEvents(
      (msg: ServerMessage) => {
        if (msg.type !== 'system_notification') return
        if (msg.subtype !== COLLAB_TASK_CHANGED_SUBTYPE) return
        scheduleRefresh()
      },
      () => {
        // 重连：清空副本（断线窗口内漏事件会让已接单的任务残留为待接单）后重拉。
        // 代数 +1：在途的旧响应随之作废，不会把清空结果覆盖回旧快照。
        generation += 1
        if (refreshTimer) {
          clearTimeout(refreshTimer)
          refreshTimer = null
        }
        set({ dispatchedBySessionId: {} })
        void useCollabTaskStore.getState().refreshDispatched()
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
}))
