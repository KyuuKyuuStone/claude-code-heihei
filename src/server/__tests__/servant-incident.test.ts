import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as realServantService from '../services/servantService.js'
import * as realSessionMessenger from '../services/sessionMessenger.js'
import * as realProviderService from '../services/providerService.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

const servantGetMock = mock(async (id: string) => null)
const servantListMock = mock(async () => [])
const deliverMock = mock(async () => true)

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-incident-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  servantGetMock.mockImplementation(async () => null)
  servantListMock.mockImplementation(async () => [])
  deliverMock.mockImplementation(async () => true)
  deliverMock.mockClear()

  mock.module('../services/servantService.js', () => ({
    servantService: {
      getServant: servantGetMock,
      listServants: servantListMock,
    },
  }))
  mock.module('../services/providerService.js', () => ({
    ProviderService: { getServerPort: () => 61694 },
  }))
  mock.module('../services/sessionMessenger.js', () => ({
    sessionMessenger: { deliver: deliverMock },
  }))
})

afterEach(async () => {
  if (originalConfigDir) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  else delete process.env.CLAUDE_CONFIG_DIR
  mock.restore()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('notifyServantCrash', () => {
  test('notifies the project supervisor with role, exit code, and handling advice', async () => {
    servantGetMock.mockImplementation(async (id: string) =>
      id === 'emp-1' ? { sessionId: 'emp-1', role: '前端', description: '页面实现', enabled: true } : null,
    )
    servantListMock.mockImplementation(async () => [
      { sessionId: 'sup-1', supervisor: true, enabled: true },
      { sessionId: 'emp-1', supervisor: false, enabled: true },
    ])

    const { notifyServantCrash } = await import('../services/servantIncidentNotifier.js')
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

  test('auto-nudges an errored servant turn, escalates at streak 3, resets on success', async () => {
    servantGetMock.mockImplementation(async () => ({ sessionId: 'emp-1', role: '前端', enabled: true }))
    servantListMock.mockImplementation(async () => [
      { sessionId: 'sup-1', supervisor: true, enabled: true },
      { sessionId: 'emp-1', supervisor: false, enabled: true },
    ])
    const { onServantTurnError, clearServantTurnErrors } = await import('../services/servantIncidentNotifier.js')

    // 连错 1、2 轮：自动注入续跑提示（发给员工自己）
    await onServantTurnError({ sessionId: 'emp-1', streak: 1, summary: 'API 超时' })
    await onServantTurnError({ sessionId: 'emp-1', streak: 2, summary: 'API 超时' })
    expect(deliverMock).toHaveBeenCalledTimes(2)
    expect(deliverMock.mock.calls[0][0]).toBe('emp-1')
    expect(deliverMock.mock.calls[0][1]).toContain('自动续跑 1/2')
    expect(deliverMock.mock.calls[1][1]).toContain('自动续跑 2/2')

    // 第 3 轮：升级通知主管，不再给员工发提示
    await onServantTurnError({ sessionId: 'emp-1', streak: 3, summary: '仍然失败' })
    expect(deliverMock).toHaveBeenCalledTimes(3)
    expect(deliverMock.mock.calls[2][0]).toBe('sup-1')
    expect(deliverMock.mock.calls[2][1]).toContain('连续 3 轮报错')

    // 第 4 轮起静默（已升级过）
    await onServantTurnError({ sessionId: 'emp-1', streak: 4, summary: '仍然失败' })
    expect(deliverMock).toHaveBeenCalledTimes(3)

    // 成功轮清零
    clearServantTurnErrors('emp-1')
    await onServantTurnError({ sessionId: 'emp-1', streak: 1, summary: 'API 超时' })
    expect(deliverMock).toHaveBeenCalledTimes(4)
  })

  test('non-servant sessions are not auto-nudged', async () => {
    const { onServantTurnError } = await import('../services/servantIncidentNotifier.js')
    await onServantTurnError({ sessionId: 'interactive-1', streak: 1, summary: 'API 超时' })
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('ignores sessions that are not registered servants', async () => {
    const { notifyServantCrash } = await import('../services/servantIncidentNotifier.js')
    await notifyServantCrash({ sessionId: 'plain-session', exitCode: 4 })
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('ignores disabled servants', async () => {
    servantGetMock.mockImplementation(async () => ({ sessionId: 'emp-off', enabled: false }))
    const { notifyServantCrash } = await import('../services/servantIncidentNotifier.js')
    await notifyServantCrash({ sessionId: 'emp-off', exitCode: 4 })
    expect(deliverMock).not.toHaveBeenCalled()
  })
})

afterAll(async () => {
  mock.module('../services/servantService.js', () => realServantService)
  mock.module('../services/sessionMessenger.js', () => realSessionMessenger)
  mock.module('../services/providerService.js', () => realProviderService)
})
