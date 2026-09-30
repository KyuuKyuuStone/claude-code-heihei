/**
 * 协作推送：活动时间巡检 + 节流（v1.5.0 · A6 服务端侧）。
 *
 * 契约（D:\xxw_p\cc-heihei-plan\事件契约_v1.5.0.md §2）要求 lastActivityAt
 * 同一会话 ≥5 秒最多推一条——否则每个 transcript 写入都会广播，直接刷屏。
 *
 * 职责边界（避免分层环）：
 * - 本模块**只**负责"活动时间巡检 + 节流"这一件需要跨调用状态的事；
 * - 结构性变化（增/删/改/running/title）由发生地直接 emitCollabPush 原始信号
 *   （servantService / ws 层），不进本模块——servantService 已 import
 *   sessionService，若它再 import 本模块而本模块 import servantService 即成环。
 * - 250ms 合并 session_list 失效信号的逻辑在 ws 层广播出口（有 ws 上下文）。
 *
 * 分层：L2 领域服务，单向依赖 servantService。
 */

import { emitCollabPush } from '../../collaboration/collabPushSignals.js'
import { servantService } from './servantService.js'

/** lastActivityAt 推送节流窗口（契约 §2：同一会话 ≥5s 一条） */
export const LAST_ACTIVITY_THROTTLE_MS = 5_000
/** 活动时间巡检周期（略小于节流窗口，保证节流后 ~5-6s 内送达） */
export const ACTIVITY_SWEEP_INTERVAL_MS = 3_000

type ActivitySnapshot = { lastActivityAt?: string; title?: string }

class CollabPushService {
  /** sessionId → 上次推送 lastActivityAt 的时间戳（节流用） */
  private lastActivityPushedAt = new Map<string, number>()
  /** sessionId → 上次见到的活动/标题快照（比对变化用） */
  private activitySnapshot = new Map<string, ActivitySnapshot>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  /** 单飞守卫：上一轮巡检未结束（慢 IO）时本轮直接跳过 */
  private sweepInFlight: Promise<void> | null = null

  /** 启动活动时间巡检（幂等）。装配方（server/index.ts）调用。 */
  startActivitySweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => {
      void this.runSweepSingleFlight()
    }, ACTIVITY_SWEEP_INTERVAL_MS)
    // 定时器不应阻止进程退出
    this.sweepTimer.unref?.()
  }

  /**
   * 低1（v1.5.0 第二批）：单飞包装——一轮巡检慢 IO 超过 tick 周期时，
   * 并发进入会让 activitySnapshot/lastActivityPushedAt 交错写，可能重复或
   * 漏发一条 roster 推送。推送是加速路径，丢一轮无所谓：在途即跳过。
   * （守卫放在定时器路径而非 sweepActivity 本体，直接调用仍按次执行，
   * 便于测试与手动触发。）
   */
  private runSweepSingleFlight(): Promise<void> {
    if (this.sweepInFlight) return this.sweepInFlight
    const run = this.sweepActivity().finally(() => {
      if (this.sweepInFlight === run) this.sweepInFlight = null
    })
    this.sweepInFlight = run
    return run
  }

  stopActivitySweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  /**
   * 巡检一次：比对在册员工会话的 lastActivityAt/title 与上次快照，
   * 有变化则按 5s 节流推送。
   */
  async sweepActivity(now = Date.now()): Promise<void> {
    let servants: Awaited<ReturnType<typeof servantService.listServants>>
    try {
      servants = await servantService.listServants()
    } catch {
      return // 花名册读失败：下一轮再试，推送是加速路径
    }
    const seen = new Set<string>()
    for (const servant of servants) {
      seen.add(servant.sessionId)
      const prev = this.activitySnapshot.get(servant.sessionId)
      const next: ActivitySnapshot = {
        ...(servant.lastActivityAt !== undefined ? { lastActivityAt: servant.lastActivityAt } : {}),
        title: servant.title,
      }
      this.activitySnapshot.set(servant.sessionId, next)
      if (!prev) continue // 首次见到：只建快照，避免启动即刷一批
      const fields: string[] = []
      if (prev.lastActivityAt !== next.lastActivityAt) fields.push('lastActivityAt')
      if (prev.title !== next.title) fields.push('title')
      if (fields.length === 0) continue
      const last = this.lastActivityPushedAt.get(servant.sessionId) ?? 0
      if (now - last < LAST_ACTIVITY_THROTTLE_MS) continue // 窗口内静默（快照已更新）
      this.lastActivityPushedAt.set(servant.sessionId, now)
      emitCollabPush({
        kind: 'roster',
        sessionId: servant.sessionId,
        change: 'updated',
        fields,
      })
    }
    // 已不在花名册的会话：清掉快照/节流记录（防 map 无界增长）
    for (const id of [...this.activitySnapshot.keys()]) {
      if (!seen.has(id)) {
        this.activitySnapshot.delete(id)
        this.lastActivityPushedAt.delete(id)
      }
    }
  }

  /** 测试隔离 */
  resetForTests(): void {
    this.stopActivitySweep()
    this.sweepInFlight = null
    this.lastActivityPushedAt.clear()
    this.activitySnapshot.clear()
  }
}

export const collabPushService = new CollabPushService()
