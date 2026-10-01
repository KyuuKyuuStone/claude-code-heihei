/**
 * chatStore 消息回放快照测试（v1.7.0 结构拆分前置设施）。
 *
 * 目的：chatStore 开拆前，把「事件/历史序列 → 可观察输出」的当前行为冻结成
 * 快照，让后续拆分「只移动代码、不改行为」可以被机器验证。断言全部落在
 * 行为输出上（序列化的会话状态 / 消息数组），不断言函数存在或调用次数。
 *
 * 稳定化（不放宽断言）：
 * - 固定时钟：vi.useFakeTimers + vi.setSystemTime 固定 Date.now()；
 *   content_delta 的 50ms 合并节流用 advanceTimersByTimeAsync 确定性触发。
 * - store 内部 id（msg-N-<ts>、queued-user-<ts>-<rand>）依赖计数器与时间戳，
 *   快照序列化器按「首次出现顺序」映射成 #m1/#q1 等稳定序号；服务端提供的
 *   id（toolUseId / requestId / transcriptMessageId）原样保留。
 * - randomSpinnerVerb（sendMessage 时随机选词）→ 序列化为 '<verb>'。
 * - elapsedTimer（interval 句柄）→ 不属于可观察输出，丢弃。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageEntry } from '../types/session'
import type { UIMessage } from '../types/chat'
import { useSessionRuntimeStore } from './sessionRuntimeStore'

const {
  sendMock,
  sendMessageToMemberMock,
  handleTeamCreatedMock,
  handleTeamUpdateMock,
  handleTeamDeletedMock,
  fetchSessionTasksMock,
  clearTasksMock,
  setTasksFromTodosMock,
  markCompletedAndDismissedMock,
  resetCompletedTasksMock,
  refreshTasksMock,
  notifyDesktopMock,
  updateTabTitleMock,
  updateTabStatusMock,
  updateSessionTitleMock,
  updateSessionMessageCountMock,
  updateSessionPermissionModeMock,
  sessionStoreSnapshot,
  cliTaskStoreSnapshot,
} = vi.hoisted(() => ({
  sendMock: vi.fn(),
  sendMessageToMemberMock: vi.fn(async () => {}),
  handleTeamCreatedMock: vi.fn(),
  handleTeamUpdateMock: vi.fn(),
  handleTeamDeletedMock: vi.fn(),
  fetchSessionTasksMock: vi.fn(),
  clearTasksMock: vi.fn(),
  setTasksFromTodosMock: vi.fn(),
  markCompletedAndDismissedMock: vi.fn(),
  resetCompletedTasksMock: vi.fn(async () => {}),
  refreshTasksMock: vi.fn(),
  notifyDesktopMock: vi.fn(),
  updateTabTitleMock: vi.fn(),
  updateTabStatusMock: vi.fn(),
  updateSessionTitleMock: vi.fn(),
  updateSessionMessageCountMock: vi.fn(),
  updateSessionPermissionModeMock: vi.fn(),
  sessionStoreSnapshot: {
    sessions: [] as Array<{
      id: string
      title: string
      createdAt: string
      modifiedAt: string
      messageCount: number
      projectPath: string
      workDir: string | null
      workDirExists: boolean
    }>,
  },
  cliTaskStoreSnapshot: {
    tasks: [] as Array<{ id: string; subject: string; status: string; activeForm?: string }>,
    sessionId: null as string | null,
  },
}))

vi.mock('../lib/desktopNotifications', () => ({
  notifyDesktop: notifyDesktopMock,
}))

vi.mock('../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onConnectionState: vi.fn(() => () => {}),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: sendMock,
  },
}))

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    getMessages: vi.fn(async () => ({ messages: [] })),
    getSlashCommands: vi.fn(async () => ({ commands: [] })),
  },
}))

vi.mock('./teamStore', () => ({
  useTeamStore: {
    getState: () => ({
      getMemberBySessionId: vi.fn(() => null),
      sendMessageToMember: sendMessageToMemberMock,
      handleTeamCreated: handleTeamCreatedMock,
      handleTeamUpdate: handleTeamUpdateMock,
      handleTeamDeleted: handleTeamDeletedMock,
    }),
  },
}))

vi.mock('./tabStore', () => ({
  useTabStore: {
    getState: () => ({
      updateTabStatus: updateTabStatusMock,
      updateTabTitle: updateTabTitleMock,
    }),
  },
}))

vi.mock('./sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      sessions: sessionStoreSnapshot.sessions,
      updateSessionTitle: updateSessionTitleMock,
      updateSessionMessageCount: updateSessionMessageCountMock,
      updateSessionPermissionMode: updateSessionPermissionModeMock,
    }),
  },
}))

vi.mock('./cliTaskStore', () => ({
  useCLITaskStore: {
    getState: () => ({
      fetchSessionTasks: fetchSessionTasksMock,
      tasks: cliTaskStoreSnapshot.tasks,
      sessionId: cliTaskStoreSnapshot.sessionId,
      clearTasks: clearTasksMock,
      setTasksFromTodos: setTasksFromTodosMock,
      markCompletedAndDismissed: markCompletedAndDismissedMock,
      resetCompletedTasks: resetCompletedTasksMock,
      refreshTasks: refreshTasksMock,
    }),
  },
}))

import { sessionsApi } from '../api/sessions'
import { useSettingsStore } from './settingsStore'
import {
  mapHistoryMessagesToUiMessages,
  type PerSessionState,
  useChatStore,
} from './chatStore'

const SID = 'replay-session'
const initialState = useChatStore.getState()

function makeSession(overrides: Partial<PerSessionState> = {}): PerSessionState {
  return {
    messages: [],
    chatState: 'idle',
    connectionState: 'connected',
    historyStatus: 'idle',
    historyError: null,
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    streamingResponseChars: 0,
    elapsedSeconds: 0,
    statusVerb: '',
    apiRetry: null,
    slashCommands: [],
    agentTaskNotifications: {},
    backgroundAgentTasks: {},
    elapsedTimer: null,
    ...overrides,
  }
}

// ── 稳定化序列化器 ─────────────────────────────────────────────────────────

const TS = '<ts>'

function makeStableIdMapper(prefix: string): (id: string) => string {
  const ids = new Map<string, string>()
  return (id: string) => {
    if (!ids.has(id)) ids.set(id, `${prefix}${ids.size + 1}`)
    return ids.get(id)!
  }
}

function normalizeMessage(message: UIMessage, stableId: (id: string) => string): Record<string, unknown> {
  return { ...message, id: stableId(message.id), timestamp: TS }
}

/** 会话可观察输出的确定性投影（id/时间戳/随机词稳定化，其余全部保留）。 */
function serializeSession(sessionId: string): Record<string, unknown> | null {
  const session = useChatStore.getState().sessions[sessionId]
  if (!session) return null
  const stableId = makeStableIdMapper('#m')
  const stableQueuedId = makeStableIdMapper('#q')
  return {
    chatState: session.chatState,
    connectionState: session.connectionState,
    historyStatus: session.historyStatus,
    historyHasMore: session.historyHasMore,
    historyNextBefore: session.historyNextBefore,
    streamingText: session.streamingText,
    streamingToolInput: session.streamingToolInput,
    streamingResponseChars: session.streamingResponseChars,
    activeToolUseId: session.activeToolUseId,
    activeToolName: session.activeToolName,
    activeThinkingId: session.activeThinkingId == null ? null : stableId(session.activeThinkingId),
    pendingPermission: session.pendingPermission,
    pendingPermissions: session.pendingPermissions,
    pendingComputerUsePermission: session.pendingComputerUsePermission,
    tokenUsage: session.tokenUsage,
    compactCount: session.compactCount,
    apiRetry: session.apiRetry ? { ...session.apiRetry, receivedAt: TS } : null,
    streamingFallback: session.streamingFallback
      ? { ...session.streamingFallback, receivedAt: TS }
      : null,
    turnStartedAt: session.turnStartedAt == null ? null : TS,
    statusVerb: session.statusVerb ? '<verb>' : '',
    queuedUserMessages: (session.queuedUserMessages ?? []).map((queued) => ({
      ...queued,
      id: stableQueuedId(queued.id),
      createdAt: TS,
    })),
    messages: session.messages.map((message) => normalizeMessage(message, stableId)),
  }
}

/** 让 message_complete 触发的异步 loadHistory（空历史 → 恒等合并）在快照前落定。 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(1000)
  await Promise.resolve()
}

/** 触发 content_delta 的 50ms 合并节流，得到确定性的流式中间态。 */
async function flushDeltas(): Promise<void> {
  await vi.advanceTimersByTimeAsync(60)
}

function emit(store: ReturnType<typeof useChatStore.getState>, msg: Parameters<typeof store.handleServerMessage>[1]): void {
  store.handleServerMessage(SID, msg)
}

// ── 场景 ───────────────────────────────────────────────────────────────────

describe('chatStore 消息回放快照', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T08:00:00.000Z'))
    sendMock.mockReset()
    notifyDesktopMock.mockReset()
    updateTabStatusMock.mockReset()
    updateTabTitleMock.mockReset()
    updateSessionTitleMock.mockReset()
    updateSessionMessageCountMock.mockReset()
    updateSessionPermissionModeMock.mockReset()
    vi.mocked(sessionsApi.getMessages).mockReset()
    vi.mocked(sessionsApi.getMessages).mockResolvedValue({ messages: [] })
    sessionStoreSnapshot.sessions = []
    cliTaskStoreSnapshot.tasks = []
    cliTaskStoreSnapshot.sessionId = null
    useSessionRuntimeStore.setState({ selections: {} })
    localStorage.clear()
    useSettingsStore.setState({ locale: 'en' })
    useChatStore.setState({ ...initialState, sessions: { [SID]: makeSession() } })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('完整回合回放：思考合并 → 流式文本 → 工具增量预览 → 工具结果 → 完成冲刷', async () => {
    const store = useChatStore.getState()
    emit(store, { type: 'thinking', text: 'Let me inspect. ' })
    emit(store, { type: 'thinking', text: 'Now reading the file.' })
    emit(store, { type: 'content_start', blockType: 'text' })
    emit(store, { type: 'content_delta', text: 'Here is ' })
    emit(store, { type: 'content_delta', text: 'what I ' })
    emit(store, { type: 'content_delta', text: 'found. ' })
    await flushDeltas()
    emit(store, { type: 'content_start', blockType: 'tool_use', toolName: 'Read', toolUseId: 'toolu_read_1' })
    emit(store, { type: 'content_delta', toolInput: '{"file_path":"/src/log' })
    await flushDeltas()
    emit(store, { type: 'content_delta', toolInput: 'in.ts"}' })
    await flushDeltas()
    emit(store, { type: 'tool_use_complete', toolName: 'Read', toolUseId: 'toolu_read_1', input: { file_path: '/src/login.ts' } })
    emit(store, { type: 'tool_result', toolUseId: 'toolu_read_1', content: 'export function login(){}', isError: false })
    emit(store, { type: 'message_complete', usage: { input_tokens: 7, output_tokens: 3 } })
    await settle()

    expect(serializeSession(SID)).toMatchSnapshot()
  })

  it('并行工具失败结算：失败结果保留，兄弟工具标记 stopped', async () => {
    const store = useChatStore.getState()
    emit(store, { type: 'content_start', blockType: 'tool_use', toolName: 'Grep', toolUseId: 'grep-1' })
    emit(store, { type: 'tool_use_complete', toolName: 'Grep', toolUseId: 'grep-1', input: { pattern: 'needle' } })
    emit(store, { type: 'content_start', blockType: 'tool_use', toolName: 'Read', toolUseId: 'read-1' })
    emit(store, { type: 'tool_use_complete', toolName: 'Read', toolUseId: 'read-1', input: { file_path: '/missing.md' } })
    emit(store, { type: 'tool_result', toolUseId: 'read-1', content: 'File does not exist', isError: true })
    emit(store, { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 0 } })
    await settle()

    expect(serializeSession(SID)).toMatchSnapshot()
  })

  it('后台子代理活动不打断主回复合并（#1108 语义）', async () => {
    const store = useChatStore.getState()
    emit(store, { type: 'content_start', blockType: 'text' })
    emit(store, { type: 'content_delta', text: 'First half. ' })
    await flushDeltas()
    emit(store, { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } })
    await settle()
    emit(store, { type: 'tool_use_complete', toolName: 'Grep', toolUseId: 'child-1', input: { pattern: 'needle' }, parentToolUseId: 'agent-1' })
    emit(store, { type: 'tool_result', toolUseId: 'child-1', content: 'match', isError: false, parentToolUseId: 'agent-1' })
    emit(store, { type: 'content_start', blockType: 'text' })
    emit(store, { type: 'content_delta', text: 'Second half.' })
    await flushDeltas()
    emit(store, { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } })
    await settle()

    expect(serializeSession(SID)).toMatchSnapshot()
  })

  it('用户消息、附件与队列生命周期', async () => {
    const store = useChatStore.getState()
    const attachment = { type: 'file' as const, name: 'notes.md', path: '/workspace/notes.md' }
    store.sendMessage(SID, 'Check this', [attachment], { displayContent: 'Check this', displayAttachments: [attachment] })
    expect(sendMock).toHaveBeenCalledWith(SID, {
      type: 'user_message',
      content: 'Check this',
      attachments: [attachment],
    })

    const queuedId = store.queueUserMessage(SID, { content: 'queued-raw', displayContent: 'Queued display' })
    store.updateQueuedUserMessage(SID, queuedId, 'Queued display edited')
    expect(serializeSession(SID)).toMatchSnapshot('queued after update')

    store.removeQueuedUserMessage(SID, queuedId)
    const secondQueuedId = store.queueUserMessage(SID, { content: 'queued-send', displayContent: 'Queued send' })
    store.sendQueuedUserMessage(SID, secondQueuedId)
    expect(serializeSession(SID)).toMatchSnapshot('after queued send')
  })

  it('中断：stopGeneration 冲刷未提交文本并停挂起工具', async () => {
    const store = useChatStore.getState()
    emit(store, { type: 'content_start', blockType: 'text' })
    emit(store, { type: 'content_delta', text: 'Partial answer ' })
    emit(store, { type: 'content_start', blockType: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_stop_1' })
    store.stopGeneration(SID)
    expect(sendMock).toHaveBeenCalledWith(SID, { type: 'stop_generation' })

    expect(serializeSession(SID)).toMatchSnapshot()
  })

  it('api_retry 设置重试横幅状态', async () => {
    const store = useChatStore.getState()
    emit(store, {
      type: 'api_retry',
      attempt: 2,
      maxRetries: 5,
      retryDelayMs: 1200,
      errorStatus: 429,
      errorType: 'rate_limit_error',
      errorMessage: 'Too many requests',
    })

    expect(serializeSession(SID)).toMatchSnapshot()
  })

  it('stream_retry 丢弃未提交的尝试（含挂起工具）', async () => {
    const store = useChatStore.getState()
    emit(store, { type: 'thinking', text: 'Stable thought. ' })
    emit(store, { type: 'status', state: 'thinking', attemptStart: true })
    emit(store, { type: 'thinking', text: 'Attempt thinking. ' })
    emit(store, { type: 'content_start', blockType: 'tool_use', toolName: 'Read', toolUseId: 'toolu_drop_1' })
    emit(store, { type: 'streaming_fallback', cause: 'stream_retry' })

    expect(serializeSession(SID)).toMatchSnapshot()
  })

  it('error 终态：冲刷正文 + 错误消息 + 状态复位', async () => {
    const store = useChatStore.getState()
    emit(store, { type: 'content_start', blockType: 'text' })
    emit(store, { type: 'content_delta', text: 'will not survive' })
    emit(store, { type: 'error', message: 'Upstream overloaded', code: 'API_ERROR', retryable: false })

    expect(serializeSession(SID)).toMatchSnapshot()
  })

  it('乱序到达：工具结果先于工具块', async () => {
    const store = useChatStore.getState()
    emit(store, { type: 'tool_result', toolUseId: 'toolu_late_1', content: 'late result', isError: false })
    emit(store, { type: 'content_start', blockType: 'tool_use', toolName: 'Read', toolUseId: 'toolu_late_1' })
    emit(store, { type: 'tool_use_complete', toolName: 'Read', toolUseId: 'toolu_late_1', input: { file_path: '/src/a.ts' } })
    emit(store, { type: 'message_complete', usage: { input_tokens: 2, output_tokens: 2 } })
    await settle()

    expect(serializeSession(SID)).toMatchSnapshot()
  })

  it('迟到 thinking 与重放去重的最终态', async () => {
    const seed: UIMessage = {
      id: 'seed-1',
      type: 'assistant_text',
      content: 'Hello world',
      transcriptMessageId: 't1',
      timestamp: 0,
    }
    useChatStore.setState({
      sessions: { [SID]: makeSession({ messages: [seed] }) },
    })
    const store = useChatStore.getState()
    emit(store, { type: 'content_start', blockType: 'text' })
    emit(store, { type: 'content_delta', text: 'Hello world' })
    await flushDeltas()
    emit(store, { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } })
    await settle()
    emit(store, { type: 'thinking', text: 'Late thought.' })

    const messages = useChatStore.getState().sessions[SID]?.messages ?? []
    expect(messages).toHaveLength(2)
    expect(serializeSession(SID)).toMatchSnapshot()
  })

  it('compact 续接卡片与权限请求/解决的最终态', async () => {
    const store = useChatStore.getState()
    emit(store, {
      type: 'system_notification',
      subtype: 'compact_boundary',
      message: 'Manual compact',
      data: { trigger: 'manual', preTokens: 48000, messagesSummarized: 42 },
    })
    emit(store, {
      type: 'system_notification',
      subtype: 'compact_summary',
      message:
        'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nContinuation summary of earlier work.\n\nIf you need specific details from before compaction, see the summary above.',
      data: { trigger: 'auto', preTokens: 51200, messagesSummarized: 50 },
    })
    emit(store, {
      type: 'permission_request',
      requestId: 'perm_1',
      toolName: 'Bash',
      toolUseId: 'toolu_bash_1',
      input: { command: 'ls' },
      description: 'List files',
    })
    emit(store, { type: 'permission_resolved', requestId: 'perm_1', permissionType: 'tool', allowed: true })
    emit(store, { type: 'permission_resolved', requestId: 'perm_unknown', permissionType: 'tool', allowed: false })

    expect(serializeSession(SID)).toMatchSnapshot()
  })

  it('真实历史序列回放：mapHistoryMessagesToUiMessages', () => {
    const history: MessageEntry[] = [
      { id: 'u1', type: 'user', content: 'Fix the login bug', timestamp: '2026-09-30T08:00:00.000Z' },
      {
        id: 'a1',
        type: 'assistant',
        timestamp: '2026-09-30T08:00:05.000Z',
        content: [
          { type: 'thinking', thinking: 'Check auth flow first.' },
          { type: 'text', text: 'I will look at the login module.' },
          { type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: '/src/login.ts' } },
        ],
      },
      {
        id: 'u2',
        type: 'user',
        timestamp: '2026-09-30T08:00:09.000Z',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_read_1', content: 'export function login(){}' },
        ],
      },
      {
        id: 'a2',
        type: 'assistant',
        timestamp: '2026-09-30T08:00:12.000Z',
        content: 'The login function is here.',
        model: 'claude-sonnet-5',
      },
      {
        id: 'u3',
        type: 'user',
        timestamp: '2026-09-30T08:01:00.000Z',
        content: [
          { type: 'text', text: 'Here is the screenshot.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aWNvbg==' } },
        ],
      },
      {
        id: 'u4',
        type: 'user',
        timestamp: '2026-09-30T08:02:00.000Z',
        content:
          'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nEarlier work summary.\n\nIf you need specific details from before compaction, see the summary above.',
      },
      { id: 's1', type: 'system', content: 'Conversation compacted', timestamp: '2026-09-30T08:02:01.000Z' },
      {
        id: 'u5',
        type: 'user',
        timestamp: '2026-09-30T08:03:00.000Z',
        content: '<teammate-message teammate_id="worker-a">Worker report body</teammate-message>',
      },
    ]

    const uiMessages = mapHistoryMessagesToUiMessages(history)
    const stableId = makeStableIdMapper('#m')
    const normalized = uiMessages.map((message) => normalizeMessage(message, stableId))
    expect(normalized).toMatchSnapshot()
  })
})
