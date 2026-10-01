// v1.7.0 结构拆分第①批（virtualization / renderModel / scroll / find）：
// renderModel 域从 components/chat/MessageList.tsx 逐字移出
// （原 52-89、403-416、564-874 行），逻辑零改动；门面保留为入口。
// memoryFileLabel / openMemorySettings / getBackgroundTaskLabel 随卡片域
// 留守门面（第②批），故不在本文件。

import { ApiError } from '../../../api/client'
import type { SessionTurnCheckpoint } from '../../../api/sessions'
import type { UIMessage } from '../../../types/chat'

export type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
export type ToolResult = Extract<UIMessage, { type: 'tool_result' }>
export type MemoryEvent = Extract<UIMessage, { type: 'memory_event' }>
export type GoalEvent = Extract<UIMessage, { type: 'goal_event' }>
export type BackgroundTaskEvent = Extract<UIMessage, { type: 'background_task' }>
export type CompactSummaryEvent = Extract<UIMessage, { type: 'compact_summary' }>

export type RenderItem =
  | { kind: 'tool_group'; toolCalls: ToolCall[]; id: string }
  | { kind: 'message'; message: UIMessage }

export type RenderModel = {
  renderItems: RenderItem[]
  toolResultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
}

export type RewindTurnTarget = {
  messageId: string
  userMessageIndex: number
  content: string
  expectedContent: string
  attachments?: Extract<UIMessage, { type: 'user_text' }>['attachments']
}

export type BranchableMessageTarget = {
  uiMessageId: string
  transcriptMessageId: string
}

export type TurnChangeCardModel = {
  target: RewindTurnTarget
  checkpoint: SessionTurnCheckpoint
  workDir: string | null
  isLatest: boolean
}

export const EMPTY_TURN_CHANGE_CARDS: TurnChangeCardModel[] = []

function isAgentBackgroundTaskMessage(message: UIMessage): boolean {
  if (message.type !== 'background_task') return false
  if (
    message.task.taskType === 'local_agent' ||
    message.task.taskType === 'remote_agent' ||
    message.task.taskType === 'dream'
  ) {
    return true
  }
  return /^Agent (?:(?:"[^"]+" )?(completed|was stopped)|(?:"[^"]+" )?failed(?::|$))/.test(
    message.task.summary ?? '',
  )
}

function appendChildToolCall(
  childToolCallsByParent: Map<string, ToolCall[]>,
  parentToolUseId: string,
  toolCall: ToolCall,
) {
  const siblings = childToolCallsByParent.get(parentToolUseId)
  if (siblings) {
    siblings.push(toolCall)
  } else {
    childToolCallsByParent.set(parentToolUseId, [toolCall])
  }
}

export function buildRenderModel(messages: UIMessage[], activeAskUserQuestionToolUseId?: string | null): RenderModel {
  const items: RenderItem[] = []
  const toolResultMap = new Map<string, ToolResult>()
  const childToolCallsByParent = new Map<string, ToolCall[]>()
  const toolUseIds = new Set<string>()
  const lastUnresolvedAskUserQuestionIndexByToolUseId = new Map<string, number>()
  let lastUnresolvedAskUserQuestionIndex: number | null = null
  let pendingToolCalls: ToolCall[] = []

  const flushGroup = () => {
    if (pendingToolCalls.length > 0) {
      items.push({
        kind: 'tool_group',
        toolCalls: [...pendingToolCalls],
        id: `group-${pendingToolCalls[0]!.id}`,
      })
      pendingToolCalls = []
    }
  }
  const appendRootToolCall = (toolCall: ToolCall) => {
    const nextIsAgent = toolCall.toolName === 'Agent'
    const pendingIsAgentGroup = pendingToolCalls.every((pendingToolCall) => pendingToolCall.toolName === 'Agent')

    if (pendingToolCalls.length > 0 && pendingIsAgentGroup !== nextIsAgent) {
      flushGroup()
    }
    pendingToolCalls.push(toolCall)
  }

  for (const msg of messages) {
    if (msg.type === 'tool_use') {
      toolUseIds.add(msg.toolUseId)
    }
    if (msg.type === 'tool_result') {
      toolResultMap.set(msg.toolUseId, msg)
    }
  }
  messages.forEach((msg, index) => {
    if (
      msg.type === 'tool_use' &&
      msg.toolName === 'AskUserQuestion' &&
      !toolResultMap.has(msg.toolUseId)
    ) {
      lastUnresolvedAskUserQuestionIndexByToolUseId.set(msg.toolUseId, index)
      lastUnresolvedAskUserQuestionIndex = index
    }
  })

  for (const msg of messages) {
    if (msg.type === 'assistant_text' && !msg.content.trim()) {
      continue
    }
    if (isAgentBackgroundTaskMessage(msg)) {
      continue
    }

    if (msg.type === 'tool_result' && toolUseIds.has(msg.toolUseId)) {
      continue
    }
    if (msg.type === 'tool_result' && msg.parentToolUseId && toolUseIds.has(msg.parentToolUseId)) {
      continue
    }

    if (msg.type === 'tool_use') {
      if (msg.parentToolUseId && toolUseIds.has(msg.parentToolUseId)) {
        flushGroup()
        appendChildToolCall(childToolCallsByParent, msg.parentToolUseId, msg)
        continue
      }
      if (msg.toolName === 'AskUserQuestion') {
        const isResolved = toolResultMap.has(msg.toolUseId)
        const lastUnresolvedIndex = lastUnresolvedAskUserQuestionIndexByToolUseId.get(msg.toolUseId)
        if (!isResolved && lastUnresolvedIndex !== undefined && messages[lastUnresolvedIndex] !== msg) {
          continue
        }
        if (
          !isResolved &&
          activeAskUserQuestionToolUseId &&
          msg.toolUseId !== activeAskUserQuestionToolUseId
        ) {
          continue
        }
        if (
          !isResolved &&
          !activeAskUserQuestionToolUseId &&
          lastUnresolvedAskUserQuestionIndex !== null &&
          messages[lastUnresolvedAskUserQuestionIndex] !== msg
        ) {
          continue
        }
        flushGroup()
        items.push({ kind: 'message', message: msg })
      } else {
        appendRootToolCall(msg)
      }
    } else {
      flushGroup()
      items.push({ kind: 'message', message: msg })
    }
  }

  flushGroup()
  return { renderItems: items, toolResultMap, childToolCallsByParent }
}

function isTurnResponseMessage(message: UIMessage) {
  return (
    message.type === 'assistant_text' ||
    message.type === 'tool_use' ||
    message.type === 'tool_result' ||
    (message.type === 'background_task' && !isAgentBackgroundTaskMessage(message)) ||
    message.type === 'error' ||
    message.type === 'task_summary'
  )
}

export function getBranchableMessageTargets(messages: UIMessage[]): Map<string, BranchableMessageTarget> {
  const branchableTargets = new Map<string, BranchableMessageTarget>()
  let currentTurnCandidates: Array<Extract<UIMessage, { type: 'user_text' | 'assistant_text' }>> = []
  let hasResponseForCurrentTurn = false

  const markCurrentTurnBranchable = () => {
    if (!hasResponseForCurrentTurn) return
    for (const candidate of currentTurnCandidates) {
      if (!candidate.transcriptMessageId) continue
      branchableTargets.set(candidate.id, {
        uiMessageId: candidate.id,
        transcriptMessageId: candidate.transcriptMessageId,
      })
    }
  }

  for (const message of messages) {
    if (message.type === 'user_text') {
      markCurrentTurnBranchable()
      currentTurnCandidates = []
      hasResponseForCurrentTurn = false
      if (!message.pending && message.transcriptMessageId) {
        currentTurnCandidates = [message]
      }
      continue
    }

    if (currentTurnCandidates.length === 0) continue

    if (isTurnResponseMessage(message)) {
      hasResponseForCurrentTurn = true
    }

    if (message.type === 'assistant_text' && message.transcriptMessageId) {
      currentTurnCandidates.push(message)
    }
  }

  markCurrentTurnBranchable()
  return branchableTargets
}

export function getCompletedTurnTargets(messages: UIMessage[]): RewindTurnTarget[] {
  let userMessageIndex = -1
  const completedTurns: RewindTurnTarget[] = []
  let currentTarget: RewindTurnTarget | null = null
  let hasResponseForCurrentTarget = false

  for (const message of messages) {
    if (message.type === 'user_text' && !message.pending) {
      if (currentTarget && hasResponseForCurrentTarget) {
        completedTurns.push(currentTarget)
      }
      userMessageIndex += 1
      currentTarget = {
        messageId: message.id,
        userMessageIndex,
        content: message.content,
        expectedContent: message.modelContent ?? message.content,
        attachments: message.attachments,
      }
      hasResponseForCurrentTarget = false
      continue
    }

    if (currentTarget && isTurnResponseMessage(message)) {
      hasResponseForCurrentTarget = true
    }
  }

  if (currentTarget && hasResponseForCurrentTarget) {
    completedTurns.push(currentTarget)
  }

  return completedTurns
}

export function getLatestCompletedTurnTarget(messages: UIMessage[]): RewindTurnTarget | null {
  const completedTurns = getCompletedTurnTargets(messages)
  return completedTurns.length > 0 ? completedTurns[completedTurns.length - 1] ?? null : null
}

export function buildTurnCardInsertionMap(
  renderItems: RenderItem[],
  turnChangeCards: TurnChangeCardModel[],
) {
  const lastResponseIndexByTurnId = new Map<string, number>()
  const userIndexByTurnId = new Map<string, number>()
  let activeTurnId: string | null = null

  renderItems.forEach((item, index) => {
    if (item.kind === 'message' && item.message.type === 'user_text' && !item.message.pending) {
      activeTurnId = item.message.id
      userIndexByTurnId.set(activeTurnId, index)
      return
    }

    if (activeTurnId) {
      lastResponseIndexByTurnId.set(activeTurnId, index)
    }
  })

  const cardsByRenderIndex = new Map<number, TurnChangeCardModel[]>()
  turnChangeCards.forEach((card) => {
    const renderIndex =
      lastResponseIndexByTurnId.get(card.target.messageId) ??
      userIndexByTurnId.get(card.target.messageId)
    if (renderIndex === undefined) return
    const existing = cardsByRenderIndex.get(renderIndex)
    if (existing) {
      existing.push(card)
    } else {
      cardsByRenderIndex.set(renderIndex, [card])
    }
  })

  return cardsByRenderIndex
}

/**
 * Map each render item to the REAL changed files of the turn it belongs to, so an
 * assistant message can anchor its output chips on files that were actually
 * written this turn instead of guessing paths from the prose. Items are attributed
 * to the most recent preceding non-pending user message (the turn boundary).
 */
export function buildChangedFilesByRenderIndex(
  renderItems: RenderItem[],
  turnChangeCards: TurnChangeCardModel[],
): Map<number, string[]> {
  const filesByTurnId = new Map<string, string[]>()
  for (const card of turnChangeCards) {
    if (card.checkpoint.code.filesChanged.length > 0) {
      filesByTurnId.set(card.target.messageId, card.checkpoint.code.filesChanged)
    }
  }
  if (filesByTurnId.size === 0) return new Map()

  const filesByRenderIndex = new Map<number, string[]>()
  let activeTurnId: string | null = null
  renderItems.forEach((item, index) => {
    if (item.kind === 'message' && item.message.type === 'user_text' && !item.message.pending) {
      activeTurnId = item.message.id
      return
    }
    if (activeTurnId) {
      const files = filesByTurnId.get(activeTurnId)
      if (files) filesByRenderIndex.set(index, files)
    }
  })

  return filesByRenderIndex
}

export function getApiErrorMessage(error: unknown) {
  return error instanceof ApiError
    ? typeof error.body === 'object' && error.body && 'message' in error.body
      ? String((error.body as { message: unknown }).message)
      : error.message
    : error instanceof Error
      ? error.message
      : String(error)
}

function isSessionTurnCheckpoint(value: unknown): value is SessionTurnCheckpoint {
  if (!value || typeof value !== 'object') return false
  const checkpoint = value as Partial<SessionTurnCheckpoint>
  return (
    Boolean(checkpoint.target) &&
    typeof checkpoint.target?.targetUserMessageId === 'string' &&
    typeof checkpoint.target?.userMessageIndex === 'number' &&
    Boolean(checkpoint.code) &&
    typeof checkpoint.code?.available === 'boolean' &&
    Array.isArray(checkpoint.code?.filesChanged)
  )
}

export function normalizeTurnCheckpoints(response: unknown): SessionTurnCheckpoint[] {
  if (!response || typeof response !== 'object') return []
  const checkpoints = (response as { checkpoints?: unknown }).checkpoints
  if (!Array.isArray(checkpoints)) return []
  return checkpoints.filter(isSessionTurnCheckpoint)
}
