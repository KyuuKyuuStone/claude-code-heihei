import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  onServantTurnError,
  resetServantIncidentState,
  setServantIncidentDeps,
} from '../services/servantIncidentNotifier.js'
import {
  clearServantTurnError,
  getSessionPayloadLock,
  isSessionPayloadLocked,
  OVERSIZE_LOCK_THRESHOLD,
  resetOversizeLockForTests,
  resetServantTurnErrorsForTests,
  setOversizeFailureDepsForTests,
  unlockSessionPayload,
} from '../services/servantOversizeFailure.js'
import { sessionMessenger, setDeliverOverrideForTests } from '../services/sessionMessenger.js'

/**
 * R-C 熔断 / 锁死态 + C-A 派活闸门（v1.7.5）
 *
 * 判别力设计：
 * ① 连续 2 次确定性超限 ⇒ 锁死 + 停止重发 + 主管收到通知（正向）；
 * ② **反向**：429/网络类连续多次 ⇒ 不锁死、照常续跑（防误杀）；
 * ③ 锁死后 deliver（派活/信箱/汇报共用入口）⇒ 409 结构化拒绝，message 指向修复端点；
 * ④ **反向**：未锁死会话 deliver 不因锁被拦（走原有 404 语义）。
 */

const EMP = 'emp-lock-1'
const SUP = 'sup-lock-1'
const HOST = '127.0.0.1:61694'

const deliverMock = mock(async (_t: string, _c: string, _h: string) => true)
const escalationDeliverMock = mock(async (_t: string, _c: string, _h: string) => true)
const recordEventMock = mock((_input: {
  type: string
  severity?: 'info' | 'warn' | 'error'
  summary: string
  sessionId?: string
  details?: unknown
}) => {})

const OVERSIZE = 'Request too large: the request body exceeds the server-side size limit.'

beforeEach(() => {
  resetOversizeLockForTests()
  resetServantTurnErrorsForTests()
  resetServantIncidentState()
  setDeliverOverrideForTests(null)
  deliverMock.mockClear()
  escalationDeliverMock.mockClear()
  recordEventMock.mockClear()
  setServantIncidentDeps({
    deliver: deliverMock,
    getServant: (async () => ({ sessionId: EMP, role: '前端', enabled: true })) as never,
    listServants: (async () => []) as never,
    getServerPort: () => 61694,
    recordEvent: recordEventMock,
  } as never)
  setOversizeFailureDepsForTests({
    deliver: escalationDeliverMock,
    listServants: async () => [{ sessionId: SUP, supervisor: true, enabled: true, workDir: '/proj/emp' }],
    getSessionWorkDir: async () => '/proj/emp',
    getServerPort: () => 61694,
    recordEvent: recordEventMock,
  } as never)
})

afterEach(() => {
  setServantIncidentDeps(null)
  setOversizeFailureDepsForTests(null)
  setDeliverOverrideForTests(null)
  resetOversizeLockForTests()
  resetServantTurnErrorsForTests()
  resetServantIncidentState()
  mock.restore()
})

describe('R-C：连续超限 ⇒ 锁死', () => {
  test('连续 2 次确定性超限 ⇒ 锁死 + 通知主管 + 零续跑注入', async () => {
    expect(isSessionPayloadLocked(EMP)).toBe(false)

    await onServantTurnError({ sessionId: EMP, streak: 1, summary: OVERSIZE })
    // 第 1 次：C-B 停续跑 + 通知一次；尚未锁死
    expect(deliverMock).not.toHaveBeenCalled()
    expect(isSessionPayloadLocked(EMP)).toBe(false)
    expect(getSessionPayloadLock(EMP).streak).toBe(1)

    await onServantTurnError({ sessionId: EMP, streak: 2, summary: OVERSIZE })
    expect(isSessionPayloadLocked(EMP)).toBe(true)
    expect(getSessionPayloadLock(EMP).streak).toBe(OVERSIZE_LOCK_THRESHOLD)
    // 锁死那一次再通知主管一次，且文案指向修复动作
    const notices = escalationDeliverMock.mock.calls.map((c) => String(c[1]))
    expect(notices.some((n) => n.includes('已锁死'))).toBe(true)
    expect(notices.some((n) => n.includes('shed-payload'))).toBe(true)
    // 全程零注入（不往死会话里塞东西）
    expect(deliverMock).not.toHaveBeenCalled()
    // 诊断里有锁死事件
    const types = recordEventMock.mock.calls.map((c) => String((c[0] as { type: string }).type))
    expect(types).toContain('session_payload_locked')
  })

  test('反向：429/网络类连续多次 ⇒ 不锁死、照常续跑（防误杀）', async () => {
    for (const summary of ['Rate limited (429)', 'ECONNRESET', 'Overloaded (529)']) {
      await onServantTurnError({ sessionId: EMP, streak: 1, summary })
      await onServantTurnError({ sessionId: EMP, streak: 1, summary })
    }
    expect(isSessionPayloadLocked(EMP)).toBe(false)
    expect(getSessionPayloadLock(EMP).streak).toBe(0)
    expect(deliverMock).toHaveBeenCalled()
    expect(escalationDeliverMock).not.toHaveBeenCalled()
  })

  test('P1 返工：超限 1 次 → 成功 1 轮 → 再超限 1 次 ⇒ **不得锁死**（连续 ≠ 累计）', async () => {
    await onServantTurnError({ sessionId: EMP, streak: 1, summary: OVERSIZE })
    expect(getSessionPayloadLock(EMP).streak).toBe(1)

    // 成功轮：`conversationService.observeServantTurnResult` 的成功分支就是调这个
    clearServantTurnError(EMP)
    expect(getSessionPayloadLock(EMP).streak).toBe(0)

    // 之后再偶发一次超限：应从 1 重新数起，而不是接着 2 ⇒ 不锁死
    await onServantTurnError({ sessionId: EMP, streak: 1, summary: OVERSIZE })
    expect(getSessionPayloadLock(EMP).streak).toBe(1)
    expect(isSessionPayloadLocked(EMP)).toBe(false)
  })

  test('P1 对照：成功轮**不解锁**（锁死是显式修复的对偶）', async () => {
    await onServantTurnError({ sessionId: EMP, streak: 1, summary: OVERSIZE })
    await onServantTurnError({ sessionId: EMP, streak: 2, summary: OVERSIZE })
    expect(isSessionPayloadLocked(EMP)).toBe(true)

    clearServantTurnError(EMP)
    expect(getSessionPayloadLock(EMP).streak).toBe(0)
    // 仍然锁死：只能靠修复（unlockSessionPayload）解除
    expect(isSessionPayloadLocked(EMP)).toBe(true)
  })

  test('修复后解锁 + 连续计数归零', async () => {
    await onServantTurnError({ sessionId: EMP, streak: 1, summary: OVERSIZE })
    await onServantTurnError({ sessionId: EMP, streak: 2, summary: OVERSIZE })
    expect(isSessionPayloadLocked(EMP)).toBe(true)

    unlockSessionPayload(EMP)
    expect(isSessionPayloadLocked(EMP)).toBe(false)
    expect(getSessionPayloadLock(EMP).streak).toBe(0)
  })
})

describe('C-A：派活闸门（deliver 入口）', () => {
  test('锁死会话被拒 ⇒ 409 结构化原因且指向修复端点', async () => {
    await onServantTurnError({ sessionId: EMP, streak: 1, summary: OVERSIZE })
    await onServantTurnError({ sessionId: EMP, streak: 2, summary: OVERSIZE })
    expect(isSessionPayloadLocked(EMP)).toBe(true)

    let thrown: unknown = null
    try {
      await sessionMessenger.deliver(EMP, '派活：做点事', HOST)
    } catch (error) {
      thrown = error
    }
    const err = thrown as { statusCode?: number; code?: string; message?: string }
    expect(err?.statusCode).toBe(409)
    expect(err?.code).toBe('PAYLOAD_LOCKED')
    expect(String(err?.message)).toContain('shed-payload')
    expect(String(err?.message)).toContain('repair')
  })

  test('反向：未锁死会话不因闸门被拦（走原有语义）', async () => {
    expect(isSessionPayloadLocked(EMP)).toBe(false)
    let thrown: unknown = null
    try {
      // 未登记的会话：deliver 会因解析不到工作目录抛 404 —— 关键是**不是** PAYLOAD_LOCKED
      await sessionMessenger.deliver('never-registered-session', 'x', HOST)
    } catch (error) {
      thrown = error
    }
    const err = thrown as { statusCode?: number; code?: string }
    expect(err?.code).not.toBe('PAYLOAD_LOCKED')
    expect(err?.statusCode).toBe(404)
  })
})
