/**
 * DispatchReceiptService — 会话间消息的「消费回执」
 *
 * 背景（交接文档 P2）：派活响应已带目标忙闲，但**投递成功 ≠ 目标已消费**——
 * 消息写进目标 CLI 的输入流后，可能还排在它当前回合的后面（甚至目标刚被拉起、
 * 还没读输入）。主管此前的唯一办法是"假活检查"间接猜。
 *
 * 判定口径（本模块的契约）：
 *   **消费 = 目标会话确实开始了对这条消息的处理。**
 * 服务端不依赖 CLI 的私有 ack，而是用「回合边界」这一确定性信号推断：
 *   - 投递时目标**空闲** → 之后任一"回合活动"信号（assistant / stream_event /
 *     tool_result 等）只可能来自新回合，即已消费；
 *   - 投递时目标**忙碌**（正在跑回合）→ 期间的活动信号属于它当前这条回合，
 *     不能算消费；要等到**下一个回合结束（result）**——CLI 在回合边界才读取
 *     排队的输入，此时该消息必然已被拉取。
 *   - 目标离线被拉起、但始终没有产生任何活动 → 一直保持「未消费」（正确暴露
 *     "没人接手"），这正是"大目标离线/卡住"场景需要的信号。
 *
 * 回合状态（v1.3.0 阶段2 · 5a）：本模块不再自持 sessionMidTurn 副本——
 * 「回合进行中」读 sessionRegistry 快照（单一权威源）；观察流按阶段 1 交错
 * 规则「只降不升」接线：result → observeTurnResult 无条件清 turn（观察流是
 * CLI 事实的最终裁决者）；进行中信号在无 turn 时**丢弃**（不得新建 turn）。
 *
 * 状态仅存内存（重启即清空，与 servantIncidentNotifier 的连错计数同类取舍）：
 * 回执是"最近一次派活有没有被接住"的运维信号，不需要跨重启持久化。
 */

import { hasActiveTurn, observeTurnResult } from './sessionRegistry.js'
import { diagnosticsService } from './diagnosticsService.js'
import { onSessionEvent, type SessionEvent } from './sessionEvents.js'

export type DispatchReceipt = {
  messageId: string
  targetSessionId: string
  /** 派活方（主管）会话 ID，用于回执归属 */
  fromSessionId?: string
  deliveredAt: number
  consumed: boolean
  consumedAt: number | null
  /** 投递时目标是否正忙；忙碌投递必须等到下一个回合边界才算消费 */
  targetWasBusy: boolean
}

/** 内存中保留的回执上限（超出丢最旧），避免长时间运行无界增长 */
export const MAX_TRACKED_RECEIPTS = 200

const receipts = new Map<string, DispatchReceipt>()

/**
 * 广播节流（仅 addTurnChangeListener 去重用，非会话状态）：turn 存在期间
 * 观察流的每个进行中信号都会出现，只把「首次」广播给前端花名册状态灯
 * （转圈残留根治·方案B），避免每条 SDK 消息都触发一次幂等广播。
 */
const turnActiveBroadcast = new Set<string>()

/**
 * 回合状态翻转监听器（sessionId, turnInProgress）。
 * 消费方：ws/handler 把它广播到 _events 全局通道，让前端花名册状态灯
 * 不必等轮询就能即时反映回合开始/结束（转圈残留根治·方案B）。
 */
type TurnChangeListener = (sessionId: string, turnInProgress: boolean) => void
const turnChangeListeners = new Set<TurnChangeListener>()

export function addTurnChangeListener(listener: TurnChangeListener): () => void {
  turnChangeListeners.add(listener)
  return () => { turnChangeListeners.delete(listener) }
}

function emitTurnChange(sessionId: string, turnInProgress: boolean): void {
  for (const listener of turnChangeListeners) {
    try {
      listener(sessionId, turnInProgress)
    } catch {
      // 监听器异常不能影响回执状态推进本身
    }
  }
}

/**
 * 清 turn 的补偿广播（v1.3.1 转圈残留修复）：registry 清 turn 的**全部**路径
 * （观察流 result / markCrashed 崩溃 / markStopped+clearSession 主动停止 /
 * tombstone / TurnHandle abort·settle）都会发 turn_changed(none) 事件——此前
 * 只有观察流 result 分支补发 false 给前端，CLI 崩溃/停止路径清 turn 后前端
 * 收不到 servant_turn_changed(false)，状态灯永久卡 busy（服务端 hasActiveTurn
 * 已为 false）。此处按事件总线补偿：仅当该会话此前广播过 true（前端确实在
 * 转圈）才补发 false，与「只降不升」不冲突（false 是降向）。
 *
 * 同步派发顺序（observeSessionSdkMessage result 分支）：先 turnActiveBroadcast
 * .delete（wasBroadcast=true → result 分支发一次 false）→ observeTurnResult 内
 * clearTurnInternal 再发 turn_changed(none) → 本订阅器 delete 已为空 → 不再发。
 * 净语义：恰好一次 false，两处判定互为兜底。
 *
 * 订阅生命周期（复核①收口）：本订阅器必须常驻，但 resetSessionEventsForTests
 * 会 listeners.clear() 静默清掉它（先跑的测试文件即可触发，故障表现为下游
 * 补偿断言假失败）。故经 ensureTurnChangeCompensationSubscribed 显式保证：
 * onSessionEvent 按 handler 函数引用去重（同一引用至多注册一份）——重复调用幂等，
 * 被清后重调即恢复。消费方（dispatch-receipts.test.ts beforeEach）每次调用，
 * 并跑活性自检（合成 markCrashed 流程断言 false 到达监听链），将来任何清空
 * 都会显式报错而非假失败。
 */
function compensationListener(event: SessionEvent): void {
  if (event.type !== 'turn_changed' || event.turn !== 'none') return
  if (turnActiveBroadcast.delete(event.sessionId)) {
    emitTurnChange(event.sessionId, false)
  }
}

export function ensureTurnChangeCompensationSubscribed(): void {
  onSessionEvent(compensationListener)
}

ensureTurnChangeCompensationSubscribed()

/** 测试隔离用：清空全部状态（含监听器，避免跨用例泄漏） */
export function resetDispatchReceipts(): void {
  receipts.clear()
  turnActiveBroadcast.clear()
  turnChangeListeners.clear()
}

/**
 * 该会话当前是否处于「回合进行中」。
 *
 * v1.3.0 阶段2（5a）：改为读 sessionRegistry 快照（单一权威源）。registry 的
 * turn 由注入路径（beginTurn/beginTurnReplacing）建立、由观察流 result
 * （observeTurnResult，本模块接线）按事实裁决清除——语义与旧 sessionMidTurn
 * 副本等价：turn 存在 = 观察流见过回合活动且尚未见到 result 边界。
 *
 * 消费方：servantStallWatcher（deps 注入，默认实现即本导出）——只有"回合
 * 进行中却长时间没动静"才算假死；"回合已结束、只是待命"是正常空闲。
 */
export function isSessionTurnInProgress(sessionId: string): boolean {
  return hasActiveTurn(sessionId)
}

export function getReceipt(messageId: string): DispatchReceipt | null {
  const receipt = receipts.get(messageId)
  return receipt ? { ...receipt } : null
}

/** 该会话还有多少条**未被消费**的派活（0 = 没有悬着的活） */
export function countUnconsumedReceipts(targetSessionId: string): number {
  let count = 0
  for (const receipt of receipts.values()) {
    if (!receipt.consumed && receipt.targetSessionId === targetSessionId) count += 1
  }
  return count
}

/** 最近的回执（可选按目标会话过滤），最新在前 */
export function listReceipts(targetSessionId?: string): DispatchReceipt[] {
  return [...receipts.values()]
    .filter((receipt) => !targetSessionId || receipt.targetSessionId === targetSessionId)
    .sort((left, right) => right.deliveredAt - left.deliveredAt)
    .map((receipt) => ({ ...receipt }))
}

/**
 * 登记一次成功投递（未消费）。
 *
 * 调用方应在**发出消息之前**登记：目标可能极快地处理完并产生活动信号，
 * 若先发后登记，信号会赶在登记之前到达，回执将永远停在"未消费"。
 * 发送失败时用 forgetReceipt 撤回。
 */
export function recordDelivery(input: {
  messageId: string
  targetSessionId: string
  fromSessionId?: string
  at?: number
}): DispatchReceipt {
  const receipt: DispatchReceipt = {
    messageId: input.messageId,
    targetSessionId: input.targetSessionId,
    ...(input.fromSessionId ? { fromSessionId: input.fromSessionId } : {}),
    deliveredAt: input.at ?? Date.now(),
    consumed: false,
    consumedAt: null,
    targetWasBusy: hasActiveTurn(input.targetSessionId),
  }
  receipts.set(receipt.messageId, receipt)
  pruneReceipts()
  return { ...receipt }
}

/** 投递失败时撤回登记（避免留下一条永远"未消费"的假回执） */
export function forgetReceipt(messageId: string): void {
  receipts.delete(messageId)
}

/**
 * 观察一条来自目标会话的 SDK 消息，据此推进消费状态与 registry 回合裁决
 * （v1.3.0 阶段2 · 5a 接线）。
 *
 * 交错规则（阶段 1 合同补充 2）：
 * - result → observeTurnResult 无条件清除任何 turn（观察流是 CLI 事实的
 *   最终裁决者），并消费该会话全部未消费回执；
 * - 进行中信号（assistant / stream_event / user）在**无 turn 时丢弃**
 *   （只降不升：观察流不得新建 turn）——协作架构下所有回合均经注入/WS
 *   路径建立 turn，无 turn 的进行中信号属异常时序，交由 turn 建立方裁决；
 * - turn 存在时的首个进行中信号向 addTurnChangeListener 广播 true（节流）。
 *
 * @param messageType SDK 消息的 `type`（assistant / stream_event / user / result / …）
 * @param isError result 消息的 is_error（进 observeTurnResult 的 meta 可回查；
 *                非结果消息忽略）
 */
export function observeSessionSdkMessage(
  sessionId: string,
  messageType: unknown,
  at: number = Date.now(),
  isError?: boolean,
): void {
  const type = typeof messageType === 'string' ? messageType : ''

  if (type === 'result') {
    // 回合边界：CLI 在此时才拉取排队的输入 → 该会话所有未消费回执都算被消费
    const wasBroadcast = turnActiveBroadcast.delete(sessionId)
    observeTurnResult(sessionId, { isError: isError ?? false })
    if (wasBroadcast) emitTurnChange(sessionId, false)
    consume(sessionId, at, () => true, 'result')
    return
  }

  if (type === 'assistant' || type === 'stream_event' || type === 'user') {
    // 只降不升：无 turn 时丢弃信号（不广播、不新建 turn）；有 turn 时首次广播
    if (hasActiveTurn(sessionId)) {
      if (!turnActiveBroadcast.has(sessionId)) {
        turnActiveBroadcast.add(sessionId)
        emitTurnChange(sessionId, true)
      }
    }
    // 只有"投递时空闲"的回执才会被活动信号消费；忙碌期间的活动属于上一条回合
    consume(sessionId, at, (receipt) => !receipt.targetWasBusy, 'activity')
    return
  }

  // system(init) / control_* 等中性事件：既不代表新回合，也不代表回合结束
}

function consume(
  sessionId: string,
  at: number,
  shouldConsume: (receipt: DispatchReceipt) => boolean,
  trigger: 'result' | 'activity',
): void {
  let consumedCount = 0
  for (const receipt of receipts.values()) {
    if (receipt.consumed || receipt.targetSessionId !== sessionId) continue
    if (!shouldConsume(receipt)) continue
    receipt.consumed = true
    receipt.consumedAt = at
    consumedCount++
  }
  // P2-b（裁决二十三第 5 条）：**只加记录，零行为变更**。本模块的回执表是纯内存
  // Map（无 HTTP 面 / 不写 diagnostics / 无 console），外部不可读 ⇒ 「deny → 回执
  // 消费」在冒烟里拿不到正向物证。这条诊断就是那个验证面（**不做持久化、不加 HTTP**）。
  if (consumedCount > 0) {
    void diagnosticsService
      .recordEvent({
        type: 'dispatch_receipts_consumed',
        severity: 'info',
        sessionId,
        summary: `回执消费 ${consumedCount} 条（触发来源：${trigger}）`,
        details: { sessionId, consumedCount, trigger, at },
      })
      .catch(() => {})
  }
}

function pruneReceipts(): void {
  if (receipts.size <= MAX_TRACKED_RECEIPTS) return
  const oldestFirst = [...receipts.values()].sort((left, right) => left.deliveredAt - right.deliveredAt)
  for (const receipt of oldestFirst) {
    if (receipts.size <= MAX_TRACKED_RECEIPTS) break
    receipts.delete(receipt.messageId)
  }
}
