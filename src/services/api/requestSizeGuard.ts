/**
 * requestSizeGuard —— 发送前**字节级预检**（v1.7.5 P-A）
 *
 * 背景：客户机反复出现 HTTP 413「Request too large」。此前只有**事后**补救
 * （收到 413 再剥离媒体，见 `utils/mediaStripRecovery.ts`），且纯文本超限时
 * 无可补救 ⇒ 会话卡死。本模块把防线**前移到发送之前**：
 *
 *   1. 在请求定形后（`addCacheBreakpoints` 之后）、`create()` 之前**实测**
 *      整个请求体的 JSON 字节数；
 *   2. 未达触发阈值 ⇒ **原样返回**（正常会话行为与不做预检逐字节一致）；
 *   3. 超阈值 ⇒ 先做**降体积 pass**（媒体块由大到小剥离，复用批次 1 的
 *      `applyMediaStripToUserMessage`），再重算，迭代到限内；
 *   4. 仍超（通常是无媒体可剥的纯文本大请求）⇒ **不发网络请求**，抛
 *      `RequestTooLargePreflightError`（由 `errors.ts` 转成**可执行**的错误消息）。
 *
 * 为什么放在这里：`messagesForAPI` 级的手段（M1 截断 / L1+L2 裁剪 / 媒体条数上限）
 * 都只作用于**消息**，看不到 system/tools/betas 等其余请求体开销；只有在此处
 * 序列化才是「**整个请求**的实测字节」——也才是链路上限真正卡的东西。
 *
 * 成本：每次尝试序列化一次请求体（与大请求的实际发送开销同阶）。仅在
 * ≥ 触发阈值时才可能改动消息；低于阈值时**只测量、不改动**。
 */

import {
  getApiRequestMaxBytes,
  getApiRequestTriggerBytes,
} from '../../constants/apiLimits.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { applyMediaStripToUserMessage } from '../../utils/mediaStripRecovery.js'

/** 请求体超限且无可降体积时抛出的错误（`errors.ts` 负责转成可执行文案） */
export class RequestTooLargePreflightError extends Error {
  constructor(
    readonly measuredBytes: number,
    readonly limitBytes: number,
    readonly actions: readonly string[],
  ) {
    super(
      `request body ${measuredBytes} bytes exceeds limit ${limitBytes} bytes ` +
        `(preflight, request not sent; actions: ${actions.join(', ') || 'none'})`,
    )
    this.name = 'RequestTooLargePreflightError'
  }
}

/** 结构视图：只依赖 `message.content`（见 mediaStripRecovery 的同款说明） */
type BlockLike = { type?: string; content?: unknown }
type MessageLike = {
  type?: string
  uuid?: string
  message?: { content?: unknown }
}
/** 请求参数里本模块唯一关心/会改写的字段 */
export type SizeGuardedParams = { messages?: unknown } & Record<string, unknown>

/** 迭代上限：防「剥了又剥仍不达标」时的病态长循环 */
const MAX_REDUCTION_ROUNDS = 20

/** 单条消息的实测字节（用于按「由大到小」排序剥离候选） */
function messageBytes(message: MessageLike): number {
  try {
    return Buffer.byteLength(jsonStringify(message), 'utf-8')
  } catch {
    return 0
  }
}

/** 该消息里是否有可剥离的媒体（顶层或 tool_result 内嵌） */
function hasMedia(message: MessageLike): boolean {
  const content = message.message?.content
  if (!Array.isArray(content)) return false
  for (const block of content as BlockLike[]) {
    const t = block?.type
    if (t === 'image' || t === 'document') return true
    if (t === 'tool_result' && Array.isArray(block.content)) {
      for (const nested of block.content as BlockLike[]) {
        const nt = nested?.type
        if (nt === 'image' || nt === 'document') return true
      }
    }
  }
  return false
}

/** 请求体实测字节（与 SDK 序列化同口径：JSON，UTF-8） */
export function measureRequestBytes(params: unknown): number {
  try {
    return Buffer.byteLength(jsonStringify(params), 'utf-8')
  } catch {
    // 序列化失败（理论上是循环引用）⇒ 保守返回 0（不触发预检），由 API 侧兜底
    return 0
  }
}

/**
 * 媒体剥离候选：按「消息字节由大到小」排序——先剥最占地方的那条，
 * 用最少的动作把体积压下去（先剥小的可能剥很多条仍不达标）。
 */
function mediaStripCandidates(messages: MessageLike[]): MessageLike[] {
  return messages
    .filter((m) => m.type === 'user' && hasMedia(m))
    .sort((a, b) => messageBytes(b) - messageBytes(a))
}

/**
 * 发送前字节级预检与降体积。返回**可能是新对象**的 params；未超阈值时返回入参
 * 本身（引用相等，调用方可据此判断「未动过」）。
 *
 * @throws RequestTooLargePreflightError 降体积后仍超上限（不发网络请求）
 */
export function enforceRequestSizeLimit<T extends SizeGuardedParams>(
  params: T,
  context: { querySource?: string } = {},
): T {
  const limitBytes = getApiRequestMaxBytes()
  const triggerBytes = getApiRequestTriggerBytes()

  const measuredBytes = measureRequestBytes(params)
  if (measuredBytes <= triggerBytes) return params

  const messages = Array.isArray(params.messages)
    ? (params.messages as MessageLike[])
    : []
  const actions: string[] = []
  let working = params
  let bytes = measuredBytes

  const candidates = mediaStripCandidates(messages)
  for (let round = 0; round < MAX_REDUCTION_ROUNDS; round++) {
    if (bytes <= limitBytes) break
    const target = candidates.shift()
    if (!target) break

    // 复用批次 1 的媒体剥离（image+document 全媒体集 ⇒ 走 stripImagesFromMessages，
    // 含 tool_result 内嵌，并以 [image]/[document] 标记留痕）
    const outcome = applyMediaStripToUserMessage(
      target as Parameters<typeof applyMediaStripToUserMessage>[0],
      new Set(['image', 'document']),
    )
    if (outcome.kind !== 'replaced') {
      actions.push(`media_strip_noop:${target.uuid ?? 'unknown'}`)
      continue
    }

    const strippedMessages = (working.messages as MessageLike[]).map((m) =>
      m === target ? outcome.message : m,
    )
    working = { ...working, messages: strippedMessages } as T
    bytes = measureRequestBytes(working)
    actions.push(`media_stripped:${target.uuid ?? 'unknown'}`)
  }

  // 诊断：与 413 事后诊断同族（`request_too_large_observed` 需要真 APIError；
  // 这里在**发出前**落一条，字段口径保持一致，便于同屏对照）
  logForDiagnosticsNoPII('warn', 'request_too_large_preflight', {
    measured_bytes: measuredBytes,
    final_bytes: bytes,
    limit_bytes: limitBytes,
    trigger_bytes: triggerBytes,
    query_source: context.querySource ?? null,
    actions,
  })

  if (bytes > limitBytes) {
    throw new RequestTooLargePreflightError(bytes, limitBytes, actions)
  }

  return working
}
