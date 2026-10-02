// v1.7.0 结构拆分 chatStore 第③批：历史映射「提取/规范化」域从 stores/chatStore.ts
// 逐字移出（原 2540-3451 行），逻辑零改动；门面保留为入口。
// 注：原门面 :2543 有一行孤儿「])」——第①批拼接删除 GOAL_EVENT_ACTIONS 区间时
// 漏删其闭合行（HEAD 376e091 即带此语法错误）。它不属于本段内容，本批随段消除，
// 本文件不含该行。

import {
  SIMPLE_IMAGE_SOURCE_RE,
  DETAILED_IMAGE_SOURCE_RE,
  IMAGE_RESIZE_METADATA_RE,
  VISUAL_SELECTION_PROMPT_HEADER,
  VISUAL_SELECTION_PROMPT_FOOTER,
  COMMAND_METADATA_TAGS,
  COMMAND_METADATA_BLOCK_RE,
  TASK_NOTIFICATION_RE,
  GOAL_EVENT_ACTIONS,
  TEAMMATE_CONTENT_REGEX,
  MATERIALIZED_UPLOAD_NAME_RE,
  IMAGE_ONLY_REPLAY_FALLBACK,
  TASK_STOP_TOOL_NAMES,
} from './chatConstants'
import { nextId } from './messageTree'
import { AGENT_LIFECYCLE_TYPES } from '../../types/team'
import type {
  ActiveGoalState,
  AgentTaskNotification,
  AttachmentRef,
  BackgroundAgentTask,
  BackgroundAgentTaskUsage,
  GoalEventAction,
  UIAttachment,
  UIMessage,
} from '../../types/chat'
export type AssistantHistoryBlock = { type: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown }
export type UserHistoryBlock = { type: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; source?: { data?: string; media_type?: string }; mimeType?: string; media_type?: string; name?: string }


/**
 * Check if text is a teammate-message (internal agent-to-agent communication).
 * Uses full open+close tag match to avoid false positives on user text
 * that merely mentions the tag name (e.g., pasting code or discussing the protocol).
 */
export function isTeammateMessage(text: string): boolean {
  return text.includes('<teammate-message') && text.includes('</teammate-message>')
}

type VisualSelectionHistoryDisplay = {
  displayName: string
  selector?: string
  note?: string
}

function getHistoryImageMediaType(block: UserHistoryBlock): string {
  const mediaType = block.source?.media_type ?? block.mimeType ?? block.media_type
  return mediaType?.startsWith('image/') ? mediaType : 'image/png'
}

function normalizeHistoryImageData(data: string | undefined, mediaType: string): string | undefined {
  const trimmed = data?.trim()
  if (!trimmed) return undefined
  if (/^data:image\//i.test(trimmed)) return trimmed
  return `data:${mediaType};base64,${trimmed}`
}

export function extractImageMetadataSourcePath(text: string): string | undefined {
  const trimmed = text.trim()
  const simpleMatch = trimmed.match(SIMPLE_IMAGE_SOURCE_RE)
  if (simpleMatch?.[1]) return simpleMatch[1]
  const detailedMatch = trimmed.match(DETAILED_IMAGE_SOURCE_RE)
  if (detailedMatch?.[1]) return detailedMatch[1]
  return undefined
}

export function isGeneratedImageMetadataText(text: string): boolean {
  return Boolean(extractImageMetadataSourcePath(text)) || IMAGE_RESIZE_METADATA_RE.test(text.trim())
}

/**
 * Strip the generated image-metadata lines (`[Image source: …]`, resize notes)
 * that the server appends to a user turn's text. The optimistic message never
 * carried them, so live-replay dedupe must normalize them away first — otherwise
 * `findCurrentTurnUserMessageIndex` never matches and the raw prompt leaks in as
 * a duplicate bubble. This was most visible on Windows, where the appended
 * absolute upload path (`[Image source: C:\Users\…\uploads\…png]`) made the
 * mismatch obvious, but it affects any message that carries an image.
 */
export function stripGeneratedImageMetadataLines(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !isGeneratedImageMetadataText(line))
    .join('\n')
    .trim()
}

export function parseVisualSelectionHistoryPrompt(text: string): VisualSelectionHistoryDisplay | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== VISUAL_SELECTION_PROMPT_HEADER) return null

  let displayName: string | undefined
  let selector: string | undefined
  let note: string | undefined

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (line.startsWith('目标元素：')) {
      displayName = line.slice('目标元素：'.length).trim()
    } else if (line.startsWith('Selector：')) {
      selector = line.slice('Selector：'.length).trim()
    } else if (line === '用户注释：') {
      const noteLines: string[] = []
      for (let noteIndex = index + 1; noteIndex < lines.length; noteIndex += 1) {
        const noteLine = lines[noteIndex] ?? ''
        if (noteLine.trim() === VISUAL_SELECTION_PROMPT_FOOTER) break
        noteLines.push(noteLine)
      }
      const trimmedNote = noteLines.join('\n').trim()
      note = trimmedNote || undefined
      break
    }
  }

  return displayName
    ? {
        displayName,
        ...(selector ? { selector } : {}),
        ...(note ? { note } : {}),
      }
    : null
}

export function applyVisualSelectionHistoryDisplay(attachments: UIAttachment[], display: VisualSelectionHistoryDisplay): void {
  const imageAttachment = attachments.find((attachment) => attachment.type === 'image')
  if (!imageAttachment) return
  imageAttachment.name = display.displayName
  if (display.selector) imageAttachment.quote = display.selector
  if (display.note) imageAttachment.note = display.note
}

export function normalizeHistoryImageAttachment(block: UserHistoryBlock): UIAttachment {
  const mediaType = getHistoryImageMediaType(block)
  return {
    type: 'image',
    name: block.name || 'image',
    data: normalizeHistoryImageData(block.source?.data, mediaType),
    mimeType: mediaType,
  }
}

export function applyImageMetadataSourcePaths(attachments: UIAttachment[], sourcePaths: string[]): void {
  let imageIndex = 0
  for (const sourcePath of sourcePaths) {
    const attachment = attachments
      .slice(imageIndex)
      .find((candidate) => candidate.type === 'image')
    if (!attachment) return
    imageIndex = attachments.indexOf(attachment) + 1
    attachment.path = sourcePath
    if (!attachment.name || attachment.name === 'image') {
      attachment.name = getReferenceName(sourcePath)
    }
  }
}

export function extractHistoryTextBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []

  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return []
      const record = block as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string'
        ? [record.text]
        : []
    })
    .map((text) => text.trim())
    .filter(Boolean)
}

function hasCommandMetadataTag(text: string): boolean {
  return (
    text.includes('<command-name>') ||
    text.includes('<command-message>') ||
    text.includes('<command-args>') ||
    text.includes('<local-command-caveat>') ||
    text.includes('<skill-format>')
  )
}

function isOnlyKnownCommandMetadata(text: string): boolean {
  const remainder = text.replace(COMMAND_METADATA_BLOCK_RE, (match, tag: string) => (
    COMMAND_METADATA_TAGS.has(tag.toLowerCase()) ? '' : match
  ))
  return remainder.trim().length === 0
}

function formatCommandMetadataDisplayText(
  commandName: string,
  args: string,
  skillFormat: boolean,
  commandMessage?: string,
): string {
  if (skillFormat) {
    return `Skill(${commandMessage || commandName.replace(/^\//, '')})`
  }

  const normalizedName = commandName.startsWith('/') ? commandName : `/${commandName}`
  return [normalizedName, args.trim()].filter(Boolean).join(' ')
}

function parseCommandMetadataText(text: string): string | null {
  const trimmed = text.trim()
  if (!hasCommandMetadataTag(trimmed)) return null
  if (!isOnlyKnownCommandMetadata(trimmed)) return null

  const commandName = readXmlTag(trimmed, 'command-name')
  if (!commandName) return null

  const args = readXmlTag(trimmed, 'command-args') ?? ''
  const commandMessage = readXmlTag(trimmed, 'command-message')
  const skillFormat = readXmlTag(trimmed, 'skill-format') === 'true'
  return formatCommandMetadataDisplayText(commandName, args, skillFormat, commandMessage)
}

export function getCommandMetadataDisplayText(content: unknown): string | null {
  const textBlocks = extractHistoryTextBlocks(content)
  if (textBlocks.length === 0) return null

  const displayBlocks = textBlocks.map(parseCommandMetadataText)
  if (displayBlocks.some((text) => text === null)) return null
  return displayBlocks.join('\n')
}

export function shouldHideCommandMetadataContent(content: unknown): boolean {
  const textBlocks = extractHistoryTextBlocks(content)
  if (textBlocks.length === 0) return false
  if (!textBlocks.some(hasCommandMetadataTag)) return false
  return getCommandMetadataDisplayText(content) === null
}

export function isTaskNotificationContent(content: unknown): boolean {
  const textBlocks = extractHistoryTextBlocks(content)
  return textBlocks.length > 0 && textBlocks.every((text) => extractTaskNotificationXml(text) !== null)
}

function extractTaskNotificationXml(text: string): string | null {
  const trimmed = text.trim()
  if (TASK_NOTIFICATION_RE.test(trimmed)) return trimmed
  return trimmed.match(/<task-notification>\s*[\s\S]*?<\/task-notification>/i)?.[0] ?? null
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function readXmlTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match?.[1] ? decodeXmlText(match[1].trim()) : undefined
}

export function readNonEmptyString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function normalizeHistoryToolResultContent(content: unknown, toolUseResult: unknown): unknown {
  const result = readRecord(toolUseResult)
  const answers = readRecord(result?.answers)
  if (!result || !answers || !Array.isArray(result.questions)) return content
  return {
    questions: result.questions,
    answers,
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  const record = readRecord(value)
  if (record) return record
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return readRecord(JSON.parse(trimmed))
  } catch {
    return null
  }
}

function findToolUseMessage(messages: UIMessage[], toolUseId: string): ToolCall | null {
  return messages.find((
    message,
  ): message is ToolCall =>
    message.type === 'tool_use' &&
    message.toolUseId === toolUseId) ?? null
}

export function getStoppedBackgroundTaskFromToolResult(
  messages: UIMessage[],
  toolUseId: string,
  content: unknown,
): (Partial<BackgroundAgentTask> & Pick<BackgroundAgentTask, 'taskId' | 'status'>) | null {
  const toolUse = findToolUseMessage(messages, toolUseId)
  if (!toolUse || !TASK_STOP_TOOL_NAMES.has(toolUse.toolName)) return null

  const input = readRecord(toolUse.input) ?? {}
  const output = parseJsonRecord(content) ?? {}
  const taskId = readNonEmptyString(output, 'task_id', 'taskId') ??
    readNonEmptyString(input, 'task_id', 'taskId', 'shell_id', 'shellId')
  if (!taskId) return null

  return {
    taskId,
    status: 'stopped',
    taskType: readNonEmptyString(output, 'task_type', 'taskType'),
    description: readNonEmptyString(output, 'command', 'description', 'message'),
    summary: readNonEmptyString(output, 'message'),
  }
}

function normalizeBackgroundTaskUsage(value: unknown): BackgroundAgentTaskUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const usage: BackgroundAgentTaskUsage = {}
  const totalTokens = record.total_tokens ?? record.totalTokens
  const toolUses = record.tool_uses ?? record.toolUses
  const durationMs = record.duration_ms ?? record.durationMs
  if (typeof totalTokens === 'number') usage.totalTokens = totalTokens
  if (typeof toolUses === 'number') usage.toolUses = toolUses
  if (typeof durationMs === 'number') usage.durationMs = durationMs
  return Object.keys(usage).length > 0 ? usage : undefined
}

export function normalizeBackgroundAgentTaskEvent(
  data: unknown,
  subtype: string,
): Partial<BackgroundAgentTask> & Pick<BackgroundAgentTask, 'taskId' | 'status'> | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const taskId = readNonEmptyString(record, 'task_id', 'taskId')
  const toolUseId = readNonEmptyString(record, 'tool_use_id', 'toolUseId')
  const id = taskId ?? toolUseId
  if (!id) return null

  const rawStatus = readNonEmptyString(record, 'status')
  const status = rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'stopped'
    ? rawStatus
    : rawStatus === 'killed'
      ? 'stopped'
      : subtype === 'task_notification'
        ? 'completed'
        : 'running'

  return {
    taskId: id,
    toolUseId,
    status,
    description: readNonEmptyString(record, 'description', 'message', 'title'),
    taskType: readNonEmptyString(record, 'task_type', 'taskType'),
    workflowName: readNonEmptyString(record, 'workflow_name', 'workflowName'),
    prompt: readNonEmptyString(record, 'prompt'),
    result: readNonEmptyString(record, 'result'),
    summary: readNonEmptyString(record, 'summary'),
    lastToolName: readNonEmptyString(record, 'last_tool_name', 'lastToolName'),
    outputFile: readNonEmptyString(record, 'output_file', 'outputFile'),
    usage: normalizeBackgroundTaskUsage(record.usage),
  }
}

export function upsertBackgroundAgentTask(
  current: Record<string, BackgroundAgentTask>,
  event: Partial<BackgroundAgentTask> & Pick<BackgroundAgentTask, 'taskId' | 'status'>,
  now: number,
): Record<string, BackgroundAgentTask> {
  const existingKey = current[event.taskId]
    ? event.taskId
    : event.toolUseId
      ? Object.keys(current).find((key) =>
        key === event.toolUseId || current[key]?.toolUseId === event.toolUseId)
      : undefined
  const existing = existingKey ? current[existingKey] : undefined
  const next = { ...current }
  if (existingKey && existingKey !== event.taskId) {
    delete next[existingKey]
  }
  const startsNewLifecycle = Boolean(existing && (
    (existing.status !== 'running' && event.status === 'running') ||
    (existing.status !== 'running' && event.status !== 'running' && hasTerminalTaskPayloadChanged(existing, event))
  ))
  return {
    ...next,
    [event.taskId]: {
      taskId: event.taskId,
      toolUseId: event.toolUseId ?? existing?.toolUseId,
      status: event.status,
      description: event.description ?? existing?.description,
      taskType: event.taskType ?? existing?.taskType,
      workflowName: event.workflowName ?? existing?.workflowName,
      prompt: event.prompt ?? existing?.prompt,
      result: event.result ?? existing?.result,
      summary: event.summary ?? existing?.summary,
      lastToolName: event.lastToolName ?? existing?.lastToolName,
      outputFile: event.outputFile ?? existing?.outputFile,
      usage: event.usage ?? existing?.usage,
      startedAt: startsNewLifecycle ? now : existing?.startedAt ?? now,
      updatedAt: now,
    },
  }
}

function hasTerminalTaskPayloadChanged(
  existing: BackgroundAgentTask,
  event: Partial<BackgroundAgentTask> & Pick<BackgroundAgentTask, 'taskId' | 'status'>,
): boolean {
  return event.summary != null && event.summary !== existing.summary ||
    event.result != null && event.result !== existing.result ||
    event.outputFile != null && event.outputFile !== existing.outputFile ||
    event.usage != null && !areBackgroundTaskUsageEqual(event.usage, existing.usage)
}

function areBackgroundTaskUsageEqual(
  a: BackgroundAgentTaskUsage | undefined,
  b: BackgroundAgentTaskUsage | undefined,
): boolean {
  return a?.totalTokens === b?.totalTokens &&
    a?.toolUses === b?.toolUses &&
    a?.durationMs === b?.durationMs
}

export function normalizeGoalEventData(
  data: unknown,
  fallbackMessage?: string,
): Omit<Extract<UIMessage, { type: 'goal_event' }>, 'id' | 'type' | 'timestamp'> | null {
  if (!data || typeof data !== 'object') {
    const message = typeof fallbackMessage === 'string' ? fallbackMessage.trim() : ''
    return message ? { action: 'message', message } : null
  }

  const record = data as Record<string, unknown>
  const action = typeof record.action === 'string' && GOAL_EVENT_ACTIONS.has(record.action as GoalEventAction)
    ? record.action as GoalEventAction
    : 'message'
  const read = (key: string) =>
    typeof record[key] === 'string' && record[key].trim()
      ? record[key].trim()
      : undefined
  return {
    action,
    status: read('status'),
    objective: read('objective'),
    budget: read('budget'),
    elapsed: read('elapsed'),
    continuations: read('continuations'),
    message: read('message') ?? (typeof fallbackMessage === 'string' ? fallbackMessage.trim() : undefined),
  }
}

export function applyGoalEventToActiveGoal(
  current: ActiveGoalState | null,
  event: Omit<Extract<UIMessage, { type: 'goal_event' }>, 'id' | 'type' | 'timestamp'>,
  updatedAt: number,
): ActiveGoalState | null {
  if (event.action === 'cleared') return null
  if (
    event.action === 'message' &&
    event.message &&
    /no (active )?goal/i.test(event.message)
  ) {
    return current
  }
  if (event.action === 'message') return current
  const baseGoal = event.action === 'created' || event.action === 'replaced' ? null : current

  return {
    action: event.action,
    status: event.status ?? (event.action === 'completed' ? 'complete' : baseGoal?.status),
    objective: event.objective ?? baseGoal?.objective,
    budget: event.budget ?? baseGoal?.budget,
    elapsed: event.elapsed ?? baseGoal?.elapsed,
    continuations: event.continuations ?? baseGoal?.continuations,
    message: event.message ?? baseGoal?.message,
    updatedAt,
  }
}

export function deriveActiveGoalFromMessages(messages: UIMessage[]): ActiveGoalState | null {
  return messages.reduce<ActiveGoalState | null>((activeGoal, message) => {
    if (message.type !== 'goal_event') return activeGoal
    return applyGoalEventToActiveGoal(activeGoal, message, message.timestamp)
  }, null)
}

function extractLocalCommandText(content: unknown): string | null {
  if (typeof content !== 'string') return null
  return content.trim() || null
}

export function parseGoalCommandFromLocalCommand(content: unknown): { name: string; args: string } | null {
  const text = extractLocalCommandText(content)
  if (!text) return null
  const commandName = readXmlTag(text, 'command-name')
  if (!commandName) return null
  return {
    name: commandName.replace(/^\//, ''),
    args: readXmlTag(text, 'command-args') ?? '',
  }
}

export function formatVisibleLocalCommand(command: { name: string; args: string }): string {
  const normalizedName = command.name.replace(/^\//, '')
  const args = command.args.trim()
  return `/${normalizedName}${args ? ` ${args}` : ''}`
}

export function extractLocalCommandOutputText(content: unknown): string | null {
  const text = extractLocalCommandText(content)
  if (!text) return null
  return readXmlTag(text, 'local-command-stdout') ?? readXmlTag(text, 'local-command-stderr') ?? null
}

export function isCompactLocalCommandOutput(output: string): boolean {
  return output.trim() === 'Compacted'
}

export function parseGoalEventFromLocalCommandOutput(
  output: string,
  command: { name: string; args: string } | null,
): Omit<Extract<UIMessage, { type: 'goal_event' }>, 'id' | 'type' | 'timestamp'> | null {
  if (command && command.name !== 'goal') return null
  const trimmed = output.trim()
  if (!trimmed) return null

  if (trimmed === 'Goal cleared.' || trimmed.startsWith('Goal cleared:')) return { action: 'cleared', message: trimmed }
  if (trimmed === 'Goal marked complete.') return { action: 'completed', message: trimmed }
  if (trimmed === 'No active goal.') return { action: 'message', message: trimmed }
  if (trimmed.startsWith('Goal continuing:')) {
    return {
      action: 'status',
      status: 'continuing',
      message: trimmed,
    }
  }
  if (trimmed.startsWith('Goal set:')) {
    const objective = trimmed.slice('Goal set:'.length).trim()
    return {
      action: 'created',
      status: 'active',
      objective: objective || undefined,
      message: trimmed,
    }
  }

  return command?.name === 'goal' ? { action: 'message', message: trimmed } : null
}

export function extractTaskNotification(content: unknown): AgentTaskNotification | null {
  const xml = extractHistoryTextBlocks(content)
    .map((text) => extractTaskNotificationXml(text))
    .find((value): value is string => value !== null)
  if (!xml) return null

  const toolUseId = readXmlTag(xml, 'tool-use-id')
  const status = readXmlTag(xml, 'status')
  if (
    !toolUseId ||
    (status !== 'completed' && status !== 'failed' && status !== 'stopped')
  ) {
    return null
  }

  const taskId = readXmlTag(xml, 'task-id') || toolUseId
  const summary = readXmlTag(xml, 'summary')
  const result = readXmlTag(xml, 'result')
  const outputFile = readXmlTag(xml, 'output-file')
  return {
    taskId,
    toolUseId,
    status,
    ...(summary ? { summary } : {}),
    ...(result ? { result } : {}),
    ...(outputFile ? { outputFile } : {}),
  }
}

export function agentNotificationRecordFromList(
  notifications: AgentTaskNotification[],
): Record<string, AgentTaskNotification> {
  return Object.fromEntries(
    notifications.map((notification) => [notification.toolUseId, notification]),
  )
}

export function backgroundTaskRecordFromNotifications(
  notifications: AgentTaskNotification[],
): Record<string, BackgroundAgentTask> {
  return notifications.reduce<Record<string, BackgroundAgentTask>>((tasks, notification) => {
    const parsedTimestamp = notification.timestamp ? new Date(notification.timestamp).getTime() : NaN
    const now = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now()
    return upsertBackgroundAgentTask(tasks, {
      taskId: notification.taskId,
      toolUseId: notification.toolUseId,
      status: notification.status,
      summary: notification.summary,
      outputFile: notification.outputFile,
      usage: notification.usage,
    }, now)
  }, {})
}

export function mergeBackgroundAgentTaskRecords(
  current: Record<string, BackgroundAgentTask>,
  restored: Record<string, BackgroundAgentTask>,
): Record<string, BackgroundAgentTask> {
  return Object.values(restored).reduce(
    (tasks, task) => upsertBackgroundAgentTask(tasks, task, task.updatedAt),
    current,
  )
}

export function extractVisibleTeammateMessageContents(text: string): string[] {
  const contents: string[] = []

  for (const match of text.matchAll(TEAMMATE_CONTENT_REGEX)) {
    const content = match[2]?.trim()
    if (!content) continue

    if (content.startsWith('{') && content.endsWith('}')) {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>
        if (typeof parsed.type === 'string' && AGENT_LIFECYCLE_TYPES.has(parsed.type)) {
          continue
        }
      } catch {
        // Keep non-JSON payloads that happen to look like JSON.
      }
    }

    contents.push(content)
  }

  return contents
}

export function pushAssistantHistoryText(
  messages: UIMessage[],
  content: string,
  timestamp: number,
  model?: string,
  transcriptMessageId?: string,
): void {
  if (!content.trim()) return

  const last = messages[messages.length - 1]
  const canMergeIntoLast =
    last?.type === 'assistant_text' &&
    (
      transcriptMessageId
        ? last.transcriptMessageId === transcriptMessageId
        : !last.transcriptMessageId
    )
  if (canMergeIntoLast) {
    last.content += content
    if (model && !last.model) last.model = model
    if (transcriptMessageId && !last.transcriptMessageId) {
      last.transcriptMessageId = transcriptMessageId
    }
    return
  }

  messages.push({
    id: nextId(),
    type: 'assistant_text',
    content,
    timestamp,
    ...(transcriptMessageId ? { transcriptMessageId } : {}),
    ...(model ? { model } : {}),
  })
}

export type HistoryMappingOptions = {
  includeTeammateMessages?: boolean
}

export function buildModelContent(content: string, attachments?: AttachmentRef[]): string {
  const paths = attachments
    ?.map((attachment) => attachment.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0) ?? []
  const trimmed = content.trim()
  if (paths.length === 0) return trimmed
  const prefix = paths.map((path) => `@"${path}"`).join(' ')
  return `${prefix} ${trimmed || 'Please analyze the attached files.'}`.trim()
}

function getReferenceName(referencePath: string): string {
  const normalized = referencePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const name = normalized.split('/').filter(Boolean).pop()
  return name || referencePath
}

function extractLeadingFileReferences(text: string): {
  content: string
  attachments?: UIAttachment[]
  modelContent?: string
} {
  const attachments: UIAttachment[] = []
  let remaining = text

  while (true) {
    const match = remaining.match(/^@"([^"]+)"\s*/)
    if (!match?.[1]) break

    attachments.push({
      type: 'file',
      name: getReferenceName(match[1]),
      path: match[1],
    })
    remaining = remaining.slice(match[0].length)
  }

  if (attachments.length === 0) {
    return { content: text }
  }

  return {
    content: remaining.trimStart(),
    attachments,
    modelContent: text,
  }
}

type WorkspaceReferenceHistoryDisplay = {
  content: string
  attachments: UIAttachment[]
}

function parseWorkspaceReferenceLocation(location: string): {
  path: string
  lineStart?: number
  lineEnd?: number
  diffSide?: 'old' | 'new'
} {
  const match = location.match(/^(.*?)(?::(old|new))?:L(\d+)(?:-L(\d+))?$/)
  if (!match?.[1] || !match[3]) return { path: location }

  const lineStart = Number(match[3])
  const lineEnd = Number(match[4] ?? match[3])
  return {
    path: match[1],
    lineStart,
    lineEnd,
    ...(match[2] === 'old' || match[2] === 'new' ? { diffSide: match[2] } : {}),
  }
}

function parseWorkspaceReferenceHistoryPrompt(text: string): WorkspaceReferenceHistoryDisplay | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== 'Referenced workspace context:') return null

  const attachments: UIAttachment[] = []
  let index = 1
  const isLocationHeader = (line: string) => /^@".+":$/.test(line.trim())

  while (index < lines.length) {
    const header = lines[index]?.trim() ?? ''
    const locationMatch = header.match(/^@"(.+)":$/)
    if (!locationMatch?.[1]) break

    const location = parseWorkspaceReferenceLocation(locationMatch[1])
    index += 1

    let note: string | undefined
    if (lines[index]?.trimStart().startsWith('Comment:')) {
      const noteLines = [lines[index]!.trimStart().slice('Comment:'.length).trimStart()]
      index += 1
      while (
        index < lines.length &&
        lines[index]!.trim() !== '' &&
        !/^`{3,}/.test(lines[index]!.trim()) &&
        !isLocationHeader(lines[index]!)
      ) {
        noteLines.push(lines[index]!)
        index += 1
      }
      note = noteLines.join('\n').trim() || undefined
    }

    let quote: string | undefined
    const fenceMatch = lines[index]?.trim().match(/^(`{3,})[^`]*$/)
    if (fenceMatch?.[1]) {
      const fence = fenceMatch[1]
      index += 1
      const quoteLines: string[] = []
      while (index < lines.length && lines[index]?.trim() !== fence) {
        quoteLines.push(lines[index]!)
        index += 1
      }
      if (index >= lines.length) return null
      index += 1
      quote = quoteLines.join('\n').trim() || undefined
    }

    attachments.push({
      type: 'file',
      name: getReferenceName(location.path),
      path: location.path,
      ...(location.lineStart ? { lineStart: location.lineStart } : {}),
      ...(location.lineEnd ? { lineEnd: location.lineEnd } : {}),
      ...(location.diffSide ? { diffSide: location.diffSide } : {}),
      ...(note ? { note } : {}),
      ...(quote ? { quote } : {}),
    })
  }

  if (attachments.length === 0) return null
  while (lines[index]?.trim() === '') index += 1
  return {
    content: lines.slice(index).join('\n').trim(),
    attachments,
  }
}

function pathsReferToSameFile(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  const normalizedLeft = left.replace(/\\/g, '/').replace(/^\.\//, '')
  const normalizedRight = right.replace(/\\/g, '/').replace(/^\.\//, '')
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  )
}

export type RestoredUserDisplay = {
  content: string
  attachments?: UIAttachment[]
  modelContent?: string
}

export function extractRestoredUserDisplay(text: string): RestoredUserDisplay {
  const leading = extractLeadingFileReferences(text)
  const workspace = parseWorkspaceReferenceHistoryPrompt(leading.content)
  if (!workspace) return leading

  const unmatchedLeading = [...(leading.attachments ?? [])]
  for (const attachment of workspace.attachments) {
    const matchingIndex = unmatchedLeading.findIndex((candidate) =>
      pathsReferToSameFile(candidate.path, attachment.path),
    )
    if (matchingIndex >= 0) unmatchedLeading.splice(matchingIndex, 1)
  }

  const attachments = [...unmatchedLeading, ...workspace.attachments]
  return {
    content: workspace.content,
    attachments: attachments.length > 0 ? attachments : undefined,
    modelContent: text,
  }
}

// ConversationService stores data-only files as `${randomUUID()}-${sanitizedName}`
// and omits successfully inlined images from the replayed text content.

function isLikelyInlineImageAttachment(attachment: UIAttachment): boolean {
  if (attachment.type === 'image') return true
  if (attachment.mimeType?.startsWith('image/')) return true
  const candidate = attachment.path ?? attachment.name
  return /\.(png|jpe?g|gif|webp)$/i.test(candidate)
}

function replayAttachmentMatchesCurrent(
  replayAttachment: UIAttachment,
  currentAttachment: UIAttachment,
): boolean {
  if (pathsReferToSameFile(replayAttachment.path, currentAttachment.path)) return true
  if (currentAttachment.path || !replayAttachment.path) return false

  const replayName = getReferenceName(replayAttachment.path)
  const materializedName = replayName.match(MATERIALIZED_UPLOAD_NAME_RE)?.[1]
  if (!materializedName) return false

  const currentName = currentAttachment.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  return Boolean(currentName) && materializedName === currentName
}

function replayAttachmentsMatchCurrent(
  replayAttachments: UIAttachment[],
  currentAttachments: UIAttachment[],
): boolean {
  if (currentAttachments.length === 0) return false

  const unmatchedCurrent = new Set(currentAttachments.map((_, index) => index))
  for (const replayAttachment of replayAttachments) {
    const matchingIndex = currentAttachments.findIndex((currentAttachment, index) =>
      unmatchedCurrent.has(index) && replayAttachmentMatchesCurrent(replayAttachment, currentAttachment),
    )
    if (matchingIndex < 0) return false
    unmatchedCurrent.delete(matchingIndex)
  }

  return [...unmatchedCurrent].every((index) =>
    isLikelyInlineImageAttachment(currentAttachments[index]!),
  )
}

export function replayMatchesCurrentUserMessage(
  message: Extract<UIMessage, { type: 'user_text' }>,
  replayDisplay: RestoredUserDisplay,
  replayModelContent: string,
): boolean {
  const currentModelContent = (message.modelContent ?? message.content).trim()
  if (currentModelContent === replayModelContent) return true

  const currentAttachments = message.attachments ?? []
  if (
    message.content.trim() === '' &&
    replayDisplay.content.trim() === IMAGE_ONLY_REPLAY_FALLBACK &&
    !replayDisplay.attachments?.length &&
    currentAttachments.length > 0 &&
    currentAttachments.every(isLikelyInlineImageAttachment)
  ) {
    return true
  }

  const currentDisplay = extractRestoredUserDisplay(currentModelContent)
  if (currentDisplay.content.trim() !== replayDisplay.content.trim()) return false

  return replayAttachmentsMatchCurrent(
    replayDisplay.attachments ?? [],
    currentAttachments,
  )
}
