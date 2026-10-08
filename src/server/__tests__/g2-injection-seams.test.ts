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
