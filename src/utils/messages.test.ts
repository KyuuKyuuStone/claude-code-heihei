import { describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { BUSINESS_ERROR_CODES } from '../constants/businessErrors.js'
import {
  getLastRequestBodyProfile,
  recordRequestBodySize,
  resetBodySizeSamplesForTests,
} from '../services/api/contextGovernance.js'
import {
  getPdfTooLargeErrorMessage,
  getRequestTooLargeErrorMessage,
} from '../services/api/errors.js'
import type { AssistantMessage } from '../types/message.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from './messages.js'

function assistant(
  messageId: string,
  content: AssistantMessage['message']['content'],
): AssistantMessage {
  const message = createAssistantMessage({ content })
  message.message.id = messageId
  return message
}

function toolUse(id: string): AssistantMessage['message']['content'][number] {
  return {
    type: 'tool_use',
    id,
    name: 'Read',
    input: { file_path: `/tmp/${id}` },
  }
}

function toolResult(id: string) {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: 'ok',
      },
    ] as ContentBlockParam[],
  })
}

describe('normalizeMessagesForAPI assistant fragment indexing', () => {
  test('preserves a 10,000-step tool-result chain', () => {
    const messages = [createUserMessage({ content: 'start' })]

    for (let i = 0; i < 10_000; i++) {
      const toolId = `tool-${i}`
      messages.push(
        assistant(`response-${i}`, [toolUse(toolId)]),
        toolResult(toolId),
      )
    }

    const normalized = normalizeMessagesForAPI(messages)
    const assistants = normalized.filter(
      (message): message is AssistantMessage => message.type === 'assistant',
    )
    const toolResults = normalized.filter(message => message.type === 'user')

    expect(normalized).toHaveLength(20_001)
    expect(assistants).toHaveLength(10_000)
    expect(toolResults).toHaveLength(10_001)
    expect(assistants.at(-1)?.message.id).toBe('response-9999')
    expect(toolResults.at(-1)?.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tool-9999',
        content: 'ok',
      },
    ])
  })

  test('merges interleaved response IDs across tool-result messages', () => {
    const normalized = normalizeMessagesForAPI([
      assistant('response-a', [toolUse('tool-a')]),
      toolResult('tool-a'),
      assistant('response-b', [toolUse('tool-b')]),
      toolResult('tool-b'),
      assistant('response-a', [{ type: 'text', text: 'A complete' }]),
      assistant('response-b', [{ type: 'text', text: 'B complete' }]),
    ])

    const assistants = normalized.filter(
      (message): message is AssistantMessage => message.type === 'assistant',
    )

    expect(assistants.map(message => message.message.id)).toEqual([
      'response-a',
      'response-b',
    ])
    expect(assistants[0]!.message.content.map(block => block.type)).toEqual([
      'tool_use',
      'text',
    ])
    expect(assistants[1]!.message.content.map(block => block.type)).toEqual([
      'tool_use',
      'text',
    ])
  })

  test('does not merge the same response ID across a normal user turn', () => {
    const normalized = normalizeMessagesForAPI([
      assistant('response-a', [{ type: 'text', text: 'before' }]),
      createUserMessage({ content: 'next turn' }),
      assistant('response-a', [{ type: 'text', text: 'after' }]),
    ])

    const assistants = normalized.filter(
      (message): message is AssistantMessage => message.type === 'assistant',
    )

    expect(assistants).toHaveLength(2)
    expect(
      assistants.map(message =>
        message.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join(''),
      ),
    ).toEqual(['before', 'after'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v1.7.5 修 413 锁死：媒体类错误的剥离必须能**回到旧消息**去找那条真正的大媒体。
// 原实现「回扫到最近一条 user 消息即停、遇 assistant 即 break」，协作会话历史
// 形如 [派活1(含大图), 413错误1, 派活2, 413错误2, …] ⇒ 每次新错误都命中「不含
// 媒体的新派活」⇒ 旧大媒体永远剥不掉 ⇒ 每回合复现同一条 413（客户实测 8+ 条）。
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeMessagesForAPI：媒体类错误的剥离回扫（v1.7.5 修 413 锁死）', () => {
  const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

  const imageBlock = (): ContentBlockParam =>
    ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 },
    }) as ContentBlockParam

  const documentBlock = (): ContentBlockParam =>
    ({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
    }) as ContentBlockParam

  const userWithImage = (text: string) =>
    createUserMessage({
      content: [{ type: 'text', text }, imageBlock()],
    })

  const requestTooLargeError = () =>
    createAssistantAPIErrorMessage({
      content: getRequestTooLargeErrorMessage(),
      error: 'invalid_request',
      businessErrorCode: BUSINESS_ERROR_CODES.REQUEST_TOO_LARGE,
    })

  const contentOf = (m: unknown): Array<{ type?: string }> => {
    const content = (m as { message?: { content?: unknown } } | undefined)?.message
      ?.content
    return Array.isArray(content) ? (content as Array<{ type?: string }>) : []
  }

  /** 出参里所有 block 类型（相邻 user 会被 merge，故按整表统计更稳） */
  const allBlockTypes = (out: unknown[]): string[] =>
    out.flatMap(m => contentOf(m).map(b => b.type ?? ''))

  const blockTypes = (message: unknown): string[] =>
    contentOf(message).map(b => b.type ?? '')

  test('协作形态：大媒体在**旧消息**里也必须被剥（回扫不止步于最近一条 user）', () => {
    // 关键：媒体消息与每一条错误之间都隔着**别的 user 消息**——这样「最近一条
    // user」永远不是那条带媒体的，旧实现（回扫即停）必然剥不掉 ⇒ 本用例必红。
    const mediaMsg = userWithImage('派活1（带大图）')
    const dispatch2 = createUserMessage({ content: '派活2（不含媒体）' })
    const error1 = requestTooLargeError()
    const dispatch3 = createUserMessage({ content: '派活3（不含媒体）' })
    const error2 = requestTooLargeError()

    const out = normalizeMessagesForAPI([
      mediaMsg,
      dispatch2,
      error1,
      dispatch3,
      error2,
    ])

    // ← 关键断言：整表里不再有 image
    expect(allBlockTypes(out)).not.toContain('image')
    // 以 [image] 标记留痕（复用 stripImagesFromMessages 的语义）
    expect(JSON.stringify(out)).toContain('[image]')
    // 各条派活正文都不丢
    expect(JSON.stringify(out)).toContain('派活2（不含媒体）')
    expect(JSON.stringify(out)).toContain('派活3（不含媒体）')
  })

  test('非破坏性：剥离只发生在请求期，输入（transcript 侧）原样不动', () => {
    const mediaMsg = userWithImage('派活1（带大图）')
    const out = normalizeMessagesForAPI([
      mediaMsg,
      createUserMessage({ content: '派活2（不含媒体）' }),
      requestTooLargeError(),
      createUserMessage({ content: '派活3（不含媒体）' }),
      requestTooLargeError(),
    ])

    // 出参被剥
    expect(allBlockTypes(out)).not.toContain('image')
    // 入参完好（normalize 是纯变换，原消息对象不被改写）
    expect(blockTypes(mediaMsg)).toContain('image')
  })

  test('单条错误（媒体就在紧邻的上一条 user）仍能剥 —— 既有行为不回归', () => {
    const only = userWithImage('看这个截图')
    const out = normalizeMessagesForAPI([only, requestTooLargeError()])

    expect(allBlockTypes(out)).not.toContain('image')
  })

  test('剥离结果交接到 413 诊断画像（body 字节 + 媒体计数 + 命中消息 id）', () => {
    resetBodySizeSamplesForTests()
    const mediaMsg = userWithImage('派活1（带大图）')
    normalizeMessagesForAPI([
      mediaMsg,
      createUserMessage({ content: '派活2（不含媒体）' }),
      requestTooLargeError(),
      createUserMessage({ content: '派活3（不含媒体）' }),
      requestTooLargeError(),
    ])
    // 传消息数组（真实调用形态）：字节数与媒体计数同处算出
    recordRequestBodySize(
      [{ message: { content: [{ type: 'text', text: 'x' }] } }],
      200_000,
    )

    const profile = getLastRequestBodyProfile()
    expect(profile).not.toBeNull()
    expect(profile!.bytes).toBeGreaterThan(0)
    expect(profile!.contextWindowTokens).toBe(200_000)
    expect(profile!.imageBlocks).toBe(0)
    expect(profile!.mediaStrippedMessageIds).toEqual([mediaMsg.uuid])
  })

  test('窄类型集（PDF 专有错误）语义不变：只删 document，不碰 image', () => {
    const mixed = createUserMessage({
      content: [
        { type: 'text', text: '附件' },
        documentBlock(),
        imageBlock(),
      ],
    })
    const pdfError = createAssistantAPIErrorMessage({
      content: getPdfTooLargeErrorMessage(),
      businessErrorCode: BUSINESS_ERROR_CODES.PDF_TOO_LARGE,
    })

    const out = normalizeMessagesForAPI([mixed, pdfError])
    const types = blockTypes(out.find(m => m.uuid === mixed.uuid))
    expect(types).not.toContain('document')
    expect(types).toContain('image')
  })
})
