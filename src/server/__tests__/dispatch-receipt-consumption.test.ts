import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  countUnconsumedReceipts,
  getReceipt,
  observeSessionSdkMessage,
  recordDelivery,
} from '../services/dispatchReceiptService.js'

/**
 * P2-b（裁决二十三第 5 条）：回执消费的**可见性**。
 *
 * 背景：本模块回执表是纯内存 Map（无 HTTP 面 / 不写 diagnostics / 无 console）⇒
 * 「deny → 回执消费」这条链在冒烟里拿不到正向物证。本次在 consume 成功消费时补一条
 * 诊断事件（**只加记录、零行为变更**）。本文件锁住该事件与字段。
 */

const DIAG_REL = path.join('cc-heihei', 'diagnostics', 'diagnostics.jsonl')

describe('dispatch receipt consumption 可见性（P2-b）', () => {
  let tmpDir: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-receipt-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    if (originalConfigDir) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function readDiagnostics(): Promise<Array<Record<string, unknown>>> {
    try {
      const raw = await fs.readFile(path.join(tmpDir, DIAG_REL), 'utf-8')
      return raw
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    } catch {
      return []
    }
  }

  test('消费成功时记一条 dispatch_receipts_consumed（trigger=result，含 consumedCount）', async () => {
    const sid = `receipt-ok-${crypto.randomUUID()}`
    const mid = `msg-${crypto.randomUUID()}`
    recordDelivery({ messageId: mid, targetSessionId: sid })
    expect(countUnconsumedReceipts(sid)).toBe(1)

    observeSessionSdkMessage(sid, 'result', Date.now())
    await new Promise((r) => setTimeout(r, 80)) // 诊断是 fire-and-forget 写入，等它落盘

    // 行为不变：回执确实被消费
    expect(getReceipt(mid)?.consumed).toBe(true)
    expect(countUnconsumedReceipts(sid)).toBe(0)

    const hits = (await readDiagnostics()).filter((e) => e.type === 'dispatch_receipts_consumed')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.severity).toBe('info')
    expect(hits[0]!.sessionId).toBe(sid)
    const d = hits[0]!.details as Record<string, unknown>
    expect(d.sessionId).toBe(sid)
    expect(d.consumedCount).toBe(1)
    expect(d.trigger).toBe('result')
    expect(typeof d.at).toBe('number')
  })

  test('边界：没有未消费回执时 consume 不记事件（不产生噪音）', async () => {
    const sid = `receipt-idle-${crypto.randomUUID()}`
    observeSessionSdkMessage(sid, 'result', Date.now())
    await new Promise((r) => setTimeout(r, 80)) // 诊断是 fire-and-forget 写入，等它落盘
    expect(countUnconsumedReceipts(sid)).toBe(0)
    expect((await readDiagnostics()).filter((e) => e.type === 'dispatch_receipts_consumed')).toHaveLength(0)
  })

  test('同一次 consume 消费多条 → 只记一条事件，consumedCount 为条数', async () => {
    const sid = `receipt-multi-${crypto.randomUUID()}`
    const mids = [`m1-${crypto.randomUUID()}`, `m2-${crypto.randomUUID()}`]
    for (const mid of mids) recordDelivery({ messageId: mid, targetSessionId: sid })
    expect(countUnconsumedReceipts(sid)).toBe(2)

    observeSessionSdkMessage(sid, 'result', Date.now())
    await new Promise((r) => setTimeout(r, 80)) // 诊断是 fire-and-forget 写入，等它落盘

    expect(mids.every((m) => getReceipt(m)?.consumed === true)).toBe(true)
    const hits = (await readDiagnostics()).filter((e) => e.type === 'dispatch_receipts_consumed')
    expect(hits).toHaveLength(1)
    expect((hits[0]!.details as Record<string, unknown>).consumedCount).toBe(2)
  })
})
