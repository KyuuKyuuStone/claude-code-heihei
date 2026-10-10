/**
 * mediaStripRecovery —— 媒体类 API 错误的「请求期剥离」恢复（v1.7.5 修 413 锁死）
 *
 * 背景（客户实测）：员工/主管会话反复堆叠同一条 `Request too large`（HTTP 413），
 * 与「上级派活」卡交替 8+ 次，会话就此卡死。根因不是重试（413 不在 withRetry 的
 * 可重试集合），而是原来的「剥离承载媒体的那条 user 消息」只回扫到**最近一条
 * user 消息**、且遇 assistant 即 break：
 *
 *   [派活1(含大图), 413错误1, 派活2, 413错误2, …]
 *
 * 每个新错误的「最近一条 user」都是**新派活**（不含媒体）⇒ 真正撑爆请求体的旧
 * 媒体永远剥不掉 ⇒ 每回合原样复现同一 413。
 *
 * 本模块做两件事，全部是**请求期变换**（不改 transcript 落盘）：
 *   1) buildMediaStripTargets：错误消息 → 「该剥哪条 user 消息」的映射。回扫**继续
 *      越过** assistant / synthetic 错误，直到找到第一条**确实含可剥离媒体**的
 *      user 消息（带上限防病态长扫）。
 *   2) applyMediaStripToUserMessage：落到具体消息的剥离。媒体集为 document+image
 *      （即 REQUEST_TOO_LARGE）时**复用** compact 的 `stripImagesFromMessages`
 *      （它同时覆盖 tool_result 内嵌媒体并以 [image]/[document] 标记留痕）；更窄
 *      的类型集（PDF/图片专有错误）保持原「按类型删除」语义。
 *
 * ⚠ 本路径是本产品 build 下**唯一**的 413 自愈路径：REACTIVE_COMPACT /
 * CONTEXT_COLLAPSE 均为 ant-only，external build 实测 OFF（见 autoCompact.ts:191-195）。
 */

import {
  BUSINESS_ERROR_MEDIA_BLOCK_TYPES,
  type BusinessErrorCode,
} from '../constants/businessErrors.js'
import { noteMediaStrippedMessage } from '../services/api/contextGovernance.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'

/**
 * 最小结构视图。**刻意不从 `src/types/message.js` 导入命名类型**：那是自动生成的
 * stub（不导出这些名字），全仓靠 tsc 棘轮基线兜住；新文件引入同类错误会新增棘轮
 * 签名（只紧不松）。运行时这些类型实为 any，故结构视图等价。
 */
type BlockLike = { type?: string; text?: string; content?: unknown }
type MessageLike = {
  type?: string
  uuid?: string
  businessErrorCode?: string
  message?: { content?: unknown }
}
type UserMessageLike = MessageLike & { type: 'user' }

/** 回扫上限：从错误消息往回扫多少条去找「真正含可剥离媒体」的 user 消息 */
export const MEDIA_STRIP_SCAN_LIMIT = 500

/** 本机制可剥离的媒体块类型（与 compact 的 stripImagesFromMessages 覆盖面一致） */
const STRIPPABLE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'document'])

/**
 * 该 user 消息里是否**确实**存在可被剥离的媒体块（顶层，或 tool_result 内嵌
 * content 数组）。覆盖面刻意与 `services/compact/compact.ts` 的
 * `stripImagesFromMessages` 对齐——避免回扫「命中一条没有媒体的消息、剥了个空」
 * 这种假修复（原实现正是因此永久卡在同一处）。
 */
export function hasStrippableMediaBlocks(
  message: MessageLike,
  typesToStrip: ReadonlySet<string>,
): boolean {
  if (message.type !== 'user') return false
  const content = message.message?.content
  if (!Array.isArray(content)) return false
  for (const block of content as BlockLike[]) {
    if (typeof block !== 'object' || block === null) continue
    const blockType = block.type
    if (
      typeof blockType === 'string' &&
      typesToStrip.has(blockType) &&
      STRIPPABLE_MEDIA_TYPES.has(blockType)
    ) {
      return true
    }
    if (blockType === 'tool_result' && Array.isArray(block.content)) {
      for (const nested of block.content as BlockLike[]) {
        const nestedType = nested?.type
        if (
          typeof nestedType === 'string' &&
          typesToStrip.has(nestedType) &&
          STRIPPABLE_MEDIA_TYPES.has(nestedType)
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * 复用现成的 `stripImagesFromMessages` 做「全媒体剥离」的单条应用：把
 * image/document（含 tool_result 内嵌）换成 `[image]` / `[document]` 文本标记。
 *
 * **惰性 require**：`compact.ts` 反向 import `utils/messages.ts`，静态 import 会成环；
 * `utils/messages.ts` 已有同样的惰性 require 先例（`snipCompact.js`）。本路径只在
 * 「历史里已出现媒体类 API 错误」时才走，常态零开销。
 * require 失败/形状异常时返回 null，调用方退回「按类型删除」的老路径。
 */
function stripFullMediaFromMessage(
  message: UserMessageLike,
): UserMessageLike | null {
  try {
    const { stripImagesFromMessages } =
      require('../services/compact/compact.js') as typeof import('../services/compact/compact.js')
    const out = stripImagesFromMessages([message])
    const next = out[0]
    return next ? (next as UserMessageLike) : null
  } catch {
    return null
  }
}

/**
 * 从一个错误消息往回找「该被剥离的那条 user 消息」的 uuid。
 * 越过 assistant / 其他 synthetic 错误继续回扫，只认**确实含可剥离媒体**的 user。
 */
export function findStripTargetUuid(
  messages: MessageLike[],
  errorIndex: number,
  typesToStrip: ReadonlySet<string>,
): string | null {
  const floor = Math.max(0, errorIndex - MEDIA_STRIP_SCAN_LIMIT)
  for (let j = errorIndex - 1; j >= floor; j--) {
    const candidate = messages[j]!
    if (candidate.type !== 'user') continue
    if (!hasStrippableMediaBlocks(candidate, typesToStrip)) continue
    return candidate.uuid ?? null
  }
  return null
}

/**
 * 按错误消息构建「消息 uuid → 该剥的块类型集」。原实现内联在
 * `normalizeMessagesForAPI` 里（v1.7.5 下移至此，修回扫缺陷）。
 */
export function buildMediaStripTargets(
  messages: MessageLike[],
  errorToBlockTypes: Record<string, Set<string>>,
  isSyntheticApiErrorMessage: (message: MessageLike) => boolean,
): Map<string, Set<string>> {
  const stripTargets = new Map<string, Set<string>>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (!isSyntheticApiErrorMessage(msg)) continue

    let blockTypesToStrip: Set<string> | undefined
    const blockTypesFromCode =
      typeof msg.businessErrorCode === 'string'
        ? BUSINESS_ERROR_MEDIA_BLOCK_TYPES[
            msg.businessErrorCode as BusinessErrorCode
          ]
        : undefined
    if (blockTypesFromCode) {
      blockTypesToStrip = new Set(blockTypesFromCode)
    }
    // 兼容旧会话：历史消息里可能是「错误文本」而非 businessErrorCode
    const content = msg.message?.content
    const errorText =
      Array.isArray(content) && (content[0] as BlockLike | undefined)?.type === 'text'
        ? (content[0] as BlockLike).text
        : undefined
    if (!blockTypesToStrip && errorText) {
      blockTypesToStrip = errorToBlockTypes[errorText]
    }
    if (!blockTypesToStrip) continue

    const targetUuid = findStripTargetUuid(messages, i, blockTypesToStrip)
    if (!targetUuid) continue

    const existing = stripTargets.get(targetUuid)
    if (existing) {
      for (const t of blockTypesToStrip) existing.add(t)
    } else {
      stripTargets.set(targetUuid, new Set(blockTypesToStrip))
    }
  }
  return stripTargets
}

export type MediaStripOutcome =
  | { kind: 'unchanged' }
  | {
      kind: 'replaced'
      message: UserMessageLike
      mode: 'full_media_markers' | 'type_filter'
    }
  | { kind: 'drop' }

/**
 * 把剥离落到一条 user 消息上。**只构造新的消息对象，不改动入参**（请求期变换，
 * transcript 原样保留）。剥离过的消息 id 交给 M2 画像，随 413 诊断落盘。
 */
export function applyMediaStripToUserMessage(
  message: UserMessageLike,
  typesToStrip: ReadonlySet<string>,
): MediaStripOutcome {
  const content = message.message?.content
  if (!Array.isArray(content)) return { kind: 'unchanged' }

  // 全媒体型（REQUEST_TOO_LARGE = document + image）复用 compact 的实现
  if (typesToStrip.has('image') && typesToStrip.has('document')) {
    const stripped = stripFullMediaFromMessage(message)
    // 同一对象 = 没剥到东西（stripImagesFromMessages 未命中时原样返回）⇒ 走下面的
    // 按类型删除兜底，避免记一条「剥了个空」的假诊断
    if (stripped && (stripped as unknown) !== message) {
      noteMediaStrippedMessage(stripped.uuid ?? '')
      logForDiagnosticsNoPII('warn', 'api_media_blocks_stripped', {
        messageId: stripped.uuid,
        stripped_types: [...typesToStrip],
        mode: 'full_media_markers',
      })
      return { kind: 'replaced', message: stripped, mode: 'full_media_markers' }
    }
  }

  const filtered = (content as BlockLike[]).filter(
    block => !typesToStrip.has(block.type ?? ''),
  )
  if (filtered.length === 0) return { kind: 'drop' }
  if (filtered.length === content.length) return { kind: 'unchanged' }

  const next: UserMessageLike = {
    ...message,
    type: 'user',
    message: { ...message.message, content: filtered },
  }
  noteMediaStrippedMessage(next.uuid ?? '')
  logForDiagnosticsNoPII('warn', 'api_media_blocks_stripped', {
    messageId: next.uuid,
    stripped_types: [...typesToStrip],
    mode: 'type_filter',
  })
  return { kind: 'replaced', message: next, mode: 'type_filter' }
}
