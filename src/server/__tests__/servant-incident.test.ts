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
import {
  isDeterministicOversizeError,
  resetOversizeLockForTests,
  resetServantTurnErrorsForTests,
  setOversizeFailureDepsForTests,
} from '../services/servantOversizeFailure.js'

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
/** R1 活性自检专用会话（independent of 用例；自检后处于 crashed 态无副作用） */
const CRASH_LIVENESS_PROBE = 'crash-liveness-probe'

const deliverMock = mock(async (_target: string, _content: string, _host: string) => true)
/** C-B：升级通知专用投递 mock（与员工续跑注入分开计数） */
const escalationDeliverMock = mock(async (_target: string, _content: string, _host: string) => true)
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
  resetServantTurnErrorsForTests()
  resetOversizeLockForTests()
  // C-B：升级通知走独立缝（不复用 incident 的 deliver）——这样能分辨
  // 「是否给死掉的员工会话注入了续跑」与「是否通知了主管」两件事
  escalationDeliverMock.mockClear()
  escalationDeliverMock.mockImplementation(async () => true)
  // 整体 as never：注入缝的迁移常用写法（同 roster-change-notice 测试）
  setOversizeFailureDepsForTests({
    deliver: escalationDeliverMock,
    listServants: async () => [],
    getSessionWorkDir: async () => '/proj/emp',
    getServerPort: () => 61694,
    recordEvent: recordEventMock,
  } as never)

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
  setOversizeFailureDepsForTests(null)
  resetServantIncidentState()
  resetServantTurnErrorsForTests()
  resetOversizeLockForTests()
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

  // ── C-B（v1.7.5）：确定性超限失败不续跑，改升级通知主管 ──────────────────

  test('413 类错误：不注入续跑提示，改为通知主管（零注入 + 一条升级）', async () => {
    getServantMock.mockImplementation(
      (async (id: string) =>
        id === 'emp-1'
          ? { sessionId: 'emp-1', role: '前端', description: '前端', enabled: true }
          : null) as never,
    )
    setOversizeFailureDepsForTests({
      listServants: async () => [
        { sessionId: 'sup-1', supervisor: true, enabled: true, workDir: '/proj/emp' },
      ],
    } as never)

    await onServantTurnError({
      sessionId: 'emp-1',
      streak: 1,
      summary: 'Request too large: the request body exceeds the server-side size limit.',
    })

    // ① 零注入：不再往（可能已死的）员工会话里塞续跑提示
    expect(deliverMock).not.toHaveBeenCalled()
    // ② 升级：给主管投了一条可读通知
    expect(escalationDeliverMock).toHaveBeenCalledTimes(1)
    expect(escalationDeliverMock.mock.calls[0][0]).toBe('sup-1')
    const notice = String(escalationDeliverMock.mock.calls[0][1])
    expect(notice).toContain('请求体超限')
    expect(notice).toContain('/compact')
    expect(notice).toContain('emp-1')
    // ③ 诊断如实记一条（error 级）
    expect(recordEventMock).toHaveBeenCalledTimes(1)
    expect(recordEventMock.mock.calls[0][0]).toMatchObject({
      type: 'servant_turn_error_deterministic_oversize',
      severity: 'error',
      sessionId: 'emp-1',
    })

    // ④ 连续第 2 次 ⇒ 触发 R-C 锁死（锁死那一次再通知主管一次），仍绝不注入
    await onServantTurnError({ sessionId: 'emp-1', streak: 2, summary: 'Request too large' })
    expect(deliverMock).not.toHaveBeenCalled()
    expect(escalationDeliverMock).toHaveBeenCalledTimes(2)
    expect(String(escalationDeliverMock.mock.calls[1][1])).toContain('已锁死')
    // ⑤ 已锁死后继续报错不重复轰炸（C-B 升级去重 + 锁死只在跃迁那一次通知）
    await onServantTurnError({ sessionId: 'emp-1', streak: 3, summary: 'Request too large' })
    expect(escalationDeliverMock).toHaveBeenCalledTimes(2)
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('反向用例：429/网络类**可恢复**错误仍照常自动续跑（C-B 不误杀）', async () => {
    getServantMock.mockImplementation(
      (async (id: string) =>
        id === 'emp-1' ? { sessionId: 'emp-1', role: '前端', enabled: true } : null) as never,
    )
    setOversizeFailureDepsForTests({
      listServants: async () => [
        { sessionId: 'sup-1', supervisor: true, enabled: true, workDir: '/proj/emp' },
      ],
    } as never)

    for (const summary of [
      'Rate limited (429): too many requests',
      'Connection error: ECONNRESET',
      'Overloaded (529)',
      'API Error: Connection error.',
    ]) {
      await onServantTurnError({ sessionId: 'emp-1', streak: 1, summary })
    }

    // 四次都可恢复 ⇒ 四次续跑注入，零升级通知
    expect(deliverMock).toHaveBeenCalledTimes(4)
    expect(String(deliverMock.mock.calls[0][1])).toContain('自动续跑 1/2')
    expect(escalationDeliverMock).not.toHaveBeenCalled()
  })
})

describe('isDeterministicOversizeError（C-B 判定口径）', () => {
  test('命中：我们自己的两类文案 + 结构化错误码 + 网关/官方 413 措辞', () => {
    for (const text of [
      'Request too large: the request body exceeds the server-side size limit.',
      'Request blocked before sending: the request body is 30 MB and exceeds the configured limit of 32 MB',
      'businessErrorCode: request_too_large',
      'PAYLOAD_TOO_LARGE',
      '413 Request Entity Too Large',
      'Field "content" is too large: 600000 bytes (UTF-8) exceeds the 524288 byte limit.',
    ]) {
      expect(isDeterministicOversizeError(text)).toBe(true)
    }
  })

  test('不命中：可恢复错误与空值（防把正常自愈打死）', () => {
    for (const text of [
      'Rate limited (429)',
      'ECONNRESET',
      'socket hang up',
      'Request timed out after 60000ms',
      'Overloaded (529)',
      'Internal server error (500)',
      '',
      undefined,
      null,
    ]) {
      expect(isDeterministicOversizeError(text as string)).toBe(false)
    }
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
