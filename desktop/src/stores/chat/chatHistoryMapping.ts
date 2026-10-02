// v1.7.0 结构拆分 chatStore 第③批：历史映射「重放/映射/汇总」域从 stores/chatStore.ts
// 逐字移出（原 566-595、3453-3493、3537-3550、3580-3928 行），逻辑零改动；
// 门面保留为入口。原 export 的 appendReplayedUserMessage /
// reconstructAgentNotifications / mapHistoryMessagesToUiMessages 保持 export，门面重导出。
// queued 域（appendOptimisticQueuedUserMessage / mapQueuedDisplayAttachments /
// replaceQueuedMessageDisplayContent）因 QueuedUserMessage 类型定义在门面而留守，不搬。

import { sessionsApi } from '../../api/sessions'
import { TEAMMATE_CONTENT_REGEX, TASK_RELATED_TOOL_NAMES } from './chatConstants'
import {
  appendOrUpdateTailCompactSummary,
  extractCompactSummaryContent,
  nextId,
  normalizeMemoryEventFiles,
  normalizeMemoryTeamCount,
} from './messageTree'
import {
  stripGeneratedImageMetadataLines,
  extractRestoredUserDisplay,
  replayMatchesCurrentUserMessage,
  isTaskNotificationContent,
  getCommandMetadataDisplayText,
  shouldHideCommandMetadataContent,
  parseGoalCommandFromLocalCommand,
  formatVisibleLocalCommand,
  extractLocalCommandOutputText,
  isCompactLocalCommandOutput,
  parseGoalEventFromLocalCommandOutput,
  isTeammateMessage,
  extractVisibleTeammateMessageContents,
  normalizeHistoryImageAttachment,
  applyImageMetadataSourcePaths,
  deriveActiveGoalFromMessages,
  agentNotificationRecordFromList,
  backgroundTaskRecordFromNotifications,
  extractImageMetadataSourcePath,
  isGeneratedImageMetadataText,
  parseVisualSelectionHistoryPrompt,
  applyVisualSelectionHistoryDisplay,
  normalizeHistoryToolResultContent,
  extractTaskNotification,
  pushAssistantHistoryText,
} from './chatHistoryExtract'
import type {
  AssistantHistoryBlock,
  HistoryMappingOptions,
  RestoredUserDisplay,
  UserHistoryBlock,
} from './chatHistoryExtract'
import type { MessageEntry } from '../../types/session'
import type { AgentTaskNotification, TokenUsage, UIAttachment, UIMessage } from '../../types/chat'
import { AGENT_LIFECYCLE_TYPES } from '../../types/team'

function readUsageToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function appendReplayedUserMessage(
  messages: UIMessage[],
  content: string,
  timestamp: number,
): UIMessage[] {
  // The replayed text carries server-appended image-metadata lines that the
  // optimistic message never had. Normalize them away (same as the history
  // mapping) so the dedupe below can match the already-rendered message instead
  // of appending the raw prompt — paths and all — as a duplicate bubble.
  const sanitized = stripGeneratedImageMetadataLines(content) || content.trim()
  const parsed = extractRestoredUserDisplay(sanitized)
  const displayContent = parsed.content.trim()
  if (!displayContent && !parsed.attachments?.length) return messages

  const modelContent = parsed.modelContent ?? sanitized
  const currentTurnUserIndex = findCurrentTurnUserMessageIndex(messages, modelContent, parsed)
  if (currentTurnUserIndex >= 0) {
    const optimisticMessage = messages[currentTurnUserIndex]
    if (optimisticMessage?.type === 'user_text' && optimisticMessage.optimisticQueued) {
      const { optimisticQueued: _optimisticQueued, ...confirmedMessage } = optimisticMessage
      return [
        ...messages.slice(0, currentTurnUserIndex),
        confirmedMessage,
        ...messages.slice(currentTurnUserIndex + 1),
      ]
    }
    return messages
  }

  return [
    ...messages,
    {
      id: nextId(),
      type: 'user_text',
      content: displayContent,
      ...(parsed.modelContent ? { modelContent: parsed.modelContent } : {}),
      ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
      timestamp,
    },
  ]
}

/**
 * Reconstruct agentTaskNotifications from history.
 *
 * During a live session, background agents report completion via system_notification
 * events (task_notification). These are NOT persisted in JSONL history. On reload,
 * we reconstruct them by correlating Agent tool_use names with <teammate-message>
 * teammate_ids found in subsequent user messages.
 */
export function reconstructAgentNotifications(messages: MessageEntry[]): Record<string, AgentTaskNotification> {
  const taskNotifications = messages
    .filter((message) => message.type === 'user')
    .map((message) => extractTaskNotification(message.content))
    .filter((notification): notification is AgentTaskNotification => notification !== null)

  // Step 1: Collect Agent tool_use blocks → map agent name to toolUseId
  const agentNameToToolUseId = new Map<string, string>()

  for (const msg of messages) {
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      for (const block of msg.content as AssistantHistoryBlock[]) {
        if (block.type === 'tool_use' && block.name === 'Agent' && block.id) {
          const input = block.input as Record<string, unknown> | undefined
          const name = input?.name as string | undefined
          // Keep first toolUseId per name (consistent with first-wins for teammateContent)
          if (name && !agentNameToToolUseId.has(name)) agentNameToToolUseId.set(name, block.id)
        }
      }
    }
  }

  if (agentNameToToolUseId.size === 0) {
    return agentNotificationRecordFromList(taskNotifications)
  }

  // Step 2: Extract <teammate-message> content by teammate_id
  // Skip lifecycle messages (shutdown_approved, idle_notification, etc.)
  // which overwrite actual review content if stored later in history
  const teammateContent = new Map<string, string>()
  for (const msg of messages) {
    if (msg.type !== 'user') continue
    const text = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? (msg.content as Array<{ type?: string; text?: string }>).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
        : ''
    if (!text.includes('<teammate-message')) continue
    for (const match of text.matchAll(TEAMMATE_CONTENT_REGEX)) {
      if (match[1] && match[2]) {
        const content = match[2].trim()
        // Skip lifecycle JSON messages (shutdown, idle, terminated notifications)
        if (content.startsWith('{') && content.endsWith('}')) {
          try {
            const parsed = JSON.parse(content) as Record<string, unknown>
            if (typeof parsed.type === 'string' && AGENT_LIFECYCLE_TYPES.has(parsed.type)) continue
          } catch { /* not JSON, keep it */ }
        }
        // Only store the first meaningful content per teammate (avoid overwrite by later lifecycle msgs)
        if (!teammateContent.has(match[1])) {
          teammateContent.set(match[1], content)
        }
      }
    }
  }

  // Step 3: Correlate and build notifications
  const notifications: Record<string, AgentTaskNotification> = {}
  for (const [name, toolUseId] of agentNameToToolUseId) {
    const content = teammateContent.get(name)
    if (content) {
      notifications[toolUseId] = {
        taskId: toolUseId,
        toolUseId,
        status: 'completed',
        summary: content,
      }
    }
  }

  for (const notification of taskNotifications) {
    notifications[notification.toolUseId] = notification
  }

  return notifications
}

export function mapHistoryMessagesToUiMessages(
  messages: MessageEntry[],
  options?: HistoryMappingOptions,
): UIMessage[] {
  const includeTeammateMessages = options?.includeTeammateMessages === true
  const uiMessages: UIMessage[] = []
  let suppressTaskNotificationResponse = false
  let pendingGoalCommand: { name: string; args: string } | null = null

  for (const msg of messages) {
    if (msg.type === 'user' && isTaskNotificationContent(msg.content)) {
      suppressTaskNotificationResponse = true
      continue
    }
    if (msg.type === 'user') {
      const commandDisplayText = getCommandMetadataDisplayText(msg.content)
      if (commandDisplayText) {
        uiMessages.push({
          id: msg.id || nextId(),
          type: 'user_text',
          content: commandDisplayText,
          ...(msg.id ? { transcriptMessageId: msg.id } : {}),
          timestamp: new Date(msg.timestamp).getTime(),
        })
        suppressTaskNotificationResponse = false
        continue
      }
      if (shouldHideCommandMetadataContent(msg.content)) {
        continue
      }
    }
    if (msg.type === 'user') {
      suppressTaskNotificationResponse = false
    } else if (suppressTaskNotificationResponse) {
      continue
    }

    const timestamp = new Date(msg.timestamp).getTime()
    if (msg.type === 'system' && typeof msg.content === 'string') {
      if (msg.content.trim() === 'Conversation compacted' || msg.content.trim() === 'Context compacted') {
        const compactMessages = appendOrUpdateTailCompactSummary(
          uiMessages,
          { title: 'Context compacted', phase: 'complete' },
          timestamp,
        )
        uiMessages.splice(0, uiMessages.length, ...compactMessages)
        continue
      }

      const localCommand = parseGoalCommandFromLocalCommand(msg.content)
      if (localCommand) {
        pendingGoalCommand = localCommand
        if (localCommand.name === 'goal') {
          uiMessages.push({
            id: msg.id || nextId(),
            type: 'user_text',
            content: formatVisibleLocalCommand(localCommand),
            timestamp,
          })
        }
        continue
      }

      const localCommandOutput = extractLocalCommandOutputText(msg.content)
      if (localCommandOutput) {
        const goalEvent = parseGoalEventFromLocalCommandOutput(localCommandOutput, pendingGoalCommand)
        pendingGoalCommand = null
        if (goalEvent) {
          uiMessages.push({
            id: msg.id || nextId(),
            type: 'goal_event',
            ...goalEvent,
            timestamp,
          })
        }
        continue
      }
    }
    if (msg.type === 'user' && typeof msg.content === 'string') {
      const localCommandOutput = extractLocalCommandOutputText(msg.content)
      if (localCommandOutput && isCompactLocalCommandOutput(localCommandOutput)) {
        continue
      }

      const compactSummary = extractCompactSummaryContent(msg.content)
      if (compactSummary) {
        const compactMessages = appendOrUpdateTailCompactSummary(
          uiMessages,
          {
            title: 'Context compacted',
            phase: 'complete',
            summary: compactSummary,
          },
          timestamp,
        )
        uiMessages.splice(0, uiMessages.length, ...compactMessages)
        continue
      }

      if (isTeammateMessage(msg.content)) {
        if (!includeTeammateMessages) continue
        const teammateContents = extractVisibleTeammateMessageContents(msg.content)
        if (teammateContents.length === 0) continue
        uiMessages.push({
          id: msg.id || nextId(),
          type: 'user_text',
          content: teammateContents.join('\n\n'),
          ...(msg.id ? { transcriptMessageId: msg.id } : {}),
          timestamp,
        })
        continue
      }
      const parsed = extractRestoredUserDisplay(msg.content)
      uiMessages.push({
        id: msg.id || nextId(),
        type: 'user_text',
        content: parsed.content,
        ...(msg.id ? { transcriptMessageId: msg.id } : {}),
        ...(parsed.modelContent ? { modelContent: parsed.modelContent } : {}),
        ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
        timestamp,
      })
      continue
    }
    if (msg.type === 'assistant' && typeof msg.content === 'string') {
      if (!msg.content.trim()) continue
      uiMessages.push({
        id: msg.id || nextId(),
        type: 'assistant_text',
        content: msg.content,
        ...(msg.id ? { transcriptMessageId: msg.id } : {}),
        timestamp,
        model: msg.model,
      })
      continue
    }
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      for (const block of msg.content as AssistantHistoryBlock[]) {
        if (block.type === 'thinking' && block.thinking) uiMessages.push({ id: nextId(), type: 'thinking', content: block.thinking, timestamp })
        else if (block.type === 'text' && block.text) {
          pushAssistantHistoryText(uiMessages, block.text, timestamp, msg.model, msg.id || undefined)
        }
        else if (block.type === 'tool_use') uiMessages.push({ id: nextId(), type: 'tool_use', toolName: block.name ?? 'unknown', toolUseId: block.id ?? '', input: block.input, timestamp, parentToolUseId: msg.parentToolUseId })
      }
      continue
    }
    if ((msg.type === 'user' || msg.type === 'tool_result') && Array.isArray(msg.content)) {
      const visibleTextParts: string[] = []
      const modelTextParts: string[] = []
      const attachments: UIAttachment[] = []
      const imageSourcePaths: string[] = []
      const hasImageBlock = (msg.content as UserHistoryBlock[]).some((block) => block.type === 'image')
      for (const block of msg.content as UserHistoryBlock[]) {
        if (block.type === 'text' && block.text && isTeammateMessage(block.text)) {
          modelTextParts.push(block.text)
          if (!includeTeammateMessages) continue
          visibleTextParts.push(...extractVisibleTeammateMessageContents(block.text))
        } else if (block.type === 'text' && block.text) {
          modelTextParts.push(block.text)
          const imageSourcePath = hasImageBlock ? extractImageMetadataSourcePath(block.text) : undefined
          if (imageSourcePath) {
            imageSourcePaths.push(imageSourcePath)
          }
          if (!hasImageBlock || !isGeneratedImageMetadataText(block.text)) {
            visibleTextParts.push(block.text)
          }
        }
        else if (block.type === 'image') attachments.push(normalizeHistoryImageAttachment(block))
        else if (block.type === 'file') attachments.push({ type: 'file', name: block.name || 'file' })
        else if (block.type === 'tool_result') uiMessages.push({
          id: nextId(),
          type: 'tool_result',
          toolUseId: block.tool_use_id ?? '',
          content: normalizeHistoryToolResultContent(block.content, msg.toolUseResult),
          isError: !!block.is_error,
          timestamp,
          parentToolUseId: msg.parentToolUseId,
        })
      }
      applyImageMetadataSourcePaths(attachments, imageSourcePaths)
      if (visibleTextParts.length > 0 || attachments.length > 0) {
        const visibleText = visibleTextParts.join('\n')
        const modelText = modelTextParts.join('\n')
        const visualSelectionDisplay =
          msg.type === 'user' && hasImageBlock
            ? parseVisualSelectionHistoryPrompt(modelText)
            : null
        if (visualSelectionDisplay) {
          applyVisualSelectionHistoryDisplay(attachments, visualSelectionDisplay)
        }
        const parsed = extractRestoredUserDisplay(visibleText)
        const userContent = visualSelectionDisplay ? '' : parsed.content
        const modelContent = visualSelectionDisplay || modelText !== visibleText ? modelText : parsed.modelContent
        const allAttachments = [...(parsed.attachments ?? []), ...attachments]
        uiMessages.push({
          id: msg.id || nextId(),
          type: 'user_text',
          content: userContent,
          ...(msg.id ? { transcriptMessageId: msg.id } : {}),
          ...(modelContent ? { modelContent } : {}),
          attachments: allAttachments.length > 0 ? allAttachments : undefined,
          timestamp,
        })
      }
    }
    if (msg.type === 'system' && msg.content && typeof msg.content === 'object') {
      const subtype = (msg.content as { subtype?: unknown }).subtype
      if (subtype === 'memory_saved') {
        const files = normalizeMemoryEventFiles(msg.content)
        if (files.length > 0) {
          uiMessages.push({
            id: msg.id || nextId(),
            type: 'memory_event',
            event: 'saved',
            files,
            message: typeof (msg.content as { message?: unknown }).message === 'string'
              ? (msg.content as { message: string }).message
              : undefined,
            teamCount: normalizeMemoryTeamCount(msg.content),
            timestamp,
          })
        }
      }
    }
  }
  return uiMessages
}

export function extractLastTodoWriteFromHistory(messages: MessageEntry[]): Array<{ content: string; status: string; activeForm?: string }> | null {
  let foundIndex = -1
  let todos: Array<{ content: string; status: string; activeForm?: string }> | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      const blocks = msg.content as AssistantHistoryBlock[]
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j]!
        if (block.type === 'tool_use' && block.name === 'TodoWrite') {
          const input = block.input as { todos?: unknown } | undefined
          if (input && Array.isArray(input.todos)) {
            todos = input.todos as Array<{ content: string; status: string; activeForm?: string }>
            foundIndex = i
            break
          }
        }
      }
      if (todos) break
    }
  }
  if (!todos) return null
  const allDone = todos.every((t) => t.status === 'completed')
  if (allDone) {
    for (let i = foundIndex + 1; i < messages.length; i++) {
      if (messages[i]!.type === 'user' && messages[i]!.content) return null
    }
  }
  return todos
}

export function hasUserMessagesAfterTaskCompletion(messages: MessageEntry[]): boolean {
  let lastTaskIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      const blocks = msg.content as AssistantHistoryBlock[]
      if (blocks.some((b) => b.type === 'tool_use' && TASK_RELATED_TOOL_NAMES.has(b.name ?? ''))) { lastTaskIndex = i; break }
    }
  }
  if (lastTaskIndex < 0) return false
  for (let i = lastTaskIndex + 1; i < messages.length; i++) { if (messages[i]!.type === 'user') return true }
  return false
}

function findCurrentTurnUserMessageIndex(
  messages: UIMessage[],
  modelContent: string,
  replayDisplay: RestoredUserDisplay,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type !== 'user_text') {
      continue
    }
    return replayMatchesCurrentUserMessage(message, replayDisplay, modelContent) ? index : -1
  }
  return -1
}

export function summarizeTokenUsageFromHistory(messages: MessageEntry[]): TokenUsage | null {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0

  for (const message of messages) {
    const usage = message.usage
    if (!usage) continue
    inputTokens += readUsageToken(usage.input_tokens)
    outputTokens += readUsageToken(usage.output_tokens)
    cacheReadTokens += readUsageToken(usage.cache_read_input_tokens)
    cacheCreationTokens += readUsageToken(usage.cache_creation_input_tokens)
  }

  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) {
    return null
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cacheReadTokens > 0 ? { cache_read_tokens: cacheReadTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cache_creation_tokens: cacheCreationTokens } : {}),
  }
}

export async function fetchAndMapSessionHistory(
  sessionId: string,
  params?: { limit?: number; before?: number },
) {
  const { messages, taskNotifications, total, hasMore, nextBefore } = params
    ? await sessionsApi.getMessages(sessionId, params)
    : await sessionsApi.getMessages(sessionId)
  const uiMessages = mapHistoryMessagesToUiMessages(messages)
  const restoredNotifications = {
    ...reconstructAgentNotifications(messages),
    ...agentNotificationRecordFromList(taskNotifications ?? []),
  }
  return {
    rawMessages: messages,
    uiMessages,
    activeGoal: deriveActiveGoalFromMessages(uiMessages),
    restoredNotifications,
    restoredBackgroundTasks: backgroundTaskRecordFromNotifications(Object.values(restoredNotifications)),
    lastTodos: extractLastTodoWriteFromHistory(messages),
    hasMessagesAfterTaskCompletion: hasUserMessagesAfterTaskCompletion(messages),
    tokenUsage: summarizeTokenUsageFromHistory(messages),
    // 旧服务端忽略 limit 且不带 hasMore 字段 → 视为"已给全量"。
    historyHasMore: hasMore === true,
    historyNextBefore: typeof nextBefore === 'number' ? nextBefore : null,
    historyTotal: typeof total === 'number' ? total : null,
  }
}
