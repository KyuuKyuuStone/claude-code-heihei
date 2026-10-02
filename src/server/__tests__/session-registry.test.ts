import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  beginTurn,
  beginTurnReplacing,
  clearSession,
  dropActiveTurn,
  exists,
  getSessionSnapshot,
  hasActiveTurn,
  isTurnMessageSent,
  markCrashed,
  markRunning,
  markStarting,
  markStopped,
  markTurnSent,
  observeTurnResult,
  registerSession,
  resetRegistryForTests,
  setAwaitingPermission,
  settleTurnIfOwner,
  tombstoneSession,
  type SessionPhase,
} from '../services/sessionRegistry.js'
import {
  onSessionEvent,
  resetSessionEventsForTests,
  type SessionEvent,
} from '../services/sessionEvents.js'
import { setDiagnosticsLogWriterForTests } from '../../utils/diagLogs.js'

/**
 * sessionRegistry 状态机合同测试（v1.3.0 地基重构 · 阶段 0）。
 * 锁定架构方案 §1 迁移表 + §2 事件纪律 + §4 阶段 1 合同补充（clearSession 幂等校正）。
 * 诊断经 setDiagnosticsLogWriterForTests 注入收集（DI 缝，冷热确定——C7 禁 mock.module）。
 */

type DiagEntry = { level: string; event: string; data?: Record<string, unknown> }

let diag: DiagEntry[] = []
let events: SessionEvent[] = []

/** 到达各相的最短合法链（全部由合法迁移组成）。 */
const PATH_TO: Record<SessionPhase, (id: string) => void> = {
  registered: (id) => registerSession(id),
  starting: (id) => {
    PATH_TO.registered(id)
    markStarting(id)
  },
  running: (id) => {
    PATH_TO.starting(id)
    markRunning(id)
  },
  crashed: (id) => {
    PATH_TO.running(id)
    markCrashed(id, { exitCode: 137 })
  },
  stopped: (id) => {
    PATH_TO.running(id)
    markStopped(id)
  },
  deleted: (id) => {
    PATH_TO.registered(id)
    tombstoneSession(id)
  },
}

/** 各目标相的迁移 API（迁移表测试用）。 */
const MOVE_TO: Record<SessionPhase, (id: string) => void> = {
  registered: (id) => registerSession(id), // 恢复场景（deleted → registered）
  starting: (id) => markStarting(id),
  running: (id) => markRunning(id),
  crashed: (id) => markCrashed(id, { exitCode: 1 }),
  stopped: (id) => markStopped(id),
  deleted: (id) => tombstoneSession(id),
}

const PHASES: SessionPhase[] = ['registered', 'starting', 'running', 'crashed', 'stopped', 'deleted']

/** 架构方案 §1 迁移表（合法目标相）。 */
const LEGAL: Record<SessionPhase, SessionPhase[]> = {
  registered: ['starting', 'deleted'],
  starting: ['registered', 'running', 'crashed', 'stopped', 'deleted'],
  running: ['starting', 'crashed', 'stopped', 'deleted'],
  crashed: ['starting', 'stopped', 'deleted'],
  stopped: ['starting', 'deleted'],
  deleted: ['registered'],
}

function phaseOf(id: string): SessionPhase | null {
  return getSessionSnapshot(id)?.phase ?? null
}

function rejectedDiags(): DiagEntry[] {
  return diag.filter((d) => d.level === 'warn' && d.event.endsWith('_rejected'))
}

beforeEach(() => {
  resetRegistryForTests()
  resetSessionEventsForTests()
  diag = []
  events = []
  setDiagnosticsLogWriterForTests((level, event, data) => {
    diag.push({ level, event, data })
  })
  onSessionEvent((e) => {
    events.push(e)
  })
})

afterEach(() => {
  setDiagnosticsLogWriterForTests(null)
  resetRegistryForTests()
  resetSessionEventsForTests()
})

describe('合法迁移表（§1 表格逐条锁定）', () => {
  for (const from of PHASES) {
    for (const to of LEGAL[from]) {
      // starting → registered（失败重试）当前无 API 入口：registerSession 对非 deleted
      // 条目是拒绝语义（v1.2.4 重复登记拒绝）。该表条目在下方以表层面锁定 + 记录性
      // 测试固化，API 路径待阶段 1/2 补 markStartFailed 类入口后再接入（已在汇报注明）。
      if (from === 'starting' && to === 'registered') continue
      test(`${from} → ${to} 迁移成功且发 phase_changed`, () => {
        const id = 's1'
        PATH_TO[from](id)
        expect(phaseOf(id)).toBe(from)
        diag = []
        events = []

        MOVE_TO[to](id)

        expect(phaseOf(id)).toBe(to)
        const lastPhaseEvent = [...events].reverse().find((e) => e.type === 'phase_changed')
        expect(lastPhaseEvent).toBeDefined()
        if (lastPhaseEvent?.type === 'phase_changed') {
          expect(lastPhaseEvent.from).toBe(from)
          expect(lastPhaseEvent.to).toBe(to)
        }
        expect(rejectedDiags()).toHaveLength(0)
      })
    }
  }

  test('迁移表锁定：starting → registered（失败重试）在表内；当前无 API 入口（记录性测试）', () => {
    // 表层面：该条目存在于合法迁移表
    expect(LEGAL.starting).toContain('registered')
    // API 现状：registerSession 对已存在非 deleted 条目是拒绝语义，不触达该迁移
    const id = 's1'
    PATH_TO.starting(id)
    diag = []
    events = []
    registerSession(id)
    expect(phaseOf(id)).toBe('starting')
    expect(diag.some((d) => d.event === 'session_registry_register_rejected')).toBe(true)
    expect(events.filter((e) => e.type === 'phase_changed')).toHaveLength(0)
  })

  test('crashed → starting（显式重启）语义锚点', () => {
    const id = 's1'
    PATH_TO.crashed(id)
    markStarting(id)
    expect(phaseOf(id)).toBe('starting')
  })
  // v1.7.2 裁决二十一④ 合同补充：SDK 未确认时的「拉起中」是**稳定态**——
  // 超时不是终局：phase 停在 starting，直到（可能迟到的）markRunning 才转 running。
  test('starting 是稳定态：未 markRunning 前保持 starting，迟到 markRunning 仍合法', () => {
    const id = 's1'
    registerSession(id)
    markStarting(id)
    expect(phaseOf(id)).toBe('starting')
    // 重复 markStarting = 幂等 no-op，不会自行升级为 running
    markStarting(id)
    expect(phaseOf(id)).toBe('starting')
    // 迟到确认（子预算超时后 attach）仍走合法迁移 starting → running
    markRunning(id)
    expect(phaseOf(id)).toBe('running')
  })

})

describe('非法迁移（表外拒绝并记诊断，不静默失败）', () => {
  for (const from of PHASES) {
    for (const to of PHASES) {
      if (from === to) continue
      if (LEGAL[from].includes(to)) continue
      test(`${from} → ${to} 被拒绝：状态不变 + warn 诊断 + 无事件`, () => {
        const id = 's1'
        PATH_TO[from](id)
        diag = []
        events = []

        MOVE_TO[to](id)

        expect(phaseOf(id)).toBe(from)
        expect(rejectedDiags().length).toBeGreaterThanOrEqual(1)
        expect(rejectedDiags()[0]?.data?.['sessionId']).toBe(id)
        expect(events.filter((e) => e.type === 'phase_changed')).toHaveLength(0)
      })
    }
  }

  test('registered → crashed（任务指定的代表性非法迁移）', () => {
    const id = 's1'
    registerSession(id)
    markCrashed(id, { exitCode: 1 })
    expect(phaseOf(id)).toBe('registered')
    expect(diag.some((d) => d.event === 'session_registry_transition_rejected')).toBe(true)
  })
})

describe('对角线幂等（同相重复调用）', () => {
  test('running 重复 markRunning：no-op、无事件、无诊断', () => {
    const id = 's1'
    PATH_TO.running(id)
    diag = []
    events = []
    markRunning(id)
    markRunning(id)
    expect(phaseOf(id)).toBe('running')
    expect(events).toHaveLength(0)
    expect(diag).toHaveLength(0)
  })

  test('deleted 幂等：tombstone 重复调用不发事件', () => {
    const id = 's1'
    PATH_TO.registered(id)
    tombstoneSession(id)
    events = []
    tombstoneSession(id)
    tombstoneSession(id)
    expect(phaseOf(id)).toBe('deleted')
    expect(events).toHaveLength(0)
  })

  test('deleted 后 markStarting 被拒（表外）', () => {
    const id = 's1'
    PATH_TO.deleted(id)
    diag = []
    markStarting(id)
    expect(phaseOf(id)).toBe('deleted')
    expect(rejectedDiags().length).toBeGreaterThanOrEqual(1)
  })
})

describe('beginTurn / TurnHandle', () => {
  test('未登记会话：返回 null 并记诊断', () => {
    expect(beginTurn('ghost', { awaitSend: false })).toBeNull()
    expect(diag.some((d) => d.event === 'session_registry_begin_turn_no_session')).toBe(true)
  })

  test('deleted（tombstone）会话：返回 null 并记诊断', () => {
    const id = 's1'
    PATH_TO.deleted(id)
    diag = []
    expect(beginTurn(id, { awaitSend: false })).toBeNull()
    expect(diag.some((d) => d.event === 'session_registry_begin_turn_no_session')).toBe(true)
    expect(hasActiveTurn(id)).toBe(false)
  })

  test('awaitSend:true → awaiting_send，消息未发出', () => {
    const id = 's1'
    PATH_TO.running(id)
    const handle = beginTurn(id, { awaitSend: true })
    expect(handle).not.toBeNull()
    expect(getSessionSnapshot(id)?.turn).toBe('awaiting_send')
    expect(isTurnMessageSent(id)).toBe(false)
    expect(hasActiveTurn(id)).toBe(true)
    expect(typeof handle?.identity).toBe('symbol')
  })

  test('awaitSend:false → turn_in_progress（messageSent 语义）', () => {
    const id = 's1'
    PATH_TO.running(id)
    beginTurn(id, { awaitSend: false })
    expect(getSessionSnapshot(id)?.turn).toBe('turn_in_progress')
    expect(isTurnMessageSent(id)).toBe(true)
  })

  test('幂等：已有活跃 turn 时再次 beginTurn 返回 null 且不发事件', () => {
    const id = 's1'
    PATH_TO.running(id)
    const first = beginTurn(id, { awaitSend: true })
    expect(first).not.toBeNull()
    events = []
    const second = beginTurn(id, { awaitSend: false })
    expect(second).toBeNull()
    expect(events).toHaveLength(0)
    expect(getSessionSnapshot(id)?.turn).toBe('awaiting_send')
  })

  // ── v1.5.0 低7：beginTurnReplacing 原子替换语义 ──
  test('beginTurnReplacing：无 turn 时等价 beginTurn', () => {
    const id = 's1'
    PATH_TO.running(id)
    const handle = beginTurnReplacing(id, { awaitSend: true })
    expect(handle).not.toBeNull()
    expect(getSessionSnapshot(id)?.turn).toBe('awaiting_send')
  })

  test('beginTurnReplacing：已有 turn 时顶掉旧回合建新回合（旧 owner 作废）', () => {
    const id = 's1'
    PATH_TO.running(id)
    const first = beginTurn(id, { awaitSend: true })!
    events = []

    const second = beginTurnReplacing(id, { awaitSend: false })

    expect(second).not.toBeNull()
    expect(second!.identity).not.toBe(first.identity)
    expect(getSessionSnapshot(id)?.turnOwner).toBe(second!.identity)
    expect(getSessionSnapshot(id)?.turn).toBe('turn_in_progress')
    // 旧回合被清（turn_changed none/替换原因），再建新回合——两次事件同批可见
    const cleared = events.find(
      (e) => e.type === 'turn_changed' && e.meta?.['reason'] === 'replaced_by_new_turn',
    )
    expect(cleared).toBeDefined()
    // 旧 handle 的 settle 不再生效（身份已作废）
    first.settle({ isError: false })
    expect(getSessionSnapshot(id)?.turnOwner).toBe(second!.identity)
  })

  test('beginTurnReplacing：未登记/deleted 会话返回 null（与 beginTurn 同）', () => {
    expect(beginTurnReplacing('ghost', { awaitSend: false })).toBeNull()
    const id = 's1'
    PATH_TO.deleted(id)
    expect(beginTurnReplacing(id, { awaitSend: false })).toBeNull()
  })

  test('abort：清回合并记 lastTurnEndedAt', () => {
    const id = 's1'
    PATH_TO.running(id)
    const handle = beginTurn(id, { awaitSend: true })
    handle!.abort()
    expect(getSessionSnapshot(id)?.turn).toBe('none')
    expect(getSessionSnapshot(id)?.turnOwner).toBeNull()
    expect(getSessionSnapshot(id)?.lastTurnEndedAt).not.toBeNull()
    expect(hasActiveTurn(id)).toBe(false)
    const last = events[events.length - 1]
    expect(last?.type).toBe('turn_changed')
    if (last?.type === 'turn_changed') expect(last.meta?.['reason']).toBe('abort')
  })

  test('settle：清回合，事件 meta 带 isError', () => {
    const id = 's1'
    PATH_TO.running(id)
    const handle = beginTurn(id, { awaitSend: false })
    handle!.settle({ isError: true })
    expect(getSessionSnapshot(id)?.turn).toBe('none')
    const last = events[events.length - 1]
    if (last?.type === 'turn_changed') expect(last.meta?.['isError']).toBe(true)
  })

  test('settleTurnIfOwner：正确 handle 清回合；他人 handle 无害 no-op', () => {
    const idA = 'a'
    const idB = 'b'
    PATH_TO.running(idA)
    PATH_TO.running(idB)
    const handleA = beginTurn(idA, { awaitSend: false })
    const handleB = beginTurn(idB, { awaitSend: false })
    settleTurnIfOwner(idA, handleB!) // 他人身份：no-op
    expect(getSessionSnapshot(idA)?.turn).toBe('turn_in_progress')
    settleTurnIfOwner(idA, handleA!) // 本人身份：清
    expect(getSessionSnapshot(idA)?.turn).toBe('none')
    expect(getSessionSnapshot(idB)?.turn).toBe('turn_in_progress')
  })

  test('回合结束后 handle 再 settle/abort：幂等 no-op（不发事件）', () => {
    const id = 's1'
    PATH_TO.running(id)
    const handle = beginTurn(id, { awaitSend: false })
    handle!.settle({ isError: false })
    events = []
    handle!.settle({ isError: false })
    handle!.abort()
    settleTurnIfOwner(id, handle!)
    expect(events).toHaveLength(0)
    expect(getSessionSnapshot(id)?.turn).toBe('none')
  })
})

describe('setAwaitingPermission', () => {
  test('翻转发 permission_changed；同值幂等不发', () => {
    const id = 's1'
    PATH_TO.running(id)
    setAwaitingPermission(id, true)
    expect(getSessionSnapshot(id)?.awaitingPermission).toBe(true)
    setAwaitingPermission(id, true)
    setAwaitingPermission(id, false)
    expect(getSessionSnapshot(id)?.awaitingPermission).toBe(false)
    const permEvents = events.filter((e) => e.type === 'permission_changed')
    expect(permEvents).toHaveLength(2)
    expect(permEvents[0]).toMatchObject({ type: 'permission_changed', sessionId: id, awaiting: true })
    expect(permEvents[1]).toMatchObject({ type: 'permission_changed', sessionId: id, awaiting: false })
  })

  test('未登记会话：no-op 无事件', () => {
    setAwaitingPermission('ghost', true)
    expect(events).toHaveLength(0)
  })
})

describe('clearSession 幂等校正（§4 阶段 1 合同补充 1）', () => {
  test('running（含活跃回合）→ 强制落 stopped 再移除条目', () => {
    const id = 's1'
    PATH_TO.running(id)
    beginTurn(id, { awaitSend: false })
    events = []

    clearSession(id)

    expect(getSessionSnapshot(id)).toBeNull()
    expect(exists(id)).toBe(false)
    expect(hasActiveTurn(id)).toBe(false)
    const kinds = events.map((e) => (e.type === 'phase_changed' ? `phase:${e.from}->${e.to}` : `turn:${e.turn}`))
    expect(kinds).toEqual(['phase:running->stopped', 'turn:none'])
  })

  test('crashed → 强制落 stopped（同一校正路径）', () => {
    const id = 's1'
    PATH_TO.crashed(id)
    events = []
    clearSession(id)
    expect(getSessionSnapshot(id)).toBeNull()
    const phaseEvent = events.find((e) => e.type === 'phase_changed')
    expect(phaseEvent).toMatchObject({ type: 'phase_changed', from: 'crashed', to: 'stopped' })
  })

  test('registered（无进程）→ 直接移除，无校正事件', () => {
    const id = 's1'
    PATH_TO.registered(id)
    events = []
    clearSession(id)
    expect(getSessionSnapshot(id)).toBeNull()
    expect(events).toHaveLength(0)
  })

  test('幂等：clearSession 两次，第二次 no-op 无事件', () => {
    const id = 's1'
    PATH_TO.running(id)
    clearSession(id)
    events = []
    clearSession(id)
    expect(events).toHaveLength(0)
  })
})

describe('tombstoneSession', () => {
  test('running（含活跃回合）→ 先清回合再落 deleted', () => {
    const id = 's1'
    PATH_TO.running(id)
    beginTurn(id, { awaitSend: false })
    events = []
    tombstoneSession(id)
    expect(phaseOf(id)).toBe('deleted')
    expect(exists(id)).toBe(false)
    const kinds = events.map((e) => (e.type === 'phase_changed' ? `phase:${e.from}->${e.to}` : `turn:${e.turn}`))
    expect(kinds).toEqual(['turn:none', 'phase:running->deleted'])
  })

  test('deleted 后 beginTurn 被拒（tombstone 不可建回合）', () => {
    const id = 's1'
    PATH_TO.deleted(id)
    expect(beginTurn(id, { awaitSend: false })).toBeNull()
  })
})

describe('事件顺序：先改状态后发（C5）', () => {
  test('handler 内读到的快照已是新状态', () => {
    const id = 's1'
    PATH_TO.registered(id)
    const seen: SessionPhase[] = []
    const unsubscribe = onSessionEvent((e) => {
      if (e.type === 'phase_changed') seen.push(getSessionSnapshot(id)?.phase ?? ('<gone>' as SessionPhase))
    })
    try {
      markStarting(id)
      markRunning(id)
    } finally {
      unsubscribe()
    }
    expect(seen).toEqual(['starting', 'running'])
  })

  test('完整事件序列：register→starting→running', () => {
    const id = 's1'
    registerSession(id)
    markStarting(id)
    markRunning(id)
    expect(events).toEqual([
      { type: 'phase_changed', sessionId: id, from: 'registered', to: 'starting' },
      { type: 'phase_changed', sessionId: id, from: 'starting', to: 'running' },
    ])
  })

  test('恢复场景：deleted → registered 发事件且状态全重置', () => {
    const id = 's1'
    PATH_TO.running(id)
    beginTurn(id, { awaitSend: false })
    setAwaitingPermission(id, true)
    tombstoneSession(id)
    events = []
    registerSession(id) // 恢复
    expect(phaseOf(id)).toBe('registered')
    expect(getSessionSnapshot(id)).toMatchObject({
      sessionId: id,
      phase: 'registered',
      turn: 'none',
      turnOwner: null,
      awaitingPermission: false,
      lastTurnEndedAt: null,
    })
    expect(events).toEqual([{ type: 'phase_changed', sessionId: id, from: 'deleted', to: 'registered' }])
  })

  test('重复登记（非 deleted 态）拒绝并记诊断', () => {
    const id = 's1'
    PATH_TO.running(id)
    diag = []
    events = []
    registerSession(id)
    expect(phaseOf(id)).toBe('running')
    expect(diag.some((d) => d.event === 'session_registry_register_rejected')).toBe(true)
    expect(events).toHaveLength(0)
  })
})

describe('重入断言（assertNotReentrant）', () => {
  test('观察者 handler 内同步写 registry → 被拦截；先改状态后发仍成立；其他观察者不受影响', () => {
    const id = 's1'
    PATH_TO.registered(id)
    let secondObserverSaw = false
    let reentrantError: unknown = null
    const off1 = onSessionEvent((e) => {
      if (e.type === 'phase_changed' && e.to === 'starting') {
        try {
          markStopped(id) // 违规：handler 内同步写
        } catch (error) {
          reentrantError = error
        }
      }
    })
    const off2 = onSessionEvent(() => {
      secondObserverSaw = true
    })
    try {
      markStarting(id)
    } finally {
      off1()
      off2()
    }
    expect(reentrantError).toBeInstanceOf(Error)
    expect((reentrantError as Error).message).toContain('reentrant')
    expect(phaseOf(id)).toBe('starting') // 先改状态后发：状态不受违规写入影响
    expect(secondObserverSaw).toBe(true) // 总线未被单个观察者炸挂
  })

  test('非派发窗口调用写 API 不受影响', () => {
    const id = 's1'
    PATH_TO.running(id)
    markStopped(id) // 非 emitting 窗口：合法迁移正常执行
    expect(phaseOf(id)).toBe('stopped')
  })
})

describe('事件过滤与退订', () => {
  test('types 过滤', () => {
    const id = 's1'
    const got: SessionEvent[] = []
    const off = onSessionEvent((e) => got.push(e), { types: ['turn_changed'] })
    try {
      PATH_TO.running(id)
      beginTurn(id, { awaitSend: false })
    } finally {
      off()
    }
    expect(got.length).toBeGreaterThan(0)
    expect(got.every((e) => e.type === 'turn_changed')).toBe(true)
  })

  test('sessionId 过滤 + 退订', () => {
    const got: SessionEvent[] = []
    const off = onSessionEvent((e) => got.push(e), { sessionId: 's2' })
    PATH_TO.running('s1')
    off()
    off() // 重复退订无害
    PATH_TO.running('s2')
    expect(got).toHaveLength(0) // s1 事件被过滤；s2 事件发生时已退订
  })

  test('resetSessionEventsForTests 清空监听器', () => {
    const got: SessionEvent[] = []
    onSessionEvent((e) => got.push(e))
    resetSessionEventsForTests()
    PATH_TO.running('s1')
    expect(got).toHaveLength(0)
  })
})

describe('reset 完整性（C7）', () => {
  test('resetRegistryForTests 后无残留状态', () => {
    const id = 's1'
    PATH_TO.running(id)
    beginTurn(id, { awaitSend: false })
    resetRegistryForTests()
    expect(getSessionSnapshot(id)).toBeNull()
    expect(exists(id)).toBe(false)
    expect(hasActiveTurn(id)).toBe(false)
    expect(isTurnMessageSent(id)).toBe(false)
  })

  test('reset 后同 id 重新登记为全新状态', () => {
    const id = 's1'
    PATH_TO.running(id)
    const handle = beginTurn(id, { awaitSend: false })
    handle!.settle({ isError: false })
    resetRegistryForTests()
    registerSession(id)
    expect(getSessionSnapshot(id)).toMatchObject({
      phase: 'registered',
      turn: 'none',
      turnOwner: null,
      awaitingPermission: false,
      lastTurnEndedAt: null,
    })
  })

  test('事件监听器随 resetSessionEventsForTests 清空（无泄漏）', () => {
    const id = 's1'
    let count = 0
    onSessionEvent(() => {
      count += 1
    })
    registerSession(id)
    markStarting(id)
    markRunning(id)
    expect(count).toBe(2)
    resetSessionEventsForTests()
    const id2 = 's2'
    registerSession(id2)
    markStarting(id2)
    markRunning(id2)
    expect(count).toBe(2) // 清空后旧监听器不再收到
  })
})

describe('读取 API 边界', () => {
  test('未登记会话：全返回空语义', () => {
    expect(getSessionSnapshot('ghost')).toBeNull()
    expect(exists('ghost')).toBe(false)
    expect(hasActiveTurn('ghost')).toBe(false)
    expect(isTurnMessageSent('ghost')).toBe(false)
  })

  test('crashed 是非 deleted 存在态：exists 为 true', () => {
    const id = 's1'
    PATH_TO.crashed(id)
    expect(exists(id)).toBe(true)
    expect(phaseOf(id)).toBe('crashed')
  })
})

describe('markTurnSent（awaiting_send → turn_in_progress 提升 · 阶段 1 接线新增）', () => {
  test('owner 匹配时提升并发 turn_changed', () => {
    const id = 's1'
    registerSession(id)
    const handle = beginTurn(id, { awaitSend: true })
    expect(handle).not.toBeNull()
    markTurnSent(id, handle!)
    expect(getSessionSnapshot(id)!.turn).toBe('turn_in_progress')
    expect(isTurnMessageSent(id)).toBe(true)
    const turns = events.filter((e) => e.type === 'turn_changed')
    expect(turns).toHaveLength(2) // begin(awaiting_send) + promote(turn_in_progress)
  })

  test('owner 不匹配（陈旧句柄）时 no-op，不污染新回合', () => {
    const id = 's1'
    registerSession(id)
    const stale = beginTurn(id, { awaitSend: true })!
    stale.abort() // turn 清
    const fresh = beginTurn(id, { awaitSend: true })!
    expect(fresh).not.toBeNull()
    markTurnSent(id, stale) // 陈旧句柄的迟到提升
    expect(getSessionSnapshot(id)!.turn).toBe('awaiting_send')
  })

  test('非 awaiting_send（已提升/已清）时幂等 no-op', () => {
    const id = 's1'
    registerSession(id)
    const handle = beginTurn(id, { awaitSend: false })! // 直接 turn_in_progress
    markTurnSent(id, handle)
    expect(getSessionSnapshot(id)!.turn).toBe('turn_in_progress')
    const turns = events.filter((e) => e.type === 'turn_changed')
    expect(turns).toHaveLength(1) // 仅 begin 那次
  })
})

describe('双输入源交错规则（观察流只降不升 · §4 阶段 1 合同补充 2）', () => {
  test('观察先行：无 turn 时观察到的进行中信号被丢弃（只降不升）', () => {
    const id = 's1'
    // 未登记：no-op 且不创建条目
    observeTurnResult(id, { isError: false })
    expect(getSessionSnapshot(id)).toBeNull()
    // 已登记但无 turn：同样 no-op（观察流不得新建 turn）
    registerSession(id)
    observeTurnResult(id, { isError: false })
    expect(getSessionSnapshot(id)!.turn).toBe('none')
    expect(events.filter((e) => e.type === 'turn_changed')).toHaveLength(0)
    // 之后注入/WS 正常建立回合不受影响
    const handle = beginTurn(id, { awaitSend: true })
    expect(handle).not.toBeNull()
    expect(getSessionSnapshot(id)!.turn).toBe('awaiting_send')
  })

  test('注入先行：观察到的 result 清除任何 turn（观察流是 CLI 事实的最终裁决者）', () => {
    const id = 's1'
    registerSession(id)
    const handle = beginTurn(id, { awaitSend: true })!
    expect(hasActiveTurn(id)).toBe(true)
    observeTurnResult(id, { isError: false })
    expect(getSessionSnapshot(id)!.turn).toBe('none')
    // 被裁决回合的句柄后续 settle 无害 no-op（owner 已不符）
    handle.settle({ isError: false })
    expect(getSessionSnapshot(id)!.turn).toBe('none')
    // 可立即建立新回合
    expect(beginTurn(id, { awaitSend: false })).not.toBeNull()
  })

  test('双清竞争：handle.settle 与 observeTurnResult 先后抵达，幂等且只发一次清除事件', () => {
    const id = 's1'
    registerSession(id)
    // 顺序 A：settle 先、观察后
    const a = beginTurn(id, { awaitSend: false })!
    a.settle({ isError: false })
    observeTurnResult(id, { isError: false })
    expect(getSessionSnapshot(id)!.turn).toBe('none')
    // 顺序 B：观察先、settle 后
    const b = beginTurn(id, { awaitSend: false })!
    observeTurnResult(id, { isError: true })
    b.settle({ isError: true })
    expect(getSessionSnapshot(id)!.turn).toBe('none')
    // 每个 turn 只发过一次清除事件（第二次清除是 no-op 不发）
    const noneEvents = events.filter(
      (e) => e.type === 'turn_changed' && e.turn === 'none',
    )
    expect(noneEvents).toHaveLength(2)
    // is_error 穿透 meta，诊断可回查
    expect(noneEvents[1]).toMatchObject({ type: 'turn_changed', turn: 'none', meta: { reason: 'observed_result', isError: true } })
  })
})

// v1.4.0 阶段2 · 6「转圈无上限」：观察通道（SDK socket）断开而进程未退时，
// turn 失去全部清除来源——dropActiveTurn 预防性清除并照发 turn_changed(none)
//（前端状态灯经补偿广播立即降下）。
describe('dropActiveTurn（观察通道失联的预防性清除）', () => {
  test('clears an in-progress turn and emits turn_changed(none) with the blind reason', () => {
    const id = 's1'
    PATH_TO.running(id)
    beginTurn(id, { awaitSend: false })
    expect(hasActiveTurn(id)).toBe(true)

    const events: SessionEvent[] = []
    const off = onSessionEvent((e) => events.push(e))
    dropActiveTurn(id, { cause: 'sdk_socket_disconnected' })
    off()

    expect(hasActiveTurn(id)).toBe(false)
    expect(getSessionSnapshot(id)?.turn).toBe('none')
    const none = events.filter((e) => e.type === 'turn_changed' && e.turn === 'none')
    expect(none).toHaveLength(1)
    expect(none[0]).toMatchObject({
      sessionId: id,
      turn: 'none',
      meta: { reason: 'observation_blind', cause: 'sdk_socket_disconnected' },
    })
  })

  test('is a no-op when no turn is active (idempotent)', () => {
    const id = 's1'
    PATH_TO.running(id)
    const events: SessionEvent[] = []
    const off = onSessionEvent((e) => events.push(e))
    dropActiveTurn(id)
    dropActiveTurn(id)
    off()

    expect(hasActiveTurn(id)).toBe(false)
    expect(events.filter((e) => e.type === 'turn_changed')).toHaveLength(0)
  })
})

