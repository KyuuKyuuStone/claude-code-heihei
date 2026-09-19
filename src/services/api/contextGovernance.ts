/**
 * ContextGovernance — 上下文体积治理（v1.2.6 扩批主件）
 *
 * 依据《上下文体积抑制_设计方案_20260917》：messages 是长会话请求体里唯一的
 * 无界增长项（实测占比 ≈95%，固定开销 system+tools ≈67KB 恒定）。本模块在
 * 消息组装链末端提供三道机制，全部「正常会话零行为变化、只在异常时介入、
 * 介入必可观测、截断必可回查」：
 *
 * - M1 truncateOversizedMessages：单条 user 消息（含 tool_result）超阈值时
 *   截断并原文落盘，截断处留可回查标记——tool_result 主线由 toolResultStorage
 *   （50KB persistence）在工具侧处理，这里兜「非 tool_result 消息 + 漏网」。
 * - M2 recordRequestBodySize：每次请求的 body 体积入滚动样本，周期性输出
 *   p50/p90/p90 分位诊断，超「窗口×告警份额」时发可行动告警（接近上下文窗口）。
 * - L1+L2 pruneMessagesForContextBudget：估算消息总 bytes 超过「provider 窗口
 *   ×预算份额」（L2：窗口按 model 动态解析）时，按「原子轮次组」从最老裁起，
 *   恒保留首轮（任务目标）与末 N 轮；compaction 的请求前最后保险丝，不替代
 *   compaction（A5a：本地模型 compaction 成功率仅 9%，此保险丝就是为它兜底）。
 *
 * 红线（设计方案 §4）：不削工具描述语义（ToolSearch 教训）；裁剪/截断必可回查；
 * 不宣称「抑制体积可消除悬挂」（体积与配额耗尽间接相关，与回传链路悬挂无关）。
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Message } from '../../types/message.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { jsonStringify } from '../../utils/slowOperations.js'

/** M1：单条消息截断阈值（bytes）。48KB 低于 tool_result 主线的 50KB persistence，不与主线冲突 */
export const MAX_SINGLE_MESSAGE_BYTES = 48_000

/** L1：messages 可占 provider 上下文窗口的份额（其余留给 system+tools+输出余量） */
export const CONTEXT_MESSAGES_BUDGET_SHARE = 0.6

/** bytes/token 粗估（JSON 中文英文混合保守值；只用于触发判断，不追求精确） */
export const BYTES_PER_TOKEN_ESTIMATE = 3.5

/** M2：滚动样本窗口与分位汇总周期 */
export const BODY_SIZE_SAMPLE_WINDOW = 200
export const BODY_SIZE_SUMMARY_EVERY = 50

/** M2：告警份额——估算 body 超过窗口×0.8 即告警（可行动：接近上下文窗口） */
export const BODY_SIZE_ALERT_SHARE = 0.8

/** L1：无论如何至少保留最近 N 个轮次组 */
export const MIN_TURNS_TO_KEEP = 2

// ── 诊断写入走 logForDiagnosticsNoPII（DI 缝：setDiagnosticsLogWriterForTests）──

function logGovernanceEvent(
  level: 'info' | 'warn',
  event: string,
  data: Record<string, unknown>,
): void {
  logForDiagnosticsNoPII(level, event, data)
}

// ── M1：超长单条消息截断 + 原文落盘 ──────────────────────────────────────────

/**
 * 原文落盘依赖。路径必须**同步可得**（截断标记在组装链同步生成，需当场引用），
 * 写盘异步执行；写盘结果经 message_truncated 诊断可观测。
 */
type MessagePersister = (
  content: unknown,
  id: string,
) => { path: string | null; write: Promise<boolean> }

let messagePersisterOverride: MessagePersister | null = null

/** 测试注入落盘实现；传 null 恢复默认 */
export function setMessagePersisterForTests(
  persister: MessagePersister | null,
): void {
  messagePersisterOverride = persister
}

function persistOriginalContent(
  content: unknown,
  id: string,
): { path: string | null; write: Promise<boolean> } {
  if (messagePersisterOverride) return messagePersisterOverride(content, id)
  // 延迟 require：避免本模块被轻量场景引用时拖入 bootstrap/sessionStorage 依赖链。
  // getToolResultPath 是确定性路径（persistToolResult 就写到那里），可同步引用。
  try {
    const storage = require('../../utils/toolResultStorage.js') as typeof import('../../utils/toolResultStorage.js')
    const path = storage.getToolResultPath(id, Array.isArray(content))
    const write = storage
      .persistToolResult(content as NonNullable<ToolResultBlockParam['content']>, id)
      .then((result) => 'filepath' in result)
      .catch(() => false)
    return { path, write }
  } catch {
    return { path: null, write: Promise.resolve(false) }
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf-8')
}

/** 单条消息的序列化体积（bytes） */
export function messageByteSize(message: Message): number {
  return byteLength(jsonStringify(message))
}

/** 截断后的文本：保留头部 + 可回查标记 */
function buildTruncatedText(original: string, thresholdBytes: number, refNote: string): string {
  // 按字符截到约等于阈值（UTF-8 下字符数 ≤ bytes，取保守截点）
  let keep = thresholdBytes
  let text = original.slice(0, keep)
  while (byteLength(text) > thresholdBytes && keep > 0) {
    keep = Math.floor(keep * 0.9)
    text = original.slice(0, keep)
  }
  return `${text}\n[message truncated at ${thresholdBytes} bytes — ${refNote}]`
}

/** 单个可截断文本单元的读写句柄 */
type TextTarget = { read: () => string; write: (text: string) => void }

/** 枚举一个 block 内所有可截断的文本单元（tool_result string / 其内 text 块 / text 块） */
function collectTextTargets(block: Record<string, unknown>): TextTarget[] {
  const targets: TextTarget[] = []
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') {
      targets.push({
        read: () => block.content as string,
        write: (t) => {
          block.content = t
        },
      })
    } else if (Array.isArray(block.content)) {
      for (const inner of block.content as Array<Record<string, unknown>>) {
        if (inner.type === 'text' && typeof inner.text === 'string') {
          targets.push({
            read: () => inner.text as string,
            write: (t) => {
              inner.text = t
            },
          })
        }
      }
    }
  } else if (block.type === 'text' && typeof block.text === 'string') {
    targets.push({
      read: () => block.text as string,
      write: (t) => {
        block.text = t
      },
    })
  }
  return targets
}

/**
 * M1：截断超长的单条 user 消息（含其中的 tool_result），原文落盘可回查。
 * 只处理 user 消息（assistant 输出受 max_tokens 天然有界；tool_result 主线
 * 已由 toolResultStorage 在工具侧处理，这里兜漏网）。返回替换后的数组与统计。
 *
 * 落盘按「超长文本单元」逐条进行（审查 P2①：单条消息可含多个超长
 * tool_result——并行多工具调用——每个被截断单元的原文分别落盘并各自引用；
 * 某单元落盘失败仅该单元标记如实改口，不牵连其他块）。
 */
export function truncateOversizedMessages(
  messages: Message[],
  options: { thresholdBytes?: number } = {},
): { messages: Message[]; truncatedCount: number } {
  const thresholdBytes = options.thresholdBytes ?? MAX_SINGLE_MESSAGE_BYTES
  let truncatedCount = 0

  const out = messages.map((message) => {
    if (message.type !== 'user') return message
    const content = message.message?.content
    if (!Array.isArray(content)) return message

    // 先判整条是否超阈（小消息零成本跳过）
    if (messageByteSize(message) <= thresholdBytes) return message

    const blocks = JSON.parse(jsonStringify(content)) as Array<Record<string, unknown>>
    const baseId =
      typeof message.uuid === 'string' && message.uuid
        ? message.uuid
        : `oversized-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    let truncatedBlocks = 0
    const persistedBlocks: Array<{ id: string; path: string | null }> = []

    blocks.forEach((block, blockIndex) => {
      collectTextTargets(block).forEach((target, textIndex) => {
        const original = target.read()
        if (byteLength(original) <= thresholdBytes) return
        const unitId = `${baseId}-b${blockIndex}t${textIndex}`
        // 同步拿确定性路径 → 截断标记当场引用；写盘异步补
        const persist = persistOriginalContent(original, unitId)
        const refNote = persist.path
          ? `full content saved to ${persist.path}`
          : 'full content NOT persisted (persist failed) — data loss possible'
        target.write(buildTruncatedText(original, thresholdBytes, refNote))
        truncatedBlocks++
        persistedBlocks.push({ id: unitId, path: persist.path })
        void persist.write
          .then((ok) => {
            if (!ok) {
              logGovernanceEvent('warn', 'message_truncated_persist_failed', {
                messageId: unitId,
                persistedPath: persist.path,
              })
            }
          })
          .catch(() => {})
      })
    })

    if (truncatedBlocks > 0) {
      truncatedCount++
      // 截断是同步事实：立即记录（每单元各自路径，标记与事实一致）
      logGovernanceEvent('warn', 'message_truncated', {
        messageId: baseId,
        thresholdBytes,
        truncated_blocks: truncatedBlocks,
        persisted: persistedBlocks,
      })
      const next: Message = {
        ...message,
        message: {
          ...message.message,
          content: blocks as typeof content,
        },
      }
      return next
    }
    return message
  })

  return { messages: out, truncatedCount }
}

// ── M2：请求体体积分位统计与告警 ─────────────────────────────────────────────

const bodySizeSamples: number[] = []
let bodySizeRequestCount = 0
/** 告警 episode 状态：true = 当前超阈段已告警过，回落前静默 */
let bodySizeAlertActive = false

/** 分位数（线性插值简化版：取排序后最近位次） */
export function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]!
}

/**
 * M2：记录一次请求的 messages 体积。每请求写一条 debug 诊断（数据全量落
 * jsonl 可重建曲线；debug 级不进 runtime-errors.log、不淹没 warn/error 浏览），
 * 每 BODY_SIZE_SUMMARY_EVERY 次输出 p50/p90/p99 汇总；估算体积超
 * 「窗口×告警份额」时发可行动告警（接近上下文窗口 → 建议压缩或开新会话）。
 * 告警按 episode 去重：超阈只告一次，体积回落到阈值以下后才允许再次告警
 * （与其他告警模式一致：一 episode 一次）。
 */
export function recordRequestBodySize(
  bytes: number,
  contextWindowTokens: number,
): { alerted: boolean } {
  bodySizeRequestCount++
  bodySizeSamples.push(bytes)
  if (bodySizeSamples.length > BODY_SIZE_SAMPLE_WINDOW) {
    bodySizeSamples.shift()
  }

  logGovernanceEvent('debug', 'request_body_bytes', {
    bytes,
    sample_count: bodySizeSamples.length,
  })

  if (bodySizeRequestCount % BODY_SIZE_SUMMARY_EVERY === 0 && bodySizeSamples.length > 0) {
    logGovernanceEvent('info', 'request_body_size_summary', {
      count: bodySizeSamples.length,
      p50: percentile(bodySizeSamples, 50),
      p90: percentile(bodySizeSamples, 90),
      p99: percentile(bodySizeSamples, 99),
    })
  }

  const alertThresholdBytes = Math.floor(
    contextWindowTokens * CONTEXT_MESSAGES_BUDGET_SHARE * BYTES_PER_TOKEN_ESTIMATE * BODY_SIZE_ALERT_SHARE,
  )
  if (bytes > alertThresholdBytes) {
    if (!bodySizeAlertActive) {
      bodySizeAlertActive = true
      logGovernanceEvent('warn', 'request_body_size_alert', {
        bytes,
        alert_threshold_bytes: alertThresholdBytes,
        context_window_tokens: contextWindowTokens,
        hint: 'Approaching the context window: run /compact or start a new session; large single messages are truncated and persisted (see message_truncated).',
      })
      return { alerted: true }
    }
    // episode 已告警过：静默直至回落
    return { alerted: false }
  }
  // 回落到阈值以下：本 episode 结束，允许下次超阈再次告警
  bodySizeAlertActive = false
  return { alerted: false }
}

/** 测试重置滚动样本（模块级状态） */
export function resetBodySizeSamplesForTests(): void {
  bodySizeSamples.length = 0
  bodySizeRequestCount = 0
  bodySizeAlertActive = false
}

// ── L1+L2：历史消息裁剪（provider 窗口自适应硬封顶）────────────────────────

/** user 消息是否承载 tool_result（这类消息属于当前轮次的收尾，不开新组） */
function isToolResultMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const content = message.message?.content
  if (!Array.isArray(content)) return false
  return content.some(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'tool_result',
  )
}

/**
 * 把消息切成「原子轮次组」：每组从一条真正的用户输入（非 tool_result 载体）
 * 开始，到下一条用户输入前结束。组内 assistant/tool_use/tool_result 成对共存，
 * 整组删除不破坏配对（组装链中 ensureToolResultPairing 已在本函数之前运行）。
 */
function splitIntoTurnGroups(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  for (const message of messages) {
    const startsNewTurn =
      message.type === 'user' && !isToolResultMessage(message)
    if (startsNewTurn || groups.length === 0) {
      groups.push([message])
    } else {
      groups[groups.length - 1]!.push(message)
    }
  }
  return groups
}

function totalBytesOf(groups: Message[][]): number {
  return byteLength(jsonStringify(groups.flat()))
}

/**
 * L1+L2：按「provider 窗口 × 预算份额 × bytes/token」硬封顶 messages。
 * 超预算时从最老的中间轮次组开始裁（恒保留首轮=任务目标，与末
 * MIN_TURNS_TO_KEEP 组=当前工作现场），直到达标或只剩保留组。
 * 正常会话不触发（零行为变化）；触发必写 context_pruned 诊断。
 */
export function pruneMessagesForContextBudget(
  messages: Message[],
  options: {
    contextWindowTokens: number
    budgetShare?: number
    bytesPerToken?: number
    minTurnsToKeep?: number
  },
): {
  messages: Message[]
  pruned: boolean
  prunedTurns: number
  bytesBefore: number
  bytesAfter: number
} {
  const budgetShare = options.budgetShare ?? CONTEXT_MESSAGES_BUDGET_SHARE
  const bytesPerToken = options.bytesPerToken ?? BYTES_PER_TOKEN_ESTIMATE
  const minTurnsToKeep = options.minTurnsToKeep ?? MIN_TURNS_TO_KEEP
  const budgetBytes = Math.floor(options.contextWindowTokens * budgetShare * bytesPerToken)

  if (messages.length === 0) {
    return { messages, pruned: false, prunedTurns: 0, bytesBefore: 0, bytesAfter: 0 }
  }

  const groups = splitIntoTurnGroups(messages)
  const before = byteLength(jsonStringify(messages))
  if (before <= budgetBytes) {
    return { messages, pruned: false, prunedTurns: 0, bytesBefore: before, bytesAfter: before }
  }

  // 保留：首轮（任务目标）+ 末 minTurnsToKeep 组（当前现场）
  const keepFirst = groups.length > minTurnsToKeep + 1 ? 1 : 0
  const keepTailFrom = Math.max(keepFirst, groups.length - minTurnsToKeep)
  const droppable = []
  for (let i = keepFirst; i < keepTailFrom; i++) droppable.push(i)

  const dropped = new Set<number>()
  let currentBytes = before
  for (const index of droppable) {
    if (currentBytes <= budgetBytes) break
    currentBytes -= byteLength(jsonStringify(groups[index]))
    dropped.add(index)
  }

  if (dropped.size === 0) {
    return { messages, pruned: false, prunedTurns: 0, bytesBefore: before, bytesAfter: before }
  }

  const kept: Message[] = []
  for (let i = 0; i < groups.length; i++) {
    if (!dropped.has(i)) kept.push(...groups[i])
  }
  const after = byteLength(jsonStringify(kept))
  logGovernanceEvent('warn', 'context_pruned', {
    context_window_tokens: options.contextWindowTokens,
    budget_bytes: budgetBytes,
    bytes_before: before,
    bytes_after: after,
    pruned_turns: dropped.size,
    kept_turns: groups.length - dropped.size,
  })
  return { messages: kept, pruned: true, prunedTurns: dropped.size, bytesBefore: before, bytesAfter: after }
}
