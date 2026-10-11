/**
 * v1.7.5「上下文面板主标虚高」修复的判别力自检
 *
 * 缺陷现场：面板主标 `≥200,000 / 100%`（明细只有十几万）。成因＝粗估把 **compact
 * 之前的历史全部计入** + 主标 `max(estimate, usage)` clamp 顶格 + 明细恒取上一轮
 * usage（双基准拼接）。
 *
 * 本文件两层复现：
 *   · 纯函数层：`transcriptContextEstimate.ts` 的 boundary-aware 累计与明细组装；
 *   · 集成层：真实 SessionService + 真实 jsonl（含 `compact_boundary` + 大段
 *     compact 前历史 + 上一轮 usage cache_read=169,472，即用户截图场景）。
 * 改坏必判红：把 boundary 处理去掉 ⇒ ①② 必红；把明细改回"恒取 usage 四类" ⇒ ③ 必红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'
import {
  accumulateEstimatedTokensAfterCompactBoundary,
  buildContextCategoryBreakdown,
  createCompactBoundaryAwareEstimator,
  getContextUsageTokens,
  isCompactBoundaryEntry,
  OUTPUT_TOKENS_NOTE,
} from '../services/transcriptContextEstimate.js'

/* ── 纯函数层 ───────────────────────────────────────────────────────────── */

type RoughEntry = { type?: unknown; subtype?: unknown; message?: { content?: unknown } }

const rough = (entry: RoughEntry): number => {
  const content = entry.message?.content
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    return content.reduce(
      (sum: number, block: { text?: string }) => sum + (block?.text?.length ?? 0),
      0,
    )
  }
  return 0
}

describe('① boundary-aware 累计（纯函数）', () => {
  test('只算最后一个 compact_boundary 之后的条目', () => {
    const entries = [
      { type: 'user', message: { content: 'A'.repeat(1000) } },
      { type: 'assistant', message: { content: 'B'.repeat(1000) } },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'user', message: { content: 'C'.repeat(10) } },
    ]
    expect(accumulateEstimatedTokensAfterCompactBoundary(entries, rough)).toBe(10)
  })

  test('多个边界 ⇒ 以**最后一个**为准', () => {
    const entries = [
      { type: 'user', message: { content: 'A'.repeat(500) } },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'user', message: { content: 'B'.repeat(700) } },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'user', message: { content: 'C'.repeat(3) } },
    ]
    expect(accumulateEstimatedTokensAfterCompactBoundary(entries, rough)).toBe(3)
  })

  test('边界判定只认 system+compact_boundary；流式累加器与数组封装同口径', () => {
    expect(isCompactBoundaryEntry({ type: 'system', subtype: 'compact_boundary' })).toBe(true)
    expect(isCompactBoundaryEntry({ type: 'user', subtype: 'compact_boundary' })).toBe(false)
    expect(isCompactBoundaryEntry({ type: 'system', subtype: 'microcompact_boundary' })).toBe(false)
    expect(isCompactBoundaryEntry(null)).toBe(false)

    const estimator = createCompactBoundaryAwareEstimator(rough)
    for (const e of [
    { type: 'user', message: { content: 'x'.repeat(9) } },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'attachment', message: { content: 'y'.repeat(4) } },
  ] as RoughEntry[]) {
    estimator.observe(e)
  }
    expect(estimator.value()).toBe(4)
  })
})

describe('③④ 明细组装（按 source）', () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 169_472,
    cache_creation_input_tokens: 3000,
  }

  test('provider_usage ⇒ 四类明细；Output 带标注且不计入上下文', () => {
    const totalTokens = getContextUsageTokens(usage) // 173,472（不含 output）
    const categories = buildContextCategoryBreakdown({
      source: 'provider_usage',
      totalTokens,
      rawMaxTokens: 200_000,
      usage,
    })
    expect(categories.map((c) => c.name)).toEqual([
      'Input tokens',
      'Cache read',
      'Cache write',
      'Output tokens',
      'Free space',
    ])
    const output = categories.find((c) => c.name === 'Output tokens')!
    expect(output.tokens).toBe(200)
    expect(output.note).toBe(OUTPUT_TOKENS_NOTE)
    expect(OUTPUT_TOKENS_NOTE).toBe('上一轮输出，不计入上下文')
  })

  test('④ 不变量：上下文类明细之和 == totalTokens（Output 不计入）', () => {
    const totalTokens = getContextUsageTokens(usage)
    const categories = buildContextCategoryBreakdown({
      source: 'provider_usage',
      totalTokens,
      rawMaxTokens: 200_000,
      usage,
    })
    const sum = categories
      .filter((c) => c.name !== 'Output tokens' && c.name !== 'Free space')
      .reduce((acc, c) => acc + c.tokens, 0)
    expect(sum).toBe(totalTokens)
  })

  test('④ 不变量在「主标被窗口 clamp」时也成立（按比例收口，不是放着不管）', () => {
    const huge = { ...usage, cache_read_input_tokens: 900_000 }
    const totalTokens = 200_000 // 已被窗口 clamp
    const categories = buildContextCategoryBreakdown({
      source: 'provider_usage',
      totalTokens,
      rawMaxTokens: 200_000,
      usage: huge,
    })
    const sum = categories
      .filter((c) => c.name !== 'Output tokens' && c.name !== 'Free space')
      .reduce((acc, c) => acc + c.tokens, 0)
    expect(sum).toBe(totalTokens)
    // clamp 顶格 ⇒ 无 Free space
    expect(categories.some((c) => c.name === 'Free space')).toBe(false)
  })

  test('③ estimate ⇒ 单条 Estimated context（不再拼 usage 四类）', () => {
    const categories = buildContextCategoryBreakdown({
      source: 'estimate',
      totalTokens: 1234,
      rawMaxTokens: 200_000,
      usage,
    })
    expect(categories.map((c) => c.name)).toEqual(['Estimated context', 'Free space'])
    expect(categories[0]!.tokens).toBe(1234)
  })
})

/* ── 集成层（真实 jsonl + SessionService）───────────────────────────────── */

let configDir: string
let workDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalNodeEnv = process.env.NODE_ENV

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-ctx-'))
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-ctx-work-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.NODE_ENV = 'development'
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  await fs.rm(configDir, { recursive: true, force: true })
  await fs.rm(workDir, { recursive: true, force: true })
})

type Session = { svc: SessionService; sessionId: string; filePath: string }

async function makeSession(): Promise<Session> {
  const svc = new SessionService()
  const { sessionId } = await svc.createSession(workDir)
  const found = await svc.findSessionFile(sessionId)
  expect(found).not.toBeNull()
  return { svc, sessionId, filePath: found!.filePath }
}

async function append(filePath: string, entries: unknown[]): Promise<void> {
  await fs.appendFile(
    filePath,
    entries.map((entry) => JSON.stringify(entry) + '\n').join(''),
  )
}

const sonnetAssistant = (usage: Record<string, number>, text = 'ok') => ({
  type: 'assistant',
  uuid: crypto.randomUUID(),
  timestamp: '2026-04-27T12:00:02.000Z',
  cwd: workDir,
  version: '999.0.0-test',
  message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text }], usage },
})

const userText = (text: string) => ({
  type: 'user',
  uuid: crypto.randomUUID(),
  timestamp: '2026-04-27T12:00:01.000Z',
  cwd: workDir,
  message: { role: 'user', content: [{ type: 'text', text }] },
})

const compactBoundary = () => ({
  type: 'system',
  subtype: 'compact_boundary',
  uuid: crypto.randomUUID(),
  timestamp: '2026-04-27T12:00:01.500Z',
  content: 'Conversation compacted',
})

describe('①② 截图场景：cache_read 169,472 + compact 前历史 ⇒ 主标≈17 万而非 100%', () => {
  test('compact 前的大段历史不计入 ⇒ totalTokens 由上一轮 usage 决定', async () => {
    const { svc, sessionId, filePath } = await makeSession()
    await append(filePath, [
      // compact 之前：约 1.2MB 文本（≈30 万 token，粗估足以把 20 万窗口顶满）
      userText('P'.repeat(1_200_000)),
      compactBoundary(),
      // compact 之后：很短（新增历史）
      userText('接着做'),
      sonnetAssistant({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 169_472, cache_creation_input_tokens: 3000 }),
    ])

    const estimate = await svc.getTranscriptContextEstimate(sessionId)
    expect(estimate).not.toBeNull()
    // 主标＝上一轮真实占用（≈173,472），**不是** 200,000
    expect(estimate!.source).toBe('provider_usage')
    expect(estimate!.totalTokens).toBe(173_472)
    expect(estimate!.totalTokens).toBeLessThan(estimate!.rawMaxTokens)
    // ⑤ 「≥ 窗口」只在真实 totalTokens ≥ window 时出现 ⇒ 这里必须 < 100%
    expect(estimate!.percentage).toBeLessThan(100)
  })

  test('边界前历史规模变化 ⇒ 结果不变（boundary 处理去掉则必红）', async () => {
    const small = await makeSession()
    await append(small.filePath, [
      userText('小小历史'),
      compactBoundary(),
      sonnetAssistant({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 169_472, cache_creation_input_tokens: 3000 }),
    ])
    const big = await makeSession()
    await append(big.filePath, [
      userText('P'.repeat(1_200_000)),
      compactBoundary(),
      sonnetAssistant({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 169_472, cache_creation_input_tokens: 3000 }),
    ])

    const a = await small.svc.getTranscriptContextEstimate(small.sessionId)
    const b = await big.svc.getTranscriptContextEstimate(big.sessionId)
    expect(a!.totalTokens).toBe(b!.totalTokens)
    expect(a!.percentage).toBe(b!.percentage)
  })

  test('⑤ 真实超窗时才是 100%（clamp 到窗口，且不变量仍成立）', async () => {
    const { svc, sessionId, filePath } = await makeSession()
    await append(filePath, [
      sonnetAssistant({ input_tokens: 250_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ])
    const estimate = await svc.getTranscriptContextEstimate(sessionId)
    expect(estimate!.rawMaxTokens).toBe(200_000)
    expect(estimate!.totalTokens).toBe(200_000) // 真实超窗 ⇒ clamp
    expect(estimate!.percentage).toBe(100)
    const sum = estimate!.categories
      .filter((c) => c.name !== 'Output tokens' && c.name !== 'Free space')
      .reduce((acc, c) => acc + c.tokens, 0)
    expect(sum).toBe(estimate!.totalTokens)
  })

  test('③ 集成：estimate 占优时主标与明细同基准（单条 Estimated context）', async () => {
    const { svc, sessionId, filePath } = await makeSession()
    await append(filePath, [
      // 无 usage 条目之前先放一大段文本，再放一条 usage 很小的 assistant ⇒ estimate 占优
      userText('Z'.repeat(300_000)),
      sonnetAssistant({ input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ])
    const estimate = await svc.getTranscriptContextEstimate(sessionId)
    expect(estimate!.source).toBe('estimate')
    expect(estimate!.categories[0]!.name).toBe('Estimated context')
    expect(estimate!.categories[0]!.tokens).toBe(estimate!.totalTokens)
    const sum = estimate!.categories
      .filter((c) => c.name !== 'Output tokens' && c.name !== 'Free space')
      .reduce((acc, c) => acc + c.tokens, 0)
    expect(sum).toBe(estimate!.totalTokens)
  })
})
