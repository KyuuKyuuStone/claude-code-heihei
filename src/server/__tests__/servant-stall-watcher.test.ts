import { beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  MAX_AUTO_REPUSH,
  STALL_THRESHOLD_MS,
  ServantStallWatcher,
  type ServantStallWatcherDeps,
  type StallServantInfo,
} from '../services/servantStallWatcher.js'
import {
  getServantLastTurnError,
  recordServantTurnError,
  resetServantTurnErrorsForTests,
  setOversizeFailureDepsForTests,
} from '../services/servantOversizeFailure.js'

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
const sdkConnected = new Set<string>()
/** 会话 → 未被消费的派活条数（告警二期的触发条件） */
const pendingDispatches = new Map<string, number>()
const deliverMock = mock(async (_target: string, _content: string, _host: string) => true)
/** C-B：升级通知专用投递 mock（与假死重推分开计数） */
const escalationDeliverMock = mock(async (_target: string, _content: string, _host: string) => true)
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

function makeWatcher(overrides: Partial<ServantStallWatcherDeps> = {}): ServantStallWatcher {
  const deps: ServantStallWatcherDeps = {
    listServants: listServantsMock,
    deliver: deliverMock,
    getServerPort: () => 61694,
    recordEvent: recordEventMock,
    now: () => nowMs,
    isTurnInProgress: (sessionId: string) => turnInProgress.has(sessionId),
    countUnconsumedDispatches: (sessionId: string) => pendingDispatches.get(sessionId) ?? 0,
    isSdkConnected: (sessionId: string) => sdkConnected.has(sessionId),

    ...overrides,
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
  pendingDispatches.clear()
  // 默认 SDK 控制通道已连接（盲区失联是专门用例的场景）
  sdkConnected.add(EMP)
  sdkConnected.add(SUP)
  // 除专门验证"空闲待命"的用例外，默认认为员工正跑着回合
  turnInProgress.add(EMP)
  deliverMock.mockClear()
  listServantsMock.mockClear()
  recordEventMock.mockClear()
  deliverMock.mockImplementation(async () => true)
  listServantsMock.mockImplementation(async () => [])
  // C-B：清空「上一回合错误」登记（跨用例隔离）+ 注入升级通知缝
  resetServantTurnErrorsForTests()
  escalationDeliverMock.mockClear()
  escalationDeliverMock.mockImplementation(async () => true)
  setOversizeFailureDepsForTests({
    deliver: escalationDeliverMock,
    listServants: async () => [],
    getSessionWorkDir: async () => '/proj/emp',
    getServerPort: () => 61694,
    recordEvent: recordEventMock,
  } as never)
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

  // ── C-B（v1.7.5）：确定性超限失败不重推，改升级通知主管 ──────────────────

  test('C-B：上一回合是确定性超限失败 ⇒ 零重推 + 升级通知主管', async () => {
    const last = nowMs
    nowMs = last + 11 * MIN
    listServantsMock.mockImplementation(
      (async () =>
        roster({ lastActivityAt: iso(last) }).map((item) =>
          item.sessionId === SUP ? { ...item, workDir: '/proj/emp' } : item,
        )) as never,
    )
    setOversizeFailureDepsForTests({
      listServants: async () =>
        roster({ lastActivityAt: iso(last) }).map((item) =>
          item.sessionId === SUP ? { ...item, workDir: '/proj/emp' } : item,
        ),
    } as never)
    recordServantTurnError(EMP, 'Request too large: the request body exceeds the server-side size limit.')
    expect(getServantLastTurnError(EMP)).toContain('Request too large')

    const watcher = makeWatcher()
    await watcher.watch()

    // ① 零重推：不再往必败的会话里注入假死提示
    expect(deliveredTo(EMP)).toHaveLength(0)
    // ② 诊断如实记一条
    expect(actionsLogged()).toContain('deterministic-oversize-repush-skipped')
    // ③ 升级通知主管确实发出（走系统通知通道，不是注入员工会话）
    expect(escalationDeliverMock).toHaveBeenCalledTimes(1)
    expect(escalationDeliverMock.mock.calls[0][0]).toBe(SUP)
    expect(String(escalationDeliverMock.mock.calls[0][1])).toContain('请求体超限')

    // ④ 同 episode 不再重复升级
    await watcher.watch()
    expect(escalationDeliverMock).toHaveBeenCalledTimes(1)
    expect(deliveredTo(EMP)).toHaveLength(0)
  })

  test('C-B 反向用例：可恢复错误（429/网络）上一回合 ⇒ 仍照常重推（不误杀）', async () => {
    const last = nowMs
    nowMs = last + 11 * MIN
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(last) }))
    recordServantTurnError(EMP, 'Rate limited (429): too many requests')

    await makeWatcher().watch()

    const toEmp = deliveredTo(EMP)
    expect(toEmp).toHaveLength(1)
    expect(toEmp[0]).toContain(`自动重推 1/${MAX_AUTO_REPUSH}`)
    expect(actionsLogged()).not.toContain('deterministic-oversize-repush-skipped')
    expect(escalationDeliverMock).not.toHaveBeenCalled()
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
    // v1.2.3：升级降为日志级——不再注入任何会话，只写诊断
    expect(deliveredTo(SUP)).toHaveLength(0)
    expect(actionsLogged()).toContain('escalate')
    const escalateLog = recordEventMock.mock.calls.find(
      (call) => (call[0].details as { action?: string } | undefined)?.action === 'escalate',
    )
    expect(escalateLog?.[0].sessionId).toBe(EMP)

    // episode 已升级，不再重复记
    const before = actionsLogged().filter((action) => action === 'escalate').length
    await watcher.watch()
    expect(actionsLogged().filter((action) => action === 'escalate')).toHaveLength(before)
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

  test('an idle session without pending dispatches gets no message at all', async () => {
    const last = nowMs
    nowMs = last + 26 * MIN
    listServantsMock.mockImplementation(async () =>
      roster({ lastActivityAt: iso(last), running: false }),
    )
    // 干完活、进程回收、没有悬着的派活 = 正常闲置
    const watcher = makeWatcher()

    await watcher.watch()
    await watcher.watch()

    // 不向任何会话发消息（既不打扰主管，也绝不向员工投递＝不自动拉起）
    expect(deliverMock).not.toHaveBeenCalled()
    expect(actionsLogged()).toContain('skip-idle-no-dispatch')
    expect(actionsLogged()).not.toContain('no-process-alert')
    // 同一 episode 只记一次（否则每 60s 一条 info 是纯噪音）
    expect(
      actionsLogged().filter((action) => action === 'skip-idle-no-dispatch'),
    ).toHaveLength(1)

    // 新的 episode（活动时间变了）→ 允许再记一次
    const next = last + 40 * MIN
    nowMs = next + 26 * MIN
    listServantsMock.mockImplementation(async () =>
      roster({ lastActivityAt: iso(next), running: false }),
    )
    await watcher.watch()
    expect(
      actionsLogged().filter((action) => action === 'skip-idle-no-dispatch'),
    ).toHaveLength(2)
  })

  test('an idle session with pending dispatches writes a neutral warn diagnostic, no session message', async () => {
    const last = nowMs
    nowMs = last + 26 * MIN
    listServantsMock.mockImplementation(async () =>
      roster({ lastActivityAt: iso(last), running: false }),
    )
    pendingDispatches.set(EMP, 2)
    const watcher = makeWatcher()

    await watcher.watch()

    // v1.2.3：不注入任何会话（既不打扰主管，也绝不向员工投递＝不自动拉起）
    expect(deliverMock).not.toHaveBeenCalled()
    expect(actionsLogged()).toContain('no-process-alert')
    const alertLog = recordEventMock.mock.calls.find(
      (call) => (call[0].details as { action?: string } | undefined)?.action === 'no-process-alert',
    )!
    expect(alertLog[0].severity).toBe('warn')
    expect(alertLog[0].sessionId).toBe(EMP)
    expect(alertLog[0].summary).toContain('2 条派活未被消费')
    expect(alertLog[0].summary).toContain('26 分钟')
    expect(alertLog[0].details).toMatchObject({ running: false, pendingDispatches: 2 })
    // 文案不得出现惊悚词（v1.2.2 用户反馈：客户会以为产品坏了）
    for (const scary of ['假死', '不会自愈', '无效', '异常']) {
      expect(alertLog[0].summary).not.toContain(scary)
    }

    // 同一 episode 只记一次
    await watcher.watch()
    expect(
      actionsLogged().filter((action) => action === 'no-process-alert'),
    ).toHaveLength(1)

    // 新的 episode（活动时间变了，且再次越过阈值）→ 再记一次
    const second = last + 20 * MIN
    nowMs = second + 11 * MIN
    listServantsMock.mockImplementation(async () =>
      roster({ lastActivityAt: iso(second), running: false }),
    )
    await watcher.watch()
    expect(
      actionsLogged().filter((action) => action === 'no-process-alert'),
    ).toHaveLength(2)
  })

  test('a dispatch arriving later in the same episode still gets recorded', async () => {
    const last = nowMs
    nowMs = last + 26 * MIN
    listServantsMock.mockImplementation(async () =>
      roster({ lastActivityAt: iso(last), running: false }),
    )
    const watcher = makeWatcher()

    await watcher.watch()
    expect(deliverMock).not.toHaveBeenCalled()
    expect(actionsLogged()).toContain('skip-idle-no-dispatch')

    // 正常闲置期间又来了一条派活（同 episode）→ 必须记 warn，不能被去重吃掉
    pendingDispatches.set(EMP, 1)
    await watcher.watch()
    const alertLog = recordEventMock.mock.calls.find(
      (call) => (call[0].details as { action?: string } | undefined)?.action === 'no-process-alert',
    )!
    expect(alertLog[0].summary).toContain('1 条派活未被消费')
    expect(deliverMock).not.toHaveBeenCalled()
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

  // ── v1.5.0 C4：投递连续失败达阈值 → 升级上报 ──
  test('consecutive nudge delivery failures escalate to an error report (C4)', async () => {
    const last = nowMs
    nowMs = last + 11 * MIN
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(last) }))
    const watcher = makeWatcher()
    deliverMock.mockImplementation(async (target: string) => target !== EMP)

    // 前两次：仍是 warn 级 nudge-failed（计数 1/3、2/3）
    await watcher.watch()
    await watcher.watch()
    expect(actionsLogged().filter((a) => a === 'nudge-failed')).toHaveLength(2)
    expect(actionsLogged()).not.toContain('nudge-deliver-failed-streak')

    // 第三次：升级为 error 级「连续 3 次投递失败」
    await watcher.watch()
    expect(actionsLogged()).toContain('nudge-deliver-failed-streak')
    const escalated = recordEventMock.mock.calls.find(
      (call) => (call[0].details as { action?: string } | undefined)?.action === 'nudge-deliver-failed-streak',
    )
    expect(escalated?.[0].severity).toBe('error')
    expect(escalated?.[0].sessionId).toBe(EMP)

    // 升级后计数清零：再来两次仍是 warn，不是每轮都报 error
    const errorCountBefore = actionsLogged().filter((a) => a === 'nudge-deliver-failed-streak').length
    await watcher.watch()
    await watcher.watch()
    expect(actionsLogged().filter((a) => a === 'nudge-deliver-failed-streak')).toHaveLength(errorCountBefore)
  })

  test('a successful nudge delivery resets the failure streak (C4)', async () => {
    const last = nowMs
    nowMs = last + 11 * MIN
    listServantsMock.mockImplementation(async () => roster({ lastActivityAt: iso(last) }))
    const watcher = makeWatcher()

    deliverMock.mockImplementation(async (target: string) => target !== EMP)
    await watcher.watch()
    await watcher.watch()
    expect(actionsLogged().filter((a) => a === 'nudge-failed')).toHaveLength(2)

    // 投递恢复一次 → 计数清零；之后两次失败不应立刻升级
    deliverMock.mockImplementation(async () => true)
    await watcher.watch()
    deliverMock.mockImplementation(async (target: string) => target !== EMP)
    await watcher.watch()
    await watcher.watch()
    expect(actionsLogged()).not.toContain('nudge-deliver-failed-streak')
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
  // v1.4.0 阶段2 · 6「转圈无上限」：进程活着但 SDK 控制通道断开（盲区失联）——
  // detachSdkConnection 已清 turn（呈待命假象），watcher 必须补一条可行动路径：
  // 同一 episode 只上报一次 blind-disconnect（error 级诊断），供人工介入。
  test('reports a blind disconnect once when running but the SDK channel is gone', async () => {
    listServantsMock.mockImplementation(async () =>
      roster({ running: true, lastActivityAt: iso(nowMs - STALL_THRESHOLD_MS - 1) }),
    )
    sdkConnected.delete(EMP)
    turnInProgress.delete(EMP) // turn 已在 detach 时被清：否则会先走假死重推分支

    // 同一 watcher 实例（episode 去重状态在实例字段里）
    const watcher = makeWatcher()
    await watcher.watch()
    const blind = recordEventMock.mock.calls.filter(
      (call) => (call[0].details as { action?: string } | undefined)?.action === 'blind-disconnect',
    )
    expect(blind).toHaveLength(1)
    expect(blind[0][0].severity).toBe('error')
    expect(blind[0][0].sessionId).toBe(EMP)

    // 同一 episode（lastActivityAt 未变）不重复上报
    await watcher.watch()
    const blindAgain = recordEventMock.mock.calls.filter(
      (call) => (call[0].details as { action?: string } | undefined)?.action === 'blind-disconnect',
    )
    expect(blindAgain).toHaveLength(1)
  })

  test('does not report blind disconnect while the SDK channel is connected', async () => {
    listServantsMock.mockImplementation(async () =>
      roster({ running: true, lastActivityAt: iso(nowMs - STALL_THRESHOLD_MS - 1) }),
    )
    // 通道连接 + 回合已结束 → 走既有 skip-idle 分支，不得误报盲区
    turnInProgress.delete(EMP)

    await makeWatcher().watch()
    const blind = recordEventMock.mock.calls.filter(
      (call) => (call[0].details as { action?: string } | undefined)?.action === 'blind-disconnect',
    )
    expect(blind).toHaveLength(0)
  })

  test('a fresh blind disconnect after activity resumes is reported again', async () => {
    const stale = iso(nowMs - STALL_THRESHOLD_MS - 1)
    listServantsMock.mockImplementation(async () => roster({ running: true, lastActivityAt: stale }))
    sdkConnected.delete(EMP)
    turnInProgress.delete(EMP)

    await makeWatcher().watch()
    // 活动恢复（新 lastActivityAt）→ episode 重置 → 再次失联是新 episode
    const fresh = iso(nowMs - STALL_THRESHOLD_MS - 2)
    listServantsMock.mockImplementation(async () => roster({ running: true, lastActivityAt: fresh }))
    await makeWatcher().watch()

    const blind = recordEventMock.mock.calls.filter(
      (call) => (call[0].details as { action?: string } | undefined)?.action === 'blind-disconnect',
    )
    expect(blind).toHaveLength(2)
  })
})

// ── P1：主管会话被「投递程序化拉起」时纳入覆盖（用户在场的主管仍豁免）──────────
describe('P1 主管会话覆盖（startedByDelivery）', () => {
  const STALE = 60 * 60_000

  beforeEach(() => {
    recordEventMock.mockClear()
    deliverMock.mockClear()
    turnInProgress.clear()
    sdkConnected.clear()
    pendingDispatches.clear()
  })

  function supervisorOnly(running: boolean): StallServantInfo[] {
    return [{ sessionId: SUP, title: '主管', role: '主管', enabled: true, supervisor: true, running, lastActivityAt: iso(nowMs - STALE) }]
  }

  test('主管 + 投递拉起 + running=false + 有悬置派活 → 告警 supervisor-session-stalled', async () => {
    listServantsMock.mockResolvedValue(supervisorOnly(false))
    pendingDispatches.set(SUP, 2)
    const watcher = makeWatcher({ isStartedByDelivery: () => true })
    await watcher.watch()
    const alerts = recordEventMock.mock.calls.map((c) => c[0]).filter((e) => (e.details as { action?: string })?.action === 'supervisor-session-stalled')
    expect(alerts).toHaveLength(1)
    expect((alerts[0] as { sessionId?: string }).sessionId).toBe(SUP)
    expect(deliveredTo(SUP)).toEqual([]) // 绝不自动拉起/投递
  })

  test('反向：主管**未**打标（用户直接驱动）→ 豁免，不告警', async () => {
    listServantsMock.mockResolvedValue(supervisorOnly(false))
    pendingDispatches.set(SUP, 2)
    const watcher = makeWatcher({ isStartedByDelivery: () => false })
    await watcher.watch()
    const types = recordEventMock.mock.calls.map((c) => c[0]).map((e) => (e.details as { action?: string })?.action)
    expect(types).not.toContain('supervisor-session-stalled')
    expect(types).not.toContain('no-process-alert')
  })

  test('用户接管（清标）后回到豁免：同一会话从覆盖态复原为不告警', async () => {
    listServantsMock.mockResolvedValue(supervisorOnly(false))
    pendingDispatches.set(SUP, 2)
    let startedByDelivery = true
    const watcher = makeWatcher({ isStartedByDelivery: () => startedByDelivery })
    await watcher.watch()
    expect(recordEventMock.mock.calls.map((c) => c[0]).filter((e) => (e.details as { action?: string })?.action === 'supervisor-session-stalled')).toHaveLength(1)
    startedByDelivery = false // 等价 handler 在 user_message 时调 clearSessionStartedByDelivery
    recordEventMock.mockClear()
    await watcher.watch()
    expect(recordEventMock.mock.calls.map((c) => c[0]).filter((e) => (e.details as { action?: string })?.action === 'supervisor-session-stalled')).toHaveLength(0)
  })

  test('主管 + 投递拉起 + running=true + 回合进行中 → 走有限重推（非拉起）', async () => {
    listServantsMock.mockResolvedValue(supervisorOnly(true))
    turnInProgress.add(SUP)
    sdkConnected.add(SUP)
    pendingDispatches.set(SUP, 1)
    const watcher = makeWatcher({ isStartedByDelivery: () => true })
    await watcher.watch()
    const nudges = recordEventMock.mock.calls.map((c) => c[0]).filter((e) => (e.details as { action?: string })?.action === 'nudge')
    expect(nudges).toHaveLength(1)
    expect(deliveredTo(SUP)).toHaveLength(1)
  })
})
