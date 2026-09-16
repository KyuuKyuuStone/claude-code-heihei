import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  notifyServantCrash,
  onServantTurnError,
  resetServantIncidentState,
  setServantIncidentDeps,
} from '../services/servantIncidentNotifier.js'

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

const deliverMock = mock(async () => true)
const getServantMock = mock(async (id: string) => null)
const listServantsMock = mock(async () => [])
const recordEventMock = mock((_input: {
  type: string
  severity?: 'info' | 'warn' | 'error'
  summary: string
  sessionId?: string
  details?: unknown
}) => {})

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-incident-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  deliverMock.mockClear()
  getServantMock.mockClear()
  listServantsMock.mockClear()
  recordEventMock.mockClear()
  deliverMock.mockImplementation(async () => true)
  getServantMock.mockImplementation(async () => null)
  listServantsMock.mockImplementation(async () => [])
  setServantIncidentDeps({
    deliver: deliverMock,
    getServant: getServantMock,
    listServants: listServantsMock,
    getServerPort: () => 61694,
    recordEvent: recordEventMock,
  })
  resetServantIncidentState()
})

afterEach(async () => {
  setServantIncidentDeps(null)
  resetServantIncidentState()
  if (originalConfigDir) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  else delete process.env.CLAUDE_CONFIG_DIR
  mock.restore()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('onServantTurnError', () => {
  test('auto-nudges an errored servant turn, escalates at streak 3, resets on success', async () => {
    getServantMock.mockImplementation(async (id: string) =>
      id === 'emp-1' ? { sessionId: 'emp-1', role: '前端', enabled: true } : null,
    )
    listServantsMock.mockImplementation(async () => [
      { sessionId: 'sup-1', supervisor: true, enabled: true },
      { sessionId: 'emp-1', supervisor: false, enabled: true },
    ])
    await onServantTurnError({ sessionId: 'emp-1', streak: 1, summary: 'API 超时' })
    await onServantTurnError({ sessionId: 'emp-1', streak: 2, summary: 'API 超时' })
    // 续跑提示注入员工自身是功能动作 → 保留
    expect(deliverMock).toHaveBeenCalledTimes(2)
    expect(deliverMock.mock.calls[0][0]).toBe('emp-1')
    expect(deliverMock.mock.calls[0][1]).toContain('自动续跑 1/2')
    expect(deliverMock.mock.calls[1][1]).toContain('自动续跑 2/2')

    // 第 3 轮起升级：v1.2.3 起只写诊断，不再注入主管会话
    await onServantTurnError({ sessionId: 'emp-1', streak: 3, summary: '仍然失败' })
    expect(deliverMock).toHaveBeenCalledTimes(2)
    expect(recordEventMock).toHaveBeenCalledTimes(1)
    expect(recordEventMock.mock.calls[0][0]).toMatchObject({
      type: 'servant_turn_error_escalated',
      severity: 'warn',
      sessionId: 'emp-1',
    })
    expect(recordEventMock.mock.calls[0][0].details).toMatchObject({ streak: 3, summary: '仍然失败' })

    await onServantTurnError({ sessionId: 'emp-1', streak: 4, summary: '仍然失败' })
    expect(deliverMock).toHaveBeenCalledTimes(2)
    expect(recordEventMock).toHaveBeenCalledTimes(1)

    resetServantIncidentState()
    await onServantTurnError({ sessionId: 'emp-1', streak: 1, summary: 'API 超时' })
    expect(deliverMock).toHaveBeenCalledTimes(3)
  })

  test('non-servant sessions are not auto-nudged', async () => {
    await onServantTurnError({ sessionId: 'interactive-1', streak: 1, summary: 'API 超时' })
    expect(deliverMock).not.toHaveBeenCalled()
  })
})

describe('notifyServantCrash', () => {
  test('records a crash diagnostic instead of injecting a session message', async () => {
    getServantMock.mockImplementation(async (id: string) =>
      id === 'emp-1' ? { sessionId: 'emp-1', role: '前端', enabled: true } : null,
    )
    listServantsMock.mockImplementation(async () => [
      { sessionId: 'sup-1', supervisor: true, enabled: true },
      { sessionId: 'emp-1', supervisor: false, enabled: true },
    ])

    await notifyServantCrash({ sessionId: 'emp-1', exitCode: 4 })

    // v1.2.3：崩溃属于系统事件，只落诊断，不再注入任何会话
    expect(deliverMock).not.toHaveBeenCalled()
    expect(recordEventMock).toHaveBeenCalledTimes(1)
    const event = recordEventMock.mock.calls[0][0]
    expect(event.type).toBe('servant_crash')
    expect(event.severity).toBe('error')
    expect(event.sessionId).toBe('emp-1')
    expect(event.summary).toContain('前端')
    expect(event.summary).toContain('exit code 4')
    expect(event.details).toMatchObject({ sessionId: 'emp-1', exitCode: 4, role: '前端' })
  })

  test('ignores sessions that are not registered servants', async () => {
    await notifyServantCrash({ sessionId: 'plain-session', exitCode: 4 })
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('ignores disabled servants', async () => {
    getServantMock.mockImplementation(async () => ({ sessionId: 'emp-off', enabled: false }))
    await notifyServantCrash({ sessionId: 'emp-off', exitCode: 4 })
    expect(deliverMock).not.toHaveBeenCalled()
  })
})
