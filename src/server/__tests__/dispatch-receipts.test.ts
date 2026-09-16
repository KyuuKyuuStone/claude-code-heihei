import { beforeEach, describe, expect, test } from 'bun:test'
import { handleSessionMessagesApi } from '../api/servants.js'
import {
  MAX_TRACKED_RECEIPTS,
  forgetReceipt,
  getReceipt,
  listReceipts,
  observeSessionSdkMessage,
  recordDelivery,
  resetDispatchReceipts,
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

beforeEach(() => {
  resetDispatchReceipts()
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
    // 目标正在跑一条回合：先有活动信号，回执投递时因此被标记为"忙碌中投递"
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
