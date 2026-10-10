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
 *   3. 超阈值 ⇒ 先做**降体积 pass**（媒体块由大到小剥离），再重算，迭代到限内；
 *   4. 仍超（通常是无媒体可剥的纯文本大请求）⇒ **不发网络请求**，抛
 *      `RequestTooLargePreflightError`（由 `errors.ts` 转成**可执行**的错误消息）。
 *
 * 为什么放在这里：`messagesForAPI` 级的手段（M1 截断 / L1+L2 裁剪 / 媒体条数上限）
 * 都只作用于**消息**，看不到 system/tools/betas 等其余请求体开销；只有在此处
 * 序列化才是「**整个请求**的实测字节」——也才是链路上限真正卡的东西。
 *
 * ⚠ **形态口径（v1.7.5 返工修正，B1）**：本模块在 **wire 转换之后**运行，入参
 * `params.messages` 是 `addCacheBreakpoints`（`claude.ts:3404` →
 * `userMessageToMessageParam:657`）产出的 **wire 形态**：`{ role, content }`，
 * **没有** `type` / `uuid` / `message` 包裹。首版按**内部形态**（`message.message.content`）
 * 读块 ⇒ 候选恒空、一次都剥不掉（"剥离降体积后再发"从未发生），故此处所有
 * 读写一律按 wire 形态：
 *   · 候选消息 = `role === 'user'`（工具的 tool_result 在 wire 里也挂在 user 消息上）；
 *   · 媒体块 = content 数组里的 `image` / `document`，含 `tool_result.content`
 *     数组内嵌的媒体（含 string 形态的 tool_result.content 时无需处理：字符串里没有块）。
 * 诊断里的消息标识因此改用**索引**（wire 形态拿不到 uuid），见 `actions` 的
 * `media_stripped:index=N` 口径。
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

/** wire 形态结构视图：`{ role, content }`（见文件头「形态口径」） */
type WireBlock = {
  type?: string
  text?: string
  content?: unknown
  cache_control?: unknown
}
type WireMessage = { role?: string; content?: unknown }
/** 请求参数里本模块唯一关心/会改写的字段 */
export type SizeGuardedParams = { messages?: unknown } & Record<string, unknown>

/** 迭代上限：防「剥了又剥仍不达标」时的病态长循环 */
const MAX_REDUCTION_ROUNDS = 20

/** 与批次 1（`mediaStripRecovery`）/ compact 的 `stripImagesFromMessages` 同款留痕标记 */
const MEDIA_MARKERS: Record<string, string> = { image: '[image]', document: '[document]' }

/** 单条消息的实测字节（用于按「由大到小」排序剥离候选） */
function messageBytes(message: WireMessage): number {
  try {
    return Buffer.byteLength(jsonStringify(message), 'utf-8')
  } catch {
    return 0
  }
}

/** 把（wire 形态的）content 数组里的媒体块换掉；无改动时返回 null（调用方保留原对象） */
function stripMediaBlocks(content: unknown): unknown[] | null {
  if (!Array.isArray(content)) return null
  let changed = false
  const next = (content as WireBlock[]).map((block) => {
    if (!block || typeof block !== 'object') return block
    const marker = typeof block.type === 'string' ? MEDIA_MARKERS[block.type] : undefined
    if (marker) {
      changed = true
      // 只换块、**不动其它字段**：`cache_control` 必须跟着走——它可能正挂在
      // 这条消息的最后一个块上（`userMessageToMessageParam` 的 addCache 分支），
      // 丢掉就等于把缓存断点抹了。
      return {
        ...(block.cache_control !== undefined ? { cache_control: block.cache_control } : {}),
        type: 'text',
        text: marker,
      }
    }
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      // 硬约束②：**保留 tool_result 块本体**（拆掉它就拆散了 tool_use/tool_result
      // 配对），只换它内嵌的媒体块。
      const inner = stripMediaBlocks(block.content)
      if (inner) {
        changed = true
        return { ...block, content: inner }
      }
    }
    return block
  })
  return changed ? next : null
}

/** 该（wire 形态）消息里是否有可剥离的媒体（顶层或 tool_result 内嵌） */
function hasMedia(message: WireMessage): boolean {
  const content = message.content
  if (!Array.isArray(content)) return false
  for (const block of content as WireBlock[]) {
    const t = block?.type
    if (typeof t === 'string' && MEDIA_MARKERS[t]) return true
    if (t === 'tool_result' && Array.isArray(block.content)) {
      for (const nested of block.content as WireBlock[]) {
        const nt = nested?.type
        if (typeof nt === 'string' && MEDIA_MARKERS[nt]) return true
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
 * 媒体剥离候选（wire 形态）：按「消息字节由大到小」排序——先剥最占地方的那条，
 * 用最少的动作把体积压下去（先剥小的可能剥很多条仍不达标）。
 * 返回 [消息, 该消息在 params.messages 里的下标]（下标用于诊断标识）。
 */
function mediaStripCandidates(messages: WireMessage[]): Array<[WireMessage, number]> {
  return messages
    .map((message, index) => [message, index] as [WireMessage, number])
    .filter(([m]) => m.role === 'user' && hasMedia(m))
    .sort((a, b) => messageBytes(b[0]) - messageBytes(a[0]))
}

/**
 * 发送前字节级预检与降体积。返回**可能是新对象**的 params；未超阈值时返回入参
 * 本身（引用相等，调用方可据此判断「未动过」）。
 *
 * 纯函数语义（硬约束①）：只构造新对象，**不改入参**（连内层消息对象与 content
 * 数组都不原地改），对同一入参重复调用结果一致（幂等：剥过的消息已无媒体、
 * 不会再进候选）。
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
    ? (params.messages as WireMessage[])
    : []
  const actions: string[] = []
  let working = params
  let bytes = measuredBytes

  const candidates = mediaStripCandidates(messages)
  for (let round = 0; round < MAX_REDUCTION_ROUNDS; round++) {
    if (bytes <= limitBytes) break
    const entry = candidates.shift()
    if (!entry) break
    const [target, targetIndex] = entry

    const strippedContent = stripMediaBlocks(target.content)
    if (!strippedContent) {
      actions.push(`media_strip_noop:index=${targetIndex}`)
      continue
    }

    // 硬约束③：content 不得被清空（API 会拒）。理论上"换块"不会清空，
    // 这里仍显式兜底成一条可读标记。
    const nextContent =
      strippedContent.length === 0 ? [{ type: 'text', text: '[media removed]' }] : strippedContent
    const replacement: WireMessage = { ...target, content: nextContent }

    const strippedMessages = (working.messages as WireMessage[]).map((m, i) =>
      i === targetIndex ? replacement : m,
    )
    working = { ...working, messages: strippedMessages } as T
    bytes = measureRequestBytes(working)
    actions.push(`media_stripped:index=${targetIndex}`)
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
