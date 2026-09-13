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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-incident-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  deliverMock.mockClear()
  getServantMock.mockClear()
  listServantsMock.mockClear()
  deliverMock.mockImplementation(async () => true)
  getServantMock.mockImplementation(async () => null)
  listServantsMock.mockImplementation(async () => [])
  setServantIncidentDeps({
    deliver: deliverMock,
    getServant: getServantMock,
    listServants: listServantsMock,
    getServerPort: () => 61694,
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
    expect(deliverMock).toHaveBeenCalledTimes(2)
    expect(deliverMock.mock.calls[0][0]).toBe('emp-1')
    expect(deliverMock.mock.calls[0][1]).toContain('自动续跑 1/2')
    expect(deliverMock.mock.calls[1][1]).toContain('自动续跑 2/2')

    await onServantTurnError({ sessionId: 'emp-1', streak: 3, summary: '仍然失败' })
    expect(deliverMock).toHaveBeenCalledTimes(3)
    expect(deliverMock.mock.calls[2][0]).toBe('sup-1')
    expect(deliverMock.mock.calls[2][1]).toContain('连续 3 轮报错')

    await onServantTurnError({ sessionId: 'emp-1', streak: 4, summary: '仍然失败' })
    expect(deliverMock).toHaveBeenCalledTimes(3)

    resetServantIncidentState()
    await onServantTurnError({ sessionId: 'emp-1', streak: 1, summary: 'API 超时' })
    expect(deliverMock).toHaveBeenCalledTimes(4)
  })

  test('non-servant sessions are not auto-nudged', async () => {
    await onServantTurnError({ sessionId: 'interactive-1', streak: 1, summary: 'API 超时' })
    expect(deliverMock).not.toHaveBeenCalled()
  })
})

describe('notifyServantCrash', () => {
  test('notifies the project supervisor with role, exit code, and handling advice', async () => {
    getServantMock.mockImplementation(async (id: string) =>
      id === 'emp-1' ? { sessionId: 'emp-1', role: '前端', enabled: true } : null,
    )
    listServantsMock.mockImplementation(async () => [
      { sessionId: 'sup-1', supervisor: true, enabled: true },
      { sessionId: 'emp-1', supervisor: false, enabled: true },
    ])

    await notifyServantCrash({ sessionId: 'emp-1', exitCode: 4 })

    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe('sup-1')
    const content = deliverMock.mock.calls[0][1] as string
    expect(content).toContain('前端')
    expect(content).toContain('emp-1')
    expect(content).toContain('exit code 4')
    expect(content).toContain('/interrupt')
    expect(deliverMock.mock.calls[0][2]).toBe('127.0.0.1:61694')
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
