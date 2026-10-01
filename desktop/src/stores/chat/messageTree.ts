// v1.7.0 结构拆分 chatStore 第②批：消息树遍历 / 时间线归并纯函数从
// stores/chatStore.ts 逐字移出（原 403-404、406-708、726-744、755-851、
// 905-948 行，其中 ToolCall/CompactSummaryMessage 类型别名原 90-91），
// 逻辑零改动；门面保留为入口。
// 留守门面的近邻：buildBackgroundTaskSessionUpdate / shouldSuppressTaskNotificationResponse /
// needsTranscriptIdHydrationRetry / refresh·reconcileCompletedTranscriptHistory /
// updateSessionIn——它们以 PerSessionState/ChatStore 为参，属 store 状态域，
// 搬走会形成类型环，故不搬。
// 模块级可变状态仅 msgCounter（私有），只被 nextId 闭包访问：三向检查
// ① 定义全仓唯一 ② 门面经 import { nextId } 受控访问 ③ 本模块顶层零直读。

import {
  AGENT_COMPLETION_NOTIFICATION_PREVIEW_CHARS,
  COMPACT_SUMMARY_CUTOFFS,
  COMPACT_SUMMARY_PREFIX,
} from './chatConstants'
import type { BackgroundAgentTask, MemoryEventFile, UIMessage } from '../../types/chat'

export type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
export type CompactSummaryMessage = Extract<UIMessage, { type: 'compact_summary' }>

let msgCounter = 0
export const nextId = () => `msg-${++msgCounter}-${Date.now()}`

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readJsonStringLiteral(source: string, quoteIndex: number): string | undefined {
  if (source[quoteIndex] !== '"') return undefined
  let value = ''
  for (let index = quoteIndex + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      const escaped = source[index + 1]
      if (escaped === undefined) return undefined
      value += char + escaped
      index += 1
      continue
    }
    if (char === '"') {
      try {
        return JSON.parse(`"${value}"`) as string
      } catch {
        return value
      }
    }
    value += char
  }
  return undefined
}

function extractPartialJsonStringField(source: string, field: string): string | undefined {
  const key = `"${field}"`
  const keyIndex = source.indexOf(key)
  if (keyIndex < 0) return undefined
  const colonIndex = source.indexOf(':', keyIndex + key.length)
  if (colonIndex < 0) return undefined

  let valueIndex = colonIndex + 1
  while (valueIndex < source.length && /\s/.test(source[valueIndex] ?? '')) {
    valueIndex += 1
  }
  return readJsonStringLiteral(source, valueIndex)
}

export function buildPartialToolInputPreview(
  partialInput: string,
  previousInput: unknown,
): Record<string, unknown> {
  const previous = isRecord(previousInput) ? previousInput : {}
  const preview: Record<string, unknown> = { ...previous }
  for (const field of ['file_path', 'filePath', 'path', 'command', 'pattern', 'url', 'query', 'description']) {
    const value = extractPartialJsonStringField(partialInput, field)
    if (value !== undefined) {
      preview[field] = value
    }
  }
  return preview
}

export function upsertToolUseMessage(
  messages: UIMessage[],
  toolUseId: string,
  build: (existing?: ToolCall) => ToolCall,
): UIMessage[] {
  const existingIndex = messages.findIndex(
    (message): message is ToolCall =>
      message.type === 'tool_use' && message.toolUseId === toolUseId,
  )
  if (existingIndex < 0) {
    return [...messages, build()]
  }

  const next = [...messages]
  next[existingIndex] = build(messages[existingIndex] as ToolCall)
  return next
}

export function markPendingToolUseMessagesStopped(messages: UIMessage[]): UIMessage[] {
  const resolvedToolUseIds = new Set(
    messages
      .filter((message) => message.type === 'tool_result')
      .map((message) => message.toolUseId),
  )
  let changed = false
  const stoppedMessages = messages.map((message) => {
    if (
      message.type !== 'tool_use' ||
      (!message.isPending && resolvedToolUseIds.has(message.toolUseId))
    ) {
      return message
    }
    changed = true
    return {
      ...message,
      isPending: false,
      status: 'stopped' as const,
    }
  })
  return changed ? stoppedMessages : messages
}

// Streaming throttle for content_delta. Buffers must be per-session because
// multiple desktop tabs can stream at the same time.

/**
 * 后台（异步）子 agent 的工具活动会带着 parentToolUseId 冒泡进主消息流，但
 * 渲染层把它们折叠进父 agent 卡片、不在主流单独显示（MessageList 的
 * childToolCallsByParent）。合并流式块时必须跳过这些"隐形"消息去看真正的上一
 * 条主流消息，否则主 agent 一段连续的 thinking / 正文会被它们切成好几块 ——
 * 块之间还什么都不显示（#1108）。
 */
export function findStreamMergeTargetIndex(messages: UIMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    const isBubbledChildActivity =
      (message.type === 'tool_use' || message.type === 'tool_result') &&
      Boolean(message.parentToolUseId)
    if (!isBubbledChildActivity) return index
  }
  return -1
}

export function appendAssistantTextMessage(
  messages: UIMessage[],
  content: string,
  timestamp: number,
  model?: string,
  transcriptMessageId?: string,
): UIMessage[] {
  const trimmedContent = content.trim()
  if (!trimmedContent) return messages

  const lastIndex = findStreamMergeTargetIndex(messages)
  const last = lastIndex >= 0 ? messages[lastIndex] : undefined
  // Wake/reconnect replay can resend persisted assistant text without a
  // transcript id. Ignore chunks that are already present in the hydrated tail.
  if (
    last?.type === 'assistant_text' &&
    last.transcriptMessageId &&
    !transcriptMessageId &&
    last.content.trim().includes(trimmedContent)
  ) {
    return messages
  }
  // 上面那道只在尾部仍是那条 hydrated 消息时才够得着。整轮重放时，正文到达前
  // 尾部早被 thinking / tool_result 顶掉了，于是重复的回复照样追加进来。
  // 这里比的是"逐字相同"而不是子串：整段重发的正文会与某条 hydrated 回复完全一致，
  // 而正常流式送来的是碎片（碎片几乎必然是某条历史回复的子串，用子串判定会误伤）。
  if (
    !transcriptMessageId &&
    messages.some(
      (message) =>
        message.type === 'assistant_text' &&
        message.transcriptMessageId &&
        message.content.trim() === trimmedContent,
    )
  ) {
    return messages
  }

  const canMergeIntoLast =
    last?.type === 'assistant_text' &&
    (
      transcriptMessageId
        ? last.transcriptMessageId === transcriptMessageId
        : !last.transcriptMessageId
    )
  if (canMergeIntoLast) {
    const merged: UIMessage = {
      ...last,
      content: last.content + content,
      ...(model ?? last.model ? { model: model ?? last.model } : {}),
      ...(transcriptMessageId ?? last.transcriptMessageId
        ? { transcriptMessageId: transcriptMessageId ?? last.transcriptMessageId }
        : {}),
    }
    const next = [...messages]
    next[lastIndex] = merged
    return next
  }

  return [
    ...messages,
    {
      id: nextId(),
      type: 'assistant_text',
      content,
      timestamp,
      ...(transcriptMessageId ? { transcriptMessageId } : {}),
      ...(model ? { model } : {}),
    },
  ]
}

export function extractCompactSummaryContent(content: unknown): string | null {
  if (typeof content !== 'string') return null
  const trimmed = content.trim()
  if (!trimmed.startsWith(COMPACT_SUMMARY_PREFIX)) return null

  let summary = trimmed.slice(COMPACT_SUMMARY_PREFIX.length).trim()
  for (const marker of COMPACT_SUMMARY_CUTOFFS) {
    const index = summary.indexOf(marker)
    if (index >= 0) {
      summary = summary.slice(0, index).trim()
    }
  }
  return summary || null
}

export function compactMetadataFromUnknown(data: unknown): Pick<CompactSummaryMessage, 'trigger' | 'preTokens' | 'messagesSummarized'> {
  if (!data || typeof data !== 'object') return {}
  const record = data as Record<string, unknown>
  const trigger = record.trigger === 'manual' || record.trigger === 'auto'
    ? record.trigger
    : undefined
  const preTokens = typeof record.preTokens === 'number'
    ? record.preTokens
    : typeof record.pre_tokens === 'number'
      ? record.pre_tokens
      : undefined
  const messagesSummarized = typeof record.messagesSummarized === 'number'
    ? record.messagesSummarized
    : typeof record.messages_summarized === 'number'
      ? record.messages_summarized
      : undefined

  return {
    ...(trigger ? { trigger } : {}),
    ...(preTokens !== undefined ? { preTokens } : {}),
    ...(messagesSummarized !== undefined ? { messagesSummarized } : {}),
  }
}

export function appendOrUpdateTailCompactSummary(
  messages: UIMessage[],
  update: Partial<Omit<CompactSummaryMessage, 'id' | 'type' | 'timestamp'>>,
  timestamp: number,
): UIMessage[] {
  const existingIndex = messages.length - 1
  const existingMessage = messages[existingIndex]
  if (existingMessage?.type === 'compact_summary') {
    const existing = existingMessage
    const next: CompactSummaryMessage = {
      ...existing,
      ...update,
      title: update.title ?? existing.title,
      timestamp: existing.timestamp,
    }
    return [
      ...messages.slice(0, existingIndex),
      next,
      ...messages.slice(existingIndex + 1),
    ]
  }

  return [
    ...messages,
    {
      id: nextId(),
      type: 'compact_summary',
      title: update.title ?? 'Context compacted',
      ...update,
      timestamp,
    },
  ]
}

export function dropTailCompactingCompactSummary(messages: UIMessage[]): UIMessage[] {
  const tail = messages[messages.length - 1]
  if (tail?.type === 'compact_summary' && tail.phase === 'compacting') {
    return messages.slice(0, -1)
  }
  return messages
}

export function upsertBackgroundTaskMessage(
  messages: UIMessage[],
  task: BackgroundAgentTask,
  timestamp: number,
): UIMessage[] {
  const isSameTaskMessage = (message: UIMessage) =>
    message.type === 'background_task' &&
    (message.task.taskId === task.taskId ||
      (task.toolUseId && message.task.toolUseId === task.toolUseId))

  if (isAgentBackgroundTask(task)) {
    return messages.filter((message) => !isSameTaskMessage(message))
  }

  const existingIndex = messages.findIndex((message) =>
    isSameTaskMessage(message))
  if (existingIndex === -1) {
    return [...messages, {
      id: `background-task-${task.taskId}`,
      type: 'background_task',
      task,
      timestamp,
    }]
  }

  return messages.map((message, index) =>
    index === existingIndex && message.type === 'background_task'
      ? { ...message, task: { ...message.task, ...task }, timestamp: message.timestamp || timestamp }
      : message)
}

export function mergeBackgroundTaskMessages(
  messages: UIMessage[],
  tasks: Record<string, BackgroundAgentTask>,
): UIMessage[] {
  const merged = Object.values(tasks).reduce(
    (current, task) => upsertBackgroundTaskMessage(current, task, task.updatedAt),
    messages,
  )
  return [...merged].sort((a, b) => a.timestamp - b.timestamp)
}

export function isAgentBackgroundTask(task: Pick<BackgroundAgentTask, 'taskType' | 'summary'>): boolean {
  if (task.taskType === 'local_agent' || task.taskType === 'remote_agent' || task.taskType === 'dream') {
    return true
  }
  return /^Agent (?:(?:"[^"]+" )?(completed|was stopped)|(?:"[^"]+" )?failed(?::|$))/.test(
    task.summary ?? '',
  )
}

export function mergeRestoredTerminalGoalEvents(
  messages: UIMessage[],
  restoredMessages: UIMessage[],
): UIMessage[] {
  const existingKeys = new Set(messages
    .filter((message): message is Extract<UIMessage, { type: 'goal_event' }> =>
      message.type === 'goal_event')
    .map((message) => `${message.action}:${message.message ?? ''}:${message.objective ?? ''}`))

  const missingTerminalEvents = restoredMessages.filter((
    message,
  ): message is Extract<UIMessage, { type: 'goal_event' }> =>
    message.type === 'goal_event' &&
    (message.action === 'completed' || message.action === 'cleared') &&
    !existingKeys.has(`${message.action}:${message.message ?? ''}:${message.objective ?? ''}`))

  return missingTerminalEvents.length > 0
    ? [...messages, ...missingTerminalEvents]
    : messages
}

export function mergeRestoredTranscriptMessageIds(
  messages: UIMessage[],
  restoredMessages: UIMessage[],
): UIMessage[] {
  const restoredCandidates = restoredMessages.filter((
    message,
  ): message is Extract<UIMessage, { type: 'user_text' | 'assistant_text' }> =>
    (message.type === 'user_text' || message.type === 'assistant_text') &&
    typeof message.transcriptMessageId === 'string' &&
    message.transcriptMessageId.length > 0)

  if (restoredCandidates.length === 0) return messages

  let restoredCursor = 0
  let changed = false
  const merged = messages.map((message) => {
    if (
      (message.type !== 'user_text' && message.type !== 'assistant_text') ||
      message.transcriptMessageId
    ) {
      return message
    }

    const matchIndex = restoredCandidates.findIndex((candidate, index) =>
      index >= restoredCursor &&
      candidate.type === message.type &&
      candidate.content.trim() === message.content.trim())

    if (matchIndex === -1) return message

    restoredCursor = matchIndex + 1
    changed = true
    return {
      ...message,
      transcriptMessageId: restoredCandidates[matchIndex]!.transcriptMessageId,
    }
  })

  return changed ? merged : messages
}

export function dropDuplicateTranscriptTextMessages(messages: UIMessage[]): UIMessage[] {
  const seen = new Set<string>()
  const deduped: UIMessage[] = []
  let changed = false

  for (const message of messages) {
    if (
      (message.type === 'user_text' || message.type === 'assistant_text') &&
      message.transcriptMessageId
    ) {
      const key = `${message.type}:${message.transcriptMessageId}:${message.content.trim()}`
      if (seen.has(key)) {
        changed = true
        continue
      }
      seen.add(key)
    }

    deduped.push(message)
  }

  return changed ? deduped : messages
}

export function mergeRestoredHistoryIntoLiveMessages(
  messages: UIMessage[],
  restoredMessages: UIMessage[],
): UIMessage[] {
  return mergeRestoredTerminalGoalEvents(
    dropDuplicateTranscriptTextMessages(
      mergeRestoredTranscriptMessageIds(messages, restoredMessages),
    ),
    restoredMessages,
  )
}

export function normalizeMemoryEventFiles(data: unknown): MemoryEventFile[] {
  if (!data || typeof data !== 'object') return []
  const writtenPaths = (data as { writtenPaths?: unknown }).writtenPaths
  if (!Array.isArray(writtenPaths)) return []
  return writtenPaths
    .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    .map((path) => ({ path, action: 'saved' as const }))
}

export function normalizeMemoryTeamCount(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined
  const teamCount = (data as { teamCount?: unknown }).teamCount
  return typeof teamCount === 'number' && Number.isFinite(teamCount)
    ? teamCount
    : undefined
}

export function normalizeNotificationPreview(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildAgentCompletionNotification(
  sessionId: string,
  messages: UIMessage[],
  text: string,
): { title: string; body: string; dedupeKey: string } | null {
  const preview = normalizeNotificationPreview(text)
  if (!preview) return null

  const lastAssistant = [...messages].reverse().find((message) => message.type === 'assistant_text')
  const suffix = preview.length > AGENT_COMPLETION_NOTIFICATION_PREVIEW_CHARS ? '...' : ''
  return {
    title: 'Claude Code Heihei 已完成回复',
    body: preview.slice(0, AGENT_COMPLETION_NOTIFICATION_PREVIEW_CHARS) + suffix,
    dedupeKey: `agent-completion:${sessionId}:${lastAssistant?.id ?? Date.now()}`,
  }
}
