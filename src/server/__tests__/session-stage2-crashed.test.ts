import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  beginTurn,
  clearSession,
  getSessionSnapshot,
  hasActiveTurn,
  markCrashed,
  markRunning,
  markStarting,
  markStopped,
  observeTurnResult,
  registerSession,
  resetRegistryForTests,
  tombstoneSession,
} from '../services/sessionRegistry.js'
import { emitSessionEvent, onSessionEvent, resetSessionEventsForTests } from '../services/sessionEvents.js'
import {
  isSessionTurnInProgress,
  observeSessionSdkMessage,
  resetDispatchReceipts,
} from '../services/dispatchReceiptService.js'
import {
  resetServantIncidentState,
  setServantIncidentDeps,
  subscribeServantCrashObserver,
  unsubscribeServantCrashObserver,
} from '../services/servantIncidentNotifier.js'

/**
 * v1.3.0 阶段2 专项：crashed 中间态生命周期 + 双输入源一致性 + 事件顺序 +
 * 订阅泄漏/重入 + servantIncidentNotifier 订阅式接线（5a/5d/5e）。
 */

type Recorded = { type: string; to?: string; turn?: string; meta?: Record<string, unknown> }

function recordEvents(): Recorded[] {
  const recorded: Recorded[] = []
  onSessionEvent((e) => {
    if (e.type === 'phase_changed') {
      recorded.push({ type: e.type, to: e.to, meta: e.meta })
    } else if (e.type === 'turn_changed') {
      recorded.push({ type: e.type, turn: e.turn, meta: e.meta })
    }
  })
  return recorded
}

describe('stage2 · crashed lifecycle (5d)', () => {
  beforeEach(() => {
    resetRegistryForTests()
    resetSessionEventsForTests()
    resetDispatchReceipts()
  })

  afterEach(() => {
    resetRegistryForTests()
    resetSessionEventsForTests()
    resetDispatchReceipts()
  })

  test('crash preserves metadata (snapshot remains readable, tombstone deletes)', () => {
    registerSession('s1')
    markStarting('s1')
    markRunning('s1')
    beginTurn('s1', { awaitSend: true })

    markCrashed('s1', { exitCode: 4 })

    // 元数据保留：快照仍可读（crashed 中间态，非消失）
    const snap = getSessionSnapshot('s1')
    expect(snap?.phase).toBe('crashed')
    // 进程死亡 ⇒ 回合必然死亡（5d 语义补充：turn 残留会让 stall watcher 误判假死）
    expect(snap?.turn).toBe('none')
    expect(hasActiveTurn('s1')).toBe(false)

    // 删除走 tombstone：crashed → deleted 合法迁移
    tombstoneSession('s1')
    expect(getSessionSnapshot('s1')?.phase).toBe('deleted')
    expect(getSessionSnapshot('s1')?.turnOwner).toBe(null)
  })

  test('crash event order: phase_changed(crashed) precedes turn_changed(none)', () => {
    registerSession('s2')
    markStarting('s2')
    markRunning('s2')
    beginTurn('s2', { awaitSend: false })

    const recorded = recordEvents()
    markCrashed('s2', { exitCode: 1 })

    // C5：先 phase 后 turn（同栈按序派发，观察者可依赖顺序）
    expect(recorded.map((r) => `${r.type}:${r.to ?? r.turn}`)).toEqual([
      'phase_changed:crashed',
      'turn_changed:none',
    ])
    expect(recorded[0]?.meta).toMatchObject({ exitCode: 1 })
    expect(recorded[1]?.meta).toMatchObject({ reason: 'crashed' })
  })

  test('restart after crash: crashed→starting legal transition, beginTurn works again', () => {
    registerSession('s3')
    markStarting('s3')
    markRunning('s3')
    beginTurn('s3', { awaitSend: false })
    markCrashed('s3', { exitCode: 4 })

    // 重启复用 startSession：crashed → starting 合法迁移
    markStarting('s3')
    expect(getSessionSnapshot('s3')?.phase).toBe('starting')
    // 重启后回合可重建（turn 已随 crash 清除）
    expect(beginTurn('s3', { awaitSend: false })).not.toBeNull()
    markRunning('s3')
    expect(getSessionSnapshot('s3')?.phase).toBe('running')
  })

  test('stop path: markStopped + clearSession removes entry entirely', () => {
    registerSession('s4')
    markStarting('s4')
    markRunning('s4')
    beginTurn('s4', { awaitSend: false })

    markStopped('s4')
    expect(getSessionSnapshot('s4')?.phase).toBe('stopped')
    clearSession('s4')
    expect(getSessionSnapshot('s4')).toBeNull()
  })

  test('startup crash carries meta.startup and keeps crashed phase', () => {
    registerSession('s5')
    markStarting('s5')
    markCrashed('s5', { startup: true, exitCode: 2 })

    const snap = getSessionSnapshot('s5')
    expect(snap?.phase).toBe('crashed')
    expect(snap?.turn).toBe('none')
  })
})

describe('stage2 · dual-input consistency: isSessionTurnInProgress ≡ registry snapshot (5a)', () => {
  beforeEach(() => {
    resetRegistryForTests()
    resetSessionEventsForTests()
    resetDispatchReceipts()
  })

  afterEach(() => {
    resetRegistryForTests()
    resetSessionEventsForTests()
    resetDispatchReceipts()
  })

  test('observed in-progress signal without turn is DROPPED (only-lower rule)', () => {
    registerSession('c1')
    markRunning('c1')

    // 观察流先到（无 turn）→ 丢弃，不得新建 turn
    observeSessionSdkMessage('c1', 'assistant')
    expect(isSessionTurnInProgress('c1')).toBe(false)
    expect(hasActiveTurn('c1')).toBe(false)
    expect(getSessionSnapshot('c1')?.turn).toBe('none')
  })

  test('injection-first: turn created then observed signal keeps it; result clears', () => {
    registerSession('c2')
    markRunning('c2')
    beginTurn('c2', { awaitSend: false })

    // 注入先行 → 观察流进行中信号保持 turn
    observeSessionSdkMessage('c2', 'assistant')
    expect(isSessionTurnInProgress('c2')).toBe(true)
    expect(hasActiveTurn('c2')).toBe(true)

    // result → 观察流是无条件裁决者（清任何 turn），两视图一致
    observeSessionSdkMessage('c2', 'result', Date.now(), true)
    expect(isSessionTurnInProgress('c2')).toBe(false)
    expect(getSessionSnapshot('c2')?.turn).toBe('none')
  })

  test('consistency invariant holds across interleavings', () => {
    registerSession('c3')
    markRunning('c3')
    const handle = beginTurn('c3', { awaitSend: false })
    expect(handle).not.toBeNull()

    observeSessionSdkMessage('c3', 'stream_event')
    expect(isSessionTurnInProgress('c3')).toBe(hasActiveTurn('c3'))

    observeTurnResult('c3', { isError: false })
    expect(isSessionTurnInProgress('c3')).toBe(hasActiveTurn('c3'))
    expect(isSessionTurnInProgress('c3')).toBe(false)

    // 未登记会话：两视图同为 false
    expect(isSessionTurnInProgress('ghost')).toBe(false)
  })
})

describe('stage2 · subscriber leak & reentry guards (5e)', () => {
  beforeEach(() => {
    resetRegistryForTests()
    resetSessionEventsForTests()
    resetDispatchReceipts()
  })

  afterEach(() => {
    resetRegistryForTests()
    resetSessionEventsForTests()
    resetDispatchReceipts()
  })

  test('unsubscribed listener receives nothing (no leak)', () => {
    registerSession('l1')
    let calls = 0
    const unsubscribe = onSessionEvent(() => {
      calls += 1
    })

    markStarting('l1')
    markRunning('l1')
    // starting + running 两次合法迁移各发一次事件
    expect(calls).toBe(2)
    unsubscribe()
    unsubscribe() // 幂等

    markStopped('l1')
    expect(calls).toBe(2) // 退订后不再收到
  })

  test('synchronous registry write inside handler is blocked by reentry guard', () => {
    registerSession('l2')
    markRunning('l2')
    beginTurn('l2', { awaitSend: false })

    let handlerError: unknown = null
    onSessionEvent(() => {
      try {
        // 观察者内同步写 registry → assertNotReentrant 拦截
        observeTurnResult('l2', { isError: false })
      } catch (error) {
        handlerError = error
      }
    })

    observeTurnResult('l2', { isError: false })
    expect(handlerError).toBeInstanceOf(Error)
    expect(String(handlerError)).toContain('reentrant')
    // C5：状态改动不受观察者异常影响（先改状态后发事件）
    expect(getSessionSnapshot('l2')?.turn).toBe('none')
  })

  test('emitSessionEvent swallows observer exceptions without breaking others', () => {
    const seen: string[] = []
    onSessionEvent(() => {
      throw new Error('observer boom')
    })
    onSessionEvent((e) => {
      if (e.type === 'phase_changed') seen.push(e.to)
    })

    expect(() => emitSessionEvent({ type: 'phase_changed', sessionId: 'x', from: 'running', to: 'crashed' })).not.toThrow()
    expect(seen).toEqual(['crashed'])
  })
})

describe('stage2 · servantIncidentNotifier subscribes to phase_changed(→crashed) (5e)', () => {
  let crashEvents: Array<{ sessionId: string; exitCode: number | null }>

  beforeEach(() => {
    resetRegistryForTests()
    resetSessionEventsForTests()
    resetDispatchReceipts()
    resetServantIncidentState()
    crashEvents = []
    setServantIncidentDeps({
      getServant: async (sessionId) => ({
        sessionId,
        role: '后端',
        enabled: true,
      }),
      recordEvent: (input) => {
        crashEvents.push({ sessionId: input.sessionId, exitCode: (input.details as any)?.exitCode ?? null })
      },
    })
    // 模块加载时已订阅；测试 reset 总线后需重订阅（泄漏防护：先退订）
    unsubscribeServantCrashObserver()
    subscribeServantCrashObserver()
  })

  afterEach(() => {
    unsubscribeServantCrashObserver()
    setServantIncidentDeps(null)
    resetServantIncidentState()
    resetRegistryForTests()
    resetSessionEventsForTests()
  })

  test('crashed phase with error exit code triggers servant crash notification', async () => {
    registerSession('n1')
    markStarting('n1')
    markRunning('n1')
    markCrashed('n1', { exitCode: 4 })

    // notifyServantCrash 是 async（await getServant 后才 recordEvent）——排空微任务
    await Bun.sleep(1)

    expect(crashEvents).toHaveLength(1)
    expect(crashEvents[0]).toMatchObject({ sessionId: 'n1', exitCode: 4 })
  })

  test('startup crash and info-severity exits do NOT trigger notification (C3 zero-change)', () => {
    registerSession('n2')
    markStarting('n2')
    markCrashed('n2', { startup: true, exitCode: 2 })

    registerSession('n3')
    markStarting('n3')
    markRunning('n3')
    markCrashed('n3', { exitCode: 0 }) // info（正常回收）
    markStopped('n3')
    clearSession('n3')

    registerSession('n4')
    markStarting('n4')
    markRunning('n4')
    markCrashed('n4', { exitCode: 143 }) // SIGTERM info

    expect(crashEvents).toHaveLength(0)
  })
})
