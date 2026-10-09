import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const { sessionsApiMock, skillsApiMock, chatStoreMock } = vi.hoisted(() => ({
  sessionsApiMock: {
    getInspection: vi.fn(),
  },
  skillsApiMock: {
    list: vi.fn(),
  },
  chatStoreMock: {
    state: {
      sessions: {} as Record<string, { chatState?: string; compactCount?: number }>,
      sendMessage: vi.fn(),
    },
  },
}))

vi.mock('../../stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(chatStoreMock.state),
    { getState: () => chatStoreMock.state },
  ),
}))

vi.mock('../../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/sessions')>()
  return {
    ...actual,
    sessionsApi: {
      getInspection: sessionsApiMock.getInspection,
    },
  }
})

vi.mock('../../api/skills', () => ({
  skillsApi: {
    list: skillsApiMock.list,
  },
}))

import { LocalSlashCommandPanel } from './LocalSlashCommandPanel'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore, SETTINGS_TAB_ID } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useSkillStore } from '../../stores/skillStore'
import type { SessionContextSnapshot, SessionInspectionResponse } from '../../api/sessions'

const baseContext: SessionContextSnapshot = {
  categories: [
    {
      name: 'memory',
      tokens: 120,
      color: '#14b8a6',
    },
  ],
  totalTokens: 120,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 0.06,
  gridRows: [],
  model: 'Claude Test',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  messageBreakdown: {
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 0,
    assistantMessageTokens: 0,
    userMessageTokens: 0,
    toolCallsByType: [],
    attachmentsByType: [],
  },
}

function inspectionWithContext(context: SessionContextSnapshot): SessionInspectionResponse {
  return {
    active: true,
    status: {
      sessionId: 'session-1',
      workDir: '/workspace/demo',
      permissionMode: 'default',
      model: 'Claude Test',
      tools: [],
      mcpServers: [],
    },
    context,
  }
}

describe('LocalSlashCommandPanel context compaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatStoreMock.state.sessions = {}
    useSettingsStore.setState({ locale: 'en' })
  })

  const nearLimitContext: SessionContextSnapshot = {
    ...baseContext,
    totalTokens: 960_000,
    maxTokens: 1_000_000,
    rawMaxTokens: 1_000_000,
    percentage: 96,
    autoCompactThreshold: 967_000,
    isAutoCompactEnabled: true,
  }

  it('shows the near-limit hint and sends /compact through the ordinary send path', async () => {
    chatStoreMock.state.sessions = { 'session-1': { chatState: 'idle', compactCount: 0 } }
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext(nearLimitContext))

    render(<LocalSlashCommandPanel command="context" sessionId="session-1" onClose={vi.fn()} />)

    expect(await screen.findByText('Context is near its limit — compacting is recommended')).toBeInTheDocument()
    const action = screen.getByTestId('context-compact-action')
    expect(action).toBeEnabled()

    fireEvent.click(action)
    expect(chatStoreMock.state.sendMessage).toHaveBeenCalledWith('session-1', '/compact')
  })

  it('adds a note when auto-compact is disabled', async () => {
    chatStoreMock.state.sessions = { 'session-1': { chatState: 'idle', compactCount: 0 } }
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext({
      ...nearLimitContext,
      isAutoCompactEnabled: false,
    }))

    render(<LocalSlashCommandPanel command="context" sessionId="session-1" onClose={vi.fn()} />)

    expect(await screen.findByText('Auto-compact is off — compact manually')).toBeInTheDocument()
  })

  it('disables the action while a turn is in flight and while compacting', async () => {
    chatStoreMock.state.sessions = { 'session-1': { chatState: 'thinking', compactCount: 0 } }
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext(nearLimitContext))

    const { rerender } = render(
      <LocalSlashCommandPanel command="context" sessionId="session-1" onClose={vi.fn()} />,
    )
    expect(await screen.findByTestId('context-compact-action')).toBeDisabled()

    chatStoreMock.state.sessions = { 'session-1': { chatState: 'compacting', compactCount: 0 } }
    rerender(<LocalSlashCommandPanel command="context" sessionId="session-1" onClose={vi.fn()} />)

    expect(screen.getByText('Compacting context…')).toBeInTheDocument()
    expect(screen.getByTestId('context-compact-action')).toBeDisabled()
  })

  it('reports a finished compaction and forces one fresh context read', async () => {
    chatStoreMock.state.sessions = { 'session-1': { chatState: 'idle', compactCount: 0 } }
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext({
      ...nearLimitContext,
      totalTokens: 420_000,
      percentage: 42,
    }))

    const { rerender } = render(
      <LocalSlashCommandPanel command="context" sessionId="session-1" onClose={vi.fn()} />,
    )
    await screen.findByText('Context window usage')
    const callsBefore = sessionsApiMock.getInspection.mock.calls.length

    // compact_boundary bumped compactCount: the panel must re-read the CLI and
    // say so, instead of leaving the pre-compact meter on screen (#743).
    chatStoreMock.state.sessions = { 'session-1': { chatState: 'idle', compactCount: 1 } }
    rerender(<LocalSlashCommandPanel command="context" sessionId="session-1" onClose={vi.fn()} />)

    expect(screen.getByText('Context compacted')).toBeInTheDocument()
    await waitFor(() => {
      expect(sessionsApiMock.getInspection.mock.calls.length).toBeGreaterThan(callsBefore)
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledWith('session-1', {
      includeContext: true,
      contextOnly: true,
      timeout: 45_000,
    })
  })

  it('retries the post-compact context read once before surfacing the error', async () => {
    vi.useFakeTimers()
    try {
      chatStoreMock.state.sessions = { 'session-1': { chatState: 'idle', compactCount: 1 } }
      sessionsApiMock.getInspection
        .mockResolvedValueOnce({ ...inspectionWithContext(nearLimitContext), context: undefined })
        .mockRejectedValueOnce(new Error('Request timed out after 45s'))
        .mockResolvedValueOnce(inspectionWithContext(nearLimitContext))

      render(<LocalSlashCommandPanel command="context" sessionId="session-1" onClose={vi.fn()} />)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(2)
      expect(screen.getByText('Request timed out after 45s')).toBeInTheDocument()

      // The CLI is usually still busy right after a compaction; one short
      // retry recovers the reading instead of leaving an error on screen.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(3)
      expect(screen.queryByText('Request timed out after 45s')).not.toBeInTheDocument()
      expect(screen.getByText('Context is near its limit — compacting is recommended')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('labels the Context page as an estimate, sharing the popover key', async () => {
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext(baseContext))

    render(<LocalSlashCommandPanel command="context" sessionId="session-1" onClose={vi.fn()} />)

    expect(await screen.findByText('Context window usage')).toBeInTheDocument()
    expect(screen.getByText('Estimate')).toBeInTheDocument()
  })

  it('distinguishes a compaction that is still over the window', async () => {
    chatStoreMock.state.sessions = { 'session-1': { chatState: 'idle', compactCount: 0 } }
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext({
      ...nearLimitContext,
      totalTokens: 1_000_000,
      percentage: 100,
    }))

    const { rerender } = render(
      <LocalSlashCommandPanel command="context" sessionId="session-1" onClose={vi.fn()} />,
    )
    await screen.findByTestId('context-compact-action')

    chatStoreMock.state.sessions = { 'session-1': { chatState: 'idle', compactCount: 1 } }
    rerender(<LocalSlashCommandPanel command="context" sessionId="session-1" onClose={vi.fn()} />)

    expect(screen.getByText('Still over the context window after compacting')).toBeInTheDocument()
  })
})

describe('LocalSlashCommandPanel memory context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatStoreMock.state.sessions = {}
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState(useTabStore.getInitialState(), true)
    useUIStore.setState({
      pendingMemoryPath: null,
      pendingSettingsTab: null,
    })
    useSkillStore.setState({
      skills: [],
      selectedSkill: null,
      selectedSkillReturnTab: 'skills',
      isLoading: false,
      isDetailLoading: false,
      error: null,
      fetchSkills: vi.fn(),
      fetchSkillDetail: vi.fn().mockResolvedValue(undefined),
      clearSelection: vi.fn(),
    })
  })

  it('shows loaded memory files and opens the selected project memory in settings', async () => {
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext({
      ...baseContext,
      memoryFiles: [
        {
          path: '/Users/test/.claude/projects/demo/memory/MEMORY.md',
          type: 'project',
          tokens: 4321,
        },
        {
          path: '/Users/test/.claude/projects/demo/memory/feedback/reuse.md',
          type: 'feedback',
          tokens: 98,
        },
      ],
    }))

    render(
      <LocalSlashCommandPanel
        command="context"
        sessionId="session-1"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('Memory files')).toBeInTheDocument()
    expect(screen.getByText('MEMORY.md')).toBeInTheDocument()
    expect(screen.getByText('/Users/test/.claude/projects/demo/memory/MEMORY.md')).toBeInTheDocument()
    expect(screen.getByText('feedback')).toBeInTheDocument()
    expect(screen.getByText('4,321 tokens')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Memory' }))

    await waitFor(() => {
      expect(useUIStore.getState().pendingSettingsTab).toBe('memory')
      expect(useUIStore.getState().pendingMemoryPath).toBe('/Users/test/.claude/projects/demo/memory/MEMORY.md')
      expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    })
  })

  it('keeps the memory settings entry available when no memory files are loaded', async () => {
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext({
      ...baseContext,
      memoryFiles: [],
    }))

    render(
      <LocalSlashCommandPanel
        command="context"
        sessionId="session-1"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('No memory files are loaded in this session.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Memory' }))

    await waitFor(() => {
      expect(useUIStore.getState().pendingSettingsTab).toBe('memory')
      expect(useUIStore.getState().pendingMemoryPath).toBeNull()
      expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    })
  })

  it('keeps the header, pills and category rows on one ruler at the window limit', async () => {
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext({
      ...baseContext,
      categories: [
        { name: 'Messages', tokens: 2_037_458, color: '#8b5cf6' },
        { name: 'Memory files', tokens: 1_170, color: '#14b8a6' },
      ],
      totalTokens: 1_000_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 100,
      messageBreakdown: {
        ...baseContext.messageBreakdown!,
        assistantMessageTokens: 2_037_458,
      },
    }))

    render(
      <LocalSlashCommandPanel
        command="context"
        sessionId="session-1"
        onClose={vi.fn()}
      />,
    )

    // Header total (clamped), the Messages pill, and the oversized Messages
    // category row all read "≥ 1,000,000" — never a raw value larger than the
    // window they sit under. The small category keeps its exact value.
    await waitFor(() => {
      expect(screen.getAllByText('≥ 1,000,000').length).toBeGreaterThanOrEqual(3)
    })
    expect(screen.queryByText('2,037,458')).not.toBeInTheDocument()
    expect(screen.getByText('1,170')).toBeInTheDocument()
  })

  it('opens skill details in the unified Skill Center', async () => {
    const onClose = vi.fn()
    const fetchSkillDetail = vi.fn().mockResolvedValue(undefined)
    useSkillStore.setState({ fetchSkillDetail })
    skillsApiMock.list.mockResolvedValue({
      skills: [{
        name: 'ppt-generator',
        displayName: 'PPT Generator',
        description: 'Create slide decks.',
        source: 'user',
        userInvocable: true,
        contentLength: 100,
        hasDirectory: true,
      }],
    })

    render(
      <LocalSlashCommandPanel
        command="skills"
        cwd="/workspace/demo"
        onClose={onClose}
      />,
    )

    fireEvent.click(await screen.findByText('/ppt-generator'))

    await waitFor(() => {
      expect(fetchSkillDetail).toHaveBeenCalledWith('user', 'ppt-generator', '/workspace/demo', 'skills')
      expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    })
    expect(useUIStore.getState().pendingSettingsTab).toBe('skills')
    expect(onClose).toHaveBeenCalled()
  })
})
