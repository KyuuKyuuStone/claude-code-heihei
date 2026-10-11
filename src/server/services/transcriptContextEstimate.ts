/**
 * transcriptContextEstimate —— 会话「上下文占用」面板的口径收口（v1.7.5）
 *
 * 背景（用户实测缺陷「主标虚高」）：面板主标出现 `≥1,000,000 / 100%`，但明细
 * 只有十几万 tokens。成因两条：
 *   ① `buildTranscriptContextEstimate` 的**粗估把 compact 之前的历史全部计入**
 *      ——compact 过的会话据此虚高，再经 `max(estimate, usage)` 选中并 clamp 顶格；
 *   ② 主标走 `max(estimate, usage)` 而明细恒取上一轮 usage ⇒ **双基准拼接**，
 *      两个数字本就不是一回事，还触发误报「建议压缩」。
 *
 * 本模块把两件事收在一处（`transcriptDerivation.ts` 只负责调用，不再散落口径）：
 *   1. **boundary-aware 粗估**：只累计**最后一个 `compact_boundary` 之后**的
 *      user / assistant / attachment 条目。实现用「流式累加器」形态（见到边界即清零），
 *      因此**流式读文件**（`streamJsonlFile`，无下标）与整读数组两条路径共用同一口径。
 *      ⚠ 一期只做 `compact_boundary` 这一档；`microcompact_boundary` 等留二期
 *      （扩档只需往 `COMPACT_BOUNDARY_SUBTYPES` 里加一个值）。
 *   2. **明细按 source 组装**（冻结契约，前端 taskId 772a06ba 只认这个形状）：
 *      · `provider_usage` ⇒ 四类：Input tokens / Cache read / Cache write / Output tokens，
 *        其中 Output tokens **不参与同基准不变量**（它只是"上一轮输出"的回显）；
 *      · `estimate` ⇒ **单条** `Estimated context`（= totalTokens）。
 *   3. **同基准不变量**：上下文类明细之和 —— **未 clamp 时 == `totalTokens`**
 *      （天然成立：`totalTokens` 就是 input + cache_read + cache_creation）；
 *      **被上下文窗口 clamp 时 >= `totalTokens`**（明细**保留原始值**）。
 *      ⚠ 返工（R1）：**绝不按比例缩放明细** —— 会话饱和时主标被 clamp 到窗口，
 *      若把四类等比缩进窗口，用户读到的就是**编造的数**（显示 Input 500k、真实 700k），
 *      与本次要修的"数字不反映现实"是同类病。主标顶格 + 明细原始值，"≥"语义自洽。
 */

import type { ContextBudgetSource } from '../../utils/contextBudget.js'

export type ContextEstimateCategory = {
  name: string
  tokens: number
  color: string
  isDeferred?: boolean
}

/** 触发「先前历史不计入」的边界 subtype（一期只有 compact；microcompact 留二期） */
export const COMPACT_BOUNDARY_SUBTYPES: ReadonlySet<string> = new Set(['compact_boundary'])

/** 上下文明细的固定配色（沿用历史值，避免前端换色） */
export const CONTEXT_CATEGORY_COLORS = {
  input: '#8f3217',
  cacheRead: '#0f5c8f',
  cacheWrite: '#7c3aed',
  output: '#2f7d32',
  free: '#a1a1aa',
} as const

type BoundaryCandidate = { type?: unknown; subtype?: unknown }

/** 该条目是不是「压缩边界」（transcript 里是 system + subtype=compact_boundary） */
export function isCompactBoundaryEntry(entry: BoundaryCandidate | null | undefined): boolean {
  if (!entry) return false
  if (entry.type !== 'system') return false
  return typeof entry.subtype === 'string' && COMPACT_BOUNDARY_SUBTYPES.has(entry.subtype)
}

/**
 * 流式安全的 boundary-aware 累加器：**见到边界即把累计清零**——
 * 等价于「只累计最后一个边界之后的条目」，但不需要下标、不需要先把文件读完。
 */
export function createCompactBoundaryAwareEstimator<T extends BoundaryCandidate>(
  rough: (entry: T) => number,
): { observe: (entry: T) => void; value: () => number } {
  let total = 0
  return {
    observe(entry: T): void {
      if (isCompactBoundaryEntry(entry)) {
        total = 0
        return
      }
      if (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'attachment') {
        total += rough(entry)
      }
    },
    value: () => total,
  }
}

/** 数组形态的便捷封装（测试与整读路径用；与累加器同口径） */
export function accumulateEstimatedTokensAfterCompactBoundary<T extends BoundaryCandidate>(
  entries: readonly T[],
  rough: (entry: T) => number,
): number {
  const estimator = createCompactBoundaryAwareEstimator(rough)
  for (const entry of entries) estimator.observe(entry)
  return estimator.value()
}

export type ContextUsageNumbers = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

/**
 * provider_usage 的三类上下文 token（**不含 output**）。
 * 这就是 `totalTokens` 的语义口径（契约：当前上下文占用 = input + cache_read + cache_creation）。
 */
export function getContextUsageTokens(usage: ContextUsageNumbers): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

/**
 * 组装面板明细（含 Free space）。
 *
 * **不变量**：过滤掉 0 值后，`name !== 'Output tokens'` 的那些**上下文类**明细之和：
 *   · 未 clamp（`totalTokens < rawMaxTokens`）⇒ **== totalTokens**；
 *   · 被窗口 clamp（`totalTokens == rawMaxTokens`）⇒ **>= totalTokens**（明细保留原始值，不缩放）。
 * `Output tokens` 只是"上一轮输出"的回显，不在上下文里，故不参与该不变量。
 */
export function buildContextCategoryBreakdown(args: {
  source: ContextBudgetSource
  totalTokens: number
  rawMaxTokens: number
  usage: ContextUsageNumbers
}): ContextEstimateCategory[] {
  const { source, totalTokens, rawMaxTokens, usage } = args

  // 明细一律**原始值**：clamp 只作用于主标（前端渲染 `≥ 窗口`），
  // 分类数字不缩放、不编造（R1）。
  const contextCategories: ContextEstimateCategory[] =
    source === 'estimate'
      ? [{ name: 'Estimated context', tokens: totalTokens, color: CONTEXT_CATEGORY_COLORS.input }]
      : [
          { name: 'Input tokens', tokens: usage.input_tokens, color: CONTEXT_CATEGORY_COLORS.input },
          { name: 'Cache read', tokens: usage.cache_read_input_tokens, color: CONTEXT_CATEGORY_COLORS.cacheRead },
          { name: 'Cache write', tokens: usage.cache_creation_input_tokens, color: CONTEXT_CATEGORY_COLORS.cacheWrite },
        ]

  const outputCategory: ContextEstimateCategory[] =
    source === 'provider_usage'
      ? [{ name: 'Output tokens', tokens: usage.output_tokens, color: CONTEXT_CATEGORY_COLORS.output }]
      : []

  return [
    ...contextCategories,
    ...outputCategory,
    {
      name: 'Free space',
      tokens: Math.max(0, rawMaxTokens - totalTokens),
      color: CONTEXT_CATEGORY_COLORS.free,
      isDeferred: true,
    },
  ].filter((category) => category.tokens > 0)
}
