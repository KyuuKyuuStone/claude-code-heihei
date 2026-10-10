/**
 * P-A：媒体块字节预算（`mediaBudget.ts`）
 *
 * 修的洞：`API_MAX_MEDIA_PER_REQUEST`(100) 只封**条数**不封**字节** ⇒
 * 100 张图可撑爆请求体。这里钉住「字节也要达标的」新语义，以及旧条数语义不回归。
 */
import { describe, expect, test } from 'bun:test'
import { stripExcessMediaItems, totalMediaBytes } from './mediaBudget.js'

/** 约 `dataLen` 字节的图片块（信封开销另计，见实现） */
function imageBlock(dataLen: number) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(dataLen) },
  }
}

function userMsg(uuid: string, blocks: unknown[]) {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: blocks },
  }
}

function mediaCount(messages: unknown[]): number {
  return (JSON.stringify(messages).match(/"type":"image"/g) ?? []).length
}

describe('stripExcessMediaItems：条数 + 字节双上限', () => {
  test('都未超 ⇒ 原样返回（引用相等，正常会话零变化）', () => {
    const messages = [userMsg('u1', [imageBlock(1000)])]
    expect(stripExcessMediaItems(messages, 100, 10_000)).toBe(messages)
  })

  test('省略字节预算 ⇒ 只按条数（旧行为不回归）', () => {
    const messages = [userMsg('u1', [imageBlock(1000), imageBlock(1000)])]
    const out = stripExcessMediaItems(messages, 1)
    expect(mediaCount(out)).toBe(1)
  })

  test('100 张图未超条数、但超字节预算 ⇒ 仍被降到预算内（本次修的洞）', () => {
    const messages = [userMsg('u1', Array.from({ length: 100 }, () => imageBlock(5_000)))]
    const before = totalMediaBytes(messages)
    expect(before).toBeGreaterThan(500_000)

    const out = stripExcessMediaItems(messages, 100, 100_000)

    expect(mediaCount(out)).toBeGreaterThan(0) // 没被清空
    expect(mediaCount(out)).toBeLessThan(100) // 确实裁了
    expect(totalMediaBytes(out)).toBeLessThanOrEqual(100_000)
  })

  test('从最旧开始丢：最新的那张图必须留下', () => {
    const oldest = userMsg('oldest', [imageBlock(50_000)])
    const newest = userMsg('newest', [imageBlock(50_000)])
    const out = stripExcessMediaItems([oldest, newest], 100, 60_000)

    expect(mediaCount(out)).toBe(1)
    const kept = JSON.stringify(out)
    // 消息本身保留（不拆会话结构），只是里面的图没了 ⇒ 留标记、不产生空 content
    expect(kept).toContain('"uuid":"oldest"')
    expect(kept).toContain('"uuid":"newest"')
    expect(kept).toContain('[media removed]')
  })

  test('tool_result 内嵌媒体同样计入预算并可被裁掉', () => {
    const nested = userMsg('u1', [
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: [{ type: 'text', text: 'ok' }, imageBlock(200_000)],
      },
    ])
    expect(totalMediaBytes([nested])).toBeGreaterThan(200_000)

    const out = stripExcessMediaItems([nested], 100, 1000)
    expect(JSON.stringify(out)).not.toContain('"type":"image"')
    // 非媒体的文本内容保留
    expect(JSON.stringify(out)).toContain('"text":"ok"')
  })

  test('顶层与内嵌混合时，按出现顺序（时间）丢弃', () => {
    const messages = [
      userMsg('u1', [imageBlock(60_000)]),
      userMsg('u2', [
        { type: 'tool_result', tool_use_id: 't1', content: [imageBlock(60_000)] },
      ]),
    ]
    const out = stripExcessMediaItems(messages, 100, 70_000)
    // 只该丢最旧的那个（u1 的顶层图）⇒ 剩下的媒体在 u2（tool_result 内嵌）
    expect(mediaCount(out)).toBe(1)
    const kept = JSON.stringify(out)
    expect(kept).toContain('"uuid":"u2"')
    expect(kept.slice(kept.indexOf('"uuid":"u2"'))).toContain('"type":"image"')
  })
})
