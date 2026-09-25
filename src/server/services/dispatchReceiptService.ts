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
 * 状态仅存内存（重启即清空，与 servantIncidentNotifier 的连错计数同类取舍）：
 * 回执是"最近一次派活有没有被接住"的运维信号，不需要跨重启持久化。
 */

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
/** sessionId → 是否有回合正在进行（由 observeSessionSdkMessage 维护） */
const sessionMidTurn = new Map<string, boolean>()

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

/** 测试隔离用：清空全部状态（含监听器，避免跨用例泄漏） */
export function resetDispatchReceipts(): void {
  receipts.clear()
  sessionMidTurn.clear()
  turnChangeListeners.clear()
}

/**
 * 该会话当前是否处于「回合进行中」。
 *
 * 判定来源与消费回执完全同源：只认 CLI 实际吐出来的 SDK 消息流——
 *   见到 assistant / stream_event / user(tool_result) → 回合进行中；
 *   见到 result（回合边界）→ 回合结束；
 *   从未观察到任何消息 → **false（不认为进行中）**。
 *
 * 为什么不用别处的活跃标记：`activeUserTurns`（ws/handler）只在"用户消息注入"路径
 * set，文件信箱/HTTP 注入式回合可能根本没有 turn（《批次2_会话冻结根因调查报告》§2.3），
 * 而消息流是 CLI 实际输出的直接映射，不受注入路径影响。
 *
 * 消费方：servantStallWatcher —— 只有"回合进行中却长时间没动静"才算假死；
 * "回合已结束、只是待命"是正常空闲，不该被反复戳（v1.2.2 降噪）。
 */
export function isSessionTurnInProgress(sessionId: string): boolean {
  return sessionMidTurn.get(sessionId) === true
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
    targetWasBusy: sessionMidTurn.get(input.targetSessionId) === true,
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
 * 观察一条来自目标会话的 SDK 消息，据此推进消费状态。
 *
 * @param messageType SDK 消息的 `type`（assistant / stream_event / user / result / …）
 */
export function observeSessionSdkMessage(
  sessionId: string,
  messageType: unknown,
  at: number = Date.now(),
): void {
  const type = typeof messageType === 'string' ? messageType : ''

  if (type === 'result') {
    // 回合边界：CLI 在此时才拉取排队的输入 → 该会话所有未消费回执都算被消费
    const wasMidTurn = sessionMidTurn.get(sessionId) === true
    sessionMidTurn.set(sessionId, false)
    if (wasMidTurn) emitTurnChange(sessionId, false)
    consume(sessionId, at, () => true)
    return
  }

  if (type === 'assistant' || type === 'stream_event' || type === 'user') {
    const wasBusy = sessionMidTurn.get(sessionId) === true
    if (!wasBusy) {
      sessionMidTurn.set(sessionId, true)
      emitTurnChange(sessionId, true)
    }
    // 只有"投递时空闲"的回执才会被活动信号消费；忙碌期间的活动属于上一条回合
    consume(sessionId, at, (receipt) => !receipt.targetWasBusy)
    return
  }

  // system(init) / control_* 等中性事件：既不代表新回合，也不代表回合结束
}

function consume(
  sessionId: string,
  at: number,
  shouldConsume: (receipt: DispatchReceipt) => boolean,
): void {
  for (const receipt of receipts.values()) {
    if (receipt.consumed || receipt.targetSessionId !== sessionId) continue
    if (!shouldConsume(receipt)) continue
    receipt.consumed = true
    receipt.consumedAt = at
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
