import { beforeEach, describe, expect, test } from 'bun:test'
import { handleSessionMessagesApi } from '../api/servants.js'
import {
  MAX_TRACKED_RECEIPTS,
  addTurnChangeListener,
  countUnconsumedReceipts,
  forgetReceipt,
  getReceipt,
  isSessionTurnInProgress,
  listReceipts,
  observeSessionSdkMessage,
  recordDelivery,
  resetDispatchReceipts,
} from '../services/dispatchReceiptService.js'
// v1.3.0 阶段2（5a）：turn 状态单一权威源迁至 sessionRegistry，观察流「只降不升」
// （无 turn 时丢弃进行中信号）——「回合进行中」场景需先走注入路径建 turn。
import {
  beginTurn,
  clearSession,
  dropActiveTurn,
  markCrashed,
  registerSession,
  resetRegistryForTests,
  tombstoneSession,
} from '../services/sessionRegistry.js'
import {
  ensureTurnChangeCompensationSubscribed,
} from '../services/dispatchReceiptService.js'

/**
 * 派活消费回执（A4）。
 *
 * 纯内存模块、无外部依赖，因此不需要 mock.module，也不读运行者 env。
 * 时间一律显式传入（`at`），断言确定性。
 */

const T0 = Date.parse('2026-09-16T10:00:00.000Z')
const SUP = 'sup-1'
const EMP = 'emp-1'
const OTHER = 'emp-2'
/** 一个从不产生任何 SDK 消息的会话 ID，用于「目标毫无动静」场景 */
const SILENT = 'never-any-message'

function deliverTo(target: string, at: number, from = SUP) {
  return recordDelivery({ messageId: `m-${target}-${at}`, targetSessionId: target, fromSessionId: from, at })
}

/** 阶段2（5a）：模拟生产「注入路径先建回合」的前置（断言语义不变） */
function beginTurnFor(sessionId: string): void {
  registerSession(sessionId)
  beginTurn(sessionId, { awaitSend: false })
}

/** 活性自检专用会话（不与用例冲突；自检后处于 crashed 态，无副作用） */
const LIVENESS_PROBE = 'liveness-probe-none'

beforeEach(() => {
  resetDispatchReceipts()
  resetRegistryForTests()
  // 复核①收口：补偿订阅器必须常驻，但 resetSessionEventsForTests（先跑的
  // 测试文件会调用）会 listeners.clear() 静默清掉它——不恢复则下方补偿测试
  // 假失败（失败信息指向业务断言，真实原因无从看出）。ensure 幂等（底层
  // onSessionEvent 按 handler 引用去重、同一引用至多一份），被清后重调即恢复注册。
  ensureTurnChangeCompensationSubscribed()
  // 活性自检：合成一次「广播 true → markCrashed 清 turn」流程，断言补偿
  // false 能到达监听链——将来任何清空都会在此显式报错而非下游假失败。
  ensureTurnChangeCompensationSubscribed()
  const liveness: Array<boolean> = []
  const offLiveness = addTurnChangeListener((sessionId, turnInProgress) => {
    if (sessionId === LIVENESS_PROBE) liveness.push(turnInProgress)
  })
  registerSession(LIVENESS_PROBE)
  beginTurn(LIVENESS_PROBE, { awaitSend: false })
  observeSessionSdkMessage(LIVENESS_PROBE, 'assistant', Date.now())
  markCrashed(LIVENESS_PROBE, { exitCode: 1 })
  offLiveness()
  expect(liveness).toEqual([true, false])
})

describe('dispatch receipts', () => {
  test('a delivered message starts unconsumed', () => {
    const receipt = deliverTo(EMP, T0)
    expect(receipt.consumed).toBe(false)
    expect(receipt.consumedAt).toBeNull()
    expect(receipt.targetWasBusy).toBe(false)
    expect(getReceipt(receipt.messageId)?.consumed).toBe(false)
  })

  test('an idle target consumes the message on its first turn activity', () => {
    const receipt = deliverTo(EMP, T0)

    // 中性事件不算消费（CLI 刚被拉起时的 system/init 早于它读输入）
    observeSessionSdkMessage(EMP, 'system', T0 + 100)
    observeSessionSdkMessage(EMP, 'control_request', T0 + 200)
    expect(getReceipt(receipt.messageId)?.consumed).toBe(false)

    observeSessionSdkMessage(EMP, 'stream_event', T0 + 300)
    const consumed = getReceipt(receipt.messageId)!
    expect(consumed.consumed).toBe(true)
    expect(consumed.consumedAt).toBe(T0 + 300)
  })

  test('a busy target consumes only at the next turn boundary', () => {
    // 目标正在跑一条回合（阶段2：回合经注入路径建立）→ 回执投递时被标记为"忙碌中投递"
    beginTurnFor(EMP)
    observeSessionSdkMessage(EMP, 'assistant', T0 - 1000)
    const receipt = deliverTo(EMP, T0)
    expect(receipt.targetWasBusy).toBe(true)

    // 当前回合继续产生活动 —— 不能算消费（那些属于上一条回合）
    observeSessionSdkMessage(EMP, 'assistant', T0 + 100)
    observeSessionSdkMessage(EMP, 'user', T0 + 200)
    expect(getReceipt(receipt.messageId)?.consumed).toBe(false)

    // 回合边界：CLI 在此时才拉取排队的输入
    observeSessionSdkMessage(EMP, 'result', T0 + 300)
    expect(getReceipt(receipt.messageId)?.consumed).toBe(true)
    expect(getReceipt(receipt.messageId)?.consumedAt).toBe(T0 + 300)
  })

  test('an offline target stays unconsumed while nothing happens', () => {
    const receipt = deliverTo(EMP, T0)
    // 目标没产出任何活动（大目标离线/卡死）；时间流逝本身不应改变状态
    for (let tick = 1; tick <= 5; tick += 1) {
      observeSessionSdkMessage(SILENT, 'result', T0 + tick * 60_000)
    }
    expect(getReceipt(receipt.messageId)?.consumed).toBe(false)
    expect(getReceipt(receipt.messageId)?.consumedAt).toBeNull()
  })

  test('activity from another session does not consume the receipt', () => {
    const receipt = deliverTo(EMP, T0)
    observeSessionSdkMessage(OTHER, 'stream_event', T0 + 100)
    observeSessionSdkMessage(OTHER, 'result', T0 + 200)
    expect(getReceipt(receipt.messageId)?.consumed).toBe(false)
  })

  test('queries return the right receipts', () => {
    const first = deliverTo(EMP, T0)
    const second = deliverTo(EMP, T0 + 1000)
    deliverTo(OTHER, T0 + 2000)

    expect(getReceipt(first.messageId)?.messageId).toBe(first.messageId)
    expect(getReceipt('nope')).toBeNull()

    const forEmp = listReceipts(EMP)
    expect(forEmp.map((receipt) => receipt.messageId)).toEqual([second.messageId, first.messageId])
    expect(listReceipts()).toHaveLength(3)
    expect(listReceipts(OTHER)).toHaveLength(1)
    expect(forEmp[0]?.fromSessionId).toBe(SUP)
  })

  test('counts only the unconsumed dispatches of the given session', () => {
    deliverTo(EMP, T0)
    const second = deliverTo(EMP, T0 + 1000)
    deliverTo(OTHER, T0 + 2000)

    expect(countUnconsumedReceipts(EMP)).toBe(2)
    expect(countUnconsumedReceipts(OTHER)).toBe(1)
    expect(countUnconsumedReceipts(SILENT)).toBe(0)

    // 被消费掉的那条不再计入
    observeSessionSdkMessage(EMP, 'stream_event', T0 + 3000)
    expect(countUnconsumedReceipts(EMP)).toBe(0)
    expect(getReceipt(second.messageId)?.consumed).toBe(true)
  })

  test('a torn-down delivery leaves no receipt behind', () => {
    const receipt = deliverTo(EMP, T0)
    forgetReceipt(receipt.messageId)
    expect(getReceipt(receipt.messageId)).toBeNull()
    expect(listReceipts(EMP)).toHaveLength(0)
  })

  test('the receipt store is capped', () => {
    const first = deliverTo(EMP, T0)
    for (let index = 1; index < MAX_TRACKED_RECEIPTS + 5; index += 1) {
      deliverTo(EMP, T0 + index)
    }
    expect(listReceipts()).toHaveLength(MAX_TRACKED_RECEIPTS)
    expect(getReceipt(first.messageId)).toBeNull()
  })

  test('reports turn-in-progress state from the SDK message flow (stall watcher input)', () => {
    // 从未观察到消息 → 不认为回合进行中
    expect(isSessionTurnInProgress(SILENT)).toBe(false)

    observeSessionSdkMessage(SILENT, 'system', T0)
    observeSessionSdkMessage(SILENT, 'control_request', T0 + 1)
    expect(isSessionTurnInProgress(SILENT)).toBe(false)

    // 阶段2（5a）：回合经注入路径建立后，观察流信号与 result 边界推进该状态
    beginTurnFor(SILENT)
    observeSessionSdkMessage(SILENT, 'assistant', T0 + 2)
    expect(isSessionTurnInProgress(SILENT)).toBe(true)
    observeSessionSdkMessage(SILENT, 'user', T0 + 3)
    expect(isSessionTurnInProgress(SILENT)).toBe(true)

    // 回合边界 → 结束
    observeSessionSdkMessage(SILENT, 'result', T0 + 4)
    expect(isSessionTurnInProgress(SILENT)).toBe(false)
  })
})

describe('GET /api/session-messages (receipt query)', () => {
  async function get(query: string): Promise<Response> {
    const req = new Request(`http://localhost/api/session-messages${query}`, { method: 'GET' })
    return await handleSessionMessagesApi(req, new URL(req.url), ['api', 'session-messages'])
  }

  test('returns the receipt for a known message id', async () => {
    const receipt = deliverTo(EMP, T0)
    observeSessionSdkMessage(EMP, 'stream_event', T0 + 500)

    const body = (await (await get(`?messageId=${receipt.messageId}`)).json()) as {
      ok: boolean
      receipt: { messageId: string; consumed: boolean; consumedAt: number; targetSessionId: string }
    }

    expect(body.ok).toBe(true)
    expect(body.receipt.messageId).toBe(receipt.messageId)
    expect(body.receipt.targetSessionId).toBe(EMP)
    expect(body.receipt.consumed).toBe(true)
    expect(body.receipt.consumedAt).toBe(T0 + 500)
  })

  test('reports 404 for an unknown message id', async () => {
    expect((await get('?messageId=missing')).status).toBe(404)
  })

  test('reports 400 when neither messageId nor targetSessionId is given', async () => {
    expect((await get('')).status).toBe(400)
  })

  test('lists recent receipts for a target session', async () => {
    deliverTo(EMP, T0)
    deliverTo(EMP, T0 + 1000)
    deliverTo(OTHER, T0 + 2000)

    const body = (await (await get(`?targetSessionId=${EMP}`)).json()) as {
      ok: boolean
      receipts: Array<{ targetSessionId: string }>
    }

    expect(body.ok).toBe(true)
    expect(body.receipts).toHaveLength(2)
    expect(body.receipts.every((receipt) => receipt.targetSessionId === EMP)).toBe(true)
  })
})

describe('turn change listeners (方案B: servant_turn_changed 事件源)', () => {
  test('fires true on the idle→busy flip and false on the result boundary', () => {
    const events: Array<{ sessionId: string; turnInProgress: boolean }> = []
    const off = addTurnChangeListener((sessionId, turnInProgress) => {
      events.push({ sessionId, turnInProgress })
    })

    beginTurnFor(EMP)
    observeSessionSdkMessage(EMP, 'assistant', T0)
    observeSessionSdkMessage(EMP, 'result', T0 + 100)

    expect(events).toEqual([
      { sessionId: EMP, turnInProgress: true },
      { sessionId: EMP, turnInProgress: false },
    ])
    off()
  })

  test('does not refire while already mid-turn, and result on idle session does not fire', () => {
    const events: Array<{ sessionId: string; turnInProgress: boolean }> = []
    const off = addTurnChangeListener((sessionId, turnInProgress) => {
      events.push({ sessionId, turnInProgress })
    })

    // 连续活动信号：只有第一次翻转触发
    beginTurnFor(EMP)
    observeSessionSdkMessage(EMP, 'stream_event', T0)
    observeSessionSdkMessage(EMP, 'assistant', T0 + 100)
    observeSessionSdkMessage(EMP, 'user', T0 + 200)
    // 空闲会话收到 result（如启动即报错）：无翻转，不触发
    observeSessionSdkMessage(OTHER, 'result', T0 + 300)

    expect(events).toEqual([{ sessionId: EMP, turnInProgress: true }])
    off()
  })

  test('neutral events never fire, and unsubscribe stops notifications', () => {
    const events: Array<string> = []
    const off = addTurnChangeListener((sessionId) => {
      events.push(sessionId)
    })

    observeSessionSdkMessage(EMP, 'system', T0)
    observeSessionSdkMessage(EMP, 'control_request', T0 + 100)
    expect(events).toEqual([])

    off()
    observeSessionSdkMessage(EMP, 'assistant', T0 + 200)
    expect(events).toEqual([])
  })

  test('a throwing listener does not break state progression or other listeners', () => {
    const seen: Array<boolean> = []
    addTurnChangeListener(() => {
      throw new Error('boom')
    })
    addTurnChangeListener((_sessionId, turnInProgress) => {
      seen.push(turnInProgress)
    })

    beginTurnFor(EMP)
    observeSessionSdkMessage(EMP, 'assistant', T0)

    expect(isSessionTurnInProgress(EMP)).toBe(true)
    expect(seen).toEqual([true])
  })

  // v1.3.1 实测缺陷复现：会话已结束但前端仍显示「忙碌转圈」。
  // 根因：turnActiveBroadcast 只在观察流 result 分支清除并补发 false——
  // CLI 崩溃（markCrashed）/ 主动停止（clearSession）等非观察流路径清 turn 时，
  // 前端收不到 servant_turn_changed(false) 补偿广播，状态灯永久卡 busy
  // （服务端 isSessionTurnInProgress 已为 false，与主管复查吻合）。
  test('compensates a false broadcast when a broadcast turn is cleared by a crash (markCrashed)', () => {
    const events: Array<{ sessionId: string; turnInProgress: boolean }> = []
    const off = addTurnChangeListener((sessionId, turnInProgress) => {
      events.push({ sessionId, turnInProgress })
    })

    beginTurnFor(EMP)
    observeSessionSdkMessage(EMP, 'assistant', T0)
    expect(events).toEqual([{ sessionId: EMP, turnInProgress: true }])

    // CLI 进程异常退出：handleProcessExit 匹配分支 → markCrashed → clearTurnInternal
    markCrashed(EMP, { exitCode: 143 })
    expect(isSessionTurnInProgress(EMP)).toBe(false)

    // 缺陷断言：清 turn 必须补发 false，否则前端状态灯永久卡 busy
    expect(events).toEqual([
      { sessionId: EMP, turnInProgress: true },
      { sessionId: EMP, turnInProgress: false },
    ])
    off()
  })

  test('compensates a false broadcast when a broadcast turn is cleared by an explicit stop (clearSession)', () => {
    const events: Array<{ sessionId: string; turnInProgress: boolean }> = []
    const off = addTurnChangeListener((sessionId, turnInProgress) => {
      events.push({ sessionId, turnInProgress })
    })

    beginTurnFor(EMP)
    observeSessionSdkMessage(EMP, 'stream_event', T0)
    expect(events).toEqual([{ sessionId: EMP, turnInProgress: true }])

    // 主动停止：stopSession → markStopped + clearSession（registry 条目删除）
    clearSession(EMP)
    expect(isSessionTurnInProgress(EMP)).toBe(false)
    expect(events).toEqual([
      { sessionId: EMP, turnInProgress: true },
      { sessionId: EMP, turnInProgress: false },
    ])
    off()
  })

  test('a turn cleared without any true broadcast fires nothing (no spurious false)', () => {
    const events: Array<{ sessionId: string; turnInProgress: boolean }> = []
    const off = addTurnChangeListener((sessionId, turnInProgress) => {
      events.push({ sessionId, turnInProgress })
    })

    // turn 建立（CLI 启动即死，从未产生观察流可见信号）→ 前端从未转圈 →
    // 清 turn 时不得补发无中生有的 false
    beginTurnFor(EMP)
    markCrashed(EMP, { exitCode: 1 })
    expect(events).toEqual([])
    off()
  })

  // 复核③：两条等价路径——tombstoneSession 与 TurnHandle.abort 同样经
  // clearTurnInternal 发 turn_changed(none)，补偿行为必须一致（全路径等价）。
  test('compensates a false broadcast on the tombstone path (tombstoneSession)', () => {
    const events: Array<{ sessionId: string; turnInProgress: boolean }> = []
    const off = addTurnChangeListener((sessionId, turnInProgress) => {
      events.push({ sessionId, turnInProgress })
    })

    beginTurnFor(EMP)
    observeSessionSdkMessage(EMP, 'assistant', T0)
    expect(events).toEqual([{ sessionId: EMP, turnInProgress: true }])

    // DELETE API → tombstone：清 turn + phase=deleted（6a 操作类短路的标记源）
    tombstoneSession(EMP)
    expect(isSessionTurnInProgress(EMP)).toBe(false)
    expect(events).toEqual([
      { sessionId: EMP, turnInProgress: true },
      { sessionId: EMP, turnInProgress: false },
    ])
    off()
  })

  test('compensates a false broadcast on the TurnHandle.abort path', () => {
    const events: Array<{ sessionId: string; turnInProgress: boolean }> = []
    const off = addTurnChangeListener((sessionId, turnInProgress) => {
      events.push({ sessionId, turnInProgress })
    })

    // 注入方主动撤回：beginTurn 拿 handle → abort（settleTurnByIdentity）
    registerSession(EMP)
    const handle = beginTurn(EMP, { awaitSend: false })
    observeSessionSdkMessage(EMP, 'assistant', T0)
    expect(events).toEqual([{ sessionId: EMP, turnInProgress: true }])

    handle?.abort()
    expect(isSessionTurnInProgress(EMP)).toBe(false)
    expect(events).toEqual([
      { sessionId: EMP, turnInProgress: true },
      { sessionId: EMP, turnInProgress: false },
    ])
    off()
  })
  // v1.4.0 阶段2 · 6「转圈无上限」：SDK socket 断开（进程未退）时
  // conversationService.detachSdkConnection 调 dropActiveTurn 预防性清 turn——
  // 补偿广播链路与 crash/stop 路径等价：前端立即从 busy 降下，不再无上限转圈。
  test('compensates a false broadcast on the observation-blind path (dropActiveTurn)', () => {
    const events: Array<{ sessionId: string; turnInProgress: boolean }> = []
    const off = addTurnChangeListener((sessionId, turnInProgress) => {
      events.push({ sessionId, turnInProgress })
    })

    beginTurnFor(EMP)
    observeSessionSdkMessage(EMP, 'assistant', T0)
    expect(events).toEqual([{ sessionId: EMP, turnInProgress: true }])

    dropActiveTurn(EMP, { cause: 'sdk_socket_disconnected' })
    expect(isSessionTurnInProgress(EMP)).toBe(false)
    expect(events).toEqual([
      { sessionId: EMP, turnInProgress: true },
      { sessionId: EMP, turnInProgress: false },
    ])
    off()
  })
})

