import { beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  MAX_AUTO_REPUSH,
  STALL_THRESHOLD_MS,
  ServantStallWatcher,
  type ServantStallWatcherDeps,
  type StallServantInfo,
} from '../services/servantStallWatcher.js'

/**
 * 假死自动重推（批次 3 实施①）。
 *
 * 依赖注入而非 mock.module：mock.module 会跨测试文件泄漏（bun 同进程顺序执行，
 * 交接文档坑④）。本文件不读运行者 env（如 CC_HEIHEI_SUPERVISOR）——主管身份一律
 * 走注入的花名册，保证确定性。
 */

const MIN = 60_000

let nowMs = 0
/** 处于「回合进行中」的会话集合（v1.2.2 降噪后假死判定的前置条件） */
const turnInProgress = new Set<string>()
const deliverMock = mock(async (_target: string, _content: string, _host: string) => true)
const listServantsMock = mock(
  async (_options: { includeAll: boolean; forSessionId?: string }): Promise<StallServantInfo[]> => [],
)
const recordEventMock = mock((_input: {
  type: string
  severity?: 'info' | 'warn' | 'error'
  summary: string
  sessionId?: string
  details?: unknown
}) => {})

const SUP = 'sup-1'
const EMP = 'emp-1'

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function roster(overrides: Partial<StallServantInfo>): StallServantInfo[] {
  return [
    { sessionId: SUP, title: '主管', role: '主管', enabled: true, supervisor: true, running: true, lastActivityAt: iso(nowMs) },
    {
      sessionId: EMP,
      title: '前端',
      role: '前端',
      enabled: true,
      supervisor: false,
      running: true,
      lastActivityAt: iso(nowMs),
      ...overrides,
    },
  ]
}

function makeWatcher(): ServantStallWatcher {
  const deps: ServantStallWatcherDeps = {
    listServants: listServantsMock,
    deliver: deliverMock,
    getServerPort: () => 61694,
    recordEvent: recordEventMock,
    now: () => nowMs,
    isTurnInProgress: (sessionId: string) => turnInProgress.has(sessionId),
  }
  return new ServantStallWatcher(deps)
}

/** 只取投递给某目标的调用 */
function deliveredTo(target: string): string[] {
  return deliverMock.mock.calls
    .filter((call) => call[0] === target)
    .map((call) => String(call[1]))
}

function actionsLogged(): string[] {
  return recordEventMock.mock.calls.map(
    (call) => String((call[0].details as { action?: string } | undefined)?.action ?? ''),
  )
}

beforeEach(() => {
  nowMs = Date.parse('2026-09-16T10:00:00.000Z')
  turnInProgress.clear()
  // 除专门验证"空闲待命"的用例外，默认认为员工正跑着回合
  turnInProgress.add(EMP)
  deliverMock.mockClear()
  listServantsMock.mockClear()
  recordEventMock.mockClear()
  deliverMock.mockImplementation(async () => true)
  listServantsMock.mockImplementation(async () => [])
})

describe('ServantStallWatcher', () => {
  test('does nothing before the stall threshold', async () => {
    nowMs += 9 * MIN
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(Date.parse('2026-09-16T10:00:00.000Z')) }))
    await makeWatcher().watch()
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('repushes once the threshold is crossed', async () => {
    const last = nowMs
    nowMs = last + 11 * MIN
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(last) }))

    await makeWatcher().watch()

    const toEmp = deliveredTo(EMP)
    expect(toEmp).toHaveLength(1)
    expect(toEmp[0]).toContain(`自动重推 1/${MAX_AUTO_REPUSH}`)
    expect(deliveredTo(SUP)).toHaveLength(0)
    expect(STALL_THRESHOLD_MS).toBe(10 * MIN)
  })

  test('escalates to the supervisor after the maximum number of repushes', async () => {
    const last = nowMs
    nowMs = last + 11 * MIN
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(last) }))
    const watcher = makeWatcher()

    for (let i = 1; i <= MAX_AUTO_REPUSH; i += 1) {
      await watcher.watch()
      expect(deliveredTo(EMP)).toHaveLength(i)
      expect(deliveredTo(EMP)[i - 1]).toContain(`自动重推 ${i}/${MAX_AUTO_REPUSH}`)
    }

    await watcher.watch()
    expect(deliveredTo(EMP)).toHaveLength(MAX_AUTO_REPUSH)
    const toSup = deliveredTo(SUP)
    expect(toSup).toHaveLength(1)
    expect(toSup[0]).toContain('假死未恢复')
    expect(toSup[0]).toContain(EMP)
    expect(actionsLogged()).toContain('escalate')

    // episode 已升级，不再重复
    await watcher.watch()
    expect(deliveredTo(SUP)).toHaveLength(1)
  })

  test('activity recovery resets the episode', async () => {
    const last = nowMs
    nowMs = last + 11 * MIN
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(last) }))
    const watcher = makeWatcher()

    await watcher.watch()
    await watcher.watch()
    expect(deliveredTo(EMP)).toHaveLength(2)

    // 恢复活动
    const resumed = nowMs
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(resumed) }))
    await watcher.watch()
    expect(deliveredTo(EMP)).toHaveLength(2)

    // 再次卡死 → 从 1 重新计
    nowMs = resumed + 11 * MIN
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(resumed) }))
    await watcher.watch()
    expect(deliveredTo(EMP)).toHaveLength(3)
    expect(deliveredTo(EMP)[2]).toContain(`自动重推 1/${MAX_AUTO_REPUSH}`)
  })

  test('running=false only alerts the supervisor and never delivers to the employee', async () => {
    const last = nowMs
    nowMs = last + 26 * MIN
    listServantsMock.mockImplementation(async () =>
      roster({ lastActivityAt: iso(last), running: false }),
    )
    const watcher = makeWatcher()

    await watcher.watch()

    // 关键：绝不向员工投递（投递通道对未运行会话会 startSession = 自动拉起）
    expect(deliveredTo(EMP)).toHaveLength(0)
    const toSup = deliveredTo(SUP)
    expect(toSup).toHaveLength(1)
    expect(toSup[0]).toContain('无运行进程')
    expect(toSup[0]).toContain('running=false')
    expect(toSup[0]).toContain(`staleForMs=${26 * MIN}`)
    expect(toSup[0]).toContain('建议手动唤醒')
    expect(actionsLogged()).toContain('no-process-alert')

    // 同一 episode 只告警一次
    await watcher.watch()
    expect(deliveredTo(SUP)).toHaveLength(1)

    // 新的 episode（活动时间变了，且再次越过阈值）→ 再告警一次
    const second = last + 20 * MIN
    nowMs = second + 11 * MIN
    listServantsMock.mockImplementation(async () =>
      roster({ lastActivityAt: iso(second), running: false }),
    )
    await watcher.watch()
    expect(deliveredTo(SUP)).toHaveLength(2)
  })

  test('a failed delivery is not counted as a repush', async () => {
    const last = nowMs
    nowMs = last + 11 * MIN
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(last) }))
    const watcher = makeWatcher()

    deliverMock.mockImplementation(async (target: string) => target !== EMP)
    await watcher.watch()
    expect(deliveredTo(EMP)).toHaveLength(1)
    expect(actionsLogged()).toContain('nudge-failed')
    expect(actionsLogged()).not.toContain('nudge')

    // 投递恢复后，仍是第 1 次重推（额度没被失败吃掉）
    deliverMock.mockImplementation(async () => true)
    await watcher.watch()
    expect(deliveredTo(EMP)[1]).toContain(`自动重推 1/${MAX_AUTO_REPUSH}`)
  })

  test('the supervisor session is exempt', async () => {
    const last = nowMs
    nowMs = last + 30 * MIN
    listServantsMock.mockImplementation(async () => [
      { sessionId: SUP, title: '主管', role: '主管', enabled: true, supervisor: true, running: true, lastActivityAt: iso(last) },
    ])
    await makeWatcher().watch()
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('a roster read failure is recorded instead of being swallowed', async () => {
    listServantsMock.mockImplementation(async () => {
      throw new Error('roster boom')
    })
    const watcher = makeWatcher()
    await watcher.watch()
    expect(actionsLogged()).toContain('list-failed')
    expect(recordEventMock.mock.calls[0][0].summary).toContain('roster boom')
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('a missing or unparsable lastActivityAt is recorded instead of being swallowed', async () => {
    const watcher = makeWatcher()
    listServantsMock.mockImplementation(async () => [
      { sessionId: EMP, title: '前端', enabled: true, running: true },
    ])
    await watcher.watch()
    expect(actionsLogged()).toContain('skip-missing-activity')

    listServantsMock.mockImplementation(async () => [
      { sessionId: EMP, title: '前端', enabled: true, running: true, lastActivityAt: 'not-a-date' },
    ])
    await watcher.watch()
    expect(actionsLogged()).toContain('skip-bad-activity')
  })

  test('does not nudge a session whose turn already finished (normal idle)', async () => {
    const last = nowMs
    nowMs = last + 30 * MIN
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(last) }))
    // 回合已正常结束 → 空闲待命，不是假死
    turnInProgress.delete(EMP)

    const watcher = makeWatcher()
    await watcher.watch()
    await watcher.watch()

    expect(deliveredTo(EMP)).toHaveLength(0)
    expect(deliveredTo(SUP)).toHaveLength(0)
    expect(actionsLogged()).toContain('skip-idle')
    expect(actionsLogged()).not.toContain('nudge')
  })

  test('nudges once a stalled session is in a running turn again', async () => {
    const last = nowMs
    nowMs = last + 30 * MIN
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(last) }))
    turnInProgress.delete(EMP)
    const watcher = makeWatcher()

    await watcher.watch()
    expect(deliveredTo(EMP)).toHaveLength(0)

    // 新回合开始后再次卡死 → 从第 1 次重推起算
    turnInProgress.add(EMP)
    await watcher.watch()
    expect(deliveredTo(EMP)).toHaveLength(1)
    expect(deliveredTo(EMP)[0]).toContain(`自动重推 1/${MAX_AUTO_REPUSH}`)
  })

  test('leaves a session that never reported any turn activity alone', async () => {
    const last = nowMs
    nowMs = last + 30 * MIN
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(last) }))
    // 从未观察到该会话的任何 SDK 消息 → 按"非进行中"处理（宁可少戳）
    turnInProgress.clear()

    await makeWatcher().watch()

    expect(deliverMock).not.toHaveBeenCalled()
    expect(actionsLogged()).toContain('skip-idle')
  })

  test('disabled sessions are ignored', async () => {
    const last = nowMs
    nowMs = last + 30 * MIN
    listServantsMock.mockImplementation(async () => [
      { sessionId: EMP, title: '前端', enabled: false, running: true, lastActivityAt: iso(last) },
    ])
    await makeWatcher().watch()
    expect(deliverMock).not.toHaveBeenCalled()
  })
})
