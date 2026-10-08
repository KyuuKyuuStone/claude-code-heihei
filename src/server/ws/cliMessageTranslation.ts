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

import type { PermissionMode, TokenUsage } from './events.js'
import { readObject } from './handlerPures.js'
import { sendToSession } from './sessionTransport.js'


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

export function translateCliUsage(usage: unknown): TokenUsage {
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

export function getStreamState(sessionId: string): SessionStreamState {
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

export function resetCurrentStreamAttempt(state: SessionStreamState): void {
  state.hasReceivedStreamEvents = false
  state.activeBlockTypes.clear()
  state.activeToolBlocks.clear()
  state.pendingToolBlocks.clear()
}

export function cliParentToolUseId(cliMsg: any): string | undefined {
  return typeof cliMsg.parent_tool_use_id === 'string' && cliMsg.parent_tool_use_id.length > 0
    ? cliMsg.parent_tool_use_id
    : undefined
}

export function rememberToolParentUseId(
  streamState: SessionStreamState,
  toolUseId: string | undefined,
  parentToolUseId: string | undefined,
): void {
  if (!toolUseId || !parentToolUseId) return
  streamState.toolParentUseIds.set(toolUseId, parentToolUseId)
}

export function consumeToolParentUseId(
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



export function normalizeAskUserQuestionToolResult(content: unknown, toolUseResult: unknown): unknown {
  const result = readObject(toolUseResult)
  const answers = readObject(result?.answers)
  if (!result || !answers || !Array.isArray(result.questions)) return content
  return {
    questions: result.questions,
    answers,
  }
}

export function isDuplicateOfLastApiError(
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
