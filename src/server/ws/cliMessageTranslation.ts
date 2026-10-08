/**
 * CLI 消息翻译域（v1.7.4 结构专项 · D1′ 第①步：小件与状态表上提）
 *
 * 叶子模块（L4）：只依赖 `./events.js`（类型）、`./handlerPures.js`（纯函数）、
 * `./sessionTransport.js`（发送原语），**不得** import `ws/handler.ts`。
 *
 * 本步先落地 `translateCliMessage` 的**全部依赖件**：流状态族、usage 归一、
 * 权限模式守卫、两枚纯 helper、`updateSessionSlashCommands` 归一，以及两张状态表
 * 与其访问原语。第②步再搬 `translateCliMessage` 本体 + `cacheSessionInitMetadata`
 * ——那时本模块已自洽，第②步是纯搬移。
 *
 * 两张状态表（sessionSlashCommands / sessionStopRequested）只留本模块，外部经
 * 原语读写（T0 口径）。
 */

import type { PermissionMode, ServerMessage, TokenUsage } from './events.js'
import { readObject } from './handlerPures.js'
import { sendToSession } from './sessionTransport.js'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import { toApiRetryServerMessage, toStreamingFallbackServerMessage } from './cliRetryMessages.js'
import {
  extractGoalEvent,
  extractLocalCommand,
  extractLocalCommandOutput,
  extractReplayUserText,
  getCompactBoundaryMessage,
  isCompactLocalCommandOutput,
  isCompactSummaryMessageContent,
} from './localCommandParsing.js'
import { classifyRuntimeErrorCode, extractAssistantText } from './handlerPures.js'


/**
 * Cache slash commands from CLI init messages, keyed by sessionId.
 */
export type SessionSlashCommand = {
  name: string
  description: string
  argumentHint?: string
}

const sessionSlashCommands = new Map<string, SessionSlashCommand[]>()



/**
 * Track sessions where user requested stop — suppress the CLI_ERROR that
 * follows an interrupt so the frontend doesn't show "处理过程中发生错误".
 */
const sessionStopRequested = new Set<string>()


const validPermissionModes = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
])

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && validPermissionModes.has(value as PermissionMode)
}


export function getSlashCommands(sessionId: string): SessionSlashCommand[] {
  return sessionSlashCommands.get(sessionId) || []
}

function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function translateCliUsage(usage: unknown): TokenUsage {
  const record = usage && typeof usage === 'object'
    ? usage as Record<string, unknown>
    : {}
  const cacheReadTokens = usageNumber(record.cache_read_input_tokens ?? record.cache_read_tokens)
  const cacheCreationTokens = usageNumber(record.cache_creation_input_tokens ?? record.cache_creation_tokens)

  return {
    input_tokens: usageNumber(record.input_tokens),
    output_tokens: usageNumber(record.output_tokens),
    ...(cacheReadTokens > 0 ? { cache_read_tokens: cacheReadTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cache_creation_tokens: cacheCreationTokens } : {}),
  }
}

// ============================================================================
// CLI message translation
// ============================================================================

/**
 * Per-session streaming state to avoid cross-session interference.
 * Each session tracks its own dedup flag, active block types, and tool blocks.
 */
type SessionStreamState = {
  hasReceivedStreamEvents: boolean
  activeBlockTypes: Map<number, 'text' | 'tool_use' | 'thinking'>
  activeToolBlocks: Map<number, { toolName: string; toolUseId: string; inputJson: string; parentToolUseId?: string }>
  pendingLocalCommand?: { name: string; args: string }
  /** Tool blocks whose input JSON failed to parse in content_block_stop.
   *  The assistant message carries the complete input — defer to that. */
  pendingToolBlocks: Map<string, { toolName: string; toolUseId: string; parentToolUseId?: string }>
  toolParentUseIds: Map<string, string>
  lastApiError?: {
    message: string
    code: string
  }
}

const sessionStreamStates = new Map<string, SessionStreamState>()

function getStreamState(sessionId: string): SessionStreamState {
  let state = sessionStreamStates.get(sessionId)
  if (!state) {
    state = {
      hasReceivedStreamEvents: false,
      activeBlockTypes: new Map(),
      activeToolBlocks: new Map(),
      pendingLocalCommand: undefined,
      pendingToolBlocks: new Map(),
      toolParentUseIds: new Map(),
      lastApiError: undefined,
    }
    sessionStreamStates.set(sessionId, state)
  }
  return state
}

function resetCurrentStreamAttempt(state: SessionStreamState): void {
  state.hasReceivedStreamEvents = false
  state.activeBlockTypes.clear()
  state.activeToolBlocks.clear()
  state.pendingToolBlocks.clear()
}

function cliParentToolUseId(cliMsg: any): string | undefined {
  return typeof cliMsg.parent_tool_use_id === 'string' && cliMsg.parent_tool_use_id.length > 0
    ? cliMsg.parent_tool_use_id
    : undefined
}

function rememberToolParentUseId(
  streamState: SessionStreamState,
  toolUseId: string | undefined,
  parentToolUseId: string | undefined,
): void {
  if (!toolUseId || !parentToolUseId) return
  streamState.toolParentUseIds.set(toolUseId, parentToolUseId)
}

function consumeToolParentUseId(
  streamState: SessionStreamState,
  toolUseId: string | undefined,
): string | undefined {
  if (!toolUseId) return undefined
  const parentToolUseId = streamState.toolParentUseIds.get(toolUseId)
  streamState.toolParentUseIds.delete(toolUseId)
  return parentToolUseId
}

/** Clean up stream state when session disconnects */
export function cleanupStreamState(sessionId: string) {
  sessionStreamStates.delete(sessionId)
}



function normalizeAskUserQuestionToolResult(content: unknown, toolUseResult: unknown): unknown {
  const result = readObject(toolUseResult)
  const answers = readObject(result?.answers)
  if (!result || !answers || !Array.isArray(result.questions)) return content
  return {
    questions: result.questions,
    answers,
  }
}

function isDuplicateOfLastApiError(
  lastApiError: SessionStreamState['lastApiError'],
  resultMessage: string,
): boolean {
  if (!lastApiError?.message) return false
  if (resultMessage === lastApiError.message) return true
  return (
    resultMessage.includes(lastApiError.message) &&
    /CLI (?:process exited unexpectedly|exited during startup)/i.test(resultMessage)
  )
}



export function updateSessionSlashCommands(
  sessionId: string,
  commands: unknown[],
  options: { notifyClient?: boolean } = {},
): SessionSlashCommand[] {
  const normalized = commands
    .map(normalizeSessionSlashCommand)
    .filter((command): command is SessionSlashCommand => command !== null)

  sessionSlashCommands.set(sessionId, normalized)

  if (options.notifyClient !== false) {
    sendToSession(sessionId, {
      type: 'system_notification',
      subtype: 'slash_commands',
      data: normalized,
    })
  }

  return normalized
}

function normalizeSessionSlashCommand(command: unknown): SessionSlashCommand | null {
  if (typeof command === 'string') {
    return command.trim() ? { name: command, description: '' } : null
  }
  if (!command || typeof command !== 'object') return null

  const record = command as {
    name?: unknown
    command?: unknown
    description?: unknown
    argumentHint?: unknown
  }
  const name =
    typeof record.name === 'string'
      ? record.name
      : typeof record.command === 'string'
        ? record.command
        : ''
  if (!name.trim()) return null

  return {
    name,
    description: typeof record.description === 'string' ? record.description : '',
    ...(typeof record.argumentHint === 'string' ? { argumentHint: record.argumentHint } : {}),
  }
}

// ════════════════════════════════════════════════════════════════════════
// v1.7.4 结构专项 · D1′ 第②步：translateCliMessage 本体 + cacheSessionInitMetadata
// ════════════════════════════════════════════════════════════════════════

export function cacheSessionInitMetadata(sessionId: string, cliMsg: any) {
  if (cliMsg?.type !== 'system' || cliMsg.subtype !== 'init') return
  if (typeof cliMsg.cwd === 'string' && cliMsg.cwd.trim()) {
    conversationService.updateSessionWorkDir(sessionId, cliMsg.cwd)
    void (async () => {
      await sessionService.appendSessionMetadata(sessionId, {
        workDir: cliMsg.cwd,
      })
      await sessionService.deletePlaceholderSessionFiles(sessionId, cliMsg.cwd)
    })()
  }
  if (cliMsg.slash_commands && Array.isArray(cliMsg.slash_commands)) {
    updateSessionSlashCommands(sessionId, cliMsg.slash_commands, { notifyClient: false })
  }
}

export function translateCliMessage(cliMsg: any, sessionId: string): ServerMessage[] {
  const streamState = getStreamState(sessionId)
  switch (cliMsg.type) {
    case 'assistant': {
      if (cliMsg.error || cliMsg.isApiErrorMessage) {
        // If the user requested stop, suppress API errors caused by the
        // stream being interrupted (e.g. "Stream ended without receiving
        // any events"). The result message handler also checks this flag,
        // but the assistant error arrives first and would leak to the UI.
        if (isSessionStopRequested(sessionId)) {
          return []
        }
        const message = extractAssistantText(cliMsg) || cliMsg.error || 'Unknown API error'
        const fallbackCode = typeof cliMsg.error === 'string' ? cliMsg.error : 'API_ERROR'
        const code = classifyRuntimeErrorCode(message, fallbackCode)
        streamState.lastApiError = { message, code }
        return [{
          type: 'error',
          message,
          code,
          ...(typeof cliMsg.businessErrorCode === 'string'
            ? { businessErrorCode: cliMsg.businessErrorCode }
            : {}),
        }]
      }

      // If we already received stream_events, text/thinking were already sent.
      // Only extract tool_use blocks (stream_event's content_block_stop lacks complete tool info).
      if (cliMsg.message?.content && Array.isArray(cliMsg.message.content)) {
        const messages: ServerMessage[] = []

        for (const block of cliMsg.message.content) {
          if (streamState.hasReceivedStreamEvents) {
            // Stream events handled most blocks — but any tool_use whose
            // input JSON failed to parse in content_block_stop was deferred.
            // Emit those now with the complete input from the assistant message.
            if (block.type === 'tool_use' && streamState.pendingToolBlocks.has(block.id)) {
              const pending = streamState.pendingToolBlocks.get(block.id)!
              streamState.pendingToolBlocks.delete(block.id)
              rememberToolParentUseId(streamState, block.id, pending.parentToolUseId)
              messages.push({
                type: 'tool_use_complete',
                toolName: pending.toolName || block.name,
                toolUseId: block.id,
                input: block.input,
                parentToolUseId: pending.parentToolUseId,
              })
            }
          } else {
            // No stream events received — this is the only source, process everything
            if (block.type === 'thinking' && block.thinking) {
              messages.push({ type: 'thinking', text: block.thinking })
            } else if (block.type === 'text' && block.text) {
              messages.push({ type: 'content_start', blockType: 'text' })
              messages.push({ type: 'content_delta', text: block.text })
            } else if (block.type === 'tool_use') {
              const parentToolUseId = cliParentToolUseId(cliMsg)
              rememberToolParentUseId(streamState, block.id, parentToolUseId)
              messages.push({
                type: 'tool_use_complete',
                toolName: block.name,
                toolUseId: block.id,
                input: block.input,
                parentToolUseId,
              })
            }
          }
        }

        return messages
      }
      return []
    }

    case 'user': {
      // Bug #1: 处理 tool_result 消息
      // CLI 发送 type:'user' 消息，其中 content 包含 tool_result 块
      const messages: ServerMessage[] = []

      if (isCompactSummaryMessageContent(cliMsg.message?.content)) {
        messages.push({
          type: 'system_notification',
          subtype: 'compact_summary',
          message: cliMsg.message.content,
          data: {
            isSynthetic: cliMsg.isSynthetic,
          },
        })
      }

      const localCommandOutput = extractLocalCommandOutput(
        cliMsg.message?.content,
      )
      if (localCommandOutput) {
        const pendingLocalCommand = streamState.pendingLocalCommand
        streamState.pendingLocalCommand = undefined
        if (!isCompactLocalCommandOutput(localCommandOutput)) {
          const goalEvent = extractGoalEvent(
            localCommandOutput,
            pendingLocalCommand,
          )
          if (goalEvent) {
            messages.push({
              type: 'system_notification',
              subtype: 'goal_event',
              message: goalEvent.message,
              data: goalEvent,
            })
          } else {
            messages.push({ type: 'content_start', blockType: 'text' })
            messages.push({ type: 'content_delta', text: localCommandOutput })
          }
        }
      }

      if (cliMsg.message?.content && Array.isArray(cliMsg.message.content)) {
        for (const block of cliMsg.message.content) {
          if (block.type === 'tool_result') {
            const rememberedParentToolUseId = consumeToolParentUseId(streamState, block.tool_use_id)
            const parentToolUseId =
              cliParentToolUseId(cliMsg) ?? rememberedParentToolUseId
            messages.push({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              content: normalizeAskUserQuestionToolResult(block.content, cliMsg.toolUseResult),
              isError: !!block.is_error,
              parentToolUseId,
            })
          }
        }
      }

      const replayText = extractReplayUserText(cliMsg)
      if (replayText) {
        messages.push({
          type: 'user_message_replay',
          content: replayText,
        })
      }

      return messages
    }

    case 'stream_event': {
      streamState.hasReceivedStreamEvents = true
      const event = cliMsg.event
      if (!event) return []

      switch (event.type) {
        case 'message_start': {
          return [{ type: 'status', state: 'thinking', attemptStart: true }]
        }

        case 'content_block_start': {
          const contentBlock = event.content_block
          if (!contentBlock) return []

          const index = event.index ?? 0

          if (contentBlock.type === 'tool_use') {
            const parentToolUseId = cliParentToolUseId(cliMsg)
            streamState.activeBlockTypes.set(index, 'tool_use')
            // Track tool info so content_block_stop can emit complete data
            streamState.activeToolBlocks.set(index, {
              toolName: contentBlock.name || '',
              toolUseId: contentBlock.id || '',
              inputJson: '',
              parentToolUseId,
            })
            return [{
              type: 'content_start',
              blockType: 'tool_use',
              toolName: contentBlock.name,
              toolUseId: contentBlock.id,
              parentToolUseId,
            }]
          }

          if (contentBlock.type === 'thinking' || contentBlock.type === 'redacted_thinking') {
            streamState.activeBlockTypes.set(index, 'thinking')
            return [{ type: 'status', state: 'thinking', verb: 'Thinking' }]
          }

          streamState.activeBlockTypes.set(index, 'text')
          return [{ type: 'content_start', blockType: 'text' }]
        }

        case 'content_block_delta': {
          const delta = event.delta
          if (!delta) return []

          if (delta.type === 'text_delta' && delta.text) {
            return [{ type: 'content_delta', text: delta.text }]
          }
          if (delta.type === 'input_json_delta' && delta.partial_json) {
            // Accumulate tool input JSON
            const index = event.index ?? 0
            const toolBlock = streamState.activeToolBlocks.get(index)
            if (toolBlock) toolBlock.inputJson += delta.partial_json
            return [{ type: 'content_delta', toolInput: delta.partial_json }]
          }
          if (delta.type === 'thinking_delta' && delta.thinking) {
            return [{ type: 'thinking', text: delta.thinking }]
          }
          return []
        }

        case 'content_block_stop': {
          const index = event.index ?? 0
          const blockType = streamState.activeBlockTypes.get(index)
          streamState.activeBlockTypes.delete(index)

          if (blockType === 'tool_use') {
            const toolBlock = streamState.activeToolBlocks.get(index)
            streamState.activeToolBlocks.delete(index)
            if (toolBlock) {
              const parentToolUseId =
                cliParentToolUseId(cliMsg) ?? toolBlock.parentToolUseId
              let parsedInput = null
              try { parsedInput = JSON.parse(toolBlock.inputJson) } catch {}

              if (parsedInput !== null) {
                rememberToolParentUseId(streamState, toolBlock.toolUseId, parentToolUseId)
                return [{
                  type: 'tool_use_complete',
                  toolName: toolBlock.toolName,
                  toolUseId: toolBlock.toolUseId,
                  input: parsedInput,
                  parentToolUseId,
                }]
              }

              // JSON parse failed — defer to the assistant message which
              // carries the complete, already-parsed tool input. This is the
              // normal streaming partial-input case, not a fault: keep it at
              // debug so it doesn't surface as a diagnostics warning.
              console.debug(
                `[WS] Tool input JSON parse failed for ${toolBlock.toolName} (${toolBlock.toolUseId}), deferring to assistant message`,
              )
              streamState.pendingToolBlocks.set(toolBlock.toolUseId, {
                toolName: toolBlock.toolName,
                toolUseId: toolBlock.toolUseId,
                parentToolUseId,
              })
            }
          }
          return []
        }

        case 'message_stop': {
          // message_stop is handled by the 'result' message
          return []
        }

        case 'message_delta': {
          // message_delta may contain stop_reason or usage updates
          return []
        }

        default:
          return []
      }
    }

    case 'control_request': {
      // 权限请求 — CLI 需要用户授权才能执行工具
      if (cliMsg.request?.subtype === 'can_use_tool') {
        return [{
          type: 'permission_request',
          requestId: cliMsg.request_id,
          toolName: cliMsg.request.tool_name || 'Unknown',
          toolUseId:
            typeof cliMsg.request.tool_use_id === 'string'
              ? cliMsg.request.tool_use_id
              : undefined,
          input: cliMsg.request.input || {},
          description: cliMsg.request.description,
        }]
      }
      return []
    }

    case 'control_cancel_request':
      return typeof cliMsg.request_id === 'string'
        ? [{
            type: 'permission_resolved',
            requestId: cliMsg.request_id,
            permissionType: 'tool',
          }]
        : []

    case 'control_response': {
      const requestId = typeof cliMsg.response?.request_id === 'string'
        ? cliMsg.response.request_id
        : typeof cliMsg.request_id === 'string'
          ? cliMsg.request_id
          : null
      if (!requestId) return []
      const behavior = cliMsg.response?.response?.behavior
      return [{
        type: 'permission_resolved',
        requestId,
        permissionType: 'tool',
        ...(behavior === 'allow' || behavior === 'deny'
          ? { allowed: behavior === 'allow' }
          : {}),
      }]
    }

    case 'result': {
      // 对话结果（成功或错误）
      const usage = translateCliUsage(cliMsg.usage)
      // Buffered assistant blocks can arrive as a batch after all raw events
      // for one provider message. Keep deduplication active across the entire
      // batch, then clear it only at the terminal result boundary.
      resetCurrentStreamAttempt(streamState)

      if (cliMsg.is_error) {
        // If the user requested stop, this "error" is just the interrupt
        // result — don't show it as an error in the chat UI.
        if (isSessionStopRequested(sessionId)) {
          clearSessionStopRequested(sessionId)
          return [{ type: 'message_complete', usage }]
        }

        const resultMessage =
          (typeof cliMsg.result === 'string' && cliMsg.result) ||
          (Array.isArray(cliMsg.errors) && cliMsg.errors.length > 0
            ? cliMsg.errors.join('\n')
            : 'Unknown error')
        if (isDuplicateOfLastApiError(streamState.lastApiError, resultMessage)) {
          streamState.lastApiError = undefined
          return [{ type: 'message_complete', usage }]
        }
        // 错误和完成消息都发送
        return [
          {
            type: 'error',
            message: resultMessage,
            code: classifyRuntimeErrorCode(resultMessage, 'CLI_ERROR'),
          },
          { type: 'message_complete', usage },
        ]
      }

      // Clear stop flag on successful completion too
      clearSessionStopRequested(sessionId)
      streamState.lastApiError = undefined
      return [{ type: 'message_complete', usage }]
    }

    case 'system': {
      // 区分不同的 system 子类型
      const subtype = cliMsg.subtype
      if (subtype === 'api_retry') {
        const apiRetryMessage = toApiRetryServerMessage(cliMsg)
        return apiRetryMessage ? [apiRetryMessage] : []
      }
      if (subtype === 'streaming_fallback') {
        // The next attempt is a new stream or a full non-streaming response;
        // neither should inherit raw-event dedup/tool JSON from the failed one.
        resetCurrentStreamAttempt(streamState)
        return [toStreamingFallbackServerMessage(cliMsg)]
      }
      if (subtype === 'init') {
        // CLI 初始化完成 — 缓存 slash commands 并发送模型信息
        // NOTE: Do NOT send status:idle here — the CLI init fires while
        // processing the first user message, and sending idle would reset
        // the frontend's streaming state prematurely.
        cacheSessionInitMetadata(sessionId, cliMsg)
        const messages: ServerMessage[] = [
          // Send model info as a system notification, not a status change
          { type: 'system_notification', subtype: 'init', message: `Model: ${cliMsg.model || 'unknown'}`, data: { model: cliMsg.model } },
        ]
        // Send slash commands to frontend
        const cmds = getSlashCommands(sessionId)
        if (cmds && cmds.length > 0) {
          messages.push({
            type: 'system_notification',
            subtype: 'slash_commands',
            data: cmds,
          })
        }
        return messages
      }
      if (subtype === 'memory_saved') {
        return [{
          type: 'system_notification',
          subtype: 'memory_saved',
          message: cliMsg.message,
          data: {
            writtenPaths: Array.isArray(cliMsg.writtenPaths) ? cliMsg.writtenPaths : [],
            teamCount: typeof cliMsg.teamCount === 'number' ? cliMsg.teamCount : undefined,
            verb: typeof cliMsg.verb === 'string' ? cliMsg.verb : undefined,
          },
        }]
      }
      if (subtype === 'status') {
        if (cliMsg.status === 'compacting') {
          return [{
            type: 'status',
            state: 'compacting',
            verb: 'Compacting conversation',
          }]
        }
        // CLI 在权限模式变化时也会 enqueue 一条 status 事件（status:null +
        // permissionMode），用于把恢复后的真实权限（如 ExitPlanMode 退出 plan、
        // Shift+Tab）广播给前端。它带 status:null 但**不是** thinking 信号，
        // 必须在下面的 null→thinking 兜底之前拦截，否则字段会被丢弃，桌面端
        // 选择器就会一直卡在"计划模式"。
        if (isPermissionMode(cliMsg.permissionMode)) {
          return [{ type: 'permission_mode_changed', mode: cliMsg.permissionMode }]
        }
        if (cliMsg.status == null) {
          return [{ type: 'status', state: 'thinking', verb: 'Thinking' }]
        }
        return []
      }
      if (subtype === 'hook_started' || subtype === 'hook_response') {
        // Hook 执行中 — 不转发给前端
        return []
      }
      if (subtype === 'local_command' || subtype === 'local_command_output') {
        const localCommand = extractLocalCommand(cliMsg.content ?? cliMsg.message)
        if (localCommand) {
          streamState.pendingLocalCommand = localCommand
          return []
        }

        const localCommandOutput = extractLocalCommandOutput(
          cliMsg.content ?? cliMsg.message,
          { allowUntagged: subtype === 'local_command_output' },
        )
        if (!localCommandOutput) return []
        const goalEvent = extractGoalEvent(
          localCommandOutput,
          streamState.pendingLocalCommand,
        )
        streamState.pendingLocalCommand = undefined
        if (goalEvent) {
          return [{
            type: 'system_notification',
            subtype: 'goal_event',
            message: goalEvent.message,
            data: goalEvent,
          }]
        }
        return [
          { type: 'content_start', blockType: 'text' },
          { type: 'content_delta', text: localCommandOutput },
        ]
      }
      // Bug #7: 处理 task/team system 消息
      if (subtype === 'task_notification') {
        return [{
          type: 'system_notification',
          subtype: 'task_notification',
          message: cliMsg.message || cliMsg.title,
          data: cliMsg,
        }]
      }
      if (subtype === 'task_started') {
        const notification: ServerMessage = {
          type: 'system_notification',
          subtype: 'task_started',
          message: cliMsg.message || cliMsg.description || 'Task started',
          data: cliMsg,
        }
        // AutoDream is detached maintenance work. Keep it visible in Activity,
        // but do not revive the already-completed foreground turn.
        if (cliMsg.task_type === 'dream') return [notification]
        return [
          notification,
          {
            type: 'status',
            state: 'tool_executing',
            verb: cliMsg.message || cliMsg.description || 'Task started',
          },
        ]
      }
      if (subtype === 'task_progress') {
        return [
          {
            type: 'system_notification',
            subtype: 'task_progress',
            message: cliMsg.message || cliMsg.summary || cliMsg.description || 'Task in progress',
            data: cliMsg,
          },
          {
            type: 'status',
            state: 'tool_executing',
            verb: cliMsg.message || cliMsg.summary || cliMsg.description || 'Task in progress',
          },
        ]
      }
      if (subtype === 'agent_tool_activity') {
        // Tool activity streamed from a background (async) agent. Re-emit as a
        // normal tool_use_complete / tool_result carrying the parent Agent
        // tool_use_id, so the desktop groups it under the agent card exactly
        // like a synchronous subagent (childToolCallsByParent).
        const activity = cliMsg.activity
        const parentToolUseId =
          typeof cliMsg.tool_use_id === 'string' ? cliMsg.tool_use_id : undefined
        if (activity?.kind === 'tool_use') {
          return [{
            type: 'tool_use_complete',
            toolName: activity.tool_name,
            toolUseId: activity.tool_use_id,
            input: activity.input,
            parentToolUseId,
          }]
        }
        if (activity?.kind === 'tool_result') {
          return [{
            type: 'tool_result',
            toolUseId: activity.tool_use_id,
            content: activity.content,
            isError: activity.is_error === true,
            parentToolUseId,
          }]
        }
        return []
      }
      if (subtype === 'session_state_changed') {
        return [{
          type: 'system_notification',
          subtype: 'session_state_changed',
          message: cliMsg.message,
          data: cliMsg,
        }]
      }
      if (subtype === 'compact_boundary') {
        return [{
          type: 'system_notification',
          subtype: 'compact_boundary',
          message: getCompactBoundaryMessage(cliMsg),
          data: cliMsg.compact_metadata ?? cliMsg,
        }]
      }
      // 其他 system 消息
      return []
    }

    default:
      // 未知类型 — 调试输出但不转发
      console.log(`[WS] Unknown CLI message type: ${cliMsg.type}`, JSON.stringify(cliMsg).substring(0, 200))
      return []
  }
}

// ── 表访问原语（外部不得直接触碰上面两张表；T0 口径）───────────────────────

export function deleteSessionSlashCommands(sessionId: string): void {
  sessionSlashCommands.delete(sessionId)
}

export function isSessionStopRequested(sessionId: string): boolean {
  return sessionStopRequested.has(sessionId)
}

export function requestSessionStop(sessionId: string): void {
  sessionStopRequested.add(sessionId)
}

export function clearSessionStopRequested(sessionId: string): void {
  sessionStopRequested.delete(sessionId)
}

export function resetSessionStopRequestedForTests(): void {
  sessionStopRequested.clear()
}
