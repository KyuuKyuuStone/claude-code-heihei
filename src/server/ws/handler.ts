/**
 * WebSocket connection handler
 *
 * 管理 WebSocket 连接生命周期，处理消息路由。
 * 用户消息通过 CLI 子进程（stream-json 模式）处理，
 * CLI stdout 消息被转换为 ServerMessage 并转发到 WebSocket。
 */

import type { ServerWebSocket } from 'bun'
import type {
  ClientMessage,
  PermissionMode,
  ServerMessage,
  TokenUsage,
} from './events.js'
import * as os from 'node:os'
import {
  ConversationStartupError,
  cliExitSeverity,
  conversationService,
} from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import {
  beginTurn,
  clearSession,
  getSessionSnapshot,
  hasActiveTurn,
  isTurnMessageSent,
  markTurnSent,
  resetRegistryForTests,
  settleTurnIfOwner,
  clearSessionStartedByDelivery,
  type TurnHandle,
} from '../services/sessionRegistry.js'
import { onCollabPush, type CollabPushSignal } from '../../collaboration/collabPushSignals.js'
import { servantService } from '../services/servantService.js'
import { onSessionEvent, type SessionEvent } from '../services/sessionEvents.js'
import {
  sessionService,
} from '../services/sessionService.js'
import { SettingsService } from '../services/settingsService.js'
import { ProviderService } from '../services/providerService.js'
import { isOpenAIOfficialProviderId } from '../services/openaiOfficialProvider.js'
import { isGrokOfficialProviderId } from '../services/grokOfficialProvider.js'
import { getOpenAICodexModelCatalog } from '../../services/openaiAuth/modelCatalog.js'
import {
  OPENAI_DEFAULT_MAIN_MODEL,
  getOpenAIModelCatalogEntry,
  isOpenAIReasoningEffort,
} from '../../services/openaiAuth/models.js'
import { GROK_DEFAULT_MAIN_MODEL } from '../../services/grokAuth/models.js'
import { diagnosticsService } from '../services/diagnosticsService.js'
import { COLLAB_SERVANT_PERMISSION_MODE_LOCKED_MESSAGE } from '../../collaboration/collabToolContract.js'
import {
  buildConversationTitleInput,
  deriveTitle,
  generateTitle,
  resolveTitleLanguagePreference,
  saveAiTitle,
  type TitleConversationTurn,
} from '../services/titleService.js'
import { shouldCreateWorktreeForSessionLaunch } from '../services/repositoryLaunchService.js'
import { getDisconnectGraceMs } from './disconnectGraceConfig.js'
// v1.7 结构拆分（ws/handler.ts 第①批 · 纯移动 · 绿灯区）：cli 重试/降级消息解析族。
// 仅导入有组外调用点的 2 项（原就以裸名调用）；另 5 项组外为 0，未导入。
import {
  toApiRetryServerMessage,
  toStreamingFallbackServerMessage,
} from './cliRetryMessages.js'
// v1.7 结构拆分（ws/handler.ts 第②批 · 纯移动 · 绿灯区）：local-command 解析族。
// 10 名有组外调用点（原就以裸名调用），同名 import 承接，调用点文本零改动；
// 另 5 名（isMatchingCurrentTurnLocalCommand / isLocalCommandOutputMessage /
// extractTaggedContent / looksLikeGoalCommandOutput / hasToolResultBlock）组外为 0，未导入。
import {
  createCurrentTurnLocalCommandForwarder,
  extractGoalEvent,
  extractLocalCommand,
  extractLocalCommandOutput,
  extractReplayUserText,
  getCompactBoundaryMessage,
  getDesktopSlashCommand,
  getTitleInputForUserMessage,
  isCompactLocalCommandOutput,
  isCompactSummaryMessageContent,
} from './localCommandParsing.js'
// createCurrentTurnLocalCommandForwarder 是公开 API（src/server/__tests__/ws-memory-events.test.ts
// 直接 import），搬走后在此 re-export，保证门面导出面逐项不变、消费方零改动。
export { createCurrentTurnLocalCommandForwarder }
// v1.7 结构拆分（ws/handler.ts (C) 类批① · 架构师补充裁决十一）：延迟运行时状态族。
// RuntimeOverride 类型随两个 Map 一并迁往 ./deferredRuntimeState.ts，此处 import 回来
// （本模块 runtimeOverrides :157 仍用它；type-only，无运行期环）。
import type { RuntimeOverride } from './deferredRuntimeState.js'
import {
  deleteDeferredPermissionMode,
  deleteDeferredRuntimeRestart,
  getDeferredPermissionMode,
  getDeferredRuntimeRestart,
  setDeferredPermissionMode,
  setDeferredRuntimeRestart,
} from './deferredRuntimeState.js'

// v1.7.1 结构拆分（Wave1 批B · 架构师补充裁决十七）：handler.ts 的零依赖纯函数簇
// 迁往 ./handlerPures.ts（同目录、逐字搬移、仅新增 export）。此处一名一行接回。
import {
  beginTurnReplacing,
  classifyRuntimeErrorCode,
  extractAssistantMessageTextForTitle,
  extractAssistantStreamTextForTitle,
  extractAssistantText,
  ensureSessionRegistered,
  getDefaultOpenAIReasoningEffort,
  getGrokReasoningEfforts,
  persistSessionPermissionMode,
  persistSessionRuntimeConfig,
  readObject,
  resolveSessionWorkDir,
} from './handlerPures.js'

// v1.7.4 结构拆分（B1-1 · 会话活动域批①）：三张活动状态表与写入原语迁往
// ./sessionActivity.ts（同目录、定义点唯一）。类型与三个导出名仍由本模块提供，
// 故此处按名接回，消费方 import 面不变。
import {
  beginSessionChatActivity,
  clearActiveBackgroundTasks,
  clearSessionChatActivity,
  failSessionChatActivity,
  hasActiveBackgroundTasks,
  markLegacySessionChatQueued,
  markSessionChatInterrupted,
  resetActiveBackgroundTasksForTests,
  resetSessionChatActivityForTests,
  settleSessionChatActivity,
  trackCliBackgroundTaskLifecycle,
} from './sessionActivity.js'
import {
  clearSessionStopRequested,
  cleanupStreamState,
  cliParentToolUseId,
  consumeToolParentUseId,
  deleteSessionSlashCommands,
  getSlashCommands,
  getStreamState,
  isDuplicateOfLastApiError,
  isPermissionMode,
  isSessionStopRequested,
  normalizeAskUserQuestionToolResult,
  rememberToolParentUseId,
  requestSessionStop,
  resetCurrentStreamAttempt,
  resetSessionStopRequestedForTests,
  translateCliUsage,
  updateSessionSlashCommands,
} from './cliMessageTranslation.js'
// 原属本文件导出面的 3 个名字：按名再导出（本地绑定即上面的 import）。
export { getSlashCommands, updateSessionSlashCommands }
export type { SessionSlashCommand } from './cliMessageTranslation.js'
// 类型与组合函数的定义点陆续迁往该模块，但本模块导出面须逐项不变 ⇒ 原样再导出。
export type { SessionChatActivityState } from './sessionActivity.js'
export { getSessionChatActivityState } from './sessionActivity.js'

// v1.7.4 结构拆分（B1-3 · 任务通知持久化组外移）：`taskNotificationPersistence` 表与
// `persistCliTaskNotification` 迁往 ./taskNotificationPersistence.ts（语义属转录持久化，
// 非会话活动，故不并入 sessionActivity）。表转为模块私有，handler 只经
// 写入/清理三个原语使用；`__persistCliTaskNotificationForTests` 原样再导出以维持导出面。
import {
  forgetSessionTaskNotifications,
  persistCliTaskNotification,
  resetTaskNotificationPersistenceForTests,
} from './taskNotificationPersistence.js'
export { __persistCliTaskNotificationForTests } from './taskNotificationPersistence.js'

// v1.7.4 结构专项（T0 · WebSocket 传输枢纽族上提）：三张连接表 + 发送原语迁往
// ./sessionTransport.ts（叶子模块，绝不反向 import 本文件）。本文件改为经原语
// 读写；原属本文件导出面的 4 个名字按名再导出以维持导出面逐项不变。
import {
  addActiveClient,
  broadcastGlobalEvent,
  ensureTurnChangeBroadcastSubscribed,
  forgetClientOutputCallback,
  GLOBAL_EVENTS_SESSION_ID,
  getActiveSessionIds,
  getSessionClients,
  hasActiveClients,
  registerClientOutputCallback,
  removeActiveClient,
  removeClientOutputCallback,
  resetSessionTransportForTests,
  sendError,
  sendMessage,
  sendToSession,
  subscribeGlobalEvents,
  takeSessionClients,
  unsubscribeGlobalEvents,
  type WebSocketData,
} from './sessionTransport.js'
// 这 5 个名字原属本文件导出面 ⇒ 按名再导出（本地绑定即上面的 import）。
export {
  broadcastGlobalEvent,
  ensureTurnChangeBroadcastSubscribed,
  GLOBAL_EVENTS_SESSION_ID,
  getActiveSessionIds,
  sendToSession,
}
export type { WebSocketData }

const settingsService = new SettingsService()
const providerService = new ProviderService()

function buildSdkWebSocketUrl(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): string {
  const url = new URL(`ws://${ws.data.serverHost}:${ws.data.serverPort}/sdk/${sessionId}`)
  url.searchParams.set('token', crypto.randomUUID())
  return url.toString()
}

/**
 * Timers for delayed session cleanup after client disconnect.
 * If a client reconnects before the timer fires, the timer is cancelled.
 */
const PENDING_PERMISSION_DISCONNECT_CLEANUP_MS = 30 * 60_000
const sessionCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * Per-session removers for the active-work watcher (issue #764). When the last
 * client disconnects while a turn or background task is still running, we let
 * that work finish instead of killing the CLI, then start the idle grace timer.
 * The remover is also cleared on reconnect/cleanup.
 */
const sessionDisconnectWatchers = new Map<string, () => void>()

/**
 * Track user message count and title state per session for auto-title generation.
 */
const sessionTitleState = new Map<string, {
  userMessageCount: number
  hasCustomTitle: boolean
  firstUserMessage: string
  completedTurns: TitleConversationTurn[]
  titleDraftTurn?: TitleConversationTurn & { count: number }
  startedGenerationKeys: Set<string>
  generationSeq: number
}>()

const runtimeOverrides = new Map<string, RuntimeOverride>()
// ── (C) 类批①：deferredRuntimeRestarts / deferredPermissionModes 两个 Map 已搬到
// ./deferredRuntimeState.ts（定义点唯一），此处经同名 import 使用其单操作原语。
//
// ── (B1-1/B1-2) 会话活动三表 + 写入原语 + 后台任务子域（活跃集 activeBackgroundTaskIds
// 与生命周期解析）+ 组合函数 getSessionChatActivityState 已全部上提到
// ./sessionActivity.ts。markSessionChatQueued / clearLegacySessionChatState 两个导出
// 留在本文件，getSessionChatActivityState 经同名再导出（见上方 import 段），消费方
// import 面逐项不变。

/** Compatibility fallback for the legacy REST enqueue endpoint. */
export function markSessionChatQueued(sessionId: string): void {
  markLegacySessionChatQueued(sessionId)
}

/** Compatibility reset for the legacy REST stop endpoint. */
export function clearLegacySessionChatState(sessionId: string): void {
  clearSessionChatActivity(sessionId)
}

const runtimeTransitionPromises = new Map<string, Promise<void>>()
const sessionStartupPromises = new Map<string, Promise<void>>()
const runtimeOverrideVersions = new Map<string, number>()
const sessionStartupRuntimeVersions = new Map<string, number>()
const lastResolvedStartupWorkDirs = new Map<string, string>()
const prewarmPendingSessions = new Set<string>()
const prewarmedSessions = new Set<string>()
const prewarmIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()
const DEFAULT_PREWARM_IDLE_TIMEOUT_MS = 5 * 60_000
const VALID_CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max'])

async function sendRepositoryStartupStatus(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  reason: 'user_message' | 'prewarm_session',
): Promise<void> {
  if (reason !== 'user_message') return
  // P1（裁决十九第 5 条）：用户来源输入 = 用户接管 → 清「投递拉起」标记，
  // 回到主管会话豁免口径（用户在场即交互会话，重推/告警只会打扰现场）。
  clearSessionStartedByDelivery(sessionId)

  const launchInfo = await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
  const repository = launchInfo?.repository
  if (!repository) return

  if (shouldCreateWorktreeForSessionLaunch(launchInfo)) {
    sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Creating worktree' })
  }
}

// ── 三张连接表与发送原语已搬到 ./sessionTransport.ts（T0 批），见文件顶部 import ──

export const handleWebSocket = {
  open(ws: ServerWebSocket<WebSocketData>) {
    const { sessionId, channel, sdkToken } = ws.data

    if (channel === 'sdk') {
      if (!conversationService.authorizeSdkConnection(sessionId, sdkToken)) {
        console.warn(`[WS] Rejected SDK connection for session: ${sessionId}`)
        ws.close(1008, 'Invalid SDK token')
        return
      }

      conversationService.attachSdkConnection(sessionId, ws)
      console.log(`[WS] SDK connected for session: ${sessionId}`)
      return
    }

    console.log(`[WS] Client connected for session: ${sessionId}`)

    // 全局事件通道：不绑定会话，仅登记进独立集合后推送跨会话事件。
    if (sessionId === GLOBAL_EVENTS_SESSION_ID) {
      subscribeGlobalEvents(ws)
      sendMessage(ws, { type: 'connected', sessionId })
      return
    }

    // Cancel pending cleanup timer if client reconnects
    const pendingTimer = sessionCleanupTimers.get(sessionId)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      sessionCleanupTimers.delete(sessionId)
    }
    // Cancel any "let the running turn finish, then clean up" watcher too —
    // the session is observed again (issue #764).
    cancelSessionDisconnectWatcher(sessionId)

    addActiveClient(sessionId, ws)
    if (prewarmPendingSessions.has(sessionId) || prewarmedSessions.has(sessionId)) {
      bindPrewarmMetadataCapture(sessionId)
    } else {
      bindClientSessionOutput(sessionId, ws)
    }

    const msg: ServerMessage = { type: 'connected', sessionId }
    sendMessage(ws, msg)
    const toolRequestIds = replayPendingPermissionRequests(ws, sessionId)
    const computerUseRequestIds = replayPendingComputerUsePermissionRequests(ws, sessionId)
    sendMessage(ws, {
      type: 'permission_requests_snapshot',
      toolRequestIds,
      computerUseRequestIds,
      turnActive:
        hasPendingOrActiveUserTurn(sessionId) && !isSessionStopRequested(sessionId),
    })
  },

  message(ws: ServerWebSocket<WebSocketData>, rawMessage: string | Buffer) {
    if (ws.data.channel === 'sdk') {
      const payload = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
      conversationService.handleSdkPayload(ws.data.sessionId, payload)
      return
    }

    // 全局事件通道是纯下行：只应答心跳，忽略其余消息。
    if (ws.data.sessionId === GLOBAL_EVENTS_SESSION_ID) {
      try {
        const message = JSON.parse(
          typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
        ) as ClientMessage
        if (message.type === 'ping') sendMessage(ws, { type: 'pong' })
      } catch {
        // 忽略畸形消息
      }
      return
    }

    try {
      const message = JSON.parse(
        typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
      ) as ClientMessage

      switch (message.type) {
        case 'user_message': {
          const turnRef: { current: TurnHandle | null } = { current: null }
          handleUserMessage(ws, message, turnRef).catch((err) => {
            const sessionId = ws.data.sessionId
            void diagnosticsService.recordEvent({
              type: 'ws_user_message_failed',
              severity: 'error',
              sessionId,
              summary: err instanceof Error ? err.message : String(err),
              details: err,
            })
            console.error(`[WS] Unhandled error in handleUserMessage:`, err)
            // A queued/newer turn may have replaced this handler while an
            // earlier await was pending. Only the handler that still owns the
            // active-turn token may terminate the desktop state.
            const handle = turnRef.current
            if (
              handle !== null &&
              getSessionSnapshot(sessionId)?.turnOwner === handle.identity
            ) {
              failSessionChatActivity(sessionId)
              settleTurnIfOwner(sessionId, handle)
              const titleState = sessionTitleState.get(sessionId)
              if (titleState) titleState.titleDraftTurn = undefined
              sendMessage(ws, {
                type: 'error',
                message: 'The request could not be started. Please retry.',
                code: 'USER_TURN_FAILED',
                retryable: true,
              })
              sendMessage(ws, { type: 'status', state: 'idle' })
            }
          })
          break
        }

        case 'permission_response':
          handlePermissionResponse(ws, message)
          break

        case 'computer_use_permission_response':
          handleComputerUsePermissionResponse(ws, message)
          break

        case 'set_permission_mode':
          void handleSetPermissionMode(ws, message)
          break

        case 'set_runtime_config':
          void handleSetRuntimeConfig(ws, message)
          break

        case 'prewarm_session':
          void handlePrewarmSession(ws)
          break

        case 'sync_state':
          sendMessage(ws, {
            type: 'session_state',
            turnState: hasPendingOrActiveUserTurn(ws.data.sessionId)
              ? 'running'
              : 'idle',
          })
          break

        case 'stop_generation':
          handleStopGeneration(ws)
          break

        case 'stop_background_task':
          void handleStopBackgroundTask(ws, message)
          break

        case 'ping':
          sendMessage(ws, { type: 'pong' })
          break

        case 'keep_alive':
          // 桥接侧的静默心跳帧（replBridge 定期推送，供代理/中间层保活）。
          // v1.4.0 阶段2 · 9：登记为已知类型静默忽略（不回包、不告警）——
          // 此前落 default 分支被当未知消息回 UNKNOWN_TYPE error。
          break

        default:
          sendError(ws, `Unknown message type: ${(message as any).type}`, 'UNKNOWN_TYPE')
      }
    } catch (error) {
      sendError(ws, `Invalid message format: ${error}`, 'PARSE_ERROR')
    }
  },

  close(ws: ServerWebSocket<WebSocketData>, code: number, reason: string) {
    const { sessionId, channel } = ws.data

    if (channel === 'sdk') {
      console.log(`[WS] SDK disconnected from session: ${sessionId} (${code}: ${reason})`)
      conversationService.detachSdkConnection(sessionId, ws)
      return
    }

    if (sessionId === GLOBAL_EVENTS_SESSION_ID) {
      unsubscribeGlobalEvents(ws)
      console.log(`[WS] Global events client disconnected (${code}: ${reason})`)
      return
    }


    console.log(`[WS] Client disconnected from session: ${sessionId} (${code}: ${reason})`)
    if (!removeActiveClient(sessionId, ws)) {
      console.log(`[WS] Ignoring stale client disconnect for session: ${sessionId}`)
      return
    }
    removeClientOutputCallback(ws)

    if (hasActiveClients(sessionId)) {
      return
    }

    // No clients left. A foreground turn or background task that is still
    // running must finish (issue #764) — never kill it just because a renderer
    // closed. Defer cleanup until all active work completes, then apply the
    // idle grace period. Sessions that are already idle go straight to the timer.
    if (hasPendingOrActiveUserTurn(sessionId) || hasActiveBackgroundTasks(sessionId)) {
      // A turn blocked on permission cannot finish without user input. Keep the
      // completion watcher for early cleanup, but also enforce the existing
      // pending-permission maximum so an abandoned prompt cannot pin the CLI.
      if (conversationService.getPendingPermissionRequests(sessionId).length > 0) {
        scheduleDisconnectCleanup(sessionId)
      }
      console.log(`[WS] Session ${sessionId} still running after disconnect; keeping CLI alive until active work finishes`)
      watchTurnCompletionForCleanup(sessionId)
      return
    }

    scheduleDisconnectCleanup(sessionId)
    watchTurnCompletionForCleanup(sessionId)
  },

  drain(ws: ServerWebSocket<WebSocketData>) {
    // Backpressure handling - called when the socket is ready to receive more data
  },
}

// ============================================================================
// Message handlers
// ============================================================================

async function handleUserMessage(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'user_message' }>,
  turnRef: { current: TurnHandle | null },
) {
  const { sessionId } = ws.data

  // Clear any stale stop flag from a previous turn
  clearSessionStopRequested(sessionId)
  beginSessionChatActivity(sessionId)
  clearPrewarmState(sessionId)

  const desktopSlashCommand = getDesktopSlashCommand(message.content)
  if (desktopSlashCommand?.commandName === 'clear' && desktopSlashCommand.args.trim()) {
    sendMessage(ws, {
      type: 'error',
      message: 'The /clear command does not accept arguments.',
      code: 'INVALID_SLASH_COMMAND_ARGS',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
    return
  }

  if (desktopSlashCommand?.commandName === 'clear') {
    await handleDesktopClearCommand(ws)
    return
  }

  // Send thinking status
  sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Thinking' })

  ensureSessionRegistered(sessionId)
  turnRef.current = beginTurnReplacing(sessionId, true)

  const initialRuntimeTransition = await waitForRuntimeTransitionBeforeUserTurn(ws, sessionId)
  if (!initialRuntimeTransition.ok) {
    if (turnRef.current) settleTurnIfOwner(sessionId, turnRef.current)
    return
  }
  if (initialRuntimeTransition.waited) {
    sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Thinking' })
  }

  // Track and emit the first placeholder title before CLI startup/streaming.
  let titleState = sessionTitleState.get(sessionId)
  if (!titleState) {
    titleState = {
      userMessageCount: 0,
      hasCustomTitle: !!(await sessionService.getCustomTitle(sessionId)),
      firstUserMessage: '',
      completedTurns: [],
      startedGenerationKeys: new Set<string>(),
      generationSeq: 0,
    }
    sessionTitleState.set(sessionId, titleState)
  }
  const titleInput = getTitleInputForUserMessage(message.content, desktopSlashCommand)
  let titleTurnNumber: number | null = null
  if (titleInput) {
    titleState.userMessageCount++
    titleTurnNumber = titleState.userMessageCount
    titleState.titleDraftTurn = {
      count: titleTurnNumber,
      userText: titleInput,
      assistantText: '',
    }
    if (titleState.userMessageCount === 1) {
      titleState.firstUserMessage = titleInput
    }
    triggerTitleGeneration(ws, sessionId, 'user-message')
  }

  // 启动 CLI 子进程（如果还没有）
  try {
    await ensureCliSessionStarted(ws, sessionId, 'user_message')
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const code =
      err instanceof ConversationStartupError ? err.code : 'CLI_START_FAILED'
    console.error(`[WS] CLI start failed for ${sessionId}: ${errMsg}`)
    sendMessage(ws, {
      type: 'error',
      message: await buildSessionStartupDiagnosticMessage(sessionId, errMsg),
      code,
      retryable:
        err instanceof ConversationStartupError ? err.retryable : false,
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
    failSessionChatActivity(sessionId)
    if (turnRef.current) settleTurnIfOwner(sessionId, turnRef.current)
    return
  }

  const startupRuntimeTransition = await waitForRuntimeTransitionBeforeUserTurn(ws, sessionId)
  if (startupRuntimeTransition.ok) {
    if (startupRuntimeTransition.waited) {
      sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Thinking' })
    }
  } else {
    if (turnRef.current) settleTurnIfOwner(sessionId, turnRef.current)
    return
  }

  // Register the callback before sending the turn so startup errors are not lost.
  // Keep output muted until the current user turn is enqueued to avoid forwarding
  // any pre-turn SDK chatter as fresh chat history.
  let userMessageSent = false
  const shouldForwardCurrentTurnLocalCommand =
    createCurrentTurnLocalCommandForwarder(desktopSlashCommand)
  const removeTitleOutputCallback = titleTurnNumber === null
    ? null
    : bindTitleSessionOutput(ws, sessionId, () => userMessageSent)

  bindAllClientSessionOutputs(sessionId, {
    shouldForward: (cliMsg) => {
      if (userMessageSent || (cliMsg.type === 'result' && cliMsg.is_error)) {
        return true
      }
      return shouldForwardCurrentTurnLocalCommand(cliMsg)
    },
  })
  const removeActiveTurnOutputCallback = bindActiveUserTurnCompletion(
    ws,
    sessionId,
    () => userMessageSent,
    turnRef,
  )

  // The renderer may have left while the CLI was still starting, before this
  // turn could flip messageSent=true. The disconnect handler cannot attach an
  // effective output watcher until the ConversationService session exists, so
  // refresh it here, immediately before sending the turn, to observe a
  // permission request that arrives after the disconnect.
  refreshDisconnectedTurnCleanupWatcher(sessionId)

  const sent = await conversationService.sendMessage(
    sessionId,
    message.content,
    message.attachments
  )
  if (!sent) {
    removeActiveTurnOutputCallback()
    if (turnRef.current) settleTurnIfOwner(sessionId, turnRef.current)
    removeTitleOutputCallback?.()
    discardActiveTitleTurn(sessionId, titleTurnNumber)
    sendMessage(ws, {
      type: 'error',
      message: 'CLI process is not running. The session may have ended or the process crashed.',
      code: 'CLI_NOT_RUNNING',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
    failSessionChatActivity(sessionId)
    return
  }

  userMessageSent = true
  if (turnRef.current) markTurnSent(sessionId, turnRef.current)
}

/**
 * v1.3.0 阶段4 · 7b：注入回合建立（beginInjectedUserTurn）与清理登记
 * （injectedTurnCleanups / resetInjectedTurnsForTests）已迁至
 * services/sessionMessenger.ts——sessionMessenger 不再动态 import 本模块，
 * services → ws 的反向边消失。本模块只保留传输层补绑：订阅
 * phase_changed(→running) 事件自触发 rebindClientOutputForSession。
 */
function rebindOnRunningHandler(event: SessionEvent): void {
  if (event.type !== 'phase_changed' || event.to !== 'running') return
  rebindClientOutputForSession(event.sessionId)
}

/**
 * R4b 收口（v1.3.1）：本订阅此前是模块顶层一次性注册——先跑的测试文件调
 * resetSessionEventsForTests() 清空总线后静默失效（与崩溃观察者/补偿订阅同
 * 族）。ensure 模式：handler 为模块级稳定引用，onSessionEvent 按 handler 引用
 * 去重 → 重复调用幂等，被清后重调即恢复。消费方（websocket-handler.test.ts）
 * 每次调用并跑活性自检。
 */
export function ensureRebindOnRunningSubscribed(): void {
  onSessionEvent(rebindOnRunningHandler, { types: ['phase_changed'] })
}

ensureRebindOnRunningSubscribed()

function bindActiveUserTurnCompletion(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  isTurnMessageSentNow: () => boolean,
  turnRef: { current: TurnHandle | null },
): () => void {
  const callback = (cliMsg: any) => {
    if (
      cliMsg?.type !== 'result' ||
      (!isTurnMessageSentNow() && !cliMsg.is_error)
    ) return

    settleSessionChatActivity(sessionId, cliMsg)
    conversationService.removeOutputCallback(sessionId, callback)
    if (turnRef.current) settleTurnIfOwner(sessionId, turnRef.current)
    // Structurally disarm any prewarm idle timer that a concurrent
    // prewarm_session/user_message flush may have armed on this session: once a
    // turn completes the session is firmly user-owned, so no prewarm reaper
    // should survive — regardless of the order in which the two raced.
    clearPrewarmState(sessionId)
    applyDeferredPermissionModeAfterActiveTurn(ws, sessionId)
    applyDeferredRuntimeRestartAfterActiveTurn(ws, sessionId)
  }

  conversationService.onOutput(sessionId, callback)
  return () => conversationService.removeOutputCallback(sessionId, callback)
}

function shouldDeferRuntimeRestartForActiveTurn(sessionId: string): boolean {
  return isTurnMessageSent(sessionId)
}

function applyDeferredPermissionModeAfterActiveTurn(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): void {
  const deferredMode = getDeferredPermissionMode(sessionId)
  if (!deferredMode) return

  deleteDeferredPermissionMode(sessionId)
  void enqueueRuntimeTransition(sessionId, async () => {
    if (!conversationService.hasSession(sessionId)) return
    await applyPermissionModeToActiveSession(ws, sessionId, deferredMode)
  })
}

function applyDeferredRuntimeRestartAfterActiveTurn(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): void {
  const deferred = getDeferredRuntimeRestart(sessionId)
  if (!deferred) return

  deleteDeferredRuntimeRestart(sessionId)
  void enqueueRuntimeTransition(sessionId, async () => {
    const currentOverride = runtimeOverrides.get(sessionId)
    if (
      !currentOverride ||
      currentOverride.providerId !== deferred.providerId ||
      currentOverride.modelId !== deferred.modelId ||
      currentOverride.effort !== deferred.effort ||
      !conversationService.hasSession(sessionId)
    ) {
      return
    }
    await restartSessionWithRuntimeConfig(ws, sessionId)
  })
}

async function handleDesktopClearCommand(
  ws: ServerWebSocket<WebSocketData>,
) {
  const { sessionId } = ws.data

  const workDir = conversationService.getSessionWorkDir(sessionId)
  const permissionMode = conversationService.hasSession(sessionId)
    ? conversationService.getSessionPermissionMode(sessionId)
    : undefined
  conversationService.stopSession(sessionId)
  conversationService.clearOutputCallbacks(sessionId)
  deleteSessionSlashCommands(sessionId)
  sessionTitleState.delete(sessionId)
  cleanupStreamState(sessionId)

  try {
    await sessionService.clearSessionTranscript(sessionId, workDir || undefined, permissionMode)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    sendMessage(ws, {
      type: 'error',
      message: errMsg,
      code: 'SESSION_CLEAR_FAILED',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
    return
  }

  sendMessage(ws, {
    type: 'system_notification',
    subtype: 'session_cleared',
    message: 'Conversation cleared',
  })
  sendMessage(ws, {
    type: 'message_complete',
    usage: { input_tokens: 0, output_tokens: 0 },
  })
}

async function handlePrewarmSession(ws: ServerWebSocket<WebSocketData>) {
  const { sessionId } = ws.data
  if (conversationService.hasSession(sessionId) || sessionStartupPromises.has(sessionId)) {
    return
  }

  const launchInfo = await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)

  // Re-check after async gap: a user_message may have arrived during the await
  // and already started (or is starting) the CLI session. If so, skip prewarm
  // entirely — the user turn owns this session now, and calling markPrewarmed()
  // would arm an idle timer that later kills the active conversation.
  if (conversationService.hasSession(sessionId) || sessionStartupPromises.has(sessionId)) {
    return
  }

  if (launchInfo?.repository) {
    console.log(`[WS] Skipping prewarm for pending repository launch session ${sessionId}`)
    return
  }

  prewarmPendingSessions.add(sessionId)
  void ensureCliSessionStarted(ws, sessionId, 'prewarm_session')
    .then(() => {
      const stillPending = prewarmPendingSessions.delete(sessionId)
      if (!stillPending) return
      // Safety: if a user message arrived and claimed this session while we
      // were waiting for startup, do NOT arm the prewarm idle timer — the
      // session is now owned by the user conversation, not prewarm. Use the
      // turn-registered check (not messageSent) so the CLI-startup window is
      // covered: in the concurrent race the turn is registered but messageSent
      // is still false when this .then runs, which made the old guard dead code.
      if (hasPendingOrActiveUserTurn(sessionId)) {
        return
      }
      bindPrewarmMetadataCapture(sessionId)
      markPrewarmed(sessionId)
    })
    .catch((err) => {
      prewarmPendingSessions.delete(sessionId)
      const message = `[WS] Prewarm failed for ${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`
      // SIGTERM/SIGKILL 级退出码（如预热空闲回收器 stopSession）是设计内的
      // 正常回收：console.warn 会被诊断采集镜像成 warn 并写入 runtime-errors，
      // 会把回收伪装成"启动失败"误导排障，因此降级为 console.log。
      const isBenignExit =
        err instanceof ConversationStartupError &&
        err.exitCode !== undefined &&
        cliExitSeverity(err.exitCode) === 'info'
      if (isBenignExit) {
        console.log(message)
      } else {
        console.warn(message)
      }
    })
}

function handlePermissionResponse(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'permission_response' }>
) {
  const { sessionId } = ws.data
  const resolved = conversationService.respondToPermission(
    sessionId,
    message.requestId,
    message.allowed,
    message.rule,
    message.updatedInput,
    message.denyMessage,
    message.permissionUpdates,
  )
  if (resolved) {
    sendToSession(sessionId, {
      type: 'permission_resolved',
      requestId: message.requestId,
      permissionType: 'tool',
      allowed: message.allowed,
    })
  }
  console.log(`[WS] Permission response for ${message.requestId}: ${message.allowed}`)
}

function handleComputerUsePermissionResponse(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'computer_use_permission_response' }>
) {
  const { sessionId } = ws.data
  const ok = computerUseApprovalService.resolveApproval(
    message.requestId,
    message.response,
  )
  if (!ok) {
    console.warn(
      `[WS] Ignored Computer Use permission response for unknown request ${message.requestId} from ${sessionId}`
    )
    return
  }
  sendToSession(sessionId, {
    type: 'permission_resolved',
    requestId: message.requestId,
    permissionType: 'computer_use',
    allowed: message.response.userConsented !== false,
  })
}

async function handleSetPermissionMode(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'set_permission_mode' }>
): Promise<void> {
  const { sessionId } = ws.data
  if (!isPermissionMode(message.mode)) {
    sendMessage(ws, {
      type: 'error',
      message: 'Permission mode is invalid.',
      code: 'PERMISSION_MODE_INVALID',
    })
    return
  }
  // v1.6.1（契约 §3.3 第 2 条）：员工会话固定为免审批——界面/元数据切到非 bypass
  // 会覆盖掉员工的 bypass，之后每个工具调用都要问人，而无人可点。直接拒绝，并
  // 引导用户改用约束档位（结构性收权，不靠逐次审批）。
  if (
    message.mode !== 'bypassPermissions' &&
    (await conversationService.isServantSession(sessionId))
  ) {
    sendMessage(ws, {
      type: 'error',
      message: COLLAB_SERVANT_PERMISSION_MODE_LOCKED_MESSAGE,
      code: 'SERVANT_PERMISSION_MODE_LOCKED',
    })
    void diagnosticsService.recordEvent({
      type: 'collab_servant_permission_mode_change_rejected',
      severity: 'warning',
      sessionId,
      summary: `员工会话的权限模式切换请求（${message.mode}）已拒绝`,
      details: { sessionId, requestedMode: message.mode, at: Date.now() },
    })
    return
  }
  const pendingStartup = sessionStartupPromises.get(sessionId)

  if (pendingStartup) {
    await enqueueRuntimeTransition(sessionId, async () => {
      await pendingStartup.catch(() => undefined)
      if (!conversationService.hasSession(sessionId)) return
      await applyPermissionModeToActiveSession(ws, sessionId, message.mode)
    })
    return
  }

  if (!conversationService.hasSession(sessionId)) {
    if (await persistSessionPermissionMode(sessionId, message.mode)) {
      sendMessage(ws, { type: 'permission_mode_changed', mode: message.mode })
    }
    return
  }

  await enqueueRuntimeTransition(sessionId, () =>
    applyPermissionModeToActiveSession(ws, sessionId, message.mode),
  )
}

const BYPASS_CAPABILITY_UNAVAILABLE =
  'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions'

/**
 * Sessions launched by this desktop build can switch into bypass in-process.
 * A session that was already running before an app update may lack that launch
 * capability, so retain the old restart path only for that exact CLI error.
 */
export function shouldFallbackToPermissionRestart(
  mode: PermissionMode,
  error: unknown,
): boolean {
  if (mode !== 'bypassPermissions') return false
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(BYPASS_CAPABILITY_UNAVAILABLE)
}

async function applyPermissionModeToActiveSession(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  mode: PermissionMode,
): Promise<void> {
  const currentMode = conversationService.getSessionPermissionMode(sessionId)
  if (shouldDeferRuntimeRestartForActiveTurn(sessionId)) {
    setDeferredPermissionMode(sessionId, mode)
    return
  }

  if (currentMode === mode) {
    sendToSession(sessionId, { type: 'permission_mode_changed', mode })
    return
  }
  try {
    const ok = await conversationService.setPermissionMode(sessionId, mode)
    if (!ok) {
      console.warn(`[WS] Ignored permission mode update for inactive session ${sessionId}`)
      return
    }
    await commitConfirmedPermissionMode(sessionId, mode)
  } catch (err) {
    if (shouldFallbackToPermissionRestart(mode, err)) {
      await restartSessionWithPermissionMode(ws, sessionId, mode)
      return
    }
    const errMsg = err instanceof Error ? err.message : String(err)
    console.warn(`[WS] Failed to set permission mode for ${sessionId}: ${errMsg}`)
    sendMessage(ws, {
      type: 'error',
      message: `Failed to set permission mode: ${errMsg}`,
      code: 'PERMISSION_MODE_CHANGE_FAILED',
    })
  }
}

async function handleSetRuntimeConfig(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'set_runtime_config' }>
) {
  const { sessionId } = ws.data
  let modelId = typeof message.modelId === 'string' ? message.modelId.trim() : ''
  if (!modelId) {
    sendMessage(ws, {
      type: 'error',
      message: 'Runtime model selection is invalid.',
      code: 'RUNTIME_CONFIG_INVALID',
    })
    return
  }
  if (isGrokOfficialProviderId(message.providerId)) {
    modelId = (await getGrokReasoningEfforts(modelId)).modelId
  }
  const effortLevel =
    typeof message.effortLevel === 'string' ? message.effortLevel.trim() : undefined
  if (
    effortLevel !== undefined &&
    !(await isRuntimeEffortSupported(message.providerId, modelId, effortLevel))
  ) {
    sendMessage(ws, {
      type: 'error',
      message: 'Runtime effort selection is invalid.',
      code: 'RUNTIME_CONFIG_INVALID',
    })
    return
  }

  const nextOverride = {
    providerId: message.providerId ?? null,
    modelId,
    ...(effortLevel ? { effort: effortLevel } : {}),
  }
  const prevOverride = runtimeOverrides.get(sessionId)
  if (
    prevOverride &&
    prevOverride.providerId === nextOverride.providerId &&
    prevOverride.modelId === nextOverride.modelId &&
    prevOverride.effort === nextOverride.effort
  ) {
    return
  }

  runtimeOverrides.set(sessionId, nextOverride)
  runtimeOverrideVersions.set(
    sessionId,
    (runtimeOverrideVersions.get(sessionId) ?? 0) + 1,
  )

  if (shouldDeferRuntimeRestartForActiveTurn(sessionId)) {
    setDeferredRuntimeRestart(sessionId, nextOverride)
    await persistSessionRuntimeConfig(sessionId, nextOverride)
    return
  }

  if (conversationService.hasSession(sessionId)) {
    await enqueueRuntimeTransition(sessionId, async () => {
      await persistSessionRuntimeConfig(sessionId, nextOverride)
      await restartSessionWithRuntimeConfig(ws, sessionId)
    })
    return
  }

  const pendingStartup = sessionStartupPromises.get(sessionId)
  if (pendingStartup) {
    const startupRuntimeVersion = sessionStartupRuntimeVersions.get(sessionId) ?? 0
    const currentRuntimeVersion = runtimeOverrideVersions.get(sessionId) ?? 0
    if (startupRuntimeVersion >= currentRuntimeVersion) {
      await persistSessionRuntimeConfig(sessionId, nextOverride)
      return
    }

    await enqueueRuntimeTransition(sessionId, async () => {
      await persistSessionRuntimeConfig(sessionId, nextOverride)
      await pendingStartup.catch(() => undefined)
      const currentOverride = runtimeOverrides.get(sessionId)
      if (
        currentOverride?.providerId !== nextOverride.providerId ||
        currentOverride.modelId !== nextOverride.modelId ||
        currentOverride.effort !== nextOverride.effort ||
        !conversationService.hasSession(sessionId)
      ) {
        return
      }
      await restartSessionWithRuntimeConfig(ws, sessionId)
    })
    return
  }

  await persistSessionRuntimeConfig(sessionId, nextOverride)
}

async function restartSessionWithPermissionMode(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  mode: PermissionMode,
): Promise<void> {
  try {
    const workDir = conversationService.getSessionWorkDir(sessionId)
    conversationService.stopSession(sessionId)

    // Launch with the requested mode in-memory. Persist it only after startup
    // succeeds so a failed bypass restart cannot leave dangerous metadata.
    const runtimeSettings = {
      ...await getRuntimeSettings(sessionId),
      permissionMode: mode,
      // v1.7.2 裁决二十一④：WS 拉起来源标注（诊断事件 cli_start_unconfirmed 用）
      startSource: 'ws' as const,
    }
    const sdkUrl = buildSdkWebSocketUrl(ws, sessionId)
    await conversationService.startSession(sessionId, workDir, sdkUrl, runtimeSettings)

    await commitConfirmedPermissionMode(sessionId, mode, workDir)
    rebindClientOutputForSession(sessionId)
    sendToSession(sessionId, { type: 'status', state: 'idle' })
    console.log(`[WS] Restarted CLI for ${sessionId} with permission mode: ${mode}`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    void diagnosticsService.recordEvent({
      type: 'permission_restart_failed',
      severity: 'error',
      sessionId,
      summary: errMsg,
      details: { mode, error: err },
    })
    console.error(`[WS] Failed to restart CLI for ${sessionId}: ${errMsg}`)
    sendMessage(ws, {
      type: 'error',
      message: await buildSessionStartupDiagnosticMessage(
        sessionId,
        `Failed to restart session with new permission mode: ${errMsg}`,
      ),
      code: 'CLI_RESTART_FAILED',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
  }
}

async function commitConfirmedPermissionMode(
  sessionId: string,
  mode: PermissionMode,
  knownWorkDir?: string | null,
): Promise<void> {
  const persisted = await persistSessionPermissionMode(sessionId, mode, knownWorkDir)
  if (!persisted) {
    throw new Error(`Unable to persist confirmed permission mode: ${mode}`)
  }
  conversationService.recordSessionPermissionMode(sessionId, mode)
  sendToSession(sessionId, { type: 'permission_mode_changed', mode })
}

async function restartSessionWithRuntimeConfig(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): Promise<void> {
  try {
    const workDir = conversationService.getSessionWorkDir(sessionId)
    conversationService.stopSession(sessionId)

    const runtimeSettings = await getRuntimeSettings(sessionId)
    const sdkUrl = buildSdkWebSocketUrl(ws, sessionId)
    await conversationService.startSession(sessionId, workDir, sdkUrl, {
      ...runtimeSettings,
      startSource: 'ws' as const,
    })

    rebindClientOutputForSession(sessionId)
    sendMessage(ws, { type: 'status', state: 'idle' })
    console.log(`[WS] Restarted CLI for ${sessionId} with runtime override`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    void diagnosticsService.recordEvent({
      type: 'runtime_config_restart_failed',
      severity: 'error',
      sessionId,
      summary: errMsg,
      details: { runtimeOverride: runtimeOverrides.get(sessionId), error: err },
    })
    console.error(`[WS] Failed to restart CLI for ${sessionId} after runtime override: ${errMsg}`)
    sendMessage(ws, {
      type: 'error',
      message: await buildSessionStartupDiagnosticMessage(
        sessionId,
        `Failed to switch provider/model: ${errMsg}`,
      ),
      code: 'CLI_RESTART_FAILED',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
  }
}

/**
 * 中断会话当前运行：SDK 优雅中断 + 3 秒强杀兜底，保留会话与历史。
 * WS（stop_generation）与 REST（POST /api/sessions/:id/interrupt）共用。
 * 返回 stopped=false 表示当前没有进行中的轮次（会话空闲或未运行）。
 */
export function interruptSessionRuntime(sessionId: string): { stopped: boolean } {
  const stoppedTurnOwner = getSessionSnapshot(sessionId)?.turnOwner ?? null
  console.log(`[WS] Stop generation requested for session: ${sessionId}`)

  requestSessionStop(sessionId)
  markSessionChatInterrupted(sessionId)

  const stopped = Boolean(
    stoppedTurnOwner !== null && conversationService.hasSession(sessionId),
  )
  if (stopped) {
    // First try graceful interrupt via SDK control message
    conversationService.sendInterrupt(sessionId)

    // Force-kill if still running after 3 seconds
    setTimeout(() => {
      if (
        isSessionStopRequested(sessionId) &&
        stoppedTurnOwner !== null &&
        getSessionSnapshot(sessionId)?.turnOwner === stoppedTurnOwner &&
        conversationService.hasSession(sessionId)
      ) {
        console.log(`[WS] Force-killing CLI subprocess for session: ${sessionId}`)
        conversationService.stopSession(sessionId)
      }
    }, 3_000)
  }

  return { stopped }
}

function handleStopGeneration(ws: ServerWebSocket<WebSocketData>) {
  const { sessionId } = ws.data
  interruptSessionRuntime(sessionId)
  sendMessage(ws, { type: 'status', state: 'idle' })
}

async function handleStopBackgroundTask(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'stop_background_task' }>,
): Promise<void> {
  const { sessionId } = ws.data
  const taskId = typeof message.taskId === 'string' ? message.taskId.trim() : ''

  if (!taskId) {
    sendMessage(ws, {
      type: 'background_task_stop_failed',
      taskId,
      message: 'Background task id is required',
    })
    return
  }

  try {
    await conversationService.requestControl(sessionId, {
      subtype: 'stop_task',
      task_id: taskId,
    })
  } catch (error) {
    sendMessage(ws, {
      type: 'background_task_stop_failed',
      taskId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

// ============================================================================
// Title generation
// ============================================================================

type TitleGenerationPhase = 'user-message' | 'turn-complete'

function triggerTitleGeneration(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  phase: TitleGenerationPhase,
  completedTurnCount?: number,
): void {
  const state = sessionTitleState.get(sessionId)
  if (!state || state.hasCustomTitle) return

  const count = phase === 'turn-complete'
    ? completedTurnCount ?? state.userMessageCount
    : state.userMessageCount

  if (phase === 'user-message') {
    if (count !== 1) return
    const key = 'placeholder:1'
    if (state.startedGenerationKeys.has(key)) return
    state.startedGenerationKeys.add(key)

    void (async () => {
      try {
        const text = state.firstUserMessage
        const placeholder = deriveTitle(text)
        if (placeholder) {
          const saved = await saveAiTitle(sessionId, placeholder)
          if (!saved) {
            state.hasCustomTitle = true
            return
          }
          sendSessionTitleUpdated(ws, sessionId, placeholder)
        }
      } catch (err) {
        console.error(`[Title] Failed to derive title for ${sessionId}:`, err)
      }
    })()
    return
  }

  // Generate polished titles after assistant output completes on turn 1 and 3.
  if (count !== 1 && count !== 3) return
  const key = `complete:${count}`
  if (state.startedGenerationKeys.has(key)) return
  state.startedGenerationKeys.add(key)

  const text = buildConversationTitleInput(state.completedTurns)
  const runtimeProviderId = runtimeOverrides.get(sessionId)?.providerId
  const generationSeq = ++state.generationSeq

  void (async () => {
    try {
      const responseLanguage = await getResponseLanguageSetting()
      const titleLanguagePreference = resolveTitleLanguagePreference(
        state.firstUserMessage,
        responseLanguage,
      )
      const aiTitle = await generateTitle(
        text,
        runtimeProviderId,
        titleLanguagePreference,
      )
      if (generationSeq !== state.generationSeq) return
      if (aiTitle) {
        const saved = await saveAiTitle(sessionId, aiTitle)
        if (!saved) {
          state.hasCustomTitle = true
          return
        }
        sendSessionTitleUpdated(ws, sessionId, aiTitle)
      }
    } catch (err) {
      console.error(`[Title] Failed to generate title for ${sessionId}:`, err)
    }
  })()
}

async function getResponseLanguageSetting(): Promise<string | undefined> {
  const userSettings = await settingsService.getUserSettings().catch(() => ({}))
  return typeof userSettings.language === 'string'
    ? userSettings.language
    : undefined
}

function sendSessionTitleUpdated(
  fallbackWs: ServerWebSocket<WebSocketData>,
  sessionId: string,
  title: string,
): void {
  const payload: ServerMessage = { type: 'session_title_updated', sessionId, title }
  const clients = getSessionClients(sessionId)
  if (!clients?.size) {
    sendMessage(fallbackWs, payload)
    return
  }
  for (const client of clients) {
    sendMessage(client, payload)
  }
}

function bindTitleSessionOutput(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  shouldProcess: () => boolean,
): () => void {
  const callback = (cliMsg: any) => {
    if (!shouldProcess() && !(cliMsg?.type === 'result' && cliMsg?.is_error)) {
      return
    }

    appendAssistantTextForTitle(sessionId, cliMsg)

    if (cliMsg?.type === 'result') {
      conversationService.removeOutputCallback(sessionId, callback)
      const completedTurnCount = completeActiveTitleTurn(sessionId)
      if (!cliMsg.is_error) {
        triggerTitleGeneration(ws, sessionId, 'turn-complete', completedTurnCount ?? undefined)
      }
    }
  }

  conversationService.onOutput(sessionId, callback)
  return () => conversationService.removeOutputCallback(sessionId, callback)
}

function appendAssistantTextForTitle(sessionId: string, cliMsg: any): void {
  const titleDraftTurn = sessionTitleState.get(sessionId)?.titleDraftTurn
  if (!titleDraftTurn) return

  const streamText = extractAssistantStreamTextForTitle(cliMsg)
  if (streamText) {
    titleDraftTurn.assistantText = `${titleDraftTurn.assistantText ?? ''}${streamText}`
    return
  }

  const assistantText = extractAssistantMessageTextForTitle(cliMsg)
  if (assistantText) {
    titleDraftTurn.assistantText = titleDraftTurn.assistantText
      ? `${titleDraftTurn.assistantText}\n${assistantText}`
      : assistantText
    return
  }

  if (
    cliMsg?.type === 'result' &&
    !cliMsg.is_error &&
    !titleDraftTurn.assistantText &&
    typeof cliMsg.result === 'string'
  ) {
    titleDraftTurn.assistantText = cliMsg.result
  }
}

function completeActiveTitleTurn(sessionId: string): number | null {
  const state = sessionTitleState.get(sessionId)
  const titleDraftTurn = state?.titleDraftTurn
  if (!state || !titleDraftTurn) return null

  state.completedTurns.push({
    userText: titleDraftTurn.userText,
    assistantText: titleDraftTurn.assistantText?.trim(),
  })
  state.titleDraftTurn = undefined
  return titleDraftTurn.count
}

function discardActiveTitleTurn(sessionId: string, count: number | null): void {
  if (count === null) return
  const state = sessionTitleState.get(sessionId)
  if (state?.titleDraftTurn?.count === count) {
    state.titleDraftTurn = undefined
  }
}

function cleanupSessionRuntimeState(sessionId: string) {
  cancelSessionDisconnectWatcher(sessionId)
  cleanupStreamState(sessionId)
  deleteSessionSlashCommands(sessionId)
  sessionTitleState.delete(sessionId)
  runtimeOverrides.delete(sessionId)
  clearSession(sessionId)
  clearSessionStopRequested(sessionId)
  clearActiveBackgroundTasks(sessionId)
  clearSessionChatActivity(sessionId)
  deleteDeferredRuntimeRestart(sessionId)
  deleteDeferredPermissionMode(sessionId)
  runtimeTransitionPromises.delete(sessionId)
  sessionStartupPromises.delete(sessionId)
  lastResolvedStartupWorkDirs.delete(sessionId)
  forgetSessionTaskNotifications(sessionId)
  clearPrewarmState(sessionId)
}

function getPrewarmIdleTimeoutMs(): number {
  const raw = process.env.CC_HEIHEI_PREWARM_IDLE_TIMEOUT_MS
  if (!raw) return DEFAULT_PREWARM_IDLE_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_PREWARM_IDLE_TIMEOUT_MS
}

function clearPrewarmState(sessionId: string) {
  prewarmPendingSessions.delete(sessionId)
  prewarmedSessions.delete(sessionId)
  const timer = prewarmIdleTimers.get(sessionId)
  if (timer) {
    clearTimeout(timer)
    prewarmIdleTimers.delete(sessionId)
  }
}

function markPrewarmed(sessionId: string) {
  prewarmedSessions.add(sessionId)
  const timeoutMs = getPrewarmIdleTimeoutMs()
  if (timeoutMs === 0) return

  const existingTimer = prewarmIdleTimers.get(sessionId)
  if (existingTimer) clearTimeout(existingTimer)

  const timer = setTimeout(() => {
    prewarmIdleTimers.delete(sessionId)
    if (!prewarmedSessions.has(sessionId)) return
    const turnActive = hasPendingOrActiveUserTurn(sessionId)
    const hasClients = hasActiveClients(sessionId)
    // Safety guard: never kill a session that has a registered user turn or
    // connected clients. The turn-registered check (not messageSent) covers the
    // CLI-startup window, so a turn racing through startup is protected even if
    // the client has briefly disconnected. The prewarm idle timer is only meant
    // to reclaim truly idle prewarmed sessions — not to interrupt a conversation.
    if (turnActive || hasClients) {
      prewarmedSessions.delete(sessionId)
      return
    }
    console.log(`[WS] Prewarmed session ${sessionId} idle for ${timeoutMs}ms, stopping CLI subprocess`)
    conversationService.stopSession(sessionId)
    prewarmedSessions.delete(sessionId)
  }, timeoutMs)
  prewarmIdleTimers.set(sessionId, timer)
}

function cacheSessionInitMetadata(sessionId: string, cliMsg: any) {
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

function bindPrewarmMetadataCapture(sessionId: string) {
  for (const msg of conversationService.getRecentSdkMessages(sessionId)) {
    cacheSessionInitMetadata(sessionId, msg)
  }
  if (!conversationService.hasSession(sessionId)) return

  conversationService.clearOutputCallbacks(sessionId)
  conversationService.onOutput(sessionId, (cliMsg) => {
    cacheSessionInitMetadata(sessionId, cliMsg)
  })
}

async function ensureCliSessionStarted(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  reason: 'user_message' | 'prewarm_session',
): Promise<void> {
  const pendingStartup = sessionStartupPromises.get(sessionId)
  if (pendingStartup) {
    await pendingStartup
    return
  }

  if (conversationService.hasSession(sessionId)) return

  const startupRuntimeVersion = runtimeOverrideVersions.get(sessionId) ?? 0
  sessionStartupRuntimeVersions.set(sessionId, startupRuntimeVersion)

  const startup = (async () => {
    const workDir = await resolveSessionWorkDir(sessionId)
    lastResolvedStartupWorkDirs.set(sessionId, workDir)
    const runtimeSettings = await getRuntimeSettings(sessionId)
    const startupSettings = reason === 'prewarm_session'
      ? { ...runtimeSettings, resumeInterruptedTurn: false, startSource: 'ws' as const }
      : { ...runtimeSettings, startSource: 'ws' as const }
    const sdkUrl = buildSdkWebSocketUrl(ws, sessionId)
    await sendRepositoryStartupStatus(ws, sessionId, reason)
    console.log(`[WS] Starting CLI for ${sessionId} due to ${reason}`)
    await conversationService.startSession(sessionId, workDir, sdkUrl, startupSettings)
  })()

  sessionStartupPromises.set(sessionId, startup)
  try {
    await startup
  } finally {
    if (sessionStartupPromises.get(sessionId) === startup) {
      sessionStartupPromises.delete(sessionId)
      sessionStartupRuntimeVersions.delete(sessionId)
    }
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

// ============================================================================
// Helpers
// ============================================================================

// ── v1.7 结构拆分（ws/handler.ts 第①批 · 绿灯区）：cli 重试/降级解析族已搬到
// ./cliRetryMessages.ts（同批）：finiteNumber / normalizeRetryCount /
// readRetryErrorRecord / readRetryErrorString / toApiRetryServerMessage /
// STREAMING_FALLBACK_CAUSES / toStreamingFallbackServerMessage。
// 其中 toApiRetryServerMessage / toStreamingFallbackServerMessage 原就以裸名被本文件
// 调用（:2285 / :2292），改由同名 import 直接承接，**调用点文本一行未改**；
// 其余 5 项组外调用点为 0，不留死委托，未导入。

/**
 * Idle disconnect cleanup delay. A session waiting on a pending permission
 * keeps the long 30-minute window so a transient renderer disconnect does not
 * abort a prompt the user is about to answer. Otherwise we honor the
 * user-configured grace period (issue #764).
 */
function getDisconnectCleanupDelayMs(sessionId: string): number {
  return conversationService.getPendingPermissionRequests(sessionId).length > 0
    ? PENDING_PERMISSION_DISCONNECT_CLEANUP_MS
    : getDisconnectGraceMs()
}

/**
 * Whether a user turn has been registered for this session and not yet settled,
 * INCLUDING the CLI-startup window before the message is actually sent.
 * handleUserMessage registers the turn in its synchronous prefix (registry
 * beginTurn), well before the message is actually sent. Checking the
 * registration is not blind to that window, so the prewarm idle timer can
 * neither arm on nor fire against a session a user turn has already claimed —
 * even when a concurrent prewarm_session/user_message flush inverts their
 * ordering.
 */
function hasPendingOrActiveUserTurn(sessionId: string): boolean {
  return hasActiveTurn(sessionId)
}

/**
 * Start the idle grace timer for a disconnected, idle session. If no client
 * reconnects before it fires, the CLI subprocess is stopped.
 */
function scheduleDisconnectCleanup(sessionId: string): void {
  computerUseApprovalService.cancelSession(sessionId)

  const existing = sessionCleanupTimers.get(sessionId)
  if (existing) clearTimeout(existing)

  const cleanupDelayMs = getDisconnectCleanupDelayMs(sessionId)
  const cleanupTimer = setTimeout(() => {
    sessionCleanupTimers.delete(sessionId)
    if (hasActiveClients(sessionId)) return

    const permissionBoundExpired = conversationService
      .getPendingPermissionRequests(sessionId).length > 0
    if (
      !permissionBoundExpired &&
      (hasPendingOrActiveUserTurn(sessionId) || hasActiveBackgroundTasks(sessionId))
    ) {
      console.log(`[WS] Session ${sessionId} became active during its idle grace period; keeping CLI alive`)
      watchTurnCompletionForCleanup(sessionId)
      return
    }

    console.log(`[WS] Session ${sessionId} not reconnected after ${cleanupDelayMs}ms, stopping CLI subprocess`)
    conversationService.stopSession(sessionId)
    cleanupSessionRuntimeState(sessionId)
  }, cleanupDelayMs)
  sessionCleanupTimers.set(sessionId, cleanupTimer)
}

/**
 * Keep a session with active foreground/background work alive after the last
 * client leaves, and start the idle grace timer only once all work completes
 * (issue #764). If a client reconnects first, the watcher is torn down.
 */
function watchTurnCompletionForCleanup(sessionId: string): void {
  cancelSessionDisconnectWatcher(sessionId)

  const onComplete = (cliMsg: any) => {
    const taskLifecycle = trackCliBackgroundTaskLifecycle(sessionId, cliMsg)
    if (taskLifecycle?.running && !hasActiveClients(sessionId)) {
      // A pending permission uses a hard 30-minute disconnect bound. A late
      // background task may outlive (or never emit) its terminal notification,
      // so it must not turn that bound into an unbounded watcher. Ordinary idle
      // grace timers are still cancelled while observed work is running.
      if (conversationService.getPendingPermissionRequests(sessionId).length === 0) {
        const cleanupTimer = sessionCleanupTimers.get(sessionId)
        if (cleanupTimer) clearTimeout(cleanupTimer)
        sessionCleanupTimers.delete(sessionId)
      }
      return
    }
    if (
      cliMsg?.type === 'control_request' &&
      cliMsg.request?.subtype === 'can_use_tool' &&
      !hasActiveClients(sessionId)
    ) {
      // The permission request may arrive after the renderer disconnected.
      // ConversationService records it before notifying this callback, so the
      // cleanup delay resolves to the bounded pending-permission window.
      scheduleDisconnectCleanup(sessionId)
      return
    }

    const foregroundTurnCompleted = cliMsg?.type === 'result'
    const backgroundTaskCompleted = taskLifecycle?.running === false
    if (!foregroundTurnCompleted && !backgroundTaskCompleted) return
    if (hasActiveBackgroundTasks(sessionId)) return
    if (!foregroundTurnCompleted && hasPendingOrActiveUserTurn(sessionId)) return

    cancelSessionDisconnectWatcher(sessionId)
    // All observed work finished while still disconnected — fall back to the
    // bounded idle timer rather than stopping the CLI immediately.
    if (!hasActiveClients(sessionId)) {
      scheduleDisconnectCleanup(sessionId)
    }
  }

  conversationService.onOutput(sessionId, onComplete)
  sessionDisconnectWatchers.set(sessionId, () => {
    conversationService.removeOutputCallback(sessionId, onComplete)
  })
}

/**
 * Re-arm the disconnect watcher once CLI startup has completed. A client can
 * leave during the startup window, when the user turn is registered but the
 * ConversationService session (and therefore its output callback list) does
 * not exist yet.
 */
function refreshDisconnectedTurnCleanupWatcher(sessionId: string): void {
  if (
    hasActiveClients(sessionId) ||
    (!hasPendingOrActiveUserTurn(sessionId) && !hasActiveBackgroundTasks(sessionId))
  ) return

  const pendingTimer = sessionCleanupTimers.get(sessionId)
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    sessionCleanupTimers.delete(sessionId)
  }
  watchTurnCompletionForCleanup(sessionId)
}

/** Remove any pending active-work completion watcher for a session. */
function cancelSessionDisconnectWatcher(sessionId: string): void {
  const remove = sessionDisconnectWatchers.get(sessionId)
  if (remove) {
    remove()
    sessionDisconnectWatchers.delete(sessionId)
  }
}

function replayPendingPermissionRequests(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): string[] {
  const requests = conversationService.getPendingPermissionRequests(sessionId)
  for (const request of requests) {
    sendMessage(ws, {
      type: 'permission_request',
      requestId: request.requestId,
      toolName: request.toolName,
      ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
      input: request.input,
      ...(request.description ? { description: request.description } : {}),
    })
  }
  return requests.map((request) => request.requestId)
}

function replayPendingComputerUsePermissionRequests(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): string[] {
  const requests = computerUseApprovalService.getPendingRequests(sessionId)
  for (const request of requests) {
    sendMessage(ws, {
      type: 'computer_use_permission_request',
      requestId: request.requestId,
      request,
    })
  }
  return requests.map((request) => request.requestId)
}

// ── v1.7 结构拆分（ws/handler.ts 第②批 · local-command 解析族）已搬到
// ./localCommandParsing.ts（同批）：原 :2679-2932 的 15 个绑定整体迁出，见文件顶部 import。

function bindAllClientSessionOutputs(
  sessionId: string,
  options?: {
    shouldForward?: (cliMsg: any) => boolean
  },
): void {
  const clients = getSessionClients(sessionId)
  if (!clients) return
  for (const ws of clients) {
    bindClientSessionOutput(sessionId, ws, options)
  }
}

function bindClientSessionOutput(
  sessionId: string,
  ws: ServerWebSocket<WebSocketData>,
  options?: {
    shouldForward?: (cliMsg: any) => boolean
  },
) {
  if (!conversationService.hasSession(sessionId)) return

  removeClientOutputCallback(ws)

  const callback = (cliMsg: any) => {
    trackCliBackgroundTaskLifecycle(sessionId, cliMsg)
    if (options?.shouldForward && !options.shouldForward(cliMsg)) {
      return
    }

    const cliPermissionMode = getCliPermissionModeBroadcast(cliMsg)
    if (
      cliPermissionMode &&
      conversationService.isPermissionModeChangePending(sessionId, cliPermissionMode)
    ) {
      return
    }

    const forward = () => {
      handleCliPermissionModeBroadcast(sessionId, cliMsg)
      const serverMsgs = translateCliMessage(cliMsg, sessionId)
      for (const msg of serverMsgs) {
        sendMessage(ws, msg)
      }
    }

    const persistence = persistCliTaskNotification(sessionId, cliMsg)
    if (persistence) {
      void persistence
        .then(() => {
          if (getSessionClients(sessionId)?.has(ws)) forward()
        })
        .catch((error) => {
          console.warn(
            `[WS] Failed to forward persisted task notification for ${sessionId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        })
      return
    }
    forward()
  }

  registerClientOutputCallback(ws, sessionId, callback)
  conversationService.onOutput(sessionId, callback)
}

/**
 * CLI 被服务端程序化路径（如 /api/session-messages 的会话间投递）拉起后，
 * 为已连接的桌面客户端补绑输出回调。
 *
 * bindClientSessionOutput 在 CLI 不存在时直接返回，因此"先连上、后拉起"
 * 的客户端没有任何输出绑定，只能断开重连才能看到执行过程。
 */
export function rebindClientOutputForSession(sessionId: string): void {
  const clients = getSessionClients(sessionId)
  if (!clients) return
  for (const ws of clients) {
    bindClientSessionOutput(sessionId, ws)
  }
}

function getCliPermissionModeBroadcast(cliMsg: any): PermissionMode | null {
  if (
    cliMsg?.type === 'system' &&
    cliMsg.subtype === 'status' &&
    isPermissionMode(cliMsg.permissionMode)
  ) {
    return cliMsg.permissionMode
  }
  return null
}

function handleCliPermissionModeBroadcast(sessionId: string, cliMsg: any): void {
  const mode = getCliPermissionModeBroadcast(cliMsg)
  if (!mode) return

  const currentMode = conversationService.getSessionPermissionMode(sessionId)
  if (currentMode === mode) return

  if (!conversationService.recordSessionPermissionMode(sessionId, mode)) return
  void persistSessionPermissionMode(sessionId, mode).catch((err) => {
    console.warn(`[WS] Failed to persist CLI permission mode broadcast for ${sessionId}:`, err)
  })
}

type RuntimeSettings = {
  permissionMode?: string
  model?: string
  effort?: string
  thinking?: 'disabled'
  providerId?: string | null
}

async function isRuntimeEffortSupported(
  providerId: string | null | undefined,
  modelId: string,
  effort: string,
): Promise<boolean> {
  if (isGrokOfficialProviderId(providerId)) {
    const { supportedEfforts } = await getGrokReasoningEfforts(modelId)
    return supportedEfforts.includes(effort)
  }
  if (!isOpenAIOfficialProviderId(providerId)) {
    return VALID_CLAUDE_EFFORT_LEVELS.has(effort)
  }
  if (!isOpenAIReasoningEffort(effort)) {
    return false
  }

  const catalog = await getOpenAICodexModelCatalog()
  const model = getOpenAIModelCatalogEntry(modelId, catalog)
  return !model || model.supportedReasoningEfforts.includes(effort)
}

function isKnownRuntimeProviderId(
  providerId: string,
  providers: Array<{ id: string }>,
): boolean {
  return (
    isOpenAIOfficialProviderId(providerId) ||
    isGrokOfficialProviderId(providerId) ||
    providers.some((provider) => provider.id === providerId)
  )
}

async function getRuntimeSettings(sessionId?: string): Promise<RuntimeSettings> {
  const launchInfo = sessionId
    ? await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
    : null
  const sessionPermissionMode = sessionId
    ? launchInfo?.permissionMode ?? await getSessionPermissionMode(sessionId)
    : undefined
  const persistedRuntimeOverride =
    launchInfo?.runtimeModelId
      ? {
          providerId: launchInfo.runtimeProviderId ?? null,
          modelId: launchInfo.runtimeModelId,
          ...(launchInfo.effortLevel ? { effort: launchInfo.effortLevel } : {}),
        }
      : undefined
  const runtimeOverride = sessionId
    ? runtimeOverrides.get(sessionId) ?? persistedRuntimeOverride
    : undefined
  if (runtimeOverride) {
    if (typeof runtimeOverride.providerId === 'string') {
      const { providers } = await providerService.listProviders()
      const providerExists = isKnownRuntimeProviderId(runtimeOverride.providerId, providers)
      if (!providerExists) {
        console.warn(
          `[WS] Ignoring stale runtime provider id for ${sessionId}: ${runtimeOverride.providerId}`,
        )
        runtimeOverrides.delete(sessionId!)
        const defaults = await getDefaultRuntimeSettings()
        return {
          ...defaults,
          permissionMode: sessionPermissionMode ?? defaults.permissionMode,
        }
      }
    }

    const userSettings = await settingsService.getUserSettings()
    const thinking = resolveDesktopThinkingMode(
      userSettings,
      runtimeOverride.providerId,
    )
    let effort = runtimeOverride.effort
    if (isOpenAIOfficialProviderId(runtimeOverride.providerId)) {
      effort = effort ?? await getDefaultOpenAIReasoningEffort(runtimeOverride.modelId)
    } else if (isGrokOfficialProviderId(runtimeOverride.providerId)) {
      const grokEffort = await getGrokReasoningEfforts(runtimeOverride.modelId)
      runtimeOverride.modelId = grokEffort.modelId
      effort = effort && grokEffort.supportedEfforts.includes(effort)
        ? effort
        : grokEffort.defaultEffort
    }

    return {
      permissionMode: sessionPermissionMode ?? await settingsService.getPermissionMode().catch(() => undefined),
      model: runtimeOverride.modelId,
      effort,
      thinking,
      providerId: runtimeOverride.providerId,
    }
  }

  const defaults = await getDefaultRuntimeSettings()
  return {
    ...defaults,
    permissionMode: sessionPermissionMode ?? defaults.permissionMode,
    effort: launchInfo?.effortLevel ?? defaults.effort,
  }
}

async function getSessionPermissionMode(sessionId: string): Promise<string | undefined> {
  const launchInfo = await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
  return launchInfo?.permissionMode
}

async function getDefaultRuntimeSettings(): Promise<RuntimeSettings> {
  // Check if a custom provider is active
  const { providers, activeId } = await providerService.listProviders()
  let resolvedActiveId = activeId
  if (activeId && !isKnownRuntimeProviderId(activeId, providers)) {
    console.warn(`[WS] Active provider id is stale, falling back to official provider: ${activeId}`)
    resolvedActiveId = null
    await providerService.activateOfficial()
  }

  const userSettings = await settingsService.getUserSettings()
  const providerSettings = resolvedActiveId
    ? await providerService.getManagedSettings()
    : undefined
  const modelSettings = providerSettings ?? userSettings
  const modelContext =
    typeof modelSettings.modelContext === 'string' && modelSettings.modelContext.trim()
      ? modelSettings.modelContext
      : undefined
  let effort =
    typeof userSettings.effort === 'string' && userSettings.effort.trim()
      ? userSettings.effort
      : undefined
  const thinking = resolveDesktopThinkingMode(userSettings, resolvedActiveId)

  let model: string | undefined
  if (resolvedActiveId) {
    // Provider is active — only consult provider-managed cc-heihei settings.
    // Global ~/.claude/settings.json model values must not bleed into provider mode.
    const baseModel =
      typeof modelSettings.model === 'string' && modelSettings.model.trim()
        ? modelSettings.model
        : ''
    if (baseModel) {
      model = baseModel
      if (modelContext) model += `:${modelContext}`
    }
    if (isOpenAIOfficialProviderId(resolvedActiveId)) {
      model = model || OPENAI_DEFAULT_MAIN_MODEL
      effort = await getDefaultOpenAIReasoningEffort(model)
    } else if (isGrokOfficialProviderId(resolvedActiveId)) {
      model = model || GROK_DEFAULT_MAIN_MODEL
      effort = (await getGrokReasoningEfforts(model)).defaultEffort
    }
  } else {
    // No provider — pass model normally
    const baseModel =
      typeof userSettings.model === 'string' && userSettings.model.trim()
        ? userSettings.model
        : undefined
    model = baseModel ? (modelContext ? `${baseModel}:${modelContext}` : baseModel) : undefined
  }

  return {
    permissionMode: await settingsService.getPermissionMode().catch(() => undefined),
    model,
    effort,
    thinking,
    providerId: resolvedActiveId,
  }
}

function resolveDesktopThinkingMode(
  settings: Record<string, unknown>,
  providerId?: string | null,
): 'disabled' | undefined {
  if (isOpenAIOfficialProviderId(providerId)) return undefined
  return settings.alwaysThinkingEnabled === false ? 'disabled' : undefined
}

async function buildSessionStartupDiagnosticMessage(
  sessionId: string,
  cause: string,
): Promise<string> {
  const lines = [
    cause,
    '',
    'Desktop service diagnostics:',
    `- sessionId: ${sessionId}`,
  ]

  try {
    const recentWorkDir = lastResolvedStartupWorkDirs.get(sessionId)
    const workDir =
      recentWorkDir ||
      conversationService.getSessionWorkDir(sessionId) ||
      await sessionService.getSessionWorkDir(sessionId)
    lines.push(`- workDir: ${workDir ?? '(unknown)'}`)
  } catch (err) {
    lines.push(`- workDir: failed to resolve (${err instanceof Error ? err.message : String(err)})`)
  }

  const runtimeOverride = runtimeOverrides.get(sessionId)
  if (runtimeOverride) {
    lines.push(`- runtimeOverride.providerId: ${runtimeOverride.providerId ?? '(official)'}`)
    lines.push(`- runtimeOverride.modelId: ${runtimeOverride.modelId}`)
    lines.push(`- runtimeOverride.effort: ${runtimeOverride.effort ?? '(auto)'}`)
  } else {
    lines.push('- runtimeOverride: (none)')
  }

  try {
    const { providers, activeId } = await providerService.listProviders()
    lines.push(`- activeProviderId: ${activeId ?? '(official)'}`)
    lines.push(`- configuredProviders: ${providers.length}`)
    if (providers.length > 0) {
      lines.push(
        `- providerIndex: ${providers
          .map((provider) => `${provider.name} (${provider.id})`)
          .join(', ')}`,
      )
    }
  } catch (err) {
    lines.push(`- providers: failed to read (${err instanceof Error ? err.message : String(err)})`)
  }

  return lines.join('\n')
}

function enqueueRuntimeTransition(
  sessionId: string,
  transition: () => Promise<void>,
): Promise<void> {
  const previous = runtimeTransitionPromises.get(sessionId) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(transition)
    .finally(() => {
      if (runtimeTransitionPromises.get(sessionId) === next) {
        runtimeTransitionPromises.delete(sessionId)
      }
    })
  runtimeTransitionPromises.set(sessionId, next)
  return next
}

async function waitForRuntimeTransitionBeforeUserTurn(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): Promise<{ ok: boolean; waited: boolean }> {
  let waited = false
  let pendingRuntimeTransition = runtimeTransitionPromises.get(sessionId)
  while (pendingRuntimeTransition) {
    waited = true
    try {
      await pendingRuntimeTransition
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      void diagnosticsService.recordEvent({
        type: 'runtime_transition_failed',
        severity: 'error',
        sessionId,
        summary: errMsg,
        details: err,
      })
      console.error(`[WS] Runtime transition failed before handling user message for ${sessionId}: ${errMsg}`)
      sendMessage(ws, {
        type: 'error',
        message: `Failed to switch provider/model: ${errMsg}`,
        code: 'CLI_RESTART_FAILED',
      })
      sendMessage(ws, { type: 'status', state: 'idle' })
      failSessionChatActivity(sessionId)
      return { ok: false, waited }
    }

    const nextTransition = runtimeTransitionPromises.get(sessionId)
    pendingRuntimeTransition =
      nextTransition && nextTransition !== pendingRuntimeTransition
        ? nextTransition
        : undefined
  }

  return { ok: true, waited }
}

// ── sendToSession / broadcastGlobalEvent / 回合翻转广播 / getActiveSessionIds
//    已搬到 ./sessionTransport.ts（T0 批）──


// ── v1.5.0 A6/C12：协作推送（花名册变化 + 会话列表失效）─────────────────────
// 信号来自下层（collaboration/collabPushSignals 零依赖缝），出口仍是
// _events 通道。契约见 D:\xxw_p\cc-heihei-plan\事件契约_v1.5.0.md。

/** session_list_invalidated 的突发合并窗口（契约 §3） */
const SESSION_LIST_MERGE_MS = 250
let pendingListEpoch: number | null = null
let listMergeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 协作推送信号 → 全局事件广播。按 kind **穷尽分派**（裁决二，v1.6.0）。
 *
 * 此前只特判 roster，其余 kind 一律当 session_list 处理：task 信号没有 epoch，
 * `Math.max(pendingListEpoch ?? 0, undefined)` 得到 NaN，JSON 序列化后是 null，
 * 前端按「无条件刷新」处理——每次任务创建/流转都多刷一次整表会话列表，而且
 * 同一 250ms 窗口里真实列表的 epoch 也会被 NaN 吃掉，合并去重失效。
 * 现在 task 走自己的出口；新增 kind 若漏处理，末尾的 never 断言会直接编译报错。
 */
function broadcastCollabPush(signal: CollabPushSignal): void {
  switch (signal.kind) {
    case 'roster':
      broadcastGlobalEvent({
        type: 'system_notification',
        subtype: 'servant_roster_changed',
        data: {
          sessionId: signal.sessionId,
          change: signal.change,
          fields: signal.fields,
        },
      })
      return

    // 任务台账变化（裁决二）：专用事件，前端据此增量更新「待接单」状态。
    // data 精确限定为这四个字段——不携带 epoch，也不并入会话列表失效。
    case 'task':
      broadcastGlobalEvent({
        type: 'system_notification',
        subtype: 'collab_task_changed',
        data: {
          taskId: signal.taskId,
          projectDir: signal.projectDir,
          change: signal.change,
          status: signal.status,
        },
      })
      return

    case 'session_list': {
      // 会话列表失效：250ms 窗口合并，只广播窗口内最大 epoch（突发变更不刷屏）
      pendingListEpoch = Math.max(pendingListEpoch ?? 0, signal.epoch)
      if (listMergeTimer) return
      listMergeTimer = setTimeout(() => {
        listMergeTimer = null
        const epoch = pendingListEpoch
        pendingListEpoch = null
        if (epoch === null) return
        broadcastGlobalEvent({
          type: 'system_notification',
          subtype: 'session_list_invalidated',
          data: { epoch },
        })
      }, SESSION_LIST_MERGE_MS)
      listMergeTimer.unref?.()
      return
    }

    default: {
      // 穷尽性检查：CollabPushSignal 新增 kind 却忘记上面加分支时，这里编译报错。
      const exhaustive: never = signal
      return exhaustive
    }
  }
}

/**
 * phase_changed → 花名册 running 推送。只对在册会话广播：普通（非协作）会话的
 * 进程起停与花名册无关，广播只会给前端制造噪音。判定走花名册查询（异步 IO，
 * 在 emit 回调外完成后再广播——回调内不做任何 registry 写，符合 sessionEvents
 * 的 reentrancy 约束）。
 */
function handleRosterRunningChange(event: SessionEvent): void {
  if (event.type !== 'phase_changed') return
  void servantService
    .getServant(event.sessionId)
    .then((entry) => {
      if (!entry) return
      broadcastGlobalEvent({
        type: 'system_notification',
        subtype: 'servant_roster_changed',
        data: { sessionId: event.sessionId, change: 'updated', fields: ['running'] },
      })
    })
    .catch(() => {
      // 花名册读失败：丢一轮推送，前端重连/轮询兜底
    })
}

/** P0-b（裁决十九⑤）：权限请求超时 → 向前端补发 permission_resolved（reason:'timeout'），不静默。 */
function broadcastPermissionTimeout(e: SessionEvent): void {
  if (e.type !== 'permission_timeout') return
  sendToSession(e.sessionId, {
    type: 'permission_resolved',
    requestId: e.requestId,
    permissionType: 'tool',
    allowed: false,
    reason: 'timeout',
  })
}

/** ensure 模式（同 ensureTurnChangeBroadcastSubscribed）：被 reset 清空后可重调恢复 */
export function ensureCollabPushBroadcastSubscribed(): void {
  onCollabPush(broadcastCollabPush)
  onSessionEvent(handleRosterRunningChange, { types: ['phase_changed'] })
  onSessionEvent(broadcastPermissionTimeout, { types: ['permission_timeout'] })
}

ensureCollabPushBroadcastSubscribed()

/** 测试隔离：清空待合并的 session_list 信号与定时器 */
export function resetCollabPushBroadcastForTests(): void {
  if (listMergeTimer) clearTimeout(listMergeTimer)
  listMergeTimer = null
  pendingListEpoch = null
}

export function closeSessionConnection(sessionId: string, reason = 'session closed'): boolean {
  const cleanupTimer = sessionCleanupTimers.get(sessionId)
  if (cleanupTimer) {
    clearTimeout(cleanupTimer)
    sessionCleanupTimers.delete(sessionId)
  }
  computerUseApprovalService.cancelSession(sessionId)
  conversationService.clearOutputCallbacks(sessionId)
  cleanupSessionRuntimeState(sessionId)

  const clients = takeSessionClients(sessionId)
  if (!clients || clients.size === 0) return false

  for (const ws of clients) {
    forgetClientOutputCallback(ws)
    ws.close(1000, reason)
  }
  return true
}

export function __resetWebSocketHandlerStateForTests(): void {
  for (const timer of sessionCleanupTimers.values()) clearTimeout(timer)
  for (const timer of prewarmIdleTimers.values()) clearTimeout(timer)
  for (const remove of sessionDisconnectWatchers.values()) remove()
  resetSessionTransportForTests()
  resetTaskNotificationPersistenceForTests()
  sessionCleanupTimers.clear()
  sessionDisconnectWatchers.clear()
  prewarmPendingSessions.clear()
  prewarmedSessions.clear()
  prewarmIdleTimers.clear()
  resetRegistryForTests()
  resetActiveBackgroundTasksForTests()
  resetSessionStopRequestedForTests()
  resetSessionChatActivityForTests()
  // 协作推送 250ms 合并窗口（pendingListEpoch + listMergeTimer）同属模块级共享状态：
  // 漏复位则上个用例残留的未超时窗口会吞掉下个用例自己的信号、广播出「别人的」epoch
  // （实测原序：conversations 后跑 websocket-handler 的 C12，Expected 5 收到 199）。
  resetCollabPushBroadcastForTests()
}

export function __markPrewarmPendingForTests(sessionId: string): void {
  prewarmPendingSessions.add(sessionId)
}

/** Test hook: mark a session as mid-turn so disconnect keeps the CLI alive. */
export function __markActiveTurnForTests(sessionId: string): void {
  beginSessionChatActivity(sessionId)
  ensureSessionRegistered(sessionId)
  beginTurnReplacing(sessionId, false)
}

/**
 * Test hook: register a user turn still in the pre-send (messageSent:false)
 * window — i.e. the CLI-startup window before the message is actually sent.
 */
export function __registerPendingUserTurnForTests(sessionId: string): void {
  beginSessionChatActivity(sessionId)
  ensureSessionRegistered(sessionId)
  beginTurnReplacing(sessionId, true)
}

/** Test hook: settle a registered turn through the same CLI-result seam. */
export function __settleActiveTurnForTests(sessionId: string, cliMsg: any): void {
  settleSessionChatActivity(sessionId, cliMsg)
  const owner = getSessionSnapshot(sessionId)?.turnOwner ?? null
  const handle = owner === null ? null : { identity: owner, abort: () => {}, settle: () => {} }
  if (handle) settleTurnIfOwner(sessionId, handle)
}

/** Test hook: simulate CLI startup completing after the last client left. */
export function __refreshDisconnectedTurnCleanupWatcherForTests(sessionId: string): void {
  refreshDisconnectedTurnCleanupWatcher(sessionId)
}

/** Test hook: arm the prewarm idle timer for a session, as markPrewarmed does. */
export function __markPrewarmedForTests(sessionId: string): void {
  markPrewarmed(sessionId)
}
