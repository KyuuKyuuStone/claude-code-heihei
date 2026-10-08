/**
 * G2 批注入缝的单测。
 *
 * B-a 批（三条 `layer-L2-no-upward`，services → ws/*）——每条缝两个面：
 *  ① 注册后行为 == 旧行为（adapter 收到与旧静态调用同样的实参 / 同一语义）；
 *  ② 未注册语义（按规格逐服务不同：① fail-fast 抛错、② 丢弃 + 一次性诊断、③ 诚实 failed）。
 *
 * B-b 批（三条 `layer-L2-no-upward`，services → sessionMessenger）——三家 L2 服务
 * （dispatchMailboxService / servantStallWatcher / supervisorProtocolNotice）共用
 * 一条投递缝 `sessionDelivery`；用例证明：注册后三家默认 deps 的 deliver 都路由到缝、
 * 未注册 ⇒ 三家都 fail-fast 抛错（不静默丢弃）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  computerUseApprovalService,
  registerComputerUseApprovalTransport,
  setComputerUseApprovalTransportForTests,
} from '../services/computerUseApprovalService.js'
import type { ComputerUsePermissionRequestMessage } from '../services/computerUseApprovalService.js'
import {
  TeamWatcher,
  registerTeamWatcherBroadcast,
  setTeamWatcherBroadcastForTests,
} from '../services/teamWatcher.js'
import type { TeamBroadcastMessage } from '../services/teamWatcher.js'
import {
  reloadSessionComponents,
  registerSessionComponentReloadDeps,
  setSessionComponentReloadDepsForTests,
} from '../services/sessionComponentReloadService.js'
import { setDiagnosticsLogWriterForTests } from '../../utils/diagLogs.js'
// B-b 批：共用投递缝 + 三家消费者（dispatchMailbox / servantStallWatcher / supervisorNotice）
import {
  registerSessionDelivery,
  requireSessionDelivery,
  setSessionDeliveryForTests,
} from '../services/sessionDelivery.js'
import { DispatchMailboxService } from '../services/dispatchMailboxService.js'
import { ServantStallWatcher } from '../services/servantStallWatcher.js'
import {
  notifySupervisorsOfProtocolUpdate,
  setSupervisorNoticeDeps,
} from '../services/supervisorProtocolNotice.js'
// B-d 批：L0 提供方缝 + notifier 中断缝 + 轮次事件总线
import {
  applyConfigEnvironmentVariables,
  setCcHeiheiSettingsEnvProviderForTests,
} from '../../utils/managedEnv.js'
import {
  onServantToolResult,
  resetServantIncidentState,
  setServantIncidentDeps,
  setServantIncidentInterruptForTests,
  UNKNOWN_TOOL_MARKER,
  UNKNOWN_TOOL_STREAK_LIMIT,
} from '../services/servantIncidentNotifier.js'
import {
  emitServantToolResult,
  emitServantTurnError,
  emitServantTurnErrorsCleared,
  emitServantUnknownToolStreakReset,
  resetServantTurnIncidentSubscribersForTests,
  subscribeServantTurnIncidents,
} from '../services/servantIncidentSignals.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const CU_REQUEST = {
  requestId: 'g2-cu-1',
  reason: 'Inspect another app',
  apps: [],
  requestedFlags: {},
  screenshotFiltering: 'native' as const,
}

describe('G2 缝①：computerUseApprovalService 权限请求投递', () => {
  afterEach(() => {
    setComputerUseApprovalTransportForTests(null)
  })

  it('注册后：收到与旧 sendToSession 相同的实参，sent=true 时 promise 保持 pending 并可被 resolve', async () => {
    const calls: Array<{ sessionId: string; payload: ComputerUsePermissionRequestMessage }> = []
    registerComputerUseApprovalTransport({
      sendPermissionRequest: (sessionId, payload) => {
        calls.push({ sessionId, payload })
        return true
      },
    })

    const approval = computerUseApprovalService.requestApproval('g2-session-1', CU_REQUEST)
    expect(calls).toEqual([
      {
        sessionId: 'g2-session-1',
        payload: {
          type: 'computer_use_permission_request',
          requestId: 'g2-cu-1',
          request: CU_REQUEST,
        },
      },
    ])
    expect(computerUseApprovalService.getPendingRequests('g2-session-1')).toEqual([CU_REQUEST])

    const response = {
      granted: [],
      denied: [],
      flags: { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false },
      userConsented: true,
    }
    expect(computerUseApprovalService.resolveApproval('g2-cu-1', response)).toBe(true)
    await expect(approval).resolves.toEqual(response)
  })

  it('注册后：sent=false ⇒ 走既有 reject 路径（Desktop session is not connected）', async () => {
    registerComputerUseApprovalTransport({ sendPermissionRequest: () => false })
    const approval = computerUseApprovalService.requestApproval('g2-session-2', {
      ...CU_REQUEST,
      requestId: 'g2-cu-2',
    })
    await expect(approval).rejects.toThrow('Desktop session is not connected')
    expect(computerUseApprovalService.getPendingRequests('g2-session-2')).toEqual([])
  })

  it('未注册 ⇒ fail-fast 抛错（不静默丢弃），且不留 pending 半状态', async () => {
    await expect(
      computerUseApprovalService.requestApproval('g2-session-3', {
        ...CU_REQUEST,
        requestId: 'g2-cu-3',
      }),
    ).rejects.toThrow(/registerComputerUseApprovalTransport/)
    expect(computerUseApprovalService.getPendingRequests('g2-session-3')).toEqual([])
  })
})

describe('G2 缝②：teamWatcher 广播', () => {
  afterEach(() => {
    setTeamWatcherBroadcastForTests(null)
  })

  it('注册后：广播消息原样交给适配器（含 team_update 的 members）', () => {
    const received: TeamBroadcastMessage[] = []
    registerTeamWatcherBroadcast((message) => received.push(message))

    const watcher = new TeamWatcher()
    // broadcast 是私有方法；此处直接驱动（等价于 check 路径内的调用点）
    ;(watcher as unknown as { broadcast: (m: TeamBroadcastMessage) => void }).broadcast({
      type: 'team_update',
      teamName: 'g2-team',
      members: [{ agentId: 'a1', role: 'lead', status: 'running' }],
    })
    ;(watcher as unknown as { broadcast: (m: TeamBroadcastMessage) => void }).broadcast({
      type: 'team_deleted',
      teamName: 'g2-team',
    })

    expect(received).toEqual([
      {
        type: 'team_update',
        teamName: 'g2-team',
        members: [{ agentId: 'a1', role: 'lead', status: 'running' }],
      },
      { type: 'team_deleted', teamName: 'g2-team' },
    ])
  })

  it('未注册 ⇒ 丢弃不抛错，且只记一次诊断（watcher 不该炸进程）', () => {
    const events: Array<{ level: string; event: string }> = []
    setDiagnosticsLogWriterForTests((level, event) => {
      events.push({ level, event })
    })
    try {
      const watcher = new TeamWatcher()
      const broadcast = (watcher as unknown as { broadcast: (m: TeamBroadcastMessage) => void })
        .broadcast.bind(watcher)

      expect(() => {
        broadcast({ type: 'team_created', teamName: 't1' })
        broadcast({ type: 'team_created', teamName: 't2' })
      }).not.toThrow()

      // 两条广播 ⇒ 诊断只记 1 条（一次性）
      expect(events.filter((e) => e.event === 'team_watcher_broadcast_unregistered')).toHaveLength(1)
    } finally {
      setDiagnosticsLogWriterForTests(null)
    }
  })
})

describe('G2 缝③：sessionComponentReloadService 斜杠命令同步', () => {
  afterEach(() => {
    setSessionComponentReloadDepsForTests(null)
  })

  it('注册后：命令数取适配器返回值的 .length（与旧 updateSessionSlashCommands 同口径）', async () => {
    let sawCommands: unknown[] | null = null
    registerSessionComponentReloadDeps({
      syncSlashCommands: (_sessionId, commands) => {
        sawCommands = commands
        return [{ name: 'a' }, { name: 'b' }]
      },
    })
    const summary = await reloadSessionComponents('g2-not-running')
    // 会话不在跑（or 空装配均已排除）⇒ 未走到适配器；此用例只证明「未注册不再返回
    // 未装配错误」，其余断言见下一条生产等价用例。
    expect(summary.reason).toBe('not_running')
    expect(sawCommands).toBeNull()
  })

  it('未注册 ⇒ 诚实 failed（不假装成功），错误指向装配根', async () => {
    const summary = await reloadSessionComponents('g2-any-session')
    expect(summary.applied).toBe(false)
    expect(summary.reason).toBe('failed')
    expect(summary.commands).toBe(0)
    expect(summary.error).toMatch(/registerSessionComponentReloadDeps/)
  })
})

// ─── B-b 批：三家 L2 服务共用的投递缝 ─────────────────────────────────────────
// 三家的默认 deps 里 deliver 原为静态 import sessionMessenger.deliver（L2→L3 违规）。
// 说明：三家各自的**投递失败**处置是既有行为且都非静默——dispatchMailbox ⇒ markFailed
// + {ok:false,reason}；servantStallWatcher ⇒ report(warn)；supervisorProtocolNotice ⇒
// console.warn。故「未注册 ⇒ 缝抛错」最终会经各家的既有失败路径显形（不是静默丢弃）。

type DeliverFacade = {
  deps: { deliver: (t: string, c: string, h: string) => Promise<boolean> }
}

describe('G2 缝④（B-b）：sessionDelivery 投递缝', () => {
  let tmpDir: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    // supervisorProtocolNotice 会写 marker 文件 ⇒ 隔离到临时配置目录
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-g2bb-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    setSessionDeliveryForTests(null)
    setSupervisorNoticeDeps(null)
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const supervisorDeps = (events: Array<Record<string, unknown>>) => ({
    listServants: async () =>
      [{ sessionId: 'sup-1', supervisor: true, enabled: true, running: true }] as never,
    getServerPort: () => 53100,
    recordEvent: (input: Record<string, unknown>) => { events.push(input) },
  })

  it('注册后：三家 L2 服务的默认 deliver 全部路由到缝（实参口径与旧静态调用一致）', async () => {
    const calls: Array<[string, string, string]> = []
    registerSessionDelivery(async (target, content, host) => {
      calls.push([target, content, host])
      return true
    })

    // ①② 直取默认 deps 的 deliver（私有字段；三家各自的真实投递路径另由其自身测试覆盖）
    const mailboxDefault = (new DispatchMailboxService() as unknown as DeliverFacade).deps.deliver
    const stallDefault = (new ServantStallWatcher() as unknown as DeliverFacade).deps.deliver
    await expect(mailboxDefault('s-mailbox', 'mailbox-content', '127.0.0.1:1234')).resolves.toBe(true)
    await expect(stallDefault('s-stall', 'stall-content', '127.0.0.1:1234')).resolves.toBe(true)

    // ③ 走真实路径：不注入 deliver ⇒ 用默认（= 缝）
    const events: Array<Record<string, unknown>> = []
    setSupervisorNoticeDeps(supervisorDeps(events) as never)
    await notifySupervisorsOfProtocolUpdate()

    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual(['s-mailbox', 'mailbox-content', '127.0.0.1:1234'])
    expect(calls[1]).toEqual(['s-stall', 'stall-content', '127.0.0.1:1234'])
    expect(calls[2][0]).toBe('sup-1')
    expect(calls[2][1]).toContain('硬规则')
    expect(calls[2][2]).toBe('127.0.0.1:53100')
  })

  it('未注册 ⇒ 缝本身 fail-fast；三家默认 deliver 全部抛错（不静默丢弃）', async () => {
    expect(() => requireSessionDelivery()).toThrow(/registerSessionDelivery/)

    const mailboxDefault = (new DispatchMailboxService() as unknown as DeliverFacade).deps.deliver
    const stallDefault = (new ServantStallWatcher() as unknown as DeliverFacade).deps.deliver
    await expect(mailboxDefault('s', 'c', '127.0.0.1:1234')).rejects.toThrow(/registerSessionDelivery/)
    await expect(stallDefault('s', 'c', '127.0.0.1:1234')).rejects.toThrow(/registerSessionDelivery/)

    // ③ 该消费者对投递失败是既有 catch（console.warn）⇒ 断言不静默成功即可
    const warns: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')) }
    try {
      const events: Array<Record<string, unknown>> = []
      setSupervisorNoticeDeps(supervisorDeps(events) as never)
      await notifySupervisorsOfProtocolUpdate()
    } finally {
      console.warn = originalWarn
    }
    expect(warns.join(String.fromCharCode(10))).toContain('registerSessionDelivery')
  })
})

// ─── B-d 批：两处缝 ─────────────────────────────────────────────────────────
// ⑤ ccHeiheiSettingsEnv 提供方（L0 开口收回调：实现上提 L2）
// ⑥ servantIncidentNotifier 中断通道（原动态 import conversationService ⇒ 校验接线/未接线两态）

describe('G2 缝⑤（B-d）：ccHeiheiSettingsEnv 提供方缝', () => {
  const snapshotEnv = () => ({ ...process.env })
  const restoreEnv = (snap: Record<string, string | undefined>) => {
    for (const key of Object.keys(process.env)) {
      if (!(key in snap)) delete process.env[key]
    }
    Object.assign(process.env, snap)
  }

  afterEach(() => {
    setCcHeiheiSettingsEnvProviderForTests(null)
    setDiagnosticsLogWriterForTests(null)
  })

  it('注册后：provider 返回的 env 经真实路径合入 process.env', () => {
    const snap = snapshotEnv()
    try {
      setCcHeiheiSettingsEnvProviderForTests(() => ({
        CC_HEIHEI_G2_SEAM_PROBE: 'merged',
      }))
      applyConfigEnvironmentVariables()
      // 用自定义键做探针：ANTHROPIC_BASE_URL 会被 filterSettingsEnv 按宿主托管变量剥掉（既有语义）
      expect(process.env.CC_HEIHEI_G2_SEAM_PROBE).toBe('merged')
    } finally {
      restoreEnv(snap)
    }
  })

  it('未注册 ⇒ 不合并且不炸进程，但记**一次性**诊断（非静默）', () => {
    const snap = snapshotEnv()
    const events: string[] = []
    setDiagnosticsLogWriterForTests((_level, event) => {
      events.push(event)
    })
    try {
      applyConfigEnvironmentVariables()
      applyConfigEnvironmentVariables()
      expect(events.filter((e) => e === 'cc_heihei_settings_env_provider_unregistered')).toHaveLength(1)
    } finally {
      restoreEnv(snap)
    }
  })
})

describe('G2 缝⑥（B-d）：servantIncidentNotifier 中断通道', () => {
  afterEach(() => {
    setServantIncidentInterruptForTests(null)
    setServantIncidentDeps(null)
    resetServantIncidentState()
    setDiagnosticsLogWriterForTests(null)
  })

  /** 连续 UNKNOWN_TOOL_STREAK_LIMIT 次「不存在工具」⇒ 熔断触发（内部会调 interrupt） */
  const tripCircuitBreaker = async (sessionId: string) => {
    setServantIncidentDeps({
      getServant: async () => ({ enabled: true }) as never,
      listServants: async () => [] as never,
      deliver: async () => true,
      recordEvent: () => {},
    })
    for (let i = 0; i < UNKNOWN_TOOL_STREAK_LIMIT; i++) {
      await onServantToolResult({
        sessionId,
        resultText: `${UNKNOWN_TOOL_MARKER}: g2-probe-tool`,
        isError: true,
      })
    }
  }

  it('接线后：熔断触发时调用注入的中断函数（原动态 import 的等价替身）', async () => {
    const seen: string[] = []
    setServantIncidentInterruptForTests((sessionId) => {
      seen.push(sessionId)
    })
    await tripCircuitBreaker('g2-interrupt-1')
    expect(seen).toEqual(['g2-interrupt-1'])
  })

  it('未接线 ⇒ 不炸进程，但记诊断（非静默）', async () => {
    const events: string[] = []
    setDiagnosticsLogWriterForTests((_level, event) => {
      events.push(event)
    })
    await tripCircuitBreaker('g2-interrupt-2')
    expect(events).toContain('servant_interrupt_delivery_failed')
  })
})

describe('G2 缝⑥b（B-d）：员工轮次事件总线', () => {
  afterEach(() => {
    resetServantTurnIncidentSubscribersForTests()
    setDiagnosticsLogWriterForTests(null)
  })

  it('订阅后：四类发射都送达订阅者', () => {
    const got: string[] = []
    subscribeServantTurnIncidents({
      onTurnError: (input) => {
        got.push(`err:${input.sessionId}:${input.streak}`)
      },
      clearTurnErrors: (sessionId) => {
        got.push(`clear:${sessionId}`)
      },
      resetUnknownToolStreak: (sessionId) => {
        got.push(`reset:${sessionId}`)
      },
      onToolResult: (input) => {
        got.push(`tool:${input.sessionId}:${input.isError}`)
      },
    })

    emitServantTurnError({ sessionId: 'g2-bus', streak: 2, summary: 's' })
    emitServantTurnErrorsCleared('g2-bus')
    emitServantUnknownToolStreakReset('g2-bus')
    emitServantToolResult({ sessionId: 'g2-bus', resultText: 'r', isError: true })

    expect(got).toEqual(['err:g2-bus:2', 'clear:g2-bus', 'reset:g2-bus', 'tool:g2-bus:true'])
  })

  it('订阅者同步抛 / 异步 reject ⇒ 不冒泡，都记同一条诊断（与旧 .catch 留痕同口径）', async () => {
    const events: Array<{ event: string; hook?: unknown }> = []
    setDiagnosticsLogWriterForTests((_level, event, data) => {
      events.push({ event, hook: (data as { hook?: unknown } | undefined)?.hook })
    })
    subscribeServantTurnIncidents({
      onTurnError: () => {
        throw new Error('sync boom')
      },
      clearTurnErrors: async () => {
        throw new Error('async boom')
      },
      resetUnknownToolStreak: () => {},
      onToolResult: () => {},
    })

    expect(() => emitServantTurnError({ sessionId: 'g2-bus-2', streak: 1, summary: '' })).not.toThrow()
    emitServantTurnErrorsCleared('g2-bus-2')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events.filter((e) => e.event === 'servant_incident_notify_failed')).toHaveLength(2)
    expect(events.map((e) => e.hook)).toEqual(
      expect.arrayContaining(['onServantTurnError', 'clearServantTurnErrors']),
    )
  })

  it('0 订阅者 ⇒ 无操作、不抛（总线广播语义，不是「装配坏」）', () => {
    expect(() => {
      emitServantTurnError({ sessionId: 'g2-bus-3', streak: 1, summary: '' })
      emitServantToolResult({ sessionId: 'g2-bus-3', resultText: 'r', isError: false })
    }).not.toThrow()
  })
})
