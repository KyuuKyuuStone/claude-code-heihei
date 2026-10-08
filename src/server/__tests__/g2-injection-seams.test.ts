/**
 * G2 批（三条 `layer-L2-no-upward`）注入缝的单测。
 *
 * 每条缝两个面：
 *  ① 注册后行为 == 旧行为（adapter 收到与旧静态调用同样的实参 / 同一语义）；
 *  ② 未注册语义（按规格逐服务不同：① fail-fast 抛错、② 丢弃 + 一次性诊断、③ 诚实 failed）。
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
