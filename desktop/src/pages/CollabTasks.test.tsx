import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listForSession = vi.hoisted(() => vi.fn())
const listDispatched = vi.hoisted(() => vi.fn())
const whoami = vi.hoisted(() => vi.fn())
const subscribeTaskEvents = vi.hoisted(() => vi.fn(() => vi.fn()))
const mockRefreshSession = vi.hoisted(() => vi.fn())
const mockClearProject = vi.hoisted(() => vi.fn())

vi.mock('../api/collabTasks', () => ({
  collabTasksApi: { listForSession, listForProject: vi.fn(), listDispatched, whoami, get: vi.fn() },
}))
vi.mock('../api/client', () => ({ api: { get: vi.fn() } }))
vi.mock('../stores/sessionStore', () => ({
  useSessionStore: Object.assign((selector: (state: { activeSessionId: string | null }) => unknown) => selector({ activeSessionId: activeSessionIdRef.value }), {
    getState: () => ({ activeSessionId: activeSessionIdRef.value }),
  }),
}))
vi.mock('../stores/servantStore', () => ({
  useServantStore: (selector: (state: { turnInProgressBySessionId: Record<string, boolean> }) => unknown) => selector({ turnInProgressBySessionId: {} }),
}))
vi.mock('../stores/collabTaskStore', () => ({
  useCollabTaskStore: Object.assign((selector: (state: typeof collabState) => unknown) => selector(collabState), {
    getState: () => ({
      ...collabState,
      subscribeTaskEvents,
      checkServerIdentity: vi.fn(),
      refreshForSession: mockRefreshSession,
      clearProjectTasks: mockClearProject,
    }),
  }),
}))

const activeSessionIdRef = { value: 'session-alpha' as string | null }
const collabState = {
  tasksById: {} as Record<string, never>,
  activeProjectDir: null as string | null,
  activeProjectSessionId: null as string | null,
  isLoading: false,
  error: null as string | null,
  connectionState: 'connected' as const,
  serverReady: true,
}

import { CollabTasks } from './CollabTasks'

describe('CollabTasks', () => {
  beforeEach(() => {
    activeSessionIdRef.value = 'session-alpha'
    Object.assign(collabState, { tasksById: {}, activeProjectDir: null, activeProjectSessionId: null, isLoading: false, error: null })
    listForSession.mockReset().mockResolvedValue({ tasks: [], projectDir: '/workspace/alpha' })
    mockRefreshSession.mockReset().mockImplementation(async (sessionId: string, options?: { clear?: boolean }) => {
      collabState.activeProjectSessionId = sessionId
      collabState.activeProjectDir = null
      collabState.isLoading = true
      if (options?.clear) collabState.tasksById = {}
      const response = await listForSession(sessionId)
      collabState.tasksById = {}
      collabState.activeProjectDir = response.projectDir
      collabState.isLoading = false
    })
    mockClearProject.mockReset().mockImplementation(() => {
      collabState.activeProjectSessionId = null
      collabState.activeProjectDir = null
      collabState.tasksById = {}
      collabState.isLoading = false
    })
    listDispatched.mockReset().mockResolvedValue({ tasks: [] })
    whoami.mockReset().mockResolvedValue({ app: 'cc-heihei' })
    subscribeTaskEvents.mockClear()
  })

  afterEach(cleanup)

  it('queries only by the active session and never requests an unscoped project list', async () => {
    const { unmount } = render(<CollabTasks />)
    await waitFor(() => expect(listForSession).toHaveBeenCalledWith('session-alpha'))
    expect(listForSession.mock.calls.every(([sessionId]) => typeof sessionId === 'string' && sessionId.length > 0)).toBe(true)
    unmount()

    activeSessionIdRef.value = null
    listForSession.mockClear()
    render(<CollabTasks />)
    expect(screen.getByText('打开一个协作会话即可查看该项目的任务')).toBeInTheDocument()
    expect(listForSession).not.toHaveBeenCalled()
  })

  it('shows the server-resolved project directory and displays loading before it arrives', async () => {
    let resolve!: (value: { tasks: never[]; projectDir: string }) => void
    collabState.isLoading = true
    listForSession.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const { rerender } = render(<CollabTasks />)
    expect(screen.getByText('当前目录：加载中')).toBeInTheDocument()
    await act(async () => {
      resolve({ tasks: [], projectDir: '/resolved/server/project' })
      collabState.activeProjectDir = '/resolved/server/project'
      collabState.isLoading = false
    })
    rerender(<CollabTasks />)
    expect(screen.getByText('当前目录：/resolved/server/project')).toBeInTheDocument()
  })

  it('shows a session-switch notice using the server-resolved projectDir', async () => {
    const { rerender } = render(<CollabTasks />)
    await waitFor(() => expect(listForSession).toHaveBeenCalledWith('session-alpha'))
    await act(async () => {
      collabState.activeProjectDir = '/resolved/alpha'
      collabState.isLoading = false
    })
    rerender(<CollabTasks />)
    activeSessionIdRef.value = 'session-beta'
    listForSession.mockResolvedValueOnce({ tasks: [], projectDir: '/resolved/beta' })
    rerender(<CollabTasks />)
    await waitFor(() => expect(listForSession).toHaveBeenCalledWith('session-beta'))
    await act(async () => {
      collabState.activeProjectDir = '/resolved/beta'
      collabState.isLoading = false
    })
    rerender(<CollabTasks />)
    expect(await screen.findByRole('status')).toHaveTextContent('/resolved/beta')
    expect(screen.getByRole('status')).toHaveTextContent('任务列表已按该目录筛选')
  })
})
