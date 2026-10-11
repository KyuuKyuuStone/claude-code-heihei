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
 *        其中 **Output tokens 标注「上一轮输出，不计入上下文」**（`note` 字段）且
 *        **不参与同基准不变量**；
 *      · `estimate` ⇒ **单条** `Estimated context`（= totalTokens）。
 *   3. **同基准不变量**：上下文类明细之和 **== main `totalTokens`**（± Free space）。
 *      正常路径天然成立（`totalTokens` 就是 input + cache_read + cache_creation）；
 *      唯一会破的是「主标被上下文窗口 clamp」那种（usage 超窗）：此时按比例缩到
 *      `totalTokens`——数字在 100% 顶格状态下本来就是"超窗"的近似表达，
 *      原始值仍在 `apiUsage` 里逐字给出，不丢信息。
 */

import type { ContextBudgetSource } from '../../utils/contextBudget.js'

export type ContextEstimateCategory = {
  name: string
  tokens: number
  color: string
  isDeferred?: boolean
  /** 人类可读补充说明（当前只有 Output tokens 用：它不计入上下文占用） */
  note?: string
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

/** Output tokens 的固定说明文案（冻结契约的一部分，勿改字面） */
export const OUTPUT_TOKENS_NOTE = '上一轮输出，不计入上下文'

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
 * 按比例把明细收到 `totalTokens`（只在「主标被窗口 clamp」时才会用到）。
 * 整数拆分，最后一项吸收舍入余量，保证**和恰好等于** totalTokens。
 */
function reconcileCategories(
  categories: ContextEstimateCategory[],
  totalTokens: number,
): ContextEstimateCategory[] {
  const sum = categories.reduce((acc, category) => acc + category.tokens, 0)
  if (sum <= totalTokens || sum <= 0) return categories

  let remaining = totalTokens
  return categories.map((category, index) => {
    if (index === categories.length - 1) {
      const tokens = Math.max(0, remaining)
      remaining -= tokens
      return { ...category, tokens }
    }
    const tokens = Math.max(0, Math.floor((category.tokens / sum) * totalTokens))
    remaining -= tokens
    return { ...category, tokens }
  })
}

/**
 * 组装面板明细（含 Free space）。
 *
 * **不变量**：过滤掉 0 值后，`name !== 'Output tokens'` 的那些**上下文类**明细之和
 * == `totalTokens`（± Free space 不计）。`Output tokens` 只是"上一轮输出"的回显，
 * 不在上下文里，故不参与该不变量。
 */
export function buildContextCategoryBreakdown(args: {
  source: ContextBudgetSource
  totalTokens: number
  rawMaxTokens: number
  usage: ContextUsageNumbers
}): ContextEstimateCategory[] {
  const { source, totalTokens, rawMaxTokens, usage } = args

  const contextCategories: ContextEstimateCategory[] =
    source === 'estimate'
      ? [{ name: 'Estimated context', tokens: totalTokens, color: CONTEXT_CATEGORY_COLORS.input }]
      : reconcileCategories(
          [
            { name: 'Input tokens', tokens: usage.input_tokens, color: CONTEXT_CATEGORY_COLORS.input },
            { name: 'Cache read', tokens: usage.cache_read_input_tokens, color: CONTEXT_CATEGORY_COLORS.cacheRead },
            { name: 'Cache write', tokens: usage.cache_creation_input_tokens, color: CONTEXT_CATEGORY_COLORS.cacheWrite },
          ],
          totalTokens,
        )

  const outputCategory: ContextEstimateCategory[] =
    source === 'provider_usage'
      ? [
          {
            name: 'Output tokens',
            tokens: usage.output_tokens,
            color: CONTEXT_CATEGORY_COLORS.output,
            isDeferred: true,
            note: OUTPUT_TOKENS_NOTE,
          },
        ]
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
