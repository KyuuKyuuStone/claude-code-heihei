/**
 * v1.5.0 UI 性能专项基准（不进常规套件：vitest 默认 include 只收 *.test.*，
 * 本文件用 bunx vitest bench --run 显式执行）。
 *
 * 样本：本机真实大会话 6e10688a（jsonl 37MB），由诊断脚本先 curl 到
 * <os.tmpdir()>/cc-heihei-perf/full.json（GET /api/sessions/:id/messages 全量）。
 * 样本不存在时整组跳过，保证 CI/他机不误跑。
 *
 * 量三件事：
 *  A. 首开链路渲染进程侧成本：JSON.parse(28.6MB) + mapHistoryMessagesToUiMessages 全量映射。
 *  B. 流式渲染的 O(n²)：assistant 文本每 50ms 合帧后全文重走 marked.parse +
 *     DOMPurify.sanitize + DOM 增强，成本随 streamingText 长度增长。
 *  C. 若首开只取最近 200 条（后端 ?limit=200），上述成本缩到多少。
 */
import { bench, describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { mapHistoryMessagesToUiMessages } from '@/stores/chatStore'
import { buildRenderModel, getCompletedTurnTargets } from '@/components/chat/MessageList'
import { findSafeStreamingCut } from '@/components/markdown/MarkdownRenderer'
import { Prism } from 'prism-react-renderer'
import { findSafeCodeCut } from '@/components/chat/CodeViewer'

const SAMPLE_PATH = join(tmpdir(), 'cc-heihei-perf', 'full.json')
const HAS_SAMPLE = existsSync(SAMPLE_PATH)

type RawMessage = {
  type: string
  content?: Array<{ type: string; text?: string }> | string
}

function loadSample(): { rawText: string; messages: RawMessage[] } {
  const rawText = readFileSync(SAMPLE_PATH, 'utf8')
  const parsed = JSON.parse(rawText) as { messages: RawMessage[] }
  return { rawText, messages: parsed.messages }
}

/** 从真实会话里抽出 assistant 文本，拼到目标长度，作为流式渲染样本。 */
function buildStreamingSamples(messages: RawMessage[], sizes: number[]): Map<number, string> {
  const texts: string[] = []
  for (const message of messages) {
    if (message.type !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'text' && block.text && block.text.length > 200) {
        texts.push(block.text)
      }
    }
  }
  const samples = new Map<number, string>()
  for (const size of sizes) {
    let acc = ''
    let i = 0
    while (acc.length < size && texts.length > 0) {
      acc += `${texts[i % texts.length]!}\n\n`
      i += 1
    }
    samples.set(size, acc.slice(0, size))
  }
  return samples
}

/** 与 MarkdownRenderer 流式路径同构的一次"合帧重算"：parse + sanitize + DOM 挂载。 */
function streamingReparseOnce(content: string): number {
  const html = marked.parse(content) as string
  const clean = DOMPurify.sanitize(html)
  const container = document.createElement('div')
  container.innerHTML = clean
  return container.querySelectorAll('*').length
}

describe.skipIf(!HAS_SAMPLE)('v1.5.0 load perf baseline（真实大会话样本）', () => {
  const { rawText, messages } = loadSample()
  const samples = buildStreamingSamples(messages, [5_000, 20_000, 50_000, 100_000])

  it('打印样本规模', () => {
    console.log(`[perf] 全量响应字节=${(rawText.length / 1024 / 1024).toFixed(1)}MB 消息数=${messages.length}`)
    for (const [size, text] of samples) {
      console.log(`[perf] 流式样本 目标=${size}B 实际=${text.length}B`)
    }
    expect(messages.length).toBeGreaterThan(0)
  })

  bench('A1 JSON.parse 全量 28.6MB（渲染进程主线程）', () => {
    JSON.parse(rawText)
  })

  bench('A2 mapHistoryMessagesToUiMessages 全量映射', () => {
    mapHistoryMessagesToUiMessages(messages as never)
  })

  bench('A3 mapHistoryMessagesToUiMessages 仅最近 200 条（?limit=200 首开）', () => {
    mapHistoryMessagesToUiMessages(messages.slice(-200) as never)
  })

  for (const [size, text] of samples) {
    bench(`B 流式合帧全文重算 marked+sanitize+DOM @${(size / 1000).toFixed(0)}KB`, () => {
      streamingReparseOnce(text)
    })
  }

  it('C 推算流式 O(n²) 总量：100KB 回复按 50ms 合帧、每帧 200B 增量的累计 parse 成本', () => {
    // 用 100KB 样本的单次成本近似线性外推：sum(len_i) ≈ n²/2 * 200B
    const text100 = samples.get(100_000)!
    const t0 = performance.now()
    streamingReparseOnce(text100)
    const per100kb = performance.now() - t0
    const totalBytes = 100_000
    const step = 200
    const frames = totalBytes / step
    const cumulativeKb = (frames * (frames + 1)) / 2 * step / 1000 // ≈ 25,000KB 累计
    const estimatedSeconds = (per100kb / 100) * cumulativeKb / 1000
    console.log(`[perf] 100KB 单次重算=${per100kb.toFixed(1)}ms；一条 100KB 回复全程累计重算≈${estimatedSeconds.toFixed(1)}s（${frames} 帧）`)
    expect(per100kb).toBeGreaterThan(0)
  })

  // ── D：工具输入流（Write/Edit 大文件）期间，每 50ms 合帧 upsertToolUseMessage
  // 产生新 messages 数组 → MessageList 的 buildRenderModel 等 O(N) 派生链全部
  // 失效重算。会话越大 N 越大，即"越用越卡"；新开会话 N≈0 即"重新开就好"。──
  const uiMessages = mapHistoryMessagesToUiMessages(messages as never)

  it('D0 打印映射后 UI 消息规模', () => {
    console.log(`[perf] UIMessages=${uiMessages.length}（原始 ${messages.length}）`)
    expect(uiMessages.length).toBeGreaterThan(0)
  })

  bench('D1 buildRenderModel O(N)（每 50ms 合帧一次）', () => {
    buildRenderModel(uiMessages as never)
  })

  bench('D2 getCompletedTurnTargets O(N)', () => {
    getCompletedTurnTargets(uiMessages as never)
  })

  // ── E：v1.5.0 流式分段修复后的每帧成本对照。
  // 修复前（B 组）：每 50ms 合帧对全文 marked+sanitize+DOM，O(n)每帧、O(n²)累计。
  // 修复后：每帧 = findSafeStreamingCut 全量扫描（纯文本扫描，无 parse）
  //         + 仅尾部当前段落重 parse（段落级，亚毫秒）；封顶段全程只 parse 一次。──
  for (const [size, text] of samples) {
    bench(`E 修复后每帧：cut 扫描 + 尾部段落重算 @${(size / 1000).toFixed(0)}KB`, () => {
      const cut = findSafeStreamingCut(text)
      const tail = text.slice(cut)
      if (tail.trim()) streamingReparseOnce(tail)
    })
  }

  it('E2 推算修复后 100KB 回复全程累计成本', () => {
    const text100 = samples.get(100_000)!
    // 每帧：cut 扫描 + 尾部 parse
    const t0 = performance.now()
    const cut = findSafeStreamingCut(text100)
    streamingReparseOnce(text100.slice(cut))
    const perFrame = performance.now() - t0
    // 封顶段总成本 ≈ 一次全量 parse 的量级（各段之和），用 B 组 100KB 单次近似
    const t1 = performance.now()
    streamingReparseOnce(text100)
    const segmentsOnce = performance.now() - t1
    const frames = 500
    const total = segmentsOnce + perFrame * frames
    console.log(`[perf] 修复后：封顶段一次性≈${segmentsOnce.toFixed(1)}ms + 每帧 ${perFrame.toFixed(2)}ms × ${frames} 帧 ≈ 全程 ${(total / 1000).toFixed(2)}s`)
    expect(perFrame).toBeLessThan(50)
  })

  it('D3 推算工具输入流期间主线程占用', () => {
    const t0 = performance.now()
    buildRenderModel(uiMessages as never)
    const perFlush = performance.now() - t0
    // 一次大 Write（50KB 输入，每帧 200B）≈250 帧；每帧重建渲染模型
    const frames = 250
    console.log(`[perf] N=${uiMessages.length} 时单次 buildRenderModel=${perFlush.toFixed(1)}ms；` +
      `50ms 合帧下占主线程 ${(perFlush / 50 * 100).toFixed(0)}%；` +
      `一次 50KB Write 累计 ${(perFlush * frames / 1000).toFixed(1)}s`)
    expect(perFlush).toBeGreaterThan(0)
  })
})

// ── F：CodeViewer Prism 流式分段前后对照（合成 TS 样本，无需真实会话）。
// 修复前：流式代码每 50ms 合帧全文 Prism.tokenize（+React 侧 normalizeTokens 同样全量）。
// 修复后：每帧 = findSafeCodeCut 纯文本扫描 + 仅尾部 tokenize；封顶段走 memo 零重算。──
function buildCodeSample(size: number): string {
  let acc = ''
  let i = 0
  while (acc.length < size) {
    acc += `export function handler${i}(input: string): number {\n  const value = input.length * ${i};\n  return value + ${i};\n}\n\n`
    i += 1
  }
  // 模拟流式进行中的尾部：仍在增长、尚无空行的未闭合函数体（≥ MIN_TAIL 200B）
  acc += 'export function streamingTail(input: string): number {\n'
    + '  const alpha = input.length;\n'
    + '  const beta = alpha * 2 + 1;\n'
    + '  const gamma = beta * 3 + 2;\n'
    + '  const delta = gamma * 4 + 3;\n'
    + '  const epsilon = delta * 5 + 4;\n'
    + '  return alpha + beta + gamma + delta + epsilon + input.length;\n'
  return acc
}

describe('F CodeViewer Prism 流式分段（合成样本）', () => {
  const grammar = Prism.languages.typescript!
  for (const size of [5_000, 20_000, 50_000]) {
    const code = buildCodeSample(size)
    bench(`F1 修复前：每帧全文 tokenize @${(size / 1000).toFixed(0)}KB`, () => {
      Prism.tokenize(code, grammar)
    })
    bench(`F2 修复后：cut 扫描 + 尾部 tokenize @${(size / 1000).toFixed(0)}KB`, () => {
      const cut = findSafeCodeCut(code)
      Prism.tokenize(code.slice(cut), grammar)
    })
  }
})
