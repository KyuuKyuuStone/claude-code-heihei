import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

vi.mock('../../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onConnectionState: vi.fn((_sessionId: string, handler: (state: string) => void) => {
      handler('connecting')
      return () => {}
    }),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: vi.fn(),
  },
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getMessages: vi.fn(async () => ({ messages: [] })),
    getSlashCommands: vi.fn(async () => ({ commands: [] })),
  },
}))

import { StreamingIndicator } from './StreamingIndicator'
import { useChatStore, type PerSessionState } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'

const ACTIVE_TAB = 'active-tab'

function makeSession(overrides: Partial<PerSessionState> = {}): PerSessionState {
  return {
    messages: [],
    chatState: 'streaming',
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

describe('StreamingIndicator', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({
      activeTabId: ACTIVE_TAB,
      tabs: [{ sessionId: ACTIVE_TAB, title: 'Test', type: 'session', status: 'running' }],
    })
  })

  // issue #757: token usage is rendered with the shared compact notation and
  // an explicit unit instead of a bare number.
  it('renders the current turn token estimate as "↓ N tokens"', () => {
    useChatStore.setState({
      sessions: {
        // 8976 streamed chars ÷ 4 = 2244 tokens → "2.2k tokens"
        [ACTIVE_TAB]: makeSession({ streamingResponseChars: 8976 }),
      },
    })

    render(<StreamingIndicator />)

    expect(screen.getByText(/↓ 2\.2k tokens/)).toBeTruthy()
  })

  it('derives the elapsed readout from turnStartedAt via a local ticker, leaving the store untouched', () => {
    // v1.3.2 回归：读秒改由本组件本地计时器从 turnStartedAt 推算；
    // store 不再有每秒 set（后台/失焦时零高频重渲染），读秒语义不变。
    vi.useFakeTimers()
    try {
      const startedAt = Date.now()
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSession({ chatState: 'thinking', turnStartedAt: startedAt }),
        },
      })

      render(<StreamingIndicator />)

      const sessionsBefore = useChatStore.getState().sessions
      act(() => {
        vi.advanceTimersByTime(5000)
      })

      expect(screen.getByText('5s')).toBeTruthy()
      // 本地 tick 只重渲染本组件：chatStore 完全没被碰过。
      expect(useChatStore.getState().sessions).toBe(sessionsBefore)
      expect(useChatStore.getState().sessions[ACTIVE_TAB]?.elapsedSeconds).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides the token estimate until this turn has streamed output', () => {
    useChatStore.setState({
      sessions: {
        // Previous-turn usage must not leak into the indicator (issue #757
        // follow-up report: the count showed a stale value from the last turn).
        [ACTIVE_TAB]: makeSession({
          tokenUsage: { input_tokens: 5000, output_tokens: 6240 },
        }),
      },
    })

    render(<StreamingIndicator />)

    expect(screen.queryByText(/tokens/)).toBeNull()
  })

  it('shows the non-streaming fallback notice while waiting for the one-shot response', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSession({
          chatState: 'thinking',
          streamingFallback: { cause: 'watchdog', receivedAt: Date.now() },
          elapsedSeconds: 95,
        }),
      },
    })

    render(<StreamingIndicator />)

    const notice = screen.getByTestId('streaming-fallback-indicator')
    expect(notice.textContent).toContain('switched to non-streaming mode')
    // 回合计时保留，证明"还在跑"而不是卡死。
    expect(notice.textContent).toContain('1m 35s')
  })

  it('prefers the retry banner over the fallback notice when both are active', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSession({
          chatState: 'thinking',
          apiRetry: {
            attempt: 2,
            maxRetries: 10,
            retryDelayMs: 60_000,
            errorStatus: 529,
            receivedAt: Date.now(),
          },
          streamingFallback: { cause: 'stream_error', receivedAt: Date.now() },
        }),
      },
    })

    render(<StreamingIndicator />)

    // api_retry 携带更具体的进度（第 N 次/倒计时），优先级高于泛化的降级提示。
    expect(screen.getByTestId('api-retry-indicator')).toBeTruthy()
    expect(screen.queryByTestId('streaming-fallback-indicator')).toBeNull()
  })

  it('switches the retry banner from a countdown to "retrying now" once the delay elapses', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSession({
          chatState: 'thinking',
          apiRetry: {
            attempt: 3,
            maxRetries: 10,
            retryDelayMs: 1000,
            errorStatus: null,
            // 倒计时早已结束：请求已在途，不该再显示"waiting 0s"。
            receivedAt: Date.now() - 10_000,
          },
        }),
      },
    })

    render(<StreamingIndicator />)

    const banner = screen.getByTestId('api-retry-indicator')
    expect(banner.textContent).toContain('retrying now')
    expect(banner.textContent).not.toContain('waiting')
  })
})
