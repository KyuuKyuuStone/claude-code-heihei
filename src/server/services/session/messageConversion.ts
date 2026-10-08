/**
 * 转录条目 → MessageEntry 转换（v1.7 结构拆分 · sessionService 第⑤批 · 纯移动）。
 *
 * 从 sessionService.ts 原样搬出的 4 个函数 + 1 个私有类型别名。选段理由：
 * 这一组构成「RawEntry 数组 → MessageEntry 数组」的完整转换链——entryToMessage
 * 做单条转换，entriesToMessages 做整链（含 goal 本地命令短路、任务通知抑制、
 * 隐藏判定），resolveParentToolUseId 做侧链父引用回溯，normalizeMessageUsage
 * 做 usage 归一化。四者体内**均无 this.<字段>**，跨组依赖全部指向第①②④批
 * 已搬走的同名函数与两个公开导出类型。
 *
 * 搬移规则：函数体逐字不变，仅两处形式调整——
 *   ① 缩进 −2（原 class 方法体缩进 4，模块级函数体缩进 2）；
 *   ② 组内与跨模块互调 this.foo( → foo(。
 * 门面里 entryToMessage / entriesToMessages / resolveParentToolUseId 改为同名类字段
 * 委托，**所有调用点（含组外 loadSubagentToolMessages / getSessionMessages 系列
 * 共 6 处）的 `this.xxx(...)` 文本一行未改**。
 *
 * normalizeMessageUsage 的特殊处理：它同时被门面**红灯段**
 * accumulateUsageFromLine（会话列表/窗口读取路径）使用，不能随本批从门面消失。
 * 故它随本批搬到本模块并导出，门面改以**值导入**引用——**门面导出面零变化**
 * （它原本就不是导出符号）。RawMessageUsage 是它的私有参数别名且仅被它使用，
 * 一并搬来；MessageUsage / MessageEntry 是门面公开导出类型，按既有先例
 * （transcriptAgents.ts:34）以 import type 引用，不搬定义。
 *
 * 未随本批搬走的相邻项（有意保留在门面）：
 *   · MessageEntry / MessageUsage：公开导出类型，搬动会改公共 API 面，不搬；
 *   · loadSubagentToolMessages / subagentTranscriptPath：碰实例状态
 *     （this.readJsonlFile / this.entryToMessage / this.getProjectsDir），非纯函数。
 *
 * 三向检查（模块级可变状态）：本批**不含任何模块级可变状态**，三个函数全为纯函数，
 * 1 个类型别名不可变——不适用，自然满足。
 *
 * 路径依赖预检：本段无 import.meta / __dirname / process.execPath（全文预检亦为零）。
 */

import type { MessageEntry, MessageUsage } from '../sessionService.js'
import {
  extractAgentToolUseId,
  goalLocalCommandEntryToMessage,
} from './transcriptAgents.js'
import {
  isTaskNotificationContent,
  isToolResultContent,
} from './transcriptContent.js'
import { shouldHideTranscriptEntry } from './transcriptEntries.js'
import { stripRosterDigestFromContent } from '../rosterDigest.js'
import type { RawEntry } from './transcriptAgents.js'

type RawMessageUsage = NonNullable<RawEntry['message']>['usage']

export function normalizeMessageUsage(usage: RawMessageUsage): MessageUsage | undefined {
  if (!usage) return undefined

  const normalized: MessageUsage = {}
  if (typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) {
    normalized.input_tokens = usage.input_tokens
  }
  if (typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)) {
    normalized.output_tokens = usage.output_tokens
  }
  if (
    typeof usage.cache_read_input_tokens === 'number' &&
    Number.isFinite(usage.cache_read_input_tokens)
  ) {
    normalized.cache_read_input_tokens = usage.cache_read_input_tokens
  }
  if (
    typeof usage.cache_creation_input_tokens === 'number' &&
    Number.isFinite(usage.cache_creation_input_tokens)
  ) {
    normalized.cache_creation_input_tokens = usage.cache_creation_input_tokens
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function entryToMessage(
  entry: RawEntry,
  parentToolUseId?: string,
): MessageEntry | null {
  const msg = entry.message
  if (!msg || !msg.role) return null

  // Determine our normalized type
  let type: MessageEntry['type']
  const role = msg.role

  if (role === 'user') {
    // Check if the content is a tool_result array
    if (Array.isArray(msg.content)) {
      const hasToolResult = msg.content.some(
        (block: Record<string, unknown>) => block.type === 'tool_result'
      )
      if (hasToolResult) {
        type = 'tool_result'
      } else {
        type = 'user'
      }
    } else {
      type = 'user'
    }
  } else if (role === 'assistant') {
    // Check if the content contains tool_use blocks
    if (Array.isArray(msg.content)) {
      const hasToolUse = msg.content.some(
        (block: Record<string, unknown>) => block.type === 'tool_use'
      )
      type = hasToolUse ? 'tool_use' : 'assistant'
    } else {
      type = 'assistant'
    }
  } else {
    type = 'system'
  }

  const usage = normalizeMessageUsage(msg.usage)

  return {
    id: entry.uuid || crypto.randomUUID(),
    type,
    // v1.7.4 修缺陷：花名册摘要系统段按**模型可见、用户不可见**处理 ⇒ 转录读路径（历史 API /
    // transcriptDerivation / 子链）统一在此剥掉**本系统段**（其它 system-reminder 不动）。
    content: stripRosterDigestFromContent(msg.content),
    ...(entry.toolUseResult !== undefined ? { toolUseResult: entry.toolUseResult } : {}),
    timestamp: entry.timestamp || new Date().toISOString(),
    model: msg.model,
    ...(usage ? { usage } : {}),
    parentUuid: entry.parentUuid ?? undefined,
    parentToolUseId,
    isSidechain: entry.isSidechain,
  }
}

export function resolveParentToolUseId(
  entry: RawEntry,
  entriesByUuid: Map<string, RawEntry>,
  cache: Map<string, string | undefined>,
): string | undefined {
  if (
    typeof entry.parent_tool_use_id === 'string' &&
    entry.parent_tool_use_id.length > 0
  ) {
    return entry.parent_tool_use_id
  }

  if (entry.isSidechain !== true) {
    return undefined
  }

  const cacheKey = entry.uuid
  if (cacheKey && cache.has(cacheKey)) {
    return cache.get(cacheKey)
  }

  let resolved: string | undefined
  let currentParentUuid =
    typeof entry.parentUuid === 'string' ? entry.parentUuid : undefined
  const visited = new Set<string>()

  while (currentParentUuid && !visited.has(currentParentUuid)) {
    visited.add(currentParentUuid)
    const parentEntry = entriesByUuid.get(currentParentUuid)
    if (!parentEntry) break

    const directAgentToolUseId = extractAgentToolUseId(parentEntry)
    if (directAgentToolUseId) {
      resolved = directAgentToolUseId
      break
    }

    if (parentEntry.uuid && cache.has(parentEntry.uuid)) {
      resolved = cache.get(parentEntry.uuid)
      break
    }

    currentParentUuid =
      typeof parentEntry.parentUuid === 'string'
        ? parentEntry.parentUuid
        : undefined
  }

  if (cacheKey) {
    cache.set(cacheKey, resolved)
  }

  return resolved
}

export function entriesToMessages(entries: RawEntry[]): MessageEntry[] {
  const messages: MessageEntry[] = []
  const entriesByUuid = new Map<string, RawEntry>()
  const parentToolUseIdCache = new Map<string, string | undefined>()
  let suppressTaskNotificationResponse = false

  for (const entry of entries) {
    if (typeof entry.uuid === 'string' && entry.uuid.length > 0) {
      entriesByUuid.set(entry.uuid, entry)
    }
  }

  for (const entry of entries) {
    const goalLocalCommandMessage = goalLocalCommandEntryToMessage(entry)
    if (goalLocalCommandMessage) {
      messages.push(goalLocalCommandMessage)
      continue
    }

    // Only process transcript entries (user / assistant / system with messages)
    if (!entry.message?.role) continue

    // Skip meta entries (CLI internal bookkeeping)
    if (entry.isMeta) continue

    const isTaskNotification =
      entry.message.role === 'user' &&
      isTaskNotificationContent(entry.message.content)
    if (isTaskNotification) {
      suppressTaskNotificationResponse = true
      continue
    }

    if (
      entry.message.role === 'user' &&
      !isToolResultContent(entry.message.content)
    ) {
      suppressTaskNotificationResponse = false
    } else if (suppressTaskNotificationResponse) {
      continue
    }

    if (shouldHideTranscriptEntry(entry)) continue

    // Skip non-transcript entry types
    const entryType = entry.type
    if (
      entryType !== 'user' &&
      entryType !== 'assistant' &&
      entryType !== 'system'
    ) {
      continue
    }

    const parentToolUseId = resolveParentToolUseId(
      entry,
      entriesByUuid,
      parentToolUseIdCache,
    )
    const msg = entryToMessage(entry, parentToolUseId)
    if (msg) {
      messages.push(msg)
    }
  }
  return messages
}
