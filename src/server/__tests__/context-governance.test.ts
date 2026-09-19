import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  BODY_SIZE_SAMPLE_WINDOW,
  BODY_SIZE_SUMMARY_EVERY,
  MAX_SINGLE_MESSAGE_BYTES,
  MIN_TURNS_TO_KEEP,
  pruneMessagesForContextBudget,
  percentile,
  recordRequestBodySize,
  resetBodySizeSamplesForTests,
  setMessagePersisterForTests,
  truncateOversizedMessages,
} from '../../services/api/contextGovernance.js'
import { setDiagnosticsLogWriterForTests } from '../../utils/diagLogs.js'
import type { Message } from '../../types/message.js'

/**
 * 上下文体积治理（v1.2.6 扩批）：M1 截断+可回查 / M2 分位+告警 / L1+L2 裁剪。
 * 诊断经 setDiagnosticsLogWriterForTests 注入收集（DI 缝，冷热确定）；
 * M1 落盘经 setMessagePersisterForTests 注入临时实现。
 */

type DiagCall = { level: string; event: string; data: Record<string, unknown> }
const diagCalls: DiagCall[] = []

function userMessage(text: string, uuid?: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...(uuid ? { uuid } : {}),
  } as Message
}

function toolResultUserMessage(toolUseId: string, content: string): Message {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  } as Message
}

function assistantMessage(text: string): Message {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as Message
}

function bigText(kb: number): string {
  return 'x'.repeat(kb * 1024)
}

describe('truncateOversizedMessages (M1)', () => {
  const persisted: Array<{ id: string; size: number }> = []

  beforeEach(() => {
    diagCalls.length = 0
    persisted.length = 0
    setDiagnosticsLogWriterForTests((level, event, data) => {
      diagCalls.push({ level, event, data })
    })
    setMessagePersisterForTests((content, id) => {
      persisted.push({ id, size: JSON.stringify(content).length })
      return {
        path: `/tmp/tool-results/${id}.txt`,
        write: Promise.resolve(true),
      }
    })
  })

  afterEach(() => {
    setDiagnosticsLogWriterForTests(null)
    setMessagePersisterForTests(null)
  })

  test('small messages pass through untouched', () => {
    const messages = [userMessage('hello'), toolResultUserMessage('tu-1', 'result')]
    const { messages: out, truncatedCount } = truncateOversizedMessages(messages)
    expect(truncatedCount).toBe(0)
    expect(out).toEqual(messages)
    expect(diagCalls.some((c) => c.event === 'message_truncated')).toBe(false)
  })

  test('oversized tool_result is truncated with reference marker and original persisted', () => {
    const original = bigText(80) // 80KB > 48KB
    const { messages: out, truncatedCount } = truncateOversizedMessages([
      toolResultUserMessage('tu-big', original),
    ])

    expect(truncatedCount).toBe(1)
    const block = (out[0] as any).message.content[0]
    expect(block.type).toBe('tool_result')
    expect(block.content.length).toBeLessThan(original.length)
    expect(block.content).toContain(`truncated at ${MAX_SINGLE_MESSAGE_BYTES} bytes`)
    expect(block.content).toContain('full content saved to')
    // 截后文本体积贴近阈值（原文整段已被移出消息，仅存于落盘文件）
    expect(block.content.length).toBeLessThanOrEqual(MAX_SINGLE_MESSAGE_BYTES + 200)
    // 原文落盘可回查
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.size).toBeGreaterThan(40000)
    // 诊断可观测
    const event = diagCalls.find((c) => c.event === 'message_truncated')
    expect(event).toBeDefined()
  })

  test('oversized plain user text is truncated too (non-tool_result gap)', () => {
    const { truncatedCount } = truncateOversizedMessages([userMessage(bigText(80))])
    expect(truncatedCount).toBe(1)
    expect(persisted).toHaveLength(1)
  })

  test('assistant messages are never truncated', () => {
    const { messages: out, truncatedCount } = truncateOversizedMessages([
      assistantMessage(bigText(80)),
    ])
    expect(truncatedCount).toBe(0)
    expect((out[0] as any).message.content[0].text).toBe(bigText(80))
  })

  test('persist failure still truncates but marks data loss honestly', () => {
    setMessagePersisterForTests(() => ({ path: null, write: Promise.resolve(false) }))
    const { truncatedCount } = truncateOversizedMessages([userMessage(bigText(80))])
    expect(truncatedCount).toBe(1)
    const block = (truncateOversizedMessages([userMessage(bigText(80))]).messages[0] as any)
      .message.content[0]
    // 落盘不可得时标记如实说明（防静默丢信息）
    expect(block.text).toContain('NOT persisted')
  })

  // 审查 P2①：单条消息可含多条超长 tool_result（并行多工具调用）——
  // 每个被截断 block 的原文必须分别落盘并各自引用，标记不得失实

  function multiToolResultMessage(contents: string[]): Message {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: contents.map((content, i) => ({
          type: 'tool_result',
          tool_use_id: `tu-${i}`,
          content,
        })),
      },
    } as Message
  }

  test('multiple oversized tool_results in one message each get their own persisted original', () => {
    const { messages: out, truncatedCount } = truncateOversizedMessages([
      multiToolResultMessage([bigText(60), bigText(70), 'small']),
    ])

    expect(truncatedCount).toBe(1)
    // 两个超长块各自落盘（小块不动）
    expect(persisted).toHaveLength(2)
    expect(new Set(persisted.map((p) => p.id)).size).toBe(2)
    const blocks = (out[0] as any).message.content
    expect(blocks).toHaveLength(3)
    // 每个被截断块的标记引用各自的路径（逐块真实，不再共享一个失实路径）
    for (let i = 0; i < 2; i++) {
      expect(blocks[i].content).toContain('truncated at')
      expect(blocks[i].content).toContain(`full content saved to /tmp/tool-results/`)
    }
    expect(persisted.every((p) => p.size > 40000)).toBe(true)
    // 小块原样保留
    expect(blocks[2].content).toBe('small')
  })

  test('per-block persist failure marks only that block, others keep honest references', () => {
    setMessagePersisterForTests((content, id) => {
      if (id.endsWith('b0t0')) {
        // 仅第一块落盘失败
        return { path: null, write: Promise.resolve(false) }
      }
      persisted.push({ id, size: JSON.stringify(content).length })
      return { path: `/tmp/tool-results/${id}.txt`, write: Promise.resolve(true) }
    })

    const { messages: out, truncatedCount } = truncateOversizedMessages([
      multiToolResultMessage([bigText(60), bigText(60), bigText(60)]),
    ])

    expect(truncatedCount).toBe(1)
    const blocks = (out[0] as any).message.content
    expect(blocks[0].content).toContain('NOT persisted')
    expect(blocks[0].content).not.toContain('full content saved to')
    // 其余两块不受牵连，仍引用各自真实路径
    expect(blocks[1].content).toContain('full content saved to')
    expect(blocks[1].content).not.toContain('NOT persisted')
    expect(blocks[2].content).toContain('full content saved to')
    expect(blocks[2].content).not.toContain('NOT persisted')
    expect(persisted).toHaveLength(2)
  })
})

describe('recordRequestBodySize (M2)', () => {
  beforeEach(() => {
    diagCalls.length = 0
    resetBodySizeSamplesForTests()
    setDiagnosticsLogWriterForTests((level, event, data) => {
      diagCalls.push({ level, event, data })
    })
  })

  afterEach(() => {
    setDiagnosticsLogWriterForTests(null)
    resetBodySizeSamplesForTests()
  })

  test('percentile helper is stable on sorted input', () => {
    expect(percentile([100, 200, 300, 400, 500], 50)).toBe(300)
    expect(percentile([100, 200, 300, 400, 500], 90)).toBe(500)
    expect(percentile([], 50)).toBeNull()
  })

  test('logs per-request bytes and periodic summary', () => {
    // 填到汇总周期：每 BODY_SIZE_SUMMARY_EVERY 次输出一次 summary
    for (let i = 1; i <= BODY_SIZE_SUMMARY_EVERY; i++) {
      recordRequestBodySize(1000 * i, 200_000)
    }
    expect(diagCalls.filter((c) => c.event === 'request_body_bytes')).toHaveLength(
      BODY_SIZE_SUMMARY_EVERY,
    )
    const summary = diagCalls.find((c) => c.event === 'request_body_size_summary')
    expect(summary).toBeDefined()
    expect(summary!.data.p50).toBe(1000 * 25)
    expect(summary!.data.count).toBe(BODY_SIZE_SUMMARY_EVERY)
  })

  test('alerts when bytes approach the context window, with actionable hint', () => {
    // 阈值 = 200k tokens × 0.6 × 3.5 × 0.8 = 336_000 bytes
    const { alerted } = recordRequestBodySize(400_000, 200_000)
    expect(alerted).toBe(true)
    const alert = diagCalls.find((c) => c.event === 'request_body_size_alert')
    expect(alert).toBeDefined()
    expect(alert!.level).toBe('warn')
    expect(String(alert!.data.hint)).toContain('compact')
  })

  test('no alert below threshold', () => {
    const { alerted } = recordRequestBodySize(100_000, 200_000)
    expect(alerted).toBe(false)
    expect(diagCalls.some((c) => c.event === 'request_body_size_alert')).toBe(false)
  })

  // 审查 P3 降噪：per-request 字节流降为 debug（不淹没 warn/error 浏览），
  // 数据仍全量落 jsonl 可重建曲线
  test('per-request byte events are logged at debug level', () => {
    recordRequestBodySize(1000, 200_000)
    const event = diagCalls.find((c) => c.event === 'request_body_bytes')
    expect(event).toBeDefined()
    expect(event!.level).toBe('debug')
  })

  test('alert is deduplicated per episode: one warn until bytes fall back under threshold', () => {
    // episode：连续超阈 → 只告警一次
    expect(recordRequestBodySize(400_000, 200_000).alerted).toBe(true)
    expect(recordRequestBodySize(420_000, 200_000).alerted).toBe(false)
    expect(recordRequestBodySize(410_000, 200_000).alerted).toBe(false)
    expect(diagCalls.filter((c) => c.event === 'request_body_size_alert')).toHaveLength(1)

    // 回落到阈值以下 → episode 结束 → 再次超阈可再次告警
    expect(recordRequestBodySize(100_000, 200_000).alerted).toBe(false)
    expect(recordRequestBodySize(400_000, 200_000).alerted).toBe(true)
    expect(diagCalls.filter((c) => c.event === 'request_body_size_alert')).toHaveLength(2)
  })

  test('sample window is bounded', () => {
    for (let i = 0; i < BODY_SIZE_SAMPLE_WINDOW + 50; i++) {
      recordRequestBodySize(1000, 200_000)
    }
    // 不炸即窗口滚动成功；分位 summary 依旧可产出
    expect(diagCalls.some((c) => c.event === 'request_body_size_summary')).toBe(true)
  })
})

describe('pruneMessagesForContextBudget (L1+L2)', () => {
  beforeEach(() => {
    diagCalls.length = 0
    setDiagnosticsLogWriterForTests((level, event, data) => {
      diagCalls.push({ level, event, data })
    })
  })

  afterEach(() => {
    setDiagnosticsLogWriterForTests(null)
  })

  /** 构造 N 个轮次组：user(输入) → assistant(带 tool_use) → tool_result 收尾 */
  function buildTurns(turnTexts: string[]): Message[] {
    const messages: Message[] = []
    for (const text of turnTexts) {
      const toolUseId = `tu-${messages.length}`
      messages.push(userMessage(`[turn] ${text}`, `u-${messages.length}`))
      messages.push({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: toolUseId, name: 'Bash', input: { cmd: text } },
          ],
        },
      } as Message)
      messages.push(toolResultUserMessage(toolUseId, `[tool] ${text}`))
    }
    return messages
  }

  test('under budget: zero behavior change', () => {
    const messages = buildTurns(['a', 'b'])
    const result = pruneMessagesForContextBudget(messages, { contextWindowTokens: 1_000_000 })
    expect(result.pruned).toBe(false)
    expect(result.messages).toEqual(messages)
    expect(diagCalls.some((c) => c.event === 'context_pruned')).toBe(false)
  })

  test('over budget: middle turns pruned, first turn (goal) and last turns kept', () => {
    // 中间组放大确保超预算（5 组 × 每组 3 条消息；中间 3 组各带 20KB 文本）
    const messages = [
      userMessage('[turn] goal-task', 'u-goal'),
      assistantMessage('[reply] goal-task'),
      toolResultUserMessage('tu-goal', '[tool] goal-task'),
      userMessage(`[turn] mid-1 ${bigText(20)}`, 'u-1'),
      assistantMessage('[reply] mid-1'),
      toolResultUserMessage('tu-1', '[tool] mid-1'),
      userMessage(`[turn] mid-2 ${bigText(20)}`, 'u-2'),
      assistantMessage('[reply] mid-2'),
      toolResultUserMessage('tu-2', '[tool] mid-2'),
      userMessage(`[turn] mid-3 ${bigText(20)}`, 'u-3'),
      assistantMessage('[reply] mid-3'),
      toolResultUserMessage('tu-3', '[tool] mid-3'),
      userMessage('[turn] latest', 'u-last'),
      assistantMessage('[reply] latest'),
      toolResultUserMessage('tu-last', '[tool] latest'),
    ]
    const windowTokens = 8_000 // budget ≈ 16_800 bytes
    const result = pruneMessagesForContextBudget(messages, {
      contextWindowTokens: windowTokens,
      minTurnsToKeep: MIN_TURNS_TO_KEEP,
    })

    expect(result.pruned).toBe(true)
    expect(result.prunedTurns).toBeGreaterThan(0)
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore)
    const flat = result.messages.map((m) => JSON.stringify(m)).join('')
    // 首轮（任务目标）恒保留
    expect(flat).toContain('goal-task')
    // 末组（当前现场）恒保留
    expect(flat).toContain('latest')
    // 中间深处轮次被裁（末 2 组 = mid-3 + latest 保留）
    expect(flat).not.toContain('mid-2')

    const event = diagCalls.find((c) => c.event === 'context_pruned')
    expect(event).toBeDefined()
    expect(event!.data.pruned_turns).toBe(result.prunedTurns)
  })

  test('turn groups are atomic: no orphan tool_result after pruning', () => {
    const messages = buildTurns([
      'goal',
      `m1 ${bigText(20)}`,
      `m2 ${bigText(20)}`,
      `m3 ${bigText(20)}`,
      'tail',
    ])
    const result = pruneMessagesForContextBudget(messages, { contextWindowTokens: 8_000 })

    const ids = new Set<string>()
    for (const msg of result.messages) {
      const content = (msg as any).message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'tool_use') ids.add(block.id)
        if (block.type === 'tool_result') ids.add(`RESULT:${block.tool_use_id}`)
      }
    }
    // 裁剪按组原子删除：不存在「result 在而 use 不在」（孤儿 result）
    for (const id of ids) {
      if (id.startsWith('RESULT:')) {
        expect(ids.has(id.slice(7))).toBe(true)
      }
    }
  })

  test('keeps at least the reserved turns even when they alone exceed budget', () => {
    // 首轮+末组就超预算：不裁保留组（宁可超窗也不丢任务目标/现场）
    const messages = buildTurns([bigText(60), bigText(60)])
    const result = pruneMessagesForContextBudget(messages, { contextWindowTokens: 8_000 })
    // 只有 2 组 = 首轮 + 末组全保留，droppable 为空
    expect(result.pruned).toBe(false)
    expect(result.messages).toHaveLength(messages.length)
  })
})
