import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  notifyServantCrash,
  onServantTurnError,
  resetServantIncidentState,
  setServantIncidentDeps,
  subscribeServantCrashObserver,
} from '../services/servantIncidentNotifier.js'
import { markCrashed, markStarting, registerSession } from '../services/sessionRegistry.js'
import { resetSessionEventsForTests } from '../services/sessionEvents.js'

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
/** R1 活性自检专用会话（independent of 用例；自检后处于 crashed 态无副作用） */
const CRASH_LIVENESS_PROBE = 'crash-liveness-probe'

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

  // R1 活性自检：崩溃观察者必须可达——先跑的测试文件可能已调
  // resetSessionEventsForTests() 清空总线，subscribe（ensure 模式）重注册后
  // 合成一次 markCrashed 验证通知链，清空不再静默失效而是显式报错。
  subscribeServantCrashObserver()
  getServantMock.mockImplementation(async () => ({
    sessionId: CRASH_LIVENESS_PROBE,
    role: 'liveness',
    enabled: true,
  }))
  registerSession(CRASH_LIVENESS_PROBE)
  markStarting(CRASH_LIVENESS_PROBE)
  markCrashed(CRASH_LIVENESS_PROBE, { exitCode: 4 })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const livenessHit = recordEventMock.mock.calls.some(
    ([event]) => (event as { type: string }).type === 'servant_crash',
  )
  expect(livenessHit).toBe(true)
  // 自检痕迹清零，防污染用例断言（getServant 恢复默认「未登记」）
  deliverMock.mockClear()
  getServantMock.mockClear()
  listServantsMock.mockClear()
  recordEventMock.mockClear()
  getServantMock.mockImplementation(async () => null)
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

// R1 收口（v1.3.1 整批复核）：5e 崩溃观察者经 sessionEvents 事件总线订阅。
// resetSessionEventsForTests() 会 listeners.clear() 但清不掉订阅函数内部的
// 引用守卫——守卫误判「已订阅」early return，观察者被静默清空后永不恢复，
// 崩溃通知零报错失效（与 dispatchReceiptService 补偿订阅同族，均治以 ensure
// 模式：无条件注册 + onSessionEvent 按 handler 引用去重，被清后重调即恢复）。
describe('crash observer subscription (5e, R1)', () => {
  test('fires servant_crash from the phase_changed(→crashed) event chain', async () => {
    subscribeServantCrashObserver()
    getServantMock.mockImplementation(async () => ({
      sessionId: 'emp-crash',
      role: '后端',
      enabled: true,
    }))

    registerSession('emp-crash')
    markStarting('emp-crash') // registered→crashed 是表外迁移，须经 starting
    markCrashed('emp-crash', { exitCode: 4 })
    // 订阅回调内 notifyServantCrash 是 async：让微任务排空
    await new Promise((resolve) => setTimeout(resolve, 10))

    const crashEvents = recordEventMock.mock.calls.filter(
      ([event]) => (event as { type: string }).type === 'servant_crash',
    )
    expect(crashEvents.length).toBe(1)
    expect(crashEvents[0][0]).toMatchObject({ sessionId: 'emp-crash', severity: 'error' })
  })

  test('still fires after resetSessionEventsForTests cleared the bus (R1 reproduction)', async () => {
    // 模拟「先跑的测试文件清空事件总线订阅」：resetSessionEventsForTests 清掉
    // 模块加载期注册的观察者，再调 subscribe——修复前引用守卫 early return，
    // 崩溃通知静默失效（本用例红）；修复后 ensure 无条件重注册（绿）。
    resetSessionEventsForTests()
    subscribeServantCrashObserver()
    getServantMock.mockImplementation(async () => ({
      sessionId: 'emp-crash-2',
      role: '后端',
      enabled: true,
    }))

    registerSession('emp-crash-2')
    markStarting('emp-crash-2')
    markCrashed('emp-crash-2', { exitCode: 4 })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const crashEvents = recordEventMock.mock.calls.filter(
      ([event]) => (event as { type: string }).type === 'servant_crash',
    )
    expect(crashEvents.length).toBe(1)
  })
})
