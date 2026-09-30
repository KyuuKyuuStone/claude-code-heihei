import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveReportTarget } from '../services/reportTargetResolver.js'
import { setDiagnosticsLogWriterForTests } from '../../utils/diagLogs.js'

/**
 * 架构决策：taskId 信任边界的采纳项 (c)（2026-09-30，架构师 52ca07b6）。
 *
 * taskId 是标识符不是凭证：本机同信任域、API 无鉴权，不按安全漏洞修。但便宜模型
 * 抄错 taskId 时，resolveReportTarget 会按那个 taskId **静默改投**给别人的派活人
 * ——这是真实会发生的完整性问题。本文件守住：
 *   · 归属不符 → 不按该 taskId 改投，降级走兜底解析，并记 collab_report_task_mismatch；
 *   · 归属相符 → 行为与改动前完全一致，不产生诊断。
 */

type RecordedEvent = { level: string; event: string; data: Record<string, unknown> }

describe('resolveReportTarget 改投前归属校验 (c)', () => {
  let tmpDir: string
  let events: RecordedEvent[]

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-report-resolver-'))
    const original = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    originalConfigDir = original

    events = []
    setDiagnosticsLogWriterForTests((level, event, data) => {
      events.push({ level, event, data })
    })
  })

  afterEach(async () => {
    setDiagnosticsLogWriterForTests(null)
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  let originalConfigDir: string | undefined

  /** 登记真实会话为在册员工（resolver 走单例服务，需真实花名册） */
  async function registerWorker(input: { role: string; supervisor?: boolean }): Promise<string> {
    const { sessionService } = await import('../services/sessionService.js')
    const { ServantService } = await import('../services/servantService.js')
    const { registerSession } = await import('../services/sessionRegistry.js')
    const worker = await sessionService.createSession(tmpDir)
    registerSession(worker.sessionId)
    await new ServantService().setServant(worker.sessionId, {
      role: input.role,
      enabled: true,
      ...(input.supervisor !== undefined ? { supervisor: input.supervisor } : {}),
    })
    return worker.sessionId
  }

  async function createDispatchedTask(input: {
    id: string
    fromSessionId: string
    toSessionId: string
    title?: string
    fromRole?: 'supervisor' | 'servant'
  }) {
    const { collabTaskService } = await import('../services/collabTaskService.js')
    await collabTaskService.createTask({
      id: input.id,
      projectDir: tmpDir,
      fromSessionId: input.fromSessionId,
      fromRole: input.fromRole ?? 'supervisor',
      toSessionId: input.toSessionId,
      title: input.title ?? '派活',
      content: '做点事',
    })
  }

  function mismatchEvents(): RecordedEvent[] {
    return events.filter((e) => e.event === 'collab_report_task_mismatch')
  }

  test('带别人的 taskId → 不按它改投，按自己名下的未结任务兜底解析，并记诊断', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const otherDispatcher = await registerWorker({ role: '另一个员工的派活人' })
    const worker = await registerWorker({ role: '后端' })
    const otherWorker = await registerWorker({ role: '前端' })

    // 我（worker）名下的任务：主管派给我的
    await createDispatchedTask({
      id: 'own-task',
      fromSessionId: supervisor,
      toSessionId: worker,
    })
    // 别人的任务：别人的派活人派给另一个员工
    await createDispatchedTask({
      id: 'other-task',
      fromSessionId: otherDispatcher,
      toSessionId: otherWorker,
      fromRole: 'servant',
    })

    // 我汇报时抄错了 taskId，写成了别人的 → 目标故意填成别人的派活人
    const resolution = await resolveReportTarget({
      targetSessionId: otherDispatcher,
      fromSessionId: worker,
      taskId: 'other-task',
    })

    // 不按抄错的 taskId 改投给别人派活人：降级后按我名下未结任务解析 → 回给我的主管
    expect(resolution.targetSessionId).toBe(supervisor)
    expect(resolution.resolvedBy).toBe('latest-open-task')
    expect(resolution.isReport).toBe(true)

    // 诊断留痕
    const mismatch = mismatchEvents()
    expect(mismatch).toHaveLength(1)
    expect(mismatch[0]!.data.requestedTaskId).toBe('other-task')
    expect(mismatch[0]!.data.workerSessionId).toBe(worker)
    expect(mismatch[0]!.data.taskOwnerSessionId).toBe(otherWorker)
  })

  test('带别人的 taskId 且自己名下没有未结任务 → 不改投，落到兜底第 4 步', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const otherDispatcher = await registerWorker({ role: '别人的派活人' })
    const worker = await registerWorker({ role: '后端' })
    const otherWorker = await registerWorker({ role: '前端' })

    await createDispatchedTask({
      id: 'not-mine',
      fromSessionId: otherDispatcher,
      toSessionId: otherWorker,
      fromRole: 'servant',
    })

    const resolution = await resolveReportTarget({
      targetSessionId: otherDispatcher,
      fromSessionId: worker,
      taskId: 'not-mine',
    })

    // 仍不改投给别人主管；同项目有现任主管 → 第 4 步投给它
    expect(resolution.targetSessionId).toBe(supervisor)
    expect(resolution.resolvedBy).toBe('project-supervisor')
    expect(mismatchEvents()).toHaveLength(1)
  })

  test('taskId 属于自己 → 行为不变，按 task-id 改投，且不产生 mismatch 诊断', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })

    await createDispatchedTask({
      id: 'mine',
      fromSessionId: supervisor,
      toSessionId: worker,
    })

    // 目标填错（故意填成自己），应被按 taskId 改投回主管
    const resolution = await resolveReportTarget({
      targetSessionId: worker,
      fromSessionId: worker,
      taskId: 'mine',
    })

    expect(resolution.targetSessionId).toBe(supervisor)
    expect(resolution.resolvedBy).toBe('task-id')
    expect(resolution.redirectedFrom).toBe(worker)
    expect(resolution.isReport).toBe(true)
    expect(mismatchEvents()).toHaveLength(0)
  })

  test('taskId 查不到（抄错成不存在）→ 维持既有行为：不改投、不降级、不记 mismatch', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    await createDispatchedTask({
      id: 'exists',
      fromSessionId: supervisor,
      toSessionId: worker,
    })

    const resolution = await resolveReportTarget({
      targetSessionId: supervisor,
      fromSessionId: worker,
      taskId: 'typo-does-not-exist',
    })

    // 原有语义：查不到就原样放行（不落第 2 步的兜底解析——那是归属不符才做的事）
    expect(resolution.targetSessionId).toBe(supervisor)
    expect(resolution.resolvedBy).toBeUndefined()
    expect(events.some((e) => e.event === 'collab_report_task_not_found')).toBe(true)
    expect(mismatchEvents()).toHaveLength(0)
  })

  test('fromSessionId 缺失或全空白 → 前置守卫直接放行：不解析、不改投、不记 mismatch', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    await createDispatchedTask({
      id: 'guard-task',
      fromSessionId: supervisor,
      toSessionId: worker,
    })

    // 缺失与全空白两种都走同一条守卫（:100-101）。
    // 即便带了**归属相符**的 taskId，也无从判定发送者身份 → 一律原样放行。
    for (const missing of [undefined, '', '   ']) {
      const resolution = await resolveReportTarget({
        targetSessionId: worker,
        ...(missing === undefined ? {} : { fromSessionId: missing }),
        taskId: 'guard-task',
      })

      expect(resolution.targetSessionId).toBe(worker)
      expect(resolution.isReport).toBe(false)
      expect(resolution.redirectedFrom).toBeUndefined()
      expect(resolution.resolvedBy).toBeUndefined()
      expect(resolution.warning).toBeUndefined()
    }

    // 不产生任何诊断（既不是 mismatch 也不是 not_found）
    expect(mismatchEvents()).toHaveLength(0)
    expect(events.filter((e) => e.event === 'collab_report_task_not_found')).toHaveLength(0)
  })

  test('归属不符 + 名下多来源未结任务 → 走 ambiguous 分支：不改投、留痕、isReport=true', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const otherDispatcher = await registerWorker({ role: '别人的派活人' })
    const otherWorker = await registerWorker({ role: '前端' })
    const worker = await registerWorker({ role: '后端' })

    // 我（worker）名下两条未结任务，来自**不同**派活人 → 证据不明确
    await createDispatchedTask({
      id: 'amb-a',
      fromSessionId: supervisor,
      toSessionId: worker,
    })
    await createDispatchedTask({
      id: 'amb-b',
      fromSessionId: otherDispatcher,
      toSessionId: worker,
      fromRole: 'servant',
    })
    // 抄错的那条：别人的任务
    await createDispatchedTask({
      id: 'amb-other',
      fromSessionId: otherDispatcher,
      toSessionId: otherWorker,
      fromRole: 'servant',
    })

    const resolution = await resolveReportTarget({
      targetSessionId: otherDispatcher,
      fromSessionId: worker,
      taskId: 'amb-other',
    })

    // 降级到第 2 步后命中的是多来源歧义：不乱猜，原样返回原目标
    expect(resolution.targetSessionId).toBe(otherDispatcher)
    expect(resolution.redirectedFrom).toBeUndefined()
    expect(resolution.resolvedBy).toBeUndefined()
    // 歧义说的是「回给谁」不明，不是「这不是汇报」——仍标记为汇报
    expect(resolution.isReport).toBe(true)
    const expectedSenders = [supervisor, otherDispatcher].sort().join(',')
    expect(resolution.warning).toBe(`ambiguous-dispatchers:${expectedSenders}`)

    // 归属不符这条事实本身仍要留痕（诊断发生在降级之前）
    const mismatch = mismatchEvents()
    expect(mismatch).toHaveLength(1)
    expect(mismatch[0]!.data.requestedTaskId).toBe('amb-other')
    expect(mismatch[0]!.data.taskOwnerSessionId).toBe(otherWorker)
  })

  test('主管自己发消息永不解析 → 即便带别人的 taskId 也不改投、不记 mismatch', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const otherDispatcher = await registerWorker({ role: '别人的派活人' })
    const otherWorker = await registerWorker({ role: '前端' })

    await createDispatchedTask({
      id: 'sup-other',
      fromSessionId: otherDispatcher,
      toSessionId: otherWorker,
      fromRole: 'servant',
    })

    const resolution = await resolveReportTarget({
      targetSessionId: supervisor,
      fromSessionId: supervisor,
      taskId: 'sup-other',
    })

    expect(resolution.targetSessionId).toBe(supervisor)
    expect(resolution.isReport).toBe(false)
    expect(mismatchEvents()).toHaveLength(0)
  })
})
