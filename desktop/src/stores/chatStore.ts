import { create } from 'zustand'
import { wsManager } from '../api/websocket'
import { sessionsApi } from '../api/sessions'
import { useTeamStore } from './teamStore'
import { useSessionStore } from './sessionStore'
import { useCLITaskStore } from './cliTaskStore'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useTabStore } from './tabStore'
import { randomSpinnerVerb } from '../config/spinnerVerbs'
import { notifyDesktop } from '../lib/desktopNotifications'
import { deriveSessionTitle, isPlaceholderSessionTitle } from '../lib/sessionTitle'
import { hasRunningBackgroundTasks } from '../lib/backgroundTasks'
import type { ComposerAttachment } from '../lib/composerAttachments'
import type { PermissionMode } from '../types/settings'
import type { RuntimeSelection } from '../types/runtime'
import type {
  ActiveGoalState,
  AgentTaskNotification,
  ApiRetryState,
  AttachmentRef,
  BackgroundAgentTask,
  ChatState,
  ComputerUsePermissionRequest,
  ComputerUsePermissionResponse,
  StreamingFallbackState,
  UIAttachment,
  UIMessage,
  ServerMessage,
  TokenUsage,
  PermissionUpdate,
} from '../types/chat'
import type {
  SlashCommandKind,
  SlashCommandOption,
  SlashCommandSource,
} from '../types/slashCommand'
import {
  HISTORY_PAGE_SIZE,
  TASK_TOOL_NAMES,
} from './chat/chatConstants'
import {
  addPendingTaskToolUseId,
  appendPendingDelta,
  appendPendingToolInputDelta,
  clearPendingDelta,
  clearPendingTaskToolUseIds,
  clearPendingToolInputDelta,
  clearPendingToolParentUseIds,
  consumeAllPendingTaskToolUseIds,
  consumePendingDelta,
  consumePendingTaskToolUseId,
  consumePendingToolInputDelta,
  consumePendingToolParentUseId,
  getPendingToolParentUseId,
  rememberPendingToolParentUseId,
  clearPendingDeltaFlushTimer,
  dropPendingDelta,
  hasPendingDelta,
  hasPendingDeltaFlushTimer,
  hasPendingToolInputFlushTimer,
  peekPendingDelta,
  setPendingDeltaFlushTimer,
  setPendingToolInputFlushTimer,
} from './chat/chatPendingRegistry'
import {
  appendAssistantTextMessage,
  appendOrUpdateTailCompactSummary,
  buildAgentCompletionNotification,
  buildPartialToolInputPreview,
  compactMetadataFromUnknown,
  dropTailCompactingCompactSummary,
  extractCompactSummaryContent,
  findStreamMergeTargetIndex,
  markPendingToolUseMessagesStopped,
  mergeBackgroundTaskMessages,
  mergeRestoredHistoryIntoLiveMessages,
  nextId,
  normalizeMemoryEventFiles,
  normalizeMemoryTeamCount,
  upsertBackgroundTaskMessage,
  upsertToolUseMessage,
} from './chat/messageTree'
import {
  agentNotificationRecordFromList,
  applyGoalEventToActiveGoal,
  backgroundTaskRecordFromNotifications,
  buildModelContent,
  deriveActiveGoalFromMessages,
  getStoppedBackgroundTaskFromToolResult,
  mergeBackgroundAgentTaskRecords,
  normalizeBackgroundAgentTaskEvent,
  normalizeGoalEventData,
  readNonEmptyString,
  upsertBackgroundAgentTask,
} from './chat/chatHistoryExtract'
import {
  appendReplayedUserMessage,
  extractLastTodoWriteFromHistory,
  hasUserMessagesAfterTaskCompletion,
  mapHistoryMessagesToUiMessages,
  reconstructAgentNotifications,
  summarizeTokenUsageFromHistory,
} from './chat/chatHistoryMapping'
export { appendReplayedUserMessage, reconstructAgentNotifications, mapHistoryMessagesToUiMessages } from './chat/chatHistoryMapping'
export { stripGeneratedImageMetadataLines } from './chat/chatHistoryExtract'
export { HISTORY_PAGE_SIZE } from './chat/chatConstants'

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export type ComposerDraftState = {
  input: string
  attachments: ComposerAttachment[]
}

export type QueuedUserMessage = {
  id: string
  content: string
  attachments?: AttachmentRef[]
  displayContent: string
  displayAttachments?: AttachmentRef[]
  createdAt: number
}

export type ComposerReferenceInsertion = {
  text: string
  reference?: {
    kind: 'file'
    path: string
    absolutePath?: string
    name: string
    isDirectory?: boolean
  }
  nonce: number
}

export type ComposerPrefillMode = 'replace' | 'append'

export type PendingPermission = {
  requestId: string
  toolName: string
  toolUseId?: string
  input: unknown
  description?: string
}

type PendingPermissions = Record<string, PendingPermission>

type PendingComputerUsePermission = {
  requestId: string
  request: ComputerUsePermissionRequest
}

type PendingComputerUsePermissions = Record<string, PendingComputerUsePermission>

export type PerSessionState = {
  messages: UIMessage[]
  chatState: ChatState
  connectionState: ConnectionState
  /** True after the server's authoritative reconnect snapshot has arrived. */
  connectionSnapshotReady?: boolean
  historyStatus?: 'idle' | 'loading' | 'ready' | 'error'
  historyError?: string | null
  /**
   * v1.5.0 大会话首开分页：首开只拉最近一窗（HISTORY_PAGE_SIZE 条），
   * 更早历史按 historyNextBefore 游标向上翻页。旧服务端不分页时首窗即全量，
   * 服务端不带 hasMore → false，行为退化为旧语义。
   */
  historyHasMore?: boolean
  historyNextBefore?: number | null
  /** 向上翻页（加载更早历史）的进行态，与首开 historyStatus 相互独立。 */
  earlierHistoryStatus?: 'idle' | 'loading' | 'error'
  streamingText: string
  streamingToolInput: string
  activeToolUseId: string | null
  activeToolName: string | null
  activeThinkingId: string | null
  /** Most recently received request, retained as a compatibility mirror. */
  pendingPermission: PendingPermission | null
  /** Authoritative set of outstanding SDK permission requests, keyed by request id. */
  pendingPermissions?: PendingPermissions
  /** Currently displayed Computer Use request; remaining requests stay queued. */
  pendingComputerUsePermission: PendingComputerUsePermission | null
  pendingComputerUsePermissions?: PendingComputerUsePermissions
  tokenUsage: TokenUsage
  /**
   * Bumped each time a compact boundary arrives. The context usage indicator
   * watches this to force an immediate re-read of the (now much smaller)
   * context instead of waiting for the next API response (#743).
   * Optional: legacy persisted sessions predate the field.
   */
  compactCount?: number
  /**
   * Characters streamed by the assistant during the current turn (text,
   * thinking, tool input). ÷4 approximates output tokens for the streaming
   * indicator — same estimation the CLI spinner uses. Reset on each send.
   */
  streamingResponseChars: number
  /** Boundary used to discard one failed, side-effect-free stream attempt. */
  streamAttemptStartIndex?: number
  streamAttemptStartResponseChars?: number
  elapsedSeconds: number
  /**
   * 当前回合的开始时刻（ms）。读秒由 StreamingIndicator 本地计时器从该
   * 时间戳推算——store 不再每秒 set（v1.3.2 实测：可见但失焦时 1s tick
   * 仍全速重建 sessions map，触发 Sidebar/ActiveSession 全量重渲染）。
   */
  turnStartedAt?: number | null
  statusVerb: string
  apiRetry?: ApiRetryState | null
  // 流式恢复/非流式降级提示（活动回合状态，与 apiRetry 同清除时机）。
  streamingFallback?: StreamingFallbackState | null
  slashCommands: SlashCommandOption[]
  agentTaskNotifications: Record<string, AgentTaskNotification>
  backgroundAgentTasks?: Record<string, BackgroundAgentTask>
  stoppingBackgroundTaskIds?: Record<string, boolean>
  suppressNextTaskNotificationResponse?: boolean
  replaceHistoryOnCompletion?: boolean
  activeGoal?: ActiveGoalState | null
  elapsedTimer: ReturnType<typeof setInterval> | null
  composerPrefill?: {
    text: string
    attachments?: UIAttachment[]
    mode?: ComposerPrefillMode
    nonce: number
  } | null
  composerInsertion?: ComposerReferenceInsertion | null
  composerDraft?: ComposerDraftState | null
  queuedUserMessages?: QueuedUserMessage[]
}

const DEFAULT_SESSION_STATE: PerSessionState = {
  messages: [],
  chatState: 'idle',
  connectionState: 'disconnected',
  connectionSnapshotReady: false,
  historyStatus: 'idle',
  historyError: null,
  historyHasMore: false,
  historyNextBefore: null,
  earlierHistoryStatus: 'idle',
  streamingText: '',
  streamingToolInput: '',
  activeToolUseId: null,
  activeToolName: null,
  activeThinkingId: null,
  pendingPermission: null,
  pendingPermissions: {},
  pendingComputerUsePermission: null,
  pendingComputerUsePermissions: {},
  tokenUsage: { input_tokens: 0, output_tokens: 0 },
  compactCount: 0,
  streamingResponseChars: 0,
  elapsedSeconds: 0,
  turnStartedAt: null,
  statusVerb: '',
  apiRetry: null,
  streamingFallback: null,
  slashCommands: [],
  agentTaskNotifications: {},
  backgroundAgentTasks: {},
  stoppingBackgroundTaskIds: {},
  suppressNextTaskNotificationResponse: false,
  replaceHistoryOnCompletion: false,
  activeGoal: null,
  elapsedTimer: null,
  composerPrefill: null,
  composerInsertion: null,
  composerDraft: null,
  queuedUserMessages: [],
}

function createDefaultSessionState(): PerSessionState {
  return {
    ...DEFAULT_SESSION_STATE,
    messages: [],
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    queuedUserMessages: [],
  }
}

function getPendingPermissionRecord(
  session: Pick<PerSessionState, 'pendingPermission' | 'pendingPermissions'>,
): PendingPermissions {
  const pendingPermissions = { ...(session.pendingPermissions ?? {}) }
  if (session.pendingPermission && !pendingPermissions[session.pendingPermission.requestId]) {
    pendingPermissions[session.pendingPermission.requestId] = session.pendingPermission
  }
  return pendingPermissions
}

function getPendingComputerUsePermissionRecord(
  session: Pick<PerSessionState, 'pendingComputerUsePermission' | 'pendingComputerUsePermissions'>,
): PendingComputerUsePermissions {
  const pendingPermissions = { ...(session.pendingComputerUsePermissions ?? {}) }
  if (
    session.pendingComputerUsePermission &&
    !pendingPermissions[session.pendingComputerUsePermission.requestId]
  ) {
    pendingPermissions[session.pendingComputerUsePermission.requestId] =
      session.pendingComputerUsePermission
  }
  return pendingPermissions
}

function getCurrentComputerUsePermission(
  pendingPermissions: PendingComputerUsePermissions,
  currentPermission: PendingComputerUsePermission | null,
): PendingComputerUsePermission | null {
  return (currentPermission
    ? pendingPermissions[currentPermission.requestId]
    : undefined) ?? Object.values(pendingPermissions)[0] ?? null
}

function hasPendingPermissionRequests(session: PerSessionState): boolean {
  return Object.keys(getPendingPermissionRecord(session)).length > 0 ||
    Object.keys(getPendingComputerUsePermissionRecord(session)).length > 0
}

function getChatStateAfterPermissionResolution(
  session: PerSessionState,
  hasRemainingPermissions: boolean,
  allowed: boolean | undefined,
): ChatState {
  if (hasRemainingPermissions) return 'permission_pending'
  if (allowed === true) return 'tool_executing'
  if (allowed === false) return 'idle'
  return session.chatState === 'permission_pending' ? 'thinking' : session.chatState
}

export function listPendingPermissions(
  session: Pick<PerSessionState, 'pendingPermission' | 'pendingPermissions'> | undefined,
): PendingPermission[] {
  return session ? Object.values(getPendingPermissionRecord(session)) : []
}

export function getPendingPermission(
  session: Pick<PerSessionState, 'pendingPermission' | 'pendingPermissions'> | undefined,
  requestId: string,
): PendingPermission | undefined {
  if (!session) return undefined
  return session.pendingPermissions?.[requestId] ?? (
    session.pendingPermission?.requestId === requestId
      ? session.pendingPermission
      : undefined
  )
}

type ChatStore = {
  sessions: Record<string, PerSessionState>

  getSession: (sessionId: string) => PerSessionState
  connectToSession: (
    sessionId: string,
    options?: {
      prewarm?: boolean
      applyRuntimeSelection?: boolean
    },
  ) => void
  disconnectSession: (sessionId: string) => void
  sendMessage: (
    sessionId: string,
    content: string,
    attachments?: AttachmentRef[],
    options?: { displayContent?: string; displayAttachments?: AttachmentRef[]; hideDisplayContent?: boolean },
  ) => void
  respondToPermission: (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    options?: {
      rule?: string
      updatedInput?: Record<string, unknown>
      denyMessage?: string
      permissionUpdates?: PermissionUpdate[]
    },
  ) => void
  respondToComputerUsePermission: (
    sessionId: string,
    requestId: string,
    response: ComputerUsePermissionResponse,
  ) => void
  setSessionRuntime: (sessionId: string, selection: RuntimeSelection) => void
  setSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void
  stopGeneration: (sessionId: string) => void
  stopBackgroundTask: (sessionId: string, taskId: string) => void
  loadHistory: (sessionId: string) => Promise<void>
  /** v1.5.0：向上翻页加载更早历史（按 historyNextBefore 游标）， prepend 到消息列表头部。 */
  loadEarlierHistory: (sessionId: string) => Promise<void>
  reloadHistory: (
    sessionId: string,
    guard?: {
      messages: UIMessage[]
      backgroundAgentTasks?: Record<string, BackgroundAgentTask>
    },
  ) => Promise<void>
  queueComposerPrefill: (
    sessionId: string,
    prefill: { text: string; attachments?: UIAttachment[]; mode?: ComposerPrefillMode },
  ) => void
  clearComposerPrefill: (sessionId: string, nonce?: number) => void
  queueComposerInsertion: (
    sessionId: string,
    insertion: Omit<ComposerReferenceInsertion, 'nonce'>,
  ) => void
  clearComposerInsertion: (sessionId: string, nonce?: number) => void
  setComposerDraft: (sessionId: string, draft: ComposerDraftState) => void
  clearComposerDraft: (sessionId: string) => void
  queueUserMessage: (
    sessionId: string,
    message: Omit<QueuedUserMessage, 'id' | 'createdAt'>,
  ) => string
  updateQueuedUserMessage: (sessionId: string, messageId: string, content: string) => void
  removeQueuedUserMessage: (sessionId: string, messageId: string) => void
  sendQueuedUserMessage: (sessionId: string, messageId: string) => void
  clearMessages: (sessionId: string) => void
  handleServerMessage: (sessionId: string, msg: ServerMessage) => void
}


function buildBackgroundTaskSessionUpdate(
  session: PerSessionState,
  backgroundAgentTasks: Record<string, BackgroundAgentTask>,
  task: BackgroundAgentTask | undefined,
  timestamp: number,
): Partial<PerSessionState> {
  const messages = task
    ? upsertBackgroundTaskMessage(session.messages, task, timestamp)
    : session.messages

  return {
    backgroundAgentTasks,
    ...(messages !== session.messages ? { messages } : {}),
  }
}

function shouldSuppressTaskNotificationResponse(session: PerSessionState): boolean {
  if (session.chatState !== 'idle') return false
  const lastMessage = session.messages[session.messages.length - 1]
  const hasVisibleActiveOutput =
    session.streamingText.trim().length > 0 ||
    Boolean(session.activeToolUseId)
  return !hasVisibleActiveOutput && lastMessage?.type !== 'user_text'
}

function needsTranscriptIdHydrationRetry(session: PerSessionState | undefined): boolean {
  if (!session || session.chatState !== 'idle') return false

  let currentTurnHasHydratedUser = false
  for (const message of session.messages) {
    if (message.type === 'user_text') {
      currentTurnHasHydratedUser = Boolean(message.transcriptMessageId)
      continue
    }
    if (
      currentTurnHasHydratedUser &&
      message.type === 'assistant_text' &&
      !message.transcriptMessageId
    ) {
      return true
    }
  }

  return false
}

function refreshCompletedTranscriptHistory(
  get: () => ChatStore,
  sessionId: string,
): void {
  void get().loadHistory(sessionId).then(() => {
    if (!needsTranscriptIdHydrationRetry(get().sessions[sessionId])) return
    setTimeout(() => {
      if (!needsTranscriptIdHydrationRetry(get().sessions[sessionId])) return
      void get().loadHistory(sessionId)
    }, 750)
  })
}

function reconcileCompletedTranscriptHistory(
  get: () => ChatStore,
  sessionId: string,
  replaceHistory: boolean,
): void {
  if (!replaceHistory) {
    refreshCompletedTranscriptHistory(get, sessionId)
    return
  }

  const session = get().sessions[sessionId]
  if (!session) return
  void get().reloadHistory(sessionId, {
    messages: session.messages,
    backgroundAgentTasks: session.backgroundAgentTasks,
  })
}

/** Helper: immutably update a specific session within the sessions record */
function updateSessionIn(
  sessions: Record<string, PerSessionState>,
  sessionId: string,
  updater: (s: PerSessionState) => Partial<PerSessionState>,
): Record<string, PerSessionState> {
  const session = sessions[sessionId]
  if (!session) return sessions
  return { ...sessions, [sessionId]: { ...session, ...updater(session) } }
}

type SlashCommandState = PerSessionState['slashCommands'][number]

function normalizeSlashCommand(command: unknown): SlashCommandState | null {
  if (!command || typeof command !== 'object') return null
  const candidate = command as {
    name?: unknown
    description?: unknown
    argumentHint?: unknown
    kind?: unknown
    source?: unknown
  }
  if (typeof candidate.name !== 'string' || !candidate.name) return null
  const kind: SlashCommandKind | undefined =
    candidate.kind === 'command' || candidate.kind === 'skill' || candidate.kind === 'agent'
      ? candidate.kind
      : undefined
  const source: SlashCommandSource | undefined =
    candidate.source === 'user' || candidate.source === 'project' || candidate.source === 'plugin'
      ? candidate.source
      : undefined
  return {
    name: candidate.name,
    description: typeof candidate.description === 'string' ? candidate.description : '',
    ...(typeof candidate.argumentHint === 'string' && candidate.argumentHint
      ? { argumentHint: candidate.argumentHint }
      : {}),
    ...(kind ? { kind } : {}),
    ...(source ? { source } : {}),
  }
}

function normalizeSlashCommandList(commands: ReadonlyArray<unknown>): SlashCommandState[] {
  return commands
    .map(normalizeSlashCommand)
    .filter((command): command is SlashCommandState => command !== null)
}

function mergeSlashCommandUpdates(
  current: ReadonlyArray<SlashCommandState>,
  incoming: ReadonlyArray<SlashCommandState>,
): SlashCommandState[] {
  const merged = new Map<string, SlashCommandState>()
  for (const command of current) {
    if (command.name) merged.set(command.name, command)
  }
  for (const command of incoming) {
    if (!command.name) continue
    const currentCommand = merged.get(command.name)
    merged.set(command.name, {
      ...currentCommand,
      ...command,
      ...(command.kind ?? currentCommand?.kind
        ? { kind: command.kind ?? currentCommand?.kind }
        : {}),
      ...(command.source ?? currentCommand?.source
        ? { source: command.source ?? currentCommand?.source }
        : {}),
    })
  }
  return [...merged.values()]
}


async function fetchAndMapSessionHistory(
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

const historyLoadsInFlight = new Map<string, Promise<void>>()
const earlierHistoryLoadsInFlight = new Map<string, Promise<void>>()

function shouldPrewarmSession(sessionId: string): boolean {
  const knownSession = useSessionStore.getState().sessions.find((session) => session.id === sessionId)
  return knownSession?.messageCount === 0
}

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: {},

  getSession: (sessionId) => get().sessions[sessionId] ?? createDefaultSessionState(),

  connectToSession: (sessionId, options) => {
    void useCLITaskStore.getState().fetchSessionTasks(sessionId)

    const existing = get().sessions[sessionId]
    if (existing && existing.connectionState !== 'disconnected') {
      if (
        existing.messages.length === 0 &&
        (existing.historyStatus === 'idle' || existing.historyStatus === 'error')
      ) {
        void get().loadHistory(sessionId)
      }
      return
    }

    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...createDefaultSessionState(),
          connectionState: 'connecting',
          connectionSnapshotReady: false,
          messages: existing?.messages ?? [],
          activeGoal: existing?.activeGoal ?? null,
          composerDraft: existing?.composerDraft ?? null,
          queuedUserMessages: existing?.queuedUserMessages ?? [],
        },
      },
    }))

    wsManager.clearHandlers(sessionId)
    wsManager.connect(sessionId)
    wsManager.onConnectionState(sessionId, (connectionState) => {
      if (!get().sessions[sessionId]) return
      set((s) => ({
        sessions: updateSessionIn(s.sessions, sessionId, () => ({
          connectionState,
          connectionSnapshotReady: false,
        })),
      }))
    })
    wsManager.onMessage(sessionId, (msg) => {
      if (msg.type === 'connected') {
        set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({
          connectionState: 'connected',
          connectionSnapshotReady: false,
        })) }))
      }
      get().handleServerMessage(sessionId, msg)
    })

    const runtimeSelection = useSessionRuntimeStore.getState().selections[sessionId]
    if (runtimeSelection && options?.applyRuntimeSelection !== false) {
      wsManager.send(sessionId, { type: 'set_runtime_config', ...runtimeSelection })
    }
    if (
      options?.prewarm !== false &&
      !sessionId.startsWith('__') &&
      !useTeamStore.getState().getMemberBySessionId(sessionId) &&
      shouldPrewarmSession(sessionId)
    ) {
      wsManager.send(sessionId, { type: 'prewarm_session' })
    }

    get().loadHistory(sessionId)
    sessionsApi.getSlashCommands(sessionId)
      .then(({ commands }) => {
        if (get().sessions[sessionId]) {
          set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({ slashCommands: commands })) }))
        }
      })
      .catch(() => {
        if (get().sessions[sessionId]) {
          set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({ slashCommands: [] })) }))
        }
      })
  },

  disconnectSession: (sessionId) => {
    const session = get().sessions[sessionId]
    if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
    if (hasPendingDelta(sessionId)) {
      const text = consumePendingDelta(sessionId)
      set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, (sess) => ({ streamingText: sess.streamingText + text })) }))
    }
    clearPendingToolInputDelta(sessionId)
    clearPendingTaskToolUseIds(sessionId)
    clearPendingToolParentUseIds(sessionId)
    earlierHistoryLoadsInFlight.delete(sessionId)
    wsManager.disconnect(sessionId)
    set((s) => {
      const { [sessionId]: _, ...rest } = s.sessions
      return { sessions: rest }
    })
  },

  sendMessage: (sessionId, content, attachments, options) => {
    const isMemberSession = !!useTeamStore.getState().getMemberBySessionId(sessionId)
    const hideDisplayContent = !isMemberSession && options?.hideDisplayContent === true
    const userFacingContent =
      hideDisplayContent
        ? ''
        : options?.displayContent?.trim() || content.trim()
    const modelFacingContent = buildModelContent(content, attachments)
    const visibleAttachments = options?.displayAttachments ?? attachments
    const uiAttachments: UIAttachment[] | undefined =
      visibleAttachments && visibleAttachments.length > 0
        ? visibleAttachments.map((a) => ({
            type: a.type,
            name: a.name || a.path || a.mimeType || a.type,
            path: a.path,
            data: a.data,
            mimeType: a.mimeType,
            lineStart: a.lineStart,
            lineEnd: a.lineEnd,
            diffSide: a.diffSide,
            hunkId: a.hunkId,
            note: a.note,
            quote: a.quote,
          }))
        : undefined

    const taskStore = useCLITaskStore.getState()
    const sessionTasks = taskStore.sessionId === sessionId ? taskStore.tasks : []
    const allTasksDone = sessionTasks.length > 0 && sessionTasks.every((t) => t.status === 'completed')
    const completedTaskSummary = allTasksDone
      ? sessionTasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status, activeForm: t.activeForm }))
      : []

    if (!isMemberSession && allTasksDone) {
      void taskStore.resetCompletedTasks(sessionId)
    }

    if (!isMemberSession) {
      updateOptimisticSessionTitle(sessionId, userFacingContent || content.trim())
    }

    set((s) => {
      const session = s.sessions[sessionId] ?? createDefaultSessionState()
      const bufferedDelta = consumePendingDelta(sessionId)
      const pendingAssistantText = `${session.streamingText}${bufferedDelta}`
      const now = Date.now()

      const newMessages = pendingAssistantText.trim()
        ? appendAssistantTextMessage(session.messages, pendingAssistantText, now)
        : [...session.messages]
      if (!isMemberSession && allTasksDone) {
        newMessages.push({
          id: nextId(),
          type: 'task_summary',
          tasks: completedTaskSummary,
          timestamp: now,
        })
      }
      newMessages.push({
        id: nextId(),
        type: 'user_text',
        content: userFacingContent,
        ...(userFacingContent !== modelFacingContent ? { modelContent: modelFacingContent } : {}),
        attachments: isMemberSession ? undefined : uiAttachments,
        timestamp: now,
        ...(isMemberSession ? { pending: true } : {}),
      })

      if (!isMemberSession && session.elapsedTimer) clearInterval(session.elapsedTimer)

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...session,
            messages: newMessages,
            chatState: 'thinking',
            elapsedSeconds: 0,
            turnStartedAt: isMemberSession ? null : now,
            suppressNextTaskNotificationResponse: false,
            replaceHistoryOnCompletion: false,
            streamingText: '',
            streamingResponseChars: 0,
            statusVerb: isMemberSession ? '' : randomSpinnerVerb(),
            apiRetry: null,
            streamingFallback: null,
            elapsedTimer: null,
            connectionState: isMemberSession ? 'connected' : session.connectionState,
          },
        },
      }
    })

    if (isMemberSession) {
      void useTeamStore.getState().sendMessageToMember(sessionId, userFacingContent)
        .catch((err) => {
          set((s) => ({
            sessions: updateSessionIn(s.sessions, sessionId, (session) => ({
              chatState: 'idle',
              messages: [
                ...session.messages,
                {
                  id: nextId(),
                  type: 'error',
                  message: err instanceof Error ? err.message : String(err),
                  code: 'TEAM_MEMBER_MESSAGE_FAILED',
                  timestamp: Date.now(),
                },
              ],
            })),
          }))
        })
      return
    }

    wsManager.send(sessionId, { type: 'user_message', content, attachments })
  },

  respondToPermission: (sessionId, requestId, allowed, options) => {
    wsManager.send(sessionId, {
      type: 'permission_response',
      requestId,
      allowed,
      ...(options?.rule ? { rule: options.rule } : {}),
      ...(options?.updatedInput ? { updatedInput: options.updatedInput } : {}),
      ...(options?.denyMessage ? { denyMessage: options.denyMessage } : {}),
      ...(options?.permissionUpdates?.length ? { permissionUpdates: options.permissionUpdates } : {}),
    })
    set((s) => ({
      sessions: updateSessionIn(s.sessions, sessionId, (session) => {
        const pendingPermissions = getPendingPermissionRecord(session)
        delete pendingPermissions[requestId]
        const remainingPermissions = Object.values(pendingPermissions)

        return {
          pendingPermissions,
          pendingPermission: remainingPermissions[remainingPermissions.length - 1] ?? null,
          chatState: remainingPermissions.length > 0 ||
            Object.keys(getPendingComputerUsePermissionRecord(session)).length > 0
            ? 'permission_pending'
            : allowed ? 'tool_executing' : 'idle',
        }
      }),
    }))
  },

  respondToComputerUsePermission: (sessionId, requestId, response) => {
    wsManager.send(sessionId, {
      type: 'computer_use_permission_response',
      requestId,
      response,
    })
    set((s) => ({
      sessions: updateSessionIn(s.sessions, sessionId, (session) => {
        const pendingComputerUsePermissions = getPendingComputerUsePermissionRecord(session)
        delete pendingComputerUsePermissions[requestId]
        const remainingPermissions = Object.values(pendingComputerUsePermissions)

        return {
          pendingComputerUsePermissions,
          pendingComputerUsePermission: getCurrentComputerUsePermission(
            pendingComputerUsePermissions,
            session.pendingComputerUsePermission,
          ),
          chatState: Object.keys(getPendingPermissionRecord(session)).length > 0 ||
            remainingPermissions.length > 0
            ? 'permission_pending'
            : response.userConsented === false ? 'idle' : 'tool_executing',
        }
      }),
    }))
  },

  setSessionRuntime: (sessionId, selection) => {
    wsManager.send(sessionId, {
      type: 'set_runtime_config',
      ...selection,
    })
  },

  setSessionPermissionMode: (sessionId, mode) => {
    const session = get().sessions[sessionId]
    if (!session || session.chatState !== 'idle') return
    wsManager.send(sessionId, { type: 'set_permission_mode', mode })
  },

  stopGeneration: (sessionId) => {
    wsManager.send(sessionId, { type: 'stop_generation' })
    const bufferedText = consumePendingDelta(sessionId)
    clearPendingToolInputDelta(sessionId)
    clearPendingTaskToolUseIds(sessionId)
    clearPendingToolParentUseIds(sessionId)
    let hasRunningBackgroundAgents = false
    set((s) => {
      const session = s.sessions[sessionId]
      if (!session) return s
      hasRunningBackgroundAgents = hasRunningBackgroundTasks(session.backgroundAgentTasks)
      if (session.elapsedTimer) clearInterval(session.elapsedTimer)
      const pendingAssistantText = `${session.streamingText}${bufferedText}`
      const messagesWithFlushedText = pendingAssistantText.trim()
        ? appendAssistantTextMessage(session.messages, pendingAssistantText, Date.now())
        : session.messages
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...session,
            messages: markPendingToolUseMessagesStopped(messagesWithFlushedText),
            chatState: 'idle',
            activeToolUseId: null,
            activeToolName: null,
            activeThinkingId: null,
            streamingText: '',
            streamingToolInput: '',
            statusVerb: '',
            pendingPermission: null,
            pendingPermissions: {},
            pendingComputerUsePermission: null,
            pendingComputerUsePermissions: {},
            apiRetry: null,
            streamingFallback: null,
            suppressNextTaskNotificationResponse: false,
            elapsedTimer: null,
            turnStartedAt: null,
          },
        },
      }
    })
    useTabStore.getState().updateTabStatus(sessionId, hasRunningBackgroundAgents ? 'running' : 'idle')
  },

  stopBackgroundTask: (sessionId, taskId) => {
    const session = get().sessions[sessionId]
    const task = session?.backgroundAgentTasks?.[taskId]
    if (!task || task.status !== 'running' || session?.stoppingBackgroundTaskIds?.[taskId]) return

    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, (current) => ({
        stoppingBackgroundTaskIds: {
          ...current.stoppingBackgroundTaskIds,
          [taskId]: true,
        },
      })),
    }))
    wsManager.send(sessionId, { type: 'stop_background_task', taskId })
  },

  loadHistory: async (sessionId) => {
    const existingLoad = historyLoadsInFlight.get(sessionId)
    if (existingLoad) return existingLoad

    let load!: Promise<void>
    load = (async () => {
      try {
        set((state) => {
          const session = state.sessions[sessionId]
          if (!session) return state
          return {
            sessions: updateSessionIn(state.sessions, sessionId, () => ({
              historyStatus: 'loading',
              historyError: null,
            })),
          }
        })
        const {
          uiMessages,
          activeGoal,
          restoredNotifications,
          restoredBackgroundTasks,
          lastTodos,
          hasMessagesAfterTaskCompletion,
          tokenUsage,
          historyHasMore,
          historyNextBefore,
        } = await fetchAndMapSessionHistory(sessionId, { limit: HISTORY_PAGE_SIZE })
        set((state) => {
          const session = state.sessions[sessionId]
          if (!session) return state
          if (session.messages.length > 0) {
            return { sessions: updateSessionIn(state.sessions, sessionId, (s) => ({
              historyStatus: 'ready',
              historyError: null,
              historyHasMore,
              historyNextBefore,
              activeGoal: activeGoal ?? s.activeGoal ?? null,
              agentTaskNotifications: { ...s.agentTaskNotifications, ...restoredNotifications },
              backgroundAgentTasks: mergeBackgroundAgentTaskRecords(
                s.backgroundAgentTasks ?? {},
                restoredBackgroundTasks,
              ),
              tokenUsage: tokenUsage ?? s.tokenUsage,
              messages: mergeRestoredHistoryIntoLiveMessages(
                mergeBackgroundTaskMessages(s.messages, restoredBackgroundTasks),
                uiMessages,
              ),
            })) }
          }
          return { sessions: updateSessionIn(state.sessions, sessionId, (s) => ({
            historyStatus: 'ready',
            historyError: null,
            historyHasMore,
            historyNextBefore,
            messages: mergeBackgroundTaskMessages(uiMessages, restoredBackgroundTasks),
            activeGoal,
            agentTaskNotifications: { ...s.agentTaskNotifications, ...restoredNotifications },
            backgroundAgentTasks: mergeBackgroundAgentTaskRecords(
              s.backgroundAgentTasks ?? {},
              restoredBackgroundTasks,
            ),
            tokenUsage: tokenUsage ?? s.tokenUsage,
          })) }
        })
        // 低16：历史回放只在任务面板还没有该会话数据时播种。
        // 轮询已落地的新值不被历史快照覆盖；窗口化分页后
        // lastTodos=null 只表示「窗口内没有 TodoWrite」，绝不在此清空。
        const taskStore = useCLITaskStore.getState()
        if (
          lastTodos && lastTodos.length > 0
          && taskStore.sessionId === sessionId
          && taskStore.tasks.length === 0
        ) {
          taskStore.setTasksFromTodos(lastTodos, sessionId)
        }
        if (hasMessagesAfterTaskCompletion) {
          useCLITaskStore.getState().markCompletedAndDismissed(sessionId)
        }
      } catch (error) {
        // Session may not have messages yet
        set((state) => {
          const session = state.sessions[sessionId]
          if (!session) return state
          return {
            sessions: updateSessionIn(state.sessions, sessionId, () => ({
              historyStatus: 'error',
              historyError: error instanceof Error ? error.message : String(error),
            })),
          }
        })
      } finally {
        if (historyLoadsInFlight.get(sessionId) === load) {
          historyLoadsInFlight.delete(sessionId)
        }
      }
    })()

    historyLoadsInFlight.set(sessionId, load)
    return load
  },

  loadEarlierHistory: async (sessionId) => {
    const session = get().sessions[sessionId]
    if (!session) return
    if (session.historyHasMore !== true || session.historyNextBefore == null) return
    if (earlierHistoryLoadsInFlight.has(sessionId)) return

    const before = session.historyNextBefore
    let load!: Promise<void>
    load = (async () => {
      try {
        set((state) => {
          if (!state.sessions[sessionId]) return state
          return {
            sessions: updateSessionIn(state.sessions, sessionId, () => ({
              earlierHistoryStatus: 'loading',
            })),
          }
        })
        // 只取消息与分页游标：todos / activeGoal / tokenUsage 等"尾部语义"
        // 派生只由首开窗口驱动，翻旧页时不动它们。
        const page = await fetchAndMapSessionHistory(sessionId, {
          limit: HISTORY_PAGE_SIZE,
          before,
        })
        set((state) => {
          const current = state.sessions[sessionId]
          if (!current) return state
          // 游标在请求期间被并发重置（如重连重载）时放弃本次 prepend，防重复。
          if (current.historyNextBefore !== before) return state
          return {
            sessions: updateSessionIn(state.sessions, sessionId, (s) => ({
              // 服务端游标保证本页严格更老且无重叠，直接前插即可；
              // tool_use/tool_result 配对发生在渲染层（toolResultMap 按
              // toolUseId 关联），跨页天然成立。
              messages: [...page.uiMessages, ...s.messages],
              historyHasMore: page.historyHasMore,
              historyNextBefore: page.historyNextBefore,
              earlierHistoryStatus: 'idle',
            })),
          }
        })
      } catch {
        set((state) => {
          if (!state.sessions[sessionId]) return state
          return {
            sessions: updateSessionIn(state.sessions, sessionId, () => ({
              earlierHistoryStatus: 'error',
            })),
          }
        })
      } finally {
        if (earlierHistoryLoadsInFlight.get(sessionId) === load) {
          earlierHistoryLoadsInFlight.delete(sessionId)
        }
      }
    })()

    earlierHistoryLoadsInFlight.set(sessionId, load)
    return load
  },

  reloadHistory: async (sessionId, guard) => {
    try {
      const {
        uiMessages,
        activeGoal,
        restoredNotifications,
        restoredBackgroundTasks,
        lastTodos,
        hasMessagesAfterTaskCompletion,
        tokenUsage,
      } = await fetchAndMapSessionHistory(sessionId)

      if (guard) {
        const current = get().sessions[sessionId]
        if (
          !current ||
          current.chatState !== 'idle' ||
          current.messages !== guard.messages ||
          current.backgroundAgentTasks !== guard.backgroundAgentTasks
        ) {
          return
        }
      }

      set((state) => {
        const session = state.sessions[sessionId]
        if (!session) return state
        if (session.elapsedTimer) clearInterval(session.elapsedTimer)
        return {
          sessions: updateSessionIn(state.sessions, sessionId, () => ({
            historyStatus: 'ready',
            historyError: null,
            messages: mergeBackgroundTaskMessages(uiMessages, restoredBackgroundTasks),
            activeGoal,
            agentTaskNotifications: restoredNotifications,
            backgroundAgentTasks: restoredBackgroundTasks,
            tokenUsage: tokenUsage ?? session.tokenUsage,
            chatState: 'idle',
            activeThinkingId: null,
            activeToolUseId: null,
            activeToolName: null,
            streamingText: '',
            streamingToolInput: '',
            pendingPermission: null,
            pendingPermissions: {},
            pendingComputerUsePermission: null,
            pendingComputerUsePermissions: {},
            elapsedTimer: null,
            turnStartedAt: null,
            statusVerb: '',
            apiRetry: null,
            streamingFallback: null,
          })),
        }
      })

      // 低16：与 loadHistory 同一约定——历史回放只播种，不覆盖/清空
      // 轮询已落地的任务状态（reload 后 1s 轮询即会给出真值）。
      const reloadTaskStore = useCLITaskStore.getState()
      if (
        lastTodos && lastTodos.length > 0
        && reloadTaskStore.sessionId === sessionId
        && reloadTaskStore.tasks.length === 0
      ) {
        reloadTaskStore.setTasksFromTodos(lastTodos, sessionId)
      }
      if (hasMessagesAfterTaskCompletion) {
        useCLITaskStore.getState().markCompletedAndDismissed(sessionId)
      }
    } catch {
      // Session may not have messages yet
    }
  },

  queueComposerPrefill: (sessionId, prefill) => {
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, () => ({
        composerPrefill: {
          text: prefill.text,
          attachments: prefill.attachments,
          mode: prefill.mode,
          nonce: Date.now(),
        },
      })),
    }))
  },

  clearComposerPrefill: (sessionId, nonce) => {
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, (session) => {
        if (nonce !== undefined && session.composerPrefill?.nonce !== nonce) return {}
        return { composerPrefill: null }
      }),
    }))
  },

  queueComposerInsertion: (sessionId, insertion) => {
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, () => ({
        composerInsertion: {
          ...insertion,
          nonce: Date.now(),
        },
      })),
    }))
  },

  clearComposerInsertion: (sessionId, nonce) => {
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, (session) => {
        if (nonce !== undefined && session.composerInsertion?.nonce !== nonce) return {}
        return { composerInsertion: null }
      }),
    }))
  },

  setComposerDraft: (sessionId, draft) => {
    set((state) => {
      const session = state.sessions[sessionId] ?? createDefaultSessionState()
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            composerDraft: draft,
          },
        },
      }
    })
  },

  clearComposerDraft: (sessionId) => {
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, () => ({
        composerDraft: null,
      })),
    }))
  },

  queueUserMessage: (sessionId, message) => {
    const id = `queued-user-${Date.now()}-${Math.random().toString(36).slice(2)}`
    set((state) => {
      const session = state.sessions[sessionId] ?? createDefaultSessionState()
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            queuedUserMessages: [
              ...(session.queuedUserMessages ?? []),
              {
                ...message,
                id,
                createdAt: Date.now(),
              },
            ],
          },
        },
      }
    })
    return id
  },

  updateQueuedUserMessage: (sessionId, messageId, content) => {
    const nextContent = content.trim()
    if (!nextContent) return
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, (session) => ({
        queuedUserMessages: (session.queuedUserMessages ?? []).map((message) =>
          message.id === messageId
            ? {
                ...message,
                content: replaceQueuedMessageDisplayContent(message, nextContent),
                displayContent: nextContent,
              }
            : message),
      })),
    }))
  },

  removeQueuedUserMessage: (sessionId, messageId) => {
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, (session) => ({
        queuedUserMessages: (session.queuedUserMessages ?? []).filter((message) => message.id !== messageId),
      })),
    }))
  },

  sendQueuedUserMessage: (sessionId, messageId) => {
    const session = get().sessions[sessionId]
    const queuedMessage = (session?.queuedUserMessages ?? []).find((message) => message.id === messageId)
    if (!session || !queuedMessage) return

    if (session.chatState === 'idle') {
      get().removeQueuedUserMessage(sessionId, messageId)
      get().sendMessage(
        sessionId,
        queuedMessage.content,
        queuedMessage.attachments,
        {
          displayContent: queuedMessage.displayContent,
          displayAttachments: queuedMessage.displayAttachments,
        },
      )
      return
    }

    const now = Date.now()
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, (currentSession) => {
        const pendingText = `${currentSession.streamingText}${consumePendingDelta(sessionId)}`
        const baseMessages = pendingText.trim()
          ? appendAssistantTextMessage(currentSession.messages, pendingText, now)
          : currentSession.messages
        return {
          messages: appendOptimisticQueuedUserMessage(baseMessages, queuedMessage, now),
          queuedUserMessages: (currentSession.queuedUserMessages ?? [])
            .filter((message) => message.id !== messageId),
          ...(pendingText.trim() ? { streamingText: '' } : {}),
          suppressNextTaskNotificationResponse: false,
          replaceHistoryOnCompletion: false,
        }
      }),
    }))

    wsManager.send(sessionId, {
      type: 'user_message',
      content: queuedMessage.content,
      attachments: queuedMessage.attachments,
    })
  },

  clearMessages: (sessionId) => {
    clearPendingTaskToolUseIds(sessionId)
    clearPendingToolParentUseIds(sessionId)
    clearPendingToolInputDelta(sessionId)
    set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({
      messages: [],
      activeGoal: null,
      streamingText: '',
      chatState: 'idle',
      apiRetry: null,
      streamingFallback: null,
      suppressNextTaskNotificationResponse: false,
      replaceHistoryOnCompletion: false,
      queuedUserMessages: [],
    })) }))
  },

  handleServerMessage: (sessionId, msg) => {
    const update = (updater: (session: PerSessionState) => Partial<PerSessionState>) => {
      set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, updater) }))
    }
    const ensureTurnStartedAt = () => {
      const session = get().sessions[sessionId]
      // 只记录回合开始时刻，不再起 1s interval 每秒 set——读秒由
      // StreamingIndicator 本地计时器从该时间戳推算（v1.3.2 实测：可见但
      // 失焦时 store 级 tick 仍每秒触发全量订阅方重渲染，document.hidden
      // 不覆盖「失焦但可见」场景）。
      if (!session || session.turnStartedAt != null) return
      update(() => ({ turnStartedAt: Date.now() }))
    }
    const clearTurnClock = () => {
      const session = get().sessions[sessionId]
      if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
      if (!session || (session.elapsedTimer == null && session.turnStartedAt == null)) return
      update(() => ({ elapsedTimer: null, turnStartedAt: null }))
    }

    switch (msg.type) {
      case 'connected':
        break

      case 'session_state': {
        const session = get().sessions[sessionId]
        if (!session) break

        if (msg.turnState === 'running') {
          // Raw deltas are not replayable across a socket gap. Discard the
          // uncommitted attempt instead of appending new deltas (or a missed
          // stream_retry attempt) to stale text/tool JSON. Persisted completed
          // messages are merged back below while the turn remains running.
          consumePendingDelta(sessionId)
          clearPendingToolInputDelta(sessionId)
          clearPendingTaskToolUseIds(sessionId)
          clearPendingToolParentUseIds(sessionId)
          update((current) => {
            const startIndex = Math.max(
              0,
              Math.min(
                current.streamAttemptStartIndex ?? current.messages.length,
                current.messages.length,
              ),
            )
            return {
              messages: [
                ...current.messages.slice(0, startIndex),
                ...current.messages.slice(startIndex).filter((message) =>
                  message.type !== 'assistant_text' &&
                  message.type !== 'thinking' &&
                  !(message.type === 'tool_use' && message.isPending)),
              ],
              chatState: 'thinking',
              streamingText: '',
              streamingToolInput: '',
              activeThinkingId: null,
              activeToolUseId: null,
              activeToolName: null,
              streamingResponseChars:
                current.streamAttemptStartResponseChars ?? current.streamingResponseChars,
              streamAttemptStartIndex: undefined,
              streamAttemptStartResponseChars: undefined,
              apiRetry: null,
              streamingFallback: null,
              statusVerb: '',
              replaceHistoryOnCompletion: true,
            }
          })
          useTabStore.getState().updateTabStatus(sessionId, 'running')
          ensureTurnStartedAt()
          void get().loadHistory(sessionId)
          break
        }

        if (session.chatState === 'idle') break

        const text = `${session.streamingText}${consumePendingDelta(sessionId)}`
        clearPendingToolInputDelta(sessionId)
        clearPendingTaskToolUseIds(sessionId)
        clearPendingToolParentUseIds(sessionId)
        if (session.elapsedTimer) clearInterval(session.elapsedTimer)
        const messagesWithText = text.trim()
          ? appendAssistantTextMessage(session.messages, text, Date.now())
          : session.messages
        update(() => ({
          messages: markPendingToolUseMessagesStopped(messagesWithText),
          chatState: 'idle',
          activeThinkingId: null,
          activeToolUseId: null,
          activeToolName: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          elapsedTimer: null,
          turnStartedAt: null,
          statusVerb: '',
          apiRetry: null,
          streamingFallback: null,
          streamingText: '',
          streamingToolInput: '',
        }))
        const reconciledSession = get().sessions[sessionId]
        const hasRunningBackgroundAgents = hasRunningBackgroundTasks(
          reconciledSession?.backgroundAgentTasks,
        )
        useTabStore.getState().updateTabStatus(
          sessionId,
          hasRunningBackgroundAgents ? 'running' : 'idle',
        )
        // The terminal event may have arrived while this renderer was offline.
        // Replace optimistic/partial state with the persisted transcript.
        if (reconciledSession) {
          void get().reloadHistory(sessionId, {
            messages: reconciledSession.messages,
            backgroundAgentTasks: reconciledSession.backgroundAgentTasks,
          })
        }
        break
      }

      case 'status':
        update((session) => {
          const pendingText = `${session.streamingText}${consumePendingDelta(sessionId)}`
          const hasPendingStreamText =
            session.chatState === 'streaming' && pendingText.trim().length > 0
          // Background task progress can arrive while the assistant is still
          // streaming one markdown reply. Keep that turn intact so we do not
          // split formatting markers (for example backticks/strong markers)
          // across separate bubbles.
          const preserveStreamingTurn = hasPendingStreamText && msg.state !== 'idle' && msg.state !== 'compacting'
          const shouldFlush = hasPendingStreamText && (msg.state === 'idle' || msg.state === 'compacting')
          let nextMessages = session.messages
          if (shouldFlush) {
            nextMessages = appendAssistantTextMessage(nextMessages, pendingText, Date.now())
          }
          if (msg.state === 'compacting') {
            nextMessages = appendOrUpdateTailCompactSummary(
              nextMessages,
              {
                title: 'Context compacted',
                phase: 'compacting',
              },
              Date.now(),
            )
          } else {
            nextMessages = dropTailCompactingCompactSummary(nextMessages)
          }
          return {
            chatState: preserveStreamingTurn ? 'streaming' : msg.state,
            statusVerb: msg.state === 'idle'
              ? ''
              : msg.verb && msg.verb !== 'Thinking'
                ? msg.verb
                : '',
            ...(msg.state === 'idle' ? { activeThinkingId: null } : {}),
            ...(msg.state === 'idle' ? { apiRetry: null, streamingFallback: null } : {}),
            ...(msg.attemptStart ? {
              streamAttemptStartIndex: session.messages.length,
              streamAttemptStartResponseChars: session.streamingResponseChars,
            } : {}),
            ...(nextMessages !== session.messages ? { messages: nextMessages } : {}),
            ...(shouldFlush ? {
              streamingText: '',
            } : pendingText !== session.streamingText ? { streamingText: pendingText } : {}),
          }
        })
        if (msg.state !== 'idle') ensureTurnStartedAt()
        if (msg.state === 'idle') {
          clearTurnClock()
        }
        // Sync tab status
        useTabStore.getState().updateTabStatus(
          sessionId,
          msg.state === 'idle' && !hasRunningBackgroundTasks(get().sessions[sessionId]?.backgroundAgentTasks)
            ? 'idle'
            : 'running',
        )
        break

      case 'permission_mode_changed': {
        // CLI 是权限模式的真相来源。这里把它恢复/切换后的权威值校正到本地镜像。
        // 注意：只更新本地状态，**不要**走 setSessionPermissionMode —— 那会把
        // set_permission_mode 再回发给 CLI 形成回环。未知模式直接忽略，避免
        // 选择器拿到无法渲染的值。
        const KNOWN_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk']
        if (KNOWN_MODES.includes(msg.mode)) {
          useSessionStore.getState().updateSessionPermissionMode(sessionId, msg.mode)
        }
        break
      }

      case 'content_start': {
        const session = get().sessions[sessionId]
        if (!session) break
        if (session.suppressNextTaskNotificationResponse && msg.blockType === 'text') {
          consumePendingDelta(sessionId)
          update(() => ({
            streamingText: '',
            activeThinkingId: null,
            statusVerb: '',
          }))
          break
        }
        if (session.suppressNextTaskNotificationResponse) {
          update(() => ({ suppressNextTaskNotificationResponse: false }))
        }
        const pendingText = `${session.streamingText}${consumePendingDelta(sessionId)}`
        if (msg.blockType !== 'text' && pendingText.trim()) {
          update((s) => ({
            messages: appendAssistantTextMessage(s.messages, pendingText, Date.now()),
            streamingText: '',
          }))
        }
        if (msg.blockType === 'text') {
          update((s) => ({
            ...(pendingText !== s.streamingText ? { streamingText: pendingText } : {}),
            chatState: 'streaming',
            activeThinkingId: null,
            apiRetry: null,
            streamingFallback: null,
          }))
        } else if (msg.blockType === 'tool_use') {
          clearPendingToolInputDelta(sessionId)
          rememberPendingToolParentUseId(sessionId, msg.toolUseId, msg.parentToolUseId)
          const toolUseId = msg.toolUseId ?? null
          const toolName = msg.toolName ?? 'unknown'
          update((s) => ({
            ...(toolUseId
              ? {
                  messages: upsertToolUseMessage(s.messages, toolUseId, (existing) => ({
                    id: existing?.id ?? nextId(),
                    type: 'tool_use',
                    toolName,
                    toolUseId,
                    input: existing?.input ?? {},
                    timestamp: existing?.timestamp ?? Date.now(),
                    parentToolUseId: msg.parentToolUseId ?? existing?.parentToolUseId,
                    isPending: true,
                    partialInput: existing?.partialInput ?? '',
                  })),
                }
              : {}),
            activeToolUseId: toolUseId,
            activeToolName: toolName,
            streamingToolInput: '',
            chatState: 'tool_executing',
            activeThinkingId: null,
            apiRetry: null,
            streamingFallback: null,
          }))
        }
        ensureTurnStartedAt()
        break
      }

      case 'api_retry': {
        const attempt = Math.max(1, Math.trunc(msg.attempt))
        const maxRetries = Math.max(attempt, Math.trunc(msg.maxRetries))
        const retryDelayMs = Math.max(0, Math.trunc(msg.retryDelayMs))
        update((session) => ({
          apiRetry: {
            attempt,
            maxRetries,
            retryDelayMs,
            errorStatus: msg.errorStatus ?? null,
            errorType: msg.errorType,
            errorMessage: msg.errorMessage,
            receivedAt: Date.now(),
          },
          chatState: session.chatState === 'idle' ? 'thinking' : session.chatState,
          activeThinkingId: null,
          statusVerb: '',
        }))
        ensureTurnStartedAt()
        useTabStore.getState().updateTabStatus(sessionId, 'running')
        break
      }

      case 'streaming_fallback': {
        if (msg.cause === 'stream_retry') {
          consumePendingDelta(sessionId)
          clearPendingToolInputDelta(sessionId)
          clearPendingTaskToolUseIds(sessionId)
          clearPendingToolParentUseIds(sessionId)
          update((session) => {
            const startIndex = Math.max(
              0,
              Math.min(
                session.streamAttemptStartIndex ?? session.messages.length,
                session.messages.length,
              ),
            )
            const messages = [
              ...session.messages.slice(0, startIndex),
              ...session.messages.slice(startIndex).filter((message) =>
                message.type !== 'assistant_text' &&
                message.type !== 'thinking' &&
                !(message.type === 'tool_use' && message.isPending)),
            ]
            return {
              messages,
              streamingText: '',
              streamingToolInput: '',
              activeToolUseId: null,
              activeToolName: null,
              activeThinkingId: null,
              streamingResponseChars:
                session.streamAttemptStartResponseChars ?? session.streamingResponseChars,
              streamAttemptStartIndex: undefined,
              streamAttemptStartResponseChars: undefined,
              streamingFallback: null,
              apiRetry: null,
              chatState: 'thinking',
              statusVerb: '',
            }
          })
          ensureTurnStartedAt()
          useTabStore.getState().updateTabStatus(sessionId, 'running')
          break
        }

        // 进入非流式降级阶段：旧的重试横幅（针对失败的流式请求）已过时，
        // 清掉换成降级提示；后续非流式重试到来的 api_retry 会重新接管显示。
        update((session) => ({
          streamingFallback: {
            cause: msg.cause,
            receivedAt: Date.now(),
          },
          apiRetry: null,
          chatState: session.chatState === 'idle' ? 'thinking' : session.chatState,
          activeThinkingId: null,
          statusVerb: '',
        }))
        ensureTurnStartedAt()
        useTabStore.getState().updateTabStatus(sessionId, 'running')
        break
      }

      case 'content_delta':
        if (get().sessions[sessionId]?.suppressNextTaskNotificationResponse) {
          consumePendingDelta(sessionId)
          break
        }
        let receivedLiveDelta = false
        if (msg.text !== undefined) {
          if (!get().sessions[sessionId]) break
          receivedLiveDelta = true
          appendPendingDelta(sessionId, msg.text)
          if (!hasPendingDeltaFlushTimer(sessionId)) {
            const timer = setTimeout(() => {
              const text = peekPendingDelta(sessionId) ?? ''
              dropPendingDelta(sessionId)
              clearPendingDeltaFlushTimer(sessionId)
              update((s) => ({
                streamingText: s.streamingText + text,
                streamingResponseChars: s.streamingResponseChars + text.length,
              }))
            }, 50)
            setPendingDeltaFlushTimer(sessionId, timer)
          }
        }
        if (msg.toolInput !== undefined) {
          receivedLiveDelta = true
          appendPendingToolInputDelta(sessionId, msg.toolInput)
          if (!hasPendingToolInputFlushTimer(sessionId)) {
            const timer = setTimeout(() => {
              const text = consumePendingToolInputDelta(sessionId)
              if (!text) return
              update((s) => {
                const partialInput = s.streamingToolInput + text
                const activeToolUseId = s.activeToolUseId
                return {
                  streamingToolInput: partialInput,
                  streamingResponseChars: s.streamingResponseChars + text.length,
                  ...(activeToolUseId
                    ? {
                        messages: upsertToolUseMessage(s.messages, activeToolUseId, (existing) => {
                          const toolName = existing?.toolName ?? s.activeToolName ?? 'unknown'
                          return {
                            id: existing?.id ?? nextId(),
                            type: 'tool_use',
                            toolName,
                            toolUseId: activeToolUseId,
                            input: buildPartialToolInputPreview(partialInput, existing?.input),
                            timestamp: existing?.timestamp ?? Date.now(),
                            parentToolUseId: existing?.parentToolUseId ?? getPendingToolParentUseId(sessionId, activeToolUseId),
                            isPending: true,
                            partialInput,
                          }
                        }),
                      }
                    : {}),
                }
              })
            }, 50)
            setPendingToolInputFlushTimer(sessionId, timer)
          }
        }
        if (receivedLiveDelta && get().sessions[sessionId]?.chatState !== 'idle') ensureTurnStartedAt()
        break

      case 'thinking': {
        if (get().sessions[sessionId]?.suppressNextTaskNotificationResponse) {
          consumePendingDelta(sessionId)
          update(() => ({
            streamingText: '',
            activeThinkingId: null,
            statusVerb: '',
          }))
          break
        }
        // 重放/空块都不该冒出一个新的「已思考」气泡，也不该把会话拖回 thinking 态
        // 或者启动计时器 —— 那正是"打开一个早就结束的会话，它自己开始输出"的观感。
        let skippedThinkingBlock = false
        update((s) => {
          const pendingText = `${s.streamingText}${consumePendingDelta(sessionId)}`
          const base = pendingText.trim()
            ? appendAssistantTextMessage(s.messages, pendingText, Date.now())
            : s.messages
          // 服务端两个 thinking 发射点都做了非空过滤，但 `&& delta.thinking` 是真值
          // 判断，纯空白仍能漏过来，落到下面就是一个点开什么都没有的空壳气泡。
          if (!msg.text.trim()) {
            skippedThinkingBlock = true
            return { messages: base, streamingText: '' }
          }
          // 真正的重放源已在服务端按 uuid 挡掉（conversationService.isReplayedSdkMessage）。
          // 这里再兜一道：thinking 没有 transcriptMessageId 之类的身份，任何漏网的
          // 重放都只能靠"整块内容与已有 thinking 逐字相同"来认。流式 delta 是碎片，
          // 不会命中；命中的必然是被整块重发的同一段思考。
          if (base.some((message) => message.type === 'thinking' && message.content === msg.text)) {
            skippedThinkingBlock = true
            return { messages: base, streamingText: '' }
          }
          const lastIndex = findStreamMergeTargetIndex(base)
          const last = lastIndex >= 0 ? base[lastIndex] : undefined
          if (last && last.type === 'thinking') {
            const updated = [...base]
            updated[lastIndex] = { ...last, content: last.content + msg.text }
            return {
              messages: updated,
              chatState: 'thinking',
              activeThinkingId: last.id,
              streamingText: '',
              streamingResponseChars: s.streamingResponseChars + msg.text.length,
            }
          }
          const id = nextId()
          return {
            messages: [...base, { id, type: 'thinking', content: msg.text, timestamp: Date.now() }],
            chatState: 'thinking',
            activeThinkingId: id,
            streamingText: '',
            streamingResponseChars: s.streamingResponseChars + msg.text.length,
          }
        })
        if (!skippedThinkingBlock) ensureTurnStartedAt()
        break
      }

      case 'tool_use_complete': {
        clearPendingToolInputDelta(sessionId)
        const session = get().sessions[sessionId]
        const toolName = msg.toolName || session?.activeToolName || 'unknown'
        const toolUseId = msg.toolUseId || session?.activeToolUseId || ''
        const parentToolUseId = msg.parentToolUseId ?? getPendingToolParentUseId(sessionId, toolUseId)
        rememberPendingToolParentUseId(sessionId, toolUseId, parentToolUseId)
        update((s) => {
          // 流式路径上，工具块的 content_start 已经把待定正文冲刷成一条消息了
          // （见 case 'content_start' 里 blockType !== 'text' 的分支）。但整块兜底
          // 路径只发 tool_use_complete、不发 content_start —— 不在这里补一次冲刷，
          // 工具调用前后的两段正文就会跨消息粘成一条。
          const pendingText = `${s.streamingText}${consumePendingDelta(sessionId)}`
          const base = pendingText.trim()
            ? appendAssistantTextMessage(s.messages, pendingText, Date.now())
            : s.messages
          return {
            messages: toolUseId
              ? upsertToolUseMessage(base, toolUseId, (existing) => ({
                  id: existing?.id ?? nextId(),
                  type: 'tool_use',
                  toolName,
                  toolUseId,
                  input: msg.input,
                  timestamp: existing?.timestamp ?? Date.now(),
                  parentToolUseId,
                  isPending: false,
                }))
              : [...base, {
                  id: nextId(), type: 'tool_use', toolName,
                  toolUseId,
                  input: msg.input, timestamp: Date.now(), parentToolUseId,
                  isPending: false,
                }],
            streamingText: '',
            activeToolUseId: null, activeToolName: null, activeThinkingId: null, streamingToolInput: '',
          }
        })
        if (toolName === 'TodoWrite' && Array.isArray((msg.input as any)?.todos)) {
          useCLITaskStore.getState().setTasksFromTodos((msg.input as any).todos, sessionId)
        } else if (TASK_TOOL_NAMES.has(toolName)) {
          const useId = msg.toolUseId || session?.activeToolUseId
          if (useId) addPendingTaskToolUseId(sessionId, useId)
        }
        break
      }

      case 'tool_result': {
        const now = Date.now()
        const pendingParentToolUseId = consumePendingToolParentUseId(sessionId, msg.toolUseId)
        const parentToolUseId = msg.parentToolUseId ?? pendingParentToolUseId
        update((s) => {
          let messages: UIMessage[] = [...s.messages, {
            id: nextId(), type: 'tool_result', toolUseId: msg.toolUseId,
            content: msg.content, isError: msg.isError, timestamp: now, parentToolUseId,
          }]
          let backgroundAgentTasks = s.backgroundAgentTasks ?? {}
          const stoppedTask = msg.isError
            ? null
            : getStoppedBackgroundTaskFromToolResult(s.messages, msg.toolUseId, msg.content)
          if (stoppedTask) {
            backgroundAgentTasks = upsertBackgroundAgentTask(backgroundAgentTasks, stoppedTask, now)
            const task = backgroundAgentTasks[stoppedTask.taskId]
            if (task) {
              messages = upsertBackgroundTaskMessage(messages, task, now)
            }
          }
          return {
            messages,
            ...(stoppedTask ? { backgroundAgentTasks } : {}),
            chatState: hasPendingPermissionRequests(s)
              ? 'permission_pending'
              : 'thinking',
            activeThinkingId: null,
          }
        })
        if (consumePendingTaskToolUseId(sessionId, msg.toolUseId)) {
          useCLITaskStore.getState().refreshTasks(sessionId)
        }
        break
      }

      case 'permission_request':
        notifyDesktop({
          dedupeKey: `permission:${msg.requestId}`,
          cooldownScope: 'permission-prompt',
          requestAttention: true,
          title: 'Claude Code Heihei 需要你的确认',
          body: msg.toolName
            ? `${msg.toolName} 请求执行，正在等待允许。`
            : '有一个工具请求正在等待允许。',
          target: { type: 'session', sessionId },
        })
        update((s) => {
          const pendingPermission: PendingPermission = {
            requestId: msg.requestId,
            toolName: msg.toolName,
            toolUseId: msg.toolUseId,
            input: msg.input,
            description: msg.description,
          }
          const pendingPermissions = {
            ...getPendingPermissionRecord(s),
            [msg.requestId]: pendingPermission,
          }
          const hasPermissionMessage = s.messages.some((message) =>
            message.type === 'permission_request' && message.requestId === msg.requestId)

          return {
            pendingPermission,
            pendingPermissions,
            chatState: 'permission_pending',
            activeThinkingId: null,
            apiRetry: null,
            streamingFallback: null,
            messages:
              msg.toolName === 'AskUserQuestion' || hasPermissionMessage
                ? s.messages
                : [...s.messages, {
                    id: nextId(),
                    type: 'permission_request',
                    requestId: msg.requestId,
                    toolName: msg.toolName,
                    toolUseId: msg.toolUseId,
                    input: msg.input,
                    description: msg.description,
                    timestamp: Date.now(),
                  }],
          }
        })
        break

      case 'computer_use_permission_request':
        notifyDesktop({
          dedupeKey: `computer-use-permission:${msg.requestId}`,
          cooldownScope: 'permission-prompt',
          requestAttention: true,
          title: 'Claude Code Heihei 需要你的确认',
          body: msg.request.reason || 'Computer Use 正在等待允许。',
          target: { type: 'session', sessionId },
        })
        update((session) => {
          const pendingComputerUsePermission = {
            requestId: msg.requestId,
            request: msg.request,
          }
          const pendingComputerUsePermissions = {
            ...getPendingComputerUsePermissionRecord(session),
            [msg.requestId]: pendingComputerUsePermission,
          }
          return {
            pendingComputerUsePermission: getCurrentComputerUsePermission(
              pendingComputerUsePermissions,
              session.pendingComputerUsePermission,
            ),
            pendingComputerUsePermissions,
            chatState: 'permission_pending',
            activeThinkingId: null,
            apiRetry: null,
            streamingFallback: null,
          }
        })
        break

      case 'permission_resolved':
        update((session) => {
          if (msg.permissionType === 'computer_use') {
            const pendingComputerUsePermissions = getPendingComputerUsePermissionRecord(session)
            if (!pendingComputerUsePermissions[msg.requestId]) return {}
            delete pendingComputerUsePermissions[msg.requestId]
            const remainingPermissions = Object.values(pendingComputerUsePermissions)

            return {
              pendingComputerUsePermissions,
              pendingComputerUsePermission: getCurrentComputerUsePermission(
                pendingComputerUsePermissions,
                session.pendingComputerUsePermission,
              ),
              chatState: getChatStateAfterPermissionResolution(
                session,
                Object.keys(getPendingPermissionRecord(session)).length > 0 ||
                  remainingPermissions.length > 0,
                msg.allowed,
              ),
            }
          }

          const pendingPermissions = getPendingPermissionRecord(session)
          if (!pendingPermissions[msg.requestId]) return {}
          delete pendingPermissions[msg.requestId]
          const remainingPermissions = Object.values(pendingPermissions)
          return {
            pendingPermissions,
            pendingPermission: remainingPermissions[remainingPermissions.length - 1] ?? null,
            chatState: getChatStateAfterPermissionResolution(
              session,
              remainingPermissions.length > 0 ||
                Object.keys(getPendingComputerUsePermissionRecord(session)).length > 0,
              msg.allowed,
            ),
          }
        })
        break

      case 'permission_requests_snapshot':
        update((session) => {
          const toolRequestIds = new Set(msg.toolRequestIds)
          const pendingPermissions = Object.fromEntries(
            Object.entries(getPendingPermissionRecord(session))
              .filter(([requestId]) => toolRequestIds.has(requestId)),
          )
          const computerUseRequestIds = new Set(msg.computerUseRequestIds)
          const pendingComputerUsePermissions = Object.fromEntries(
            Object.entries(getPendingComputerUsePermissionRecord(session))
              .filter(([requestId]) => computerUseRequestIds.has(requestId)),
          )
          const remainingPermissions = Object.values(pendingPermissions)
          const remainingComputerUsePermissions = Object.values(pendingComputerUsePermissions)
          const hasRemainingPermissions = remainingPermissions.length > 0 ||
            remainingComputerUsePermissions.length > 0

          const nextChatState = hasRemainingPermissions
            ? 'permission_pending'
            : !msg.turnActive
              ? 'idle'
              : session.chatState === 'idle' || session.chatState === 'permission_pending'
                ? 'thinking'
                : session.chatState

          // C7（v1.5.0）：重连快照判回合已结束（归 idle）时镜像 clearTurnClock——
          // 正常 status:idle 路径会清 turnStartedAt/elapsedTimer，snapshot 分支此前
          // 不清：断连窗口内回合结束后，残留时间戳让下回合 ensureTurnStartedAt
          // 幂等跳过，StreamingIndicator 读秒从上一回合的陈旧时间戳起跳。
          const turnClockReset =
            nextChatState === 'idle' && session.turnStartedAt != null
              ? (() => {
                  if (session.elapsedTimer) clearInterval(session.elapsedTimer)
                  return { elapsedTimer: null, turnStartedAt: null } as const
                })()
              : null

          return {
            connectionSnapshotReady: true,
            pendingPermissions,
            pendingPermission: remainingPermissions[remainingPermissions.length - 1] ?? null,
            pendingComputerUsePermissions,
            pendingComputerUsePermission: getCurrentComputerUsePermission(
              pendingComputerUsePermissions,
              session.pendingComputerUsePermission,
            ),
            chatState: nextChatState,
            ...(turnClockReset ?? {}),
          }
        })
        break

      case 'message_complete': {
        const session = get().sessions[sessionId]
        if (!session) break
        if (consumeAllPendingTaskToolUseIds(sessionId)) {
          const cliTaskStore = useCLITaskStore.getState()
          if (cliTaskStore.sessionId === sessionId) {
            void cliTaskStore.refreshTasks(sessionId)
          }
        }
        if (session.suppressNextTaskNotificationResponse) {
          consumePendingDelta(sessionId)
          clearPendingToolInputDelta(sessionId)
          if (session.elapsedTimer) clearInterval(session.elapsedTimer)
          const hasRunningBackgroundAgents = hasRunningBackgroundTasks(session.backgroundAgentTasks)
          update(() => ({
            tokenUsage: msg.usage,
            chatState: 'idle',
            activeThinkingId: null,
            pendingPermission: null,
            pendingPermissions: {},
            pendingComputerUsePermission: null,
            pendingComputerUsePermissions: {},
            elapsedTimer: null,
            turnStartedAt: null,
            apiRetry: null,
            streamingFallback: null,
            streamingText: '',
            streamingToolInput: '',
            suppressNextTaskNotificationResponse: false,
            replaceHistoryOnCompletion: false,
          }))
          useTabStore.getState().updateTabStatus(sessionId, hasRunningBackgroundAgents ? 'running' : 'idle')
          reconcileCompletedTranscriptHistory(
            get,
            sessionId,
            session.replaceHistoryOnCompletion === true,
          )
          for (const queuedMessage of get().sessions[sessionId]?.queuedUserMessages ?? []) {
            get().sendQueuedUserMessage(sessionId, queuedMessage.id)
          }
          break
        }
        const completedAt = Date.now()
        const wasAgentRunning = session.chatState !== 'idle'
        const text = `${session.streamingText}${consumePendingDelta(sessionId)}`
        let completionMessages = session.messages
        if (text.trim()) {
          completionMessages = appendAssistantTextMessage(session.messages, text, completedAt)
          update(() => ({
            messages: completionMessages,
            streamingText: '',
          }))
        } else if (text !== session.streamingText) {
          update(() => ({ streamingText: text }))
        }
        const appendedCompletionMessage = completionMessages !== session.messages
        const finalMessages = markPendingToolUseMessagesStopped(completionMessages)
        const hasRunningBackgroundAgents = hasRunningBackgroundTasks(session.backgroundAgentTasks)
        if (session.elapsedTimer) clearInterval(session.elapsedTimer)
        update(() => ({
          messages: finalMessages,
          tokenUsage: msg.usage,
          chatState: 'idle',
          activeThinkingId: null,
          pendingPermission: null,
          pendingPermissions: {},
          pendingComputerUsePermission: null,
          pendingComputerUsePermissions: {},
          elapsedTimer: null,
          turnStartedAt: null,
          apiRetry: null,
          streamingFallback: null,
          replaceHistoryOnCompletion: false,
        }))
        useTabStore.getState().updateTabStatus(sessionId, hasRunningBackgroundAgents ? 'running' : 'idle')
        const notification = wasAgentRunning && appendedCompletionMessage
          ? buildAgentCompletionNotification(sessionId, finalMessages, text)
          : null
        if (notification) {
          void notifyDesktop({
            dedupeKey: notification.dedupeKey,
            cooldownScope: 'agent-completion',
            title: notification.title,
            body: notification.body,
            target: { type: 'session', sessionId },
          })
        }
        reconcileCompletedTranscriptHistory(
          get,
          sessionId,
          session.replaceHistoryOnCompletion === true,
        )
        for (const queuedMessage of get().sessions[sessionId]?.queuedUserMessages ?? []) {
          get().sendQueuedUserMessage(sessionId, queuedMessage.id)
        }
        break
      }

      case 'user_message_replay': {
        update((session) => {
          const pendingText = `${session.streamingText}${consumePendingDelta(sessionId)}`
          const baseMessages = pendingText.trim()
            ? appendAssistantTextMessage(session.messages, pendingText, Date.now())
            : session.messages
          return {
            messages: appendReplayedUserMessage(baseMessages, msg.content, Date.now()),
            ...(pendingText.trim() ? { streamingText: '' } : {}),
            activeThinkingId: null,
            suppressNextTaskNotificationResponse: false,
            replaceHistoryOnCompletion: false,
          }
        })
        break
      }

      case 'error':
        update((s) => {
          const pendingText = `${s.streamingText}${consumePendingDelta(sessionId)}`
          let newMessages = s.messages
          if (pendingText.trim()) {
            newMessages = appendAssistantTextMessage(newMessages, pendingText, Date.now())
          }
          newMessages = dropTailCompactingCompactSummary(newMessages)
          newMessages = [
            ...newMessages,
            {
              id: nextId(),
              type: 'error',
              message: msg.message,
              code: msg.code,
              ...(msg.businessErrorCode ? { businessErrorCode: msg.businessErrorCode } : {}),
              timestamp: Date.now(),
            },
          ]
          return {
            messages: newMessages,
            chatState: 'idle',
            activeThinkingId: null,
            streamingText: '',
            statusVerb: '',
            pendingPermission: null,
            pendingPermissions: {},
            pendingComputerUsePermission: null,
            pendingComputerUsePermissions: {},
            apiRetry: null,
            streamingFallback: null,
            suppressNextTaskNotificationResponse: false,
          }
        })
        useTabStore.getState().updateTabStatus(sessionId, 'error')
        {
          const session = get().sessions[sessionId]
          if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
          if (session && (session.elapsedTimer != null || session.turnStartedAt != null)) {
            update(() => ({ elapsedTimer: null, turnStartedAt: null }))
          }
        }
        break

      case 'background_task_stop_failed':
        update((session) => {
          const stoppingBackgroundTaskIds = { ...session.stoppingBackgroundTaskIds }
          delete stoppingBackgroundTaskIds[msg.taskId]
          const taskAlreadyFinished = session.backgroundAgentTasks?.[msg.taskId]?.status !== 'running'
          return {
            stoppingBackgroundTaskIds,
            ...(taskAlreadyFinished ? {} : {
              messages: [
                ...session.messages,
                {
                  id: nextId(),
                  type: 'error',
                  message: msg.message,
                  code: 'STOP_BACKGROUND_TASK_FAILED',
                  timestamp: Date.now(),
                },
              ],
            }),
          }
        })
        break

      case 'team_created':
        useTeamStore.getState().handleTeamCreated(msg.teamName)
        break
      case 'team_update':
        useTeamStore.getState().handleTeamUpdate(msg.teamName, msg.members)
        break
      case 'team_deleted':
        useTeamStore.getState().handleTeamDeleted(msg.teamName)
        break
      case 'task_update':
        break
      case 'session_title_updated':
        useSessionStore.getState().updateSessionTitle(msg.sessionId, msg.title)
        useTabStore.getState().updateTabTitle(msg.sessionId, msg.title)
        break
      case 'system_notification':
        if (msg.subtype === 'slash_commands' && Array.isArray(msg.data)) {
          const incomingCommands = normalizeSlashCommandList(msg.data)
          update((session) => ({
            slashCommands: mergeSlashCommandUpdates(session.slashCommands, incomingCommands),
          }))
          void sessionsApi.getSlashCommands(sessionId)
            .then(({ commands }) => {
              if (!get().sessions[sessionId]) return
              set((s) => ({
                sessions: updateSessionIn(s.sessions, sessionId, () => ({
                  slashCommands: normalizeSlashCommandList(commands),
                })),
              }))
            })
            .catch(() => {
              // Keep the last known local + CLI union when the authoritative refresh is unavailable.
            })
        }
        if (msg.subtype === 'session_cleared') {
          const session = get().sessions[sessionId]
          if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
          update(() => ({
            messages: [],
            streamingText: '',
            streamingToolInput: '',
            activeToolUseId: null,
            activeToolName: null,
            activeThinkingId: null,
            pendingPermission: null,
            pendingPermissions: {},
            pendingComputerUsePermission: null,
            pendingComputerUsePermissions: {},
            chatState: 'idle',
            elapsedTimer: null,
            turnStartedAt: null,
            elapsedSeconds: 0,
            statusVerb: '',
            apiRetry: null,
            streamingFallback: null,
            tokenUsage: { input_tokens: 0, output_tokens: 0 },
            streamingResponseChars: 0,
            slashCommands: [],
            activeGoal: null,
            backgroundAgentTasks: {},
            stoppingBackgroundTaskIds: {},
            agentTaskNotifications: {},
          }))
          clearPendingDelta(sessionId)
          clearPendingTaskToolUseIds(sessionId)
          clearPendingToolParentUseIds(sessionId)
          useCLITaskStore.getState().clearTasks(sessionId)
          useSessionStore.getState().updateSessionTitle(sessionId, 'New Session')
          useSessionStore.getState().updateSessionMessageCount(sessionId, 0)
          useTabStore.getState().updateTabTitle(sessionId, 'New Session')
          useTabStore.getState().updateTabStatus(sessionId, 'idle')
        }
        if (msg.subtype === 'compact_boundary') {
          const metadata = compactMetadataFromUnknown(msg.data)
          update((session) => ({
            chatState: session.chatState === 'compacting' ? 'thinking' : session.chatState,
            statusVerb: session.chatState === 'compacting' ? '' : session.statusVerb,
            compactCount: (session.compactCount ?? 0) + 1,
            messages: appendOrUpdateTailCompactSummary(
              session.messages,
              {
                title: typeof msg.message === 'string' && msg.message.trim()
                  ? msg.message
                  : 'Context compacted',
                phase: 'complete',
                ...metadata,
              },
              Date.now(),
            ),
          }))
        }
        if (msg.subtype === 'compact_summary') {
          const summary = extractCompactSummaryContent(msg.message)
          if (summary) {
            update((session) => ({
              messages: appendOrUpdateTailCompactSummary(
                session.messages,
                {
                  title: 'Context compacted',
                  phase: 'complete',
                  summary,
                  ...compactMetadataFromUnknown(msg.data),
                },
                Date.now(),
              ),
            }))
          }
        }
        if (msg.subtype === 'memory_saved') {
          const files = normalizeMemoryEventFiles(msg.data)
          if (files.length > 0) {
            update((session) => ({
              messages: [
                ...session.messages,
                {
                  id: nextId(),
                  type: 'memory_event',
                  event: 'saved',
                  files,
                  message: msg.message,
                  teamCount: normalizeMemoryTeamCount(msg.data),
                  timestamp: Date.now(),
                },
              ],
            }))
          }
        }
        if (msg.subtype === 'goal_event') {
          const goalEvent = normalizeGoalEventData(msg.data, msg.message)
          if (goalEvent) {
            update((session) => ({
              activeGoal: applyGoalEventToActiveGoal(session.activeGoal ?? null, goalEvent, Date.now()),
              messages: [
                ...session.messages,
                {
                  id: nextId(),
                  type: 'goal_event',
                  ...goalEvent,
                  timestamp: Date.now(),
                },
              ],
            }))
          }
        }
        if ((msg.subtype === 'task_started' || msg.subtype === 'task_progress') && msg.data && typeof msg.data === 'object') {
          const taskEvent = normalizeBackgroundAgentTaskEvent(msg.data, msg.subtype)
          if (taskEvent) {
            const now = Date.now()
            let shouldUpdateIdleTabStatus = false
            let hasRunningBackgroundAgentsAfterUpdate = false
            update((session) => {
              const backgroundAgentTasks = upsertBackgroundAgentTask(
                session.backgroundAgentTasks ?? {},
                taskEvent,
                now,
              )
              shouldUpdateIdleTabStatus = session.chatState === 'idle'
              hasRunningBackgroundAgentsAfterUpdate = hasRunningBackgroundTasks(backgroundAgentTasks)
              const task = backgroundAgentTasks[taskEvent.taskId]
              return buildBackgroundTaskSessionUpdate(session, backgroundAgentTasks, task, now)
            })
            if (shouldUpdateIdleTabStatus) {
              useTabStore.getState().updateTabStatus(
                sessionId,
                hasRunningBackgroundAgentsAfterUpdate ? 'running' : 'idle',
              )
            }
          }
        }
        if (msg.subtype === 'task_notification' && msg.data && typeof msg.data === 'object') {
          const data = msg.data as Record<string, unknown>
          const taskEvent = normalizeBackgroundAgentTaskEvent(data, 'task_notification')
          const toolUseId =
            typeof data.tool_use_id === 'string' && data.tool_use_id.trim()
              ? data.tool_use_id
              : null
          const taskResult = readNonEmptyString(data, 'result')
          const taskStatus = data.status
          if (taskEvent) {
            const now = Date.now()
            let shouldUpdateIdleTabStatus = false
            let hasRunningBackgroundAgentsAfterUpdate = false
            update((session) => {
              const backgroundAgentTasks = upsertBackgroundAgentTask(
                session.backgroundAgentTasks ?? {},
                taskEvent,
                now,
              )
              shouldUpdateIdleTabStatus = session.chatState === 'idle'
              hasRunningBackgroundAgentsAfterUpdate = hasRunningBackgroundTasks(backgroundAgentTasks)
              const task = backgroundAgentTasks[taskEvent.taskId]
              const suppressNotificationResponse =
                (taskEvent.status === 'completed' ||
                  taskEvent.status === 'failed' ||
                  taskEvent.status === 'stopped') &&
                shouldSuppressTaskNotificationResponse(session)
              const stoppingBackgroundTaskIds = { ...session.stoppingBackgroundTaskIds }
              delete stoppingBackgroundTaskIds[taskEvent.taskId]
              return {
                ...buildBackgroundTaskSessionUpdate(session, backgroundAgentTasks, task, now),
                stoppingBackgroundTaskIds,
                ...(suppressNotificationResponse ? { suppressNextTaskNotificationResponse: true } : {}),
                agentTaskNotifications: {
                  ...session.agentTaskNotifications,
                  ...(toolUseId &&
                  (taskStatus === 'completed' ||
                    taskStatus === 'failed' ||
                    taskStatus === 'stopped')
                    ? {
                        [toolUseId]: {
                          taskId: taskEvent.taskId,
                          toolUseId,
                          status: taskStatus,
                          summary: taskEvent.summary,
                          result: taskResult,
                          outputFile: taskEvent.outputFile,
                          usage: taskEvent.usage,
                        },
                      }
                    : {}),
                },
              }
            })
            if (shouldUpdateIdleTabStatus) {
              useTabStore.getState().updateTabStatus(
                sessionId,
                hasRunningBackgroundAgentsAfterUpdate ? 'running' : 'idle',
              )
            }
          }
        }
        break
      case 'pong':
        break
    }
  },
}))

function updateOptimisticSessionTitle(sessionId: string, content: string): void {
  const title = deriveSessionTitle(content)
  if (!title) return

  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
  if (!session || session.messageCount > 0 || !isPlaceholderSessionTitle(session.title)) return

  useSessionStore.getState().updateSessionTitle(sessionId, title)
  useTabStore.getState().updateTabTitle(sessionId, title)
}

function appendOptimisticQueuedUserMessage(
  messages: UIMessage[],
  message: QueuedUserMessage,
  timestamp: number,
): UIMessage[] {
  const displayContent = message.displayContent.trim()
  const modelContent = message.content.trim()
  const attachments = mapQueuedDisplayAttachments(message.displayAttachments)
  if (!displayContent && !attachments) return messages

  return [
    ...messages,
    {
      id: nextId(),
      type: 'user_text',
      content: displayContent,
      ...(modelContent && modelContent !== displayContent ? { modelContent } : {}),
      ...(attachments ? { attachments } : {}),
      timestamp,
      optimisticQueued: true,
    },
  ]
}

function mapQueuedDisplayAttachments(attachments?: AttachmentRef[]): UIAttachment[] | undefined {
  if (!attachments?.length) return undefined
  return attachments.map((attachment) => ({
    type: attachment.type,
    name: attachment.name || attachment.path || attachment.mimeType || attachment.type,
    path: attachment.path,
    data: attachment.data,
    mimeType: attachment.mimeType,
    isDirectory: attachment.isDirectory,
    lineStart: attachment.lineStart,
    lineEnd: attachment.lineEnd,
    diffSide: attachment.diffSide,
    hunkId: attachment.hunkId,
    note: attachment.note,
    quote: attachment.quote,
  }))
}

function replaceQueuedMessageDisplayContent(
  message: QueuedUserMessage,
  nextDisplayContent: string,
): string {
  const currentModelContent = message.content.trim()
  const currentDisplayContent = message.displayContent.trim()
  if (!currentModelContent) return nextDisplayContent
  if (!currentDisplayContent) return `${currentModelContent}\n\n${nextDisplayContent}`
  if (currentModelContent === currentDisplayContent) return nextDisplayContent

  const displaySuffix = `\n\n${currentDisplayContent}`
  if (currentModelContent.endsWith(displaySuffix)) {
    return `${currentModelContent.slice(0, -currentDisplayContent.length)}${nextDisplayContent}`
  }
  if (currentModelContent.endsWith(currentDisplayContent)) {
    return `${currentModelContent.slice(0, -currentDisplayContent.length)}${nextDisplayContent}`
  }
  return `${currentModelContent}\n\n${nextDisplayContent}`
}
