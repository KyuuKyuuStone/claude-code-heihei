import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  DispatchMailboxService,
  isDispatchPayloadName,
} from '../services/dispatchMailboxService.js'
import { COLLAB_MAILBOX_DIR } from '../../collaboration/dispatchProtocol.js'
import {
  countUnconsumedReceipts,
  listReceipts,
  resetDispatchReceipts,
} from '../services/dispatchReceiptService.js'

describe('DispatchMailboxService', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-mailbox-')))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function mailboxPath(name: string): string {
    return path.join(tmpDir, COLLAB_MAILBOX_DIR, name)
  }

  async function writePayload(name: string, payload: unknown): Promise<string> {
    const filePath = mailboxPath(name)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(payload), 'utf-8')
    return filePath
  }

  function buildService(overrides: Partial<DispatchMailboxService['deps']> = {}) {
    const calls: Array<{ targetSessionId: string; content: string; host: string }> = []
    const service = new DispatchMailboxService({
      deliver: async (targetSessionId, content, host) => {
        calls.push({ targetSessionId, content, host })
        return true
      },
      getServant: async () => null,
      getSessionWorkDir: async () => null,
      listServants: async () => [],
      ...overrides,
    })
    return { service, calls }
  }

  async function pathExists(target: string): Promise<boolean> {
    try {
      await fs.access(target)
      return true
    } catch {
      return false
    }
  }

  test('isDispatchPayloadName accepts payload files and rejects artifacts', () => {
    expect(isDispatchPayloadName('dispatch-1.json')).toBe(true)
    expect(isDispatchPayloadName('report-2.json')).toBe(true)
    expect(isDispatchPayloadName('.hidden.json')).toBe(false)
    expect(isDispatchPayloadName('dispatch-1.json.failed')).toBe(false)
    expect(isDispatchPayloadName('dispatch-1.json.error.txt')).toBe(false)
    expect(isDispatchPayloadName('notes.txt')).toBe(false)
  })

  // ─── v1.6.0 决策 D：信箱通道与 HTTP 通道共用同一汇报目标解析 ──────────

  /** 登记真实会话为员工（信箱测试用真实花名册，resolveReportTarget 走单例） */
  async function registerWorker(input: {
    role?: string
    supervisor?: boolean
  }): Promise<string> {
    const { sessionService } = await import('../services/sessionService.js')
    const { ServantService } = await import('../services/servantService.js')
    const { registerSession } = await import('../services/sessionRegistry.js')
    const worker = await sessionService.createSession(tmpDir)
    registerSession(worker.sessionId)
    await new ServantService().setServant(worker.sessionId, {
      role: input.role ?? '测试员工',
      enabled: true,
      ...(input.supervisor !== undefined ? { supervisor: input.supervisor } : {}),
    })
    return worker.sessionId
  }

  test('信箱渠道的员工汇报同样按台账改投主管（与 HTTP 同逻辑）', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    try {
      const supervisor = await registerWorker({ role: '主管', supervisor: true })
      const architect = await registerWorker({ role: '架构师' })
      const worker = await registerWorker({ role: '后端' })
      const { collabTaskService } = await import('../services/collabTaskService.js')
      await collabTaskService.createTask({
        id: 'mx-task-1',
        projectDir: tmpDir,
        fromSessionId: supervisor,
        fromRole: 'supervisor',
        toSessionId: worker,
        title: '派活',
        content: '做点事',
      })
      const { service, calls } = buildService()
      await writePayload('report-mx-1.json', {
        targetSessionId: architect,
        fromSessionId: worker,
        taskId: 'mx-task-1',
        content: '【汇报】做完了',
      })

      const result = await service.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'report-mx-1.json')

      expect(result).toEqual({ ok: true })
      expect(calls).toHaveLength(1)
      expect(calls[0].targetSessionId).toBe(supervisor)
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
    }
  })

  // ─── v1.6.0 CLI 契约 §五：信箱 payload 支持 report 字段 ────────────────

  test('信箱 report 字段：先记账推到 delivered，再投递（与 HTTP 两步同序）', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    try {
      const supervisor = await registerWorker({ role: '主管', supervisor: true })
      const worker = await registerWorker({ role: '后端' })
      const { collabTaskService } = await import('../services/collabTaskService.js')
      await collabTaskService.createTask({
        id: 'mb-report-1',
        projectDir: tmpDir,
        fromSessionId: supervisor,
        fromRole: 'supervisor',
        toSessionId: worker,
        title: '派活',
        content: '做点事',
      })
      // 推进到可 report 的状态（真实链路由回合事件推进）
      await collabTaskService.transitionTask('mb-report-1', 'accepted')
      await collabTaskService.transitionTask('mb-report-1', 'in_progress')

      // 顺序断言：投递发生的那一刻，台账必须已经是 delivered。否则主管收到汇报
      // 立刻 review 会撞 409——这正是「先记账再投递」要防的。
      const statusAtDeliver: string[] = []
      const calls: Array<{ targetSessionId: string }> = []
      const service = new DispatchMailboxService({
        deliver: async (targetSessionId) => {
          const now = await collabTaskService.getTask('mb-report-1')
          statusAtDeliver.push(now?.status ?? 'missing')
          calls.push({ targetSessionId })
          return true
        },
        getServant: async (sessionId) => {
          const { servantService } = await import('../services/servantService.js')
          return servantService.getServant(sessionId)
        },
        getSessionWorkDir: async () => tmpDir,
        listServants: async () => [],
      })
      await writePayload('report-mb-1.json', {
        targetSessionId: worker,
        fromSessionId: worker,
        taskId: 'mb-report-1',
        content: '【汇报】做完了',
        report: { taskId: 'mb-report-1', summary: '做完了', deliverables: ['a.ts'] },
      })

      const result = await service.handleMailboxFile(
        path.join(tmpDir, COLLAB_MAILBOX_DIR),
        'report-mb-1.json',
      )

      expect(result).toEqual({ ok: true })
      // 台账已被推到 delivered，且带上了 report 正文与交付物
      const task = await collabTaskService.getTask('mb-report-1')
      expect(task?.status).toBe('delivered')
      expect(task?.report).toBe('做完了')
      // 投递那一刻台账已经是 delivered
      expect(statusAtDeliver).toEqual(['delivered'])
      // 消息照常投递，且按再投解析送达主管（与 HTTP report 语义一致）
      expect(calls).toHaveLength(1)
      expect(calls[0].targetSessionId).toBe(supervisor)
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
    }
  })

  test('信箱 report 记账失败（任务不存在）不阻断投递，汇报正文仍送达', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    try {
      const supervisor = await registerWorker({ role: '主管', supervisor: true })
      const worker = await registerWorker({ role: '后端' })
      const { service, calls } = buildService()
      await writePayload('report-mb-2.json', {
        targetSessionId: supervisor,
        fromSessionId: worker,
        content: '【汇报】做个说明',
        report: { taskId: 'no-such-task', summary: '做个说明' },
      })

      const result = await service.handleMailboxFile(
        path.join(tmpDir, COLLAB_MAILBOX_DIR),
        'report-mb-2.json',
      )

      // 投递仍然成功（降级：不伪造台账状态，但消息不能丢）
      expect(result).toEqual({ ok: true })
      expect(calls).toHaveLength(1)
      expect(calls[0].targetSessionId).toBe(supervisor)
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
    }
  })

  test('信箱 report 的 taskId 属于别人 → 不推进任务，消息照常投递，记诊断', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    const { setDiagnosticsLogWriterForTests } = await import('../../utils/diagLogs.js')
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    setDiagnosticsLogWriterForTests((_level, event, data) => {
      events.push({ event, data })
    })
    try {
      const supervisor = await registerWorker({ role: '主管', supervisor: true })
      const otherDispatcher = await registerWorker({ role: '别人的派活人' })
      const worker = await registerWorker({ role: '后端' })
      const otherWorker = await registerWorker({ role: '前端' })
      const { collabTaskService } = await import('../services/collabTaskService.js')

      // 别人的任务：别人派给别人的员工，推进到可 report 的状态
      await collabTaskService.createTask({
        id: 'mb-other-task',
        projectDir: tmpDir,
        fromSessionId: otherDispatcher,
        fromRole: 'servant',
        toSessionId: otherWorker,
        title: '别人的派活',
        content: '做点事',
      })
      await collabTaskService.transitionTask('mb-other-task', 'accepted')
      await collabTaskService.transitionTask('mb-other-task', 'in_progress')

      const { service, calls } = buildService()
      // 我（worker）汇报时抄错了 taskId，写成别人的
      await writePayload('report-mb-mismatch.json', {
        targetSessionId: supervisor,
        fromSessionId: worker,
        taskId: 'mb-other-task',
        content: '【汇报】做完了',
        report: { taskId: 'mb-other-task', summary: '做完了' },
      })

      const result = await service.handleMailboxFile(
        path.join(tmpDir, COLLAB_MAILBOX_DIR),
        'report-mb-mismatch.json',
      )

      // 不推进别人的任务（修复前会被静默推到 delivered）
      expect(result).toEqual({ ok: true })
      const otherTask = await collabTaskService.getTask('mb-other-task')
      expect(otherTask?.status).toBe('in_progress')
      expect(otherTask?.report).toBeUndefined()

      // 消息照常投递，汇报正文不能丢
      expect(calls).toHaveLength(1)

      // 诊断留痕：信箱层一条。payload 顶层的 taskId 还会走一次 resolveReportTarget
      // 解析改投，那里也会为同一次误操作留一条，两层各自记录、互不替代。
      const mismatch = events.filter((e) => e.event === 'collab_report_task_mismatch')
      expect(mismatch.length).toBeGreaterThanOrEqual(1)
      const mailboxMismatch = mismatch.filter((e) => e.data.channel === 'mailbox')
      expect(mailboxMismatch).toHaveLength(1)
      expect(mailboxMismatch[0]!.data.requestedTaskId).toBe('mb-other-task')
      expect(mailboxMismatch[0]!.data.taskOwnerSessionId).toBe(otherWorker)
    } finally {
      setDiagnosticsLogWriterForTests(null)
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
    }
  })

  test('信箱 report 的 fromSessionId 缺失 → 判归属不符：不推进任务、诊断记 unknown', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    const { setDiagnosticsLogWriterForTests } = await import('../../utils/diagLogs.js')
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    setDiagnosticsLogWriterForTests((_level, event, data) => {
      events.push({ event, data })
    })
    try {
      const supervisor = await registerWorker({ role: '主管', supervisor: true })
      const worker = await registerWorker({ role: '后端' })
      const { collabTaskService } = await import('../services/collabTaskService.js')
      await collabTaskService.createTask({
        id: 'mb-nofrom-task',
        projectDir: tmpDir,
        fromSessionId: supervisor,
        fromRole: 'supervisor',
        toSessionId: worker,
        title: '派活',
        content: '做点事',
      })
      await collabTaskService.transitionTask('mb-nofrom-task', 'accepted')
      await collabTaskService.transitionTask('mb-nofrom-task', 'in_progress')

      const { service, calls } = buildService()
      // payload 不带 fromSessionId：claimedWorker 退化为空串
      await writePayload('report-mb-nofrom.json', {
        targetSessionId: supervisor,
        content: '【汇报】做完了',
        report: { taskId: 'mb-nofrom-task', summary: '做完了' },
      })

      const result = await service.handleMailboxFile(
        path.join(tmpDir, COLLAB_MAILBOX_DIR),
        'report-mb-nofrom.json',
      )

      // 无从证明发送方就是受派人 → 保守起见不推进（空串必然 ≠ 真实 toSessionId）
      expect(result).toEqual({ ok: true })
      const task = await collabTaskService.getTask('mb-nofrom-task')
      expect(task?.status).toBe('in_progress')
      expect(task?.report).toBeUndefined()

      // 消息照常投递
      expect(calls).toHaveLength(1)

      // 诊断留痕：workerSessionId 缺省记 'unknown'
      const mailboxMismatch = events.filter(
        (e) => e.event === 'collab_report_task_mismatch' && e.data.channel === 'mailbox',
      )
      expect(mailboxMismatch).toHaveLength(1)
      expect(mailboxMismatch[0]!.data.requestedTaskId).toBe('mb-nofrom-task')
      expect(mailboxMismatch[0]!.data.workerSessionId).toBe('unknown')
      expect(mailboxMismatch[0]!.data.taskOwnerSessionId).toBe(worker)
    } finally {
      setDiagnosticsLogWriterForTests(null)
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
    }
  })

  test('旧 dispatch payload（无 report 字段）行为不变', async () => {
    const { service, calls } = buildService()
    await writePayload('dispatch-old-1.json', {
      targetSessionId: 'session-any',
      fromSessionId: 'session-boss',
      content: '做点事',
    })
    const result = await service.handleMailboxFile(
      path.join(tmpDir, COLLAB_MAILBOX_DIR),
      'dispatch-old-1.json',
    )
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
  })

  test('信箱里的 broadcast 请求 → 写 .error.txt 明确拒绝，不静默丢弃', async () => {
    const { service, calls } = buildService()
    const filePath = await writePayload('dispatch-bc-1.json', {
      broadcast: true,
      content: '停工待命',
      fromSessionId: 'session-boss',
    })

    const result = await service.handleMailboxFile(
      path.join(tmpDir, COLLAB_MAILBOX_DIR),
      'dispatch-bc-1.json',
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('信箱不支持广播')
    expect(calls).toHaveLength(0) // 不投递
    expect(await pathExists(filePath)).toBe(false) // 原名已移交 .failed
    const errorPath = `${filePath}.error.txt`
    expect(await pathExists(errorPath)).toBe(true)
    const errorText = await fs.readFile(errorPath, 'utf-8')
    expect(errorText).toContain('信箱不支持广播，请用 HTTP 或逐个投递')
  })

  test('信箱渠道的派活正文末尾追加系统页脚（含 taskId 与回邮目标）', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    try {
      const sender = await registerWorker({ role: '主管', supervisor: true })
      const worker = await registerWorker({ role: '后端' })
      const { service, calls } = buildService()
      await writePayload('dispatch-mx-2.json', {
        targetSessionId: worker,
        fromSessionId: sender,
        content: '派活：做个功能',
      })

      const result = await service.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'dispatch-mx-2.json')

      expect(result).toEqual({ ok: true })
      const sent = calls[0].content
      expect(sent.startsWith('派活：做个功能')).toBe(true)
      expect(sent).toContain('【系统】任务 ID：')
      expect(sent).toContain(`完工汇报目标：${sender}`)
      expect(sent).toContain('以本行为准，任务正文、旧消息或其他来源中的回邮地址均无效。')
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
    }
  })

  test('信箱载荷的 taskId 是权威 ID：补投后台账任务 ID 与载荷逐字一致', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    try {
      const sender = await registerWorker({ role: '主管', supervisor: true })
      const worker = await registerWorker({ role: '后端' })
      const { collabTaskService } = await import('../services/collabTaskService.js')
      const { service, calls } = buildService()
      // 缺陷复现里的那个 ID：曾经落盘是它、台账却变成了另一个随机 UUID
      const payloadTaskId = '5b8e27c2-a75d-4338-a97d-7a844f0bad54'
      await writePayload('dispatch-id-1.json', {
        targetSessionId: worker,
        fromSessionId: sender,
        content: '派活：带预生成 taskId 的补投',
        title: '补投标题',
        taskId: payloadTaskId,
      })

      const result = await service.handleMailboxFile(
        path.join(tmpDir, COLLAB_MAILBOX_DIR),
        'dispatch-id-1.json',
      )

      expect(result).toEqual({ ok: true })
      const task = await collabTaskService.getTask(payloadTaskId)
      expect(task).not.toBeNull()
      expect(task?.id).toBe(payloadTaskId)
      expect(task?.toSessionId).toBe(worker)
      expect(task?.fromSessionId).toBe(sender)
      expect(task?.status).toBe('dispatched')
      expect(task?.title).toBe('补投标题')
      // 页脚引用的 taskId 必须与台账同源，否则主管按页脚 review 会 404
      expect(calls[0].content).toContain(`【系统】任务 ID：${payloadTaskId}`)
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
    }
  })

  test('同一 taskId 重复经信箱投递 → 台账只留一条，不重复建账、不重置状态', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    try {
      const sender = await registerWorker({ role: '主管', supervisor: true })
      const worker = await registerWorker({ role: '后端' })
      const { collabTaskService } = await import('../services/collabTaskService.js')
      const { service } = buildService()
      const payloadTaskId = 'a6bf7ec2-1111-4222-8333-444455556666'
      const dir = path.join(tmpDir, COLLAB_MAILBOX_DIR)

      await writePayload('dispatch-dup-1.json', {
        targetSessionId: worker,
        fromSessionId: sender,
        content: '派活：重试同一条',
        taskId: payloadTaskId,
      })
      expect(await service.handleMailboxFile(dir, 'dispatch-dup-1.json')).toEqual({ ok: true })

      const first = await collabTaskService.getTask(payloadTaskId)
      expect(first?.id).toBe(payloadTaskId)
      expect(first?.status).toBe('dispatched')

      // 模拟重试：同名 ID 再投一次（不同文件，等价于 ack 丢失后的补投）
      await writePayload('dispatch-dup-2.json', {
        targetSessionId: worker,
        fromSessionId: sender,
        content: '派活：重试同一条',
        taskId: payloadTaskId,
      })
      expect(await service.handleMailboxFile(dir, 'dispatch-dup-2.json')).toEqual({ ok: true })

      const matching = (await collabTaskService.listTasks({ projectDir: tmpDir })).filter(
        (task) => task.id === payloadTaskId,
      )
      expect(matching).toHaveLength(1)
      // 幂等键命中已有任务：复用同一条，不重建（createdAt/history 都不变）
      expect(matching[0]!.createdAt).toBe(first!.createdAt)
      expect(matching[0]!.history).toHaveLength(1)
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
    }
  })

  test('delivers a valid payload and deletes the file', async () => {
    const filePath = await writePayload('report-1.json', {
      targetSessionId: 'session-a',
      content: '【汇报】完成',
      fromSessionId: 'session-b',
    })
    const { service, calls } = buildService()

    const result = await service.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'report-1.json')

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].targetSessionId).toBe('session-a')
    expect(calls[0].content).toBe('【汇报】完成')
    expect(calls[0].host).toBe('127.0.0.1:0')
    expect(await pathExists(filePath)).toBe(false)
  })

  // v1.4.0 阶段1-A ③（信箱一等化）：投递成功删除原文件后同目录回写
  // `<原文件名>.ack` 回执，员工可 Read 确认送达，不必等主管口头确认。
  test('writes an .ack receipt with target/from/messageId after successful delivery', async () => {
    await writePayload('report-ack-1.json', {
      targetSessionId: 'session-a',
      content: '【汇报】完成',
      fromSessionId: 'session-b',
    })
    const { service } = buildService()

    const result = await service.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'report-ack-1.json')

    expect(result).toEqual({ ok: true })
    const ackRaw = await fs.readFile(mailboxPath('report-ack-1.json.ack'), 'utf-8')
    const ack = JSON.parse(ackRaw) as Record<string, unknown>
    expect(ack.ack).toBe(true)
    expect(ack.file).toBe('report-ack-1.json')
    expect(ack.targetSessionId).toBe('session-a')
    expect(ack.fromSessionId).toBe('session-b')
    expect(typeof ack.messageId).toBe('string')
    expect(Number.isNaN(Date.parse(ack.deliveredAt as string))).toBe(false)
    // v1.5.0 C2 裁决：unlink 成功时不带 unlinkFailed 字段（只在删除失败时出现）
    expect(ack.unlinkFailed).toBeUndefined()
  })

  test('an .ack file is itself not treated as a dispatch payload (idempotent protocol)', () => {
    expect(isDispatchPayloadName('report-ack-1.json.ack')).toBe(false)
  })

  // ── v1.5.0 C2：重复投递护栏 ──
  test('skips a file whose .ack already exists (C2 no-duplicate guard)', async () => {
    // 场景：上次投递成功但 unlink 失败、文件残留 + .ack 已写 → 周期 rescan
    // 再次扫到同名文件时必须跳过，不得重复投递
    await writePayload('report-dup.json', {
      targetSessionId: 'session-a',
      content: '【汇报】内容',
      fromSessionId: 'session-b',
    })
    await fs.writeFile(
      mailboxPath('report-dup.json.ack'),
      JSON.stringify({ ack: true, file: 'report-dup.json' }),
      'utf-8',
    )
    const { service, calls } = buildService()

    const result = await service.handleMailboxFile(
      path.join(tmpDir, COLLAB_MAILBOX_DIR),
      'report-dup.json',
    )

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(0) // 投递未被触发 = 幂等跳过生效
  })

  test('without a pre-existing .ack the same file delivers normally (guard is scoped)', async () => {
    await writePayload('report-fresh.json', {
      targetSessionId: 'session-a',
      content: '【汇报】正常',
      fromSessionId: 'session-b',
    })
    const { service, calls } = buildService()

    const result = await service.handleMailboxFile(
      path.join(tmpDir, COLLAB_MAILBOX_DIR),
      'report-fresh.json',
    )

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test('a failed delivery writes no .ack receipt', async () => {
    await writePayload('report-ack-2.json', { content: 'missing target' })
    const { service } = buildService()

    const result = await service.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'report-ack-2.json')

    expect(result.ok).toBe(false)
    expect(await pathExists(mailboxPath('report-ack-2.json.ack'))).toBe(false)
  })

  test('records a dispatch receipt so mailbox dispatches are visible to the stall watcher', async () => {
    resetDispatchReceipts()
    await writePayload('dispatch-9.json', {
      targetSessionId: 'session-mb',
      content: '【上级派活】干活',
      fromSessionId: 'session-sup',
    })
    const { service } = buildService()

    expect(countUnconsumedReceipts('session-mb')).toBe(0)
    await service.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'dispatch-9.json')

    // 投递成功 → 记一条未消费回执（否则经信箱派的活对告警判定不可见）
    expect(countUnconsumedReceipts('session-mb')).toBe(1)
    const receipt = listReceipts('session-mb')[0]!
    expect(receipt.fromSessionId).toBe('session-sup')
    expect(receipt.consumed).toBe(false)
    resetDispatchReceipts()
  })

  test('a failed mailbox delivery leaves no receipt behind', async () => {
    resetDispatchReceipts()
    await writePayload('dispatch-10.json', {
      targetSessionId: 'session-mb-fail',
      content: '【上级派活】干活',
    })
    const { service } = buildService({ deliver: async () => false })

    await service.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'dispatch-10.json')

    expect(countUnconsumedReceipts('session-mb-fail')).toBe(0)
  })

  test('rejects invalid payloads with a .failed rename and an .error.txt explanation', async () => {
    const dir = path.join(tmpDir, COLLAB_MAILBOX_DIR)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'dispatch-1.json'), '{ not json', 'utf-8')
    const { service, calls } = buildService()

    const result = await service.handleMailboxFile(dir, 'dispatch-1.json')

    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(await pathExists(path.join(dir, 'dispatch-1.json.failed'))).toBe(true)
    const errorText = await fs.readFile(path.join(dir, 'dispatch-1.json.error.txt'), 'utf-8')
    expect(errorText).toContain('Invalid payload')
  })

  test('rejects payloads with a missing targetSessionId', async () => {
    const dir = path.join(tmpDir, COLLAB_MAILBOX_DIR)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'dispatch-2.json'), JSON.stringify({ content: 'hi' }), 'utf-8')
    const { service, calls } = buildService()

    const result = await service.handleMailboxFile(dir, 'dispatch-2.json')

    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(await pathExists(path.join(dir, 'dispatch-2.json.failed'))).toBe(true)
  })

  test('blocks cross-project dispatch: enabled servant in another project', async () => {
    await writePayload('dispatch-3.json', {
      targetSessionId: 'worker-elsewhere',
      content: '【上级派活】跨项目',
      fromSessionId: 'session-b',
    })
    const { service, calls } = buildService({
      getServant: async (id) => (id === 'worker-elsewhere' ? { enabled: true } : null),
      getSessionWorkDir: async () => path.join(tmpDir, 'other-project'),
    })

    const result = await service.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'dispatch-3.json')

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toContain('Cross-project dispatch is not allowed')
    expect(calls).toHaveLength(0)
    expect(await pathExists(path.join(tmpDir, COLLAB_MAILBOX_DIR, 'dispatch-3.json.error.txt'))).toBe(true)
  })

  test('allows dispatch to an enabled servant in the same project', async () => {
    await writePayload('dispatch-4.json', {
      targetSessionId: 'worker-here',
      content: '【上级派活】同项目',
      fromSessionId: 'session-b',
    })
    const { service, calls } = buildService({
      getServant: async (id) => (id === 'worker-here' ? { enabled: true } : null),
      getSessionWorkDir: async () => tmpDir,
    })

    const result = await service.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'dispatch-4.json')

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
  })

  test('marks delivery failure when the messenger cannot deliver', async () => {
    await writePayload('dispatch-5.json', {
      targetSessionId: 'session-a',
      content: '【上级派活】交付失败',
    })
    const failing = new DispatchMailboxService({
      deliver: async () => false,
      getServant: async () => null,
      getSessionWorkDir: async () => null,
      listServants: async () => [],
    })

    const result = await failing.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'dispatch-5.json')

    expect(result.ok).toBe(false)
    const errorText = await fs.readFile(
      path.join(tmpDir, COLLAB_MAILBOX_DIR, 'dispatch-5.json.error.txt'),
      'utf-8',
    )
    expect(errorText).toContain('could not be delivered')
  })

  test('sync watches only projects with enabled servants and closes removed ones', async () => {
    const otherProject = path.join(tmpDir, 'project-b')
    await fs.mkdir(otherProject, { recursive: true })
    const { service } = buildService({
      listServants: async () => [
        {
          sessionId: 'worker-1',
          enabled: true,
          workDir: tmpDir,
          updatedAt: 1,
          title: 'w1',
        },
        {
          sessionId: 'worker-2',
          enabled: false,
          workDir: otherProject,
          updatedAt: 2,
          title: 'w2',
        },
      ],
    })

    service.start(0)
    await service.sync()
    // 只有 enabled 员工的项目被监听
    expect((service as unknown as { watchers: Map<string, unknown> }).watchers.size).toBe(1)
    expect(await pathExists(path.join(tmpDir, COLLAB_MAILBOX_DIR))).toBe(true)
    // 未启用员工的项目不会创建信箱目录
    expect(await pathExists(path.join(otherProject, COLLAB_MAILBOX_DIR))).toBe(false)

    service.stop()
    expect((service as unknown as { watchers: Map<string, unknown> }).watchers.size).toBe(0)
  })

  // —— 周期兜底扫描（三类静默失效的最后防线）——

  /** PROCESS_DELAY_MS(200) debounce 之后的确定性结算窗口 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

  function enabledWorkerList(workDir: string) {
    return [
      {
        sessionId: 'worker-1',
        enabled: true,
        workDir,
        updatedAt: 1,
        title: 'w1',
      },
    ]
  }

  test('periodic rescan rebuilds a dead watcher and consumes pending files', async () => {
    const { service, calls } = buildService({
      listServants: async () => enabledWorkerList(tmpDir),
    })
    service.start(0)
    await service.sync()
    // 模拟 watcher 事后失效：关闭并清空（等价于 watcher 从未建立/已被系统回收）
    const internal = service as unknown as { watchers: Map<string, { close(): void }> }
    for (const w of internal.watchers.values()) w.close()
    internal.watchers.clear()

    await writePayload('report-20.json', {
      targetSessionId: 'session-a',
      content: '【汇报】兜底投递',
    })
    const result = await (service as unknown as { rescanAll(): Promise<void> }).rescanAll()
    expect(result).toBeUndefined()
    await settle()

    expect(calls).toHaveLength(1)
    expect(calls[0].targetSessionId).toBe('session-a')
    expect(await pathExists(mailboxPath('report-20.json'))).toBe(false)
    service.stop()
  })

  test('periodic rescan recovers after an initial sync failure', async () => {
    let listFails = true
    const { service, calls } = buildService({
      listServants: async () => {
        if (listFails) throw new Error('roster unreadable')
        return enabledWorkerList(tmpDir)
      },
    })
    service.start(0)
    await service.sync()
    // start 时 sync 失败：没有任何 watcher 建立
    expect((service as unknown as { watchers: Map<string, unknown> }).watchers.size).toBe(0)

    await writePayload('dispatch-21.json', {
      targetSessionId: 'session-a',
      content: '【上级派活】延迟恢复',
    })
    // 第一轮周期任务：吞掉 sync 失败不抛错；故障恢复后第二轮重建并消费
    await (service as unknown as { rescanAll(): Promise<void> }).rescanAll()
    listFails = false
    await (service as unknown as { rescanAll(): Promise<void> }).rescanAll()
    await settle()

    expect(calls).toHaveLength(1)
    expect(await pathExists(mailboxPath('dispatch-21.json'))).toBe(false)
    service.stop()
  })

  test('scanExisting is idempotent: repeated scans deliver exactly once', async () => {
    const { service, calls } = buildService({
      listServants: async () => enabledWorkerList(tmpDir),
    })
    service.start(0)
    await service.sync()

    await writePayload('report-22.json', {
      targetSessionId: 'session-a',
      content: '【汇报】幂等',
    })
    const dir = path.join(tmpDir, COLLAB_MAILBOX_DIR)
    const scan = (service as unknown as { scanExisting(d: string): Promise<void> }).scanExisting.bind(service)
    // watcher 事件 + 三次手动补扫同时到达：debounce/inFlight 必须合并为一次投递
    await scan(dir)
    await scan(dir)
    await scan(dir)
    await settle()

    expect(calls).toHaveLength(1)
    expect(await pathExists(path.join(dir, 'report-22.json'))).toBe(false)
    // 文件已消费后再扫：readdir 看不到，不产生新投递
    await scan(dir)
    await settle()
    expect(calls).toHaveLength(1)
    service.stop()
  })

  test('periodic rescan timer lifecycle: created on start, cleared on stop', async () => {
    const { service } = buildService()
    service.start(0)
    const withTimer = service as unknown as { rescanTimer: unknown }
    expect(withTimer.rescanTimer).not.toBeNull()
    service.stop()
    expect(withTimer.rescanTimer).toBeNull()
  })

  /**
   * 裁决四方案 A：信箱通道的归属校验也必须**先于**补推进。
   * 停在 dispatched 的任务，若汇报方不是受派人，既不能推进、也不能补链。
   */
  test('信箱归属不符：停在 dispatched 的任务不推进、也不触发补链', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    try {
      const supervisor = await registerWorker({ role: '主管', supervisor: true })
      const worker = await registerWorker({ role: '后端' })
      const other = await registerWorker({ role: '前端' })
      const { collabTaskService } = await import('../services/collabTaskService.js')
      await collabTaskService.createTask({
        id: 'mb-catchup-mismatch',
        projectDir: tmpDir,
        fromSessionId: supervisor,
        fromRole: 'supervisor',
        toSessionId: worker,
        title: '派活',
        content: '做点事',
      })

      const { service, calls } = buildService()
      // 汇报方是 other，不是受派人 worker
      await writePayload('report-mb-mismatch.json', {
        targetSessionId: supervisor,
        fromSessionId: other,
        content: '【汇报】做完了',
        report: { taskId: 'mb-catchup-mismatch', summary: '做完了' },
      })

      const result = await service.handleMailboxFile(
        path.join(tmpDir, COLLAB_MAILBOX_DIR),
        'report-mb-mismatch.json',
      )
      expect(result).toEqual({ ok: true })

      // 消息照常投递，但台账不动：既没推进，也没有补链
      expect(calls).toHaveLength(1)
      const task = await collabTaskService.getTask('mb-catchup-mismatch')
      expect(task?.status).toBe('dispatched')
      expect(task?.history).toHaveLength(1)
      expect(task?.report).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
    }
  })

  test('信箱归属相符：停在 dispatched 的任务补链到 delivered', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    try {
      const supervisor = await registerWorker({ role: '主管', supervisor: true })
      const worker = await registerWorker({ role: '后端' })
      const { collabTaskService } = await import('../services/collabTaskService.js')
      await collabTaskService.createTask({
        id: 'mb-catchup-ok',
        projectDir: tmpDir,
        fromSessionId: supervisor,
        fromRole: 'supervisor',
        toSessionId: worker,
        title: '派活',
        content: '做点事',
      })

      const { service, calls } = buildService()
      await writePayload('report-mb-ok.json', {
        targetSessionId: supervisor,
        fromSessionId: worker,
        content: '【汇报】做完了',
        report: { taskId: 'mb-catchup-ok', summary: '做完了' },
      })

      const result = await service.handleMailboxFile(
        path.join(tmpDir, COLLAB_MAILBOX_DIR),
        'report-mb-ok.json',
      )
      expect(result).toEqual({ ok: true })
      expect(calls).toHaveLength(1)

      const task = await collabTaskService.getTask('mb-catchup-ok')
      expect(task?.status).toBe('delivered')
      expect(task?.report).toBe('做完了')
      expect(task?.history.filter((h) => h.by === 'system')).toHaveLength(2)
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
    }
  })
})
