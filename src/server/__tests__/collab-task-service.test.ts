import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  CollabTaskService,
  REPORT_CATCHUP_NOTE,
  codePointSlice,
} from '../services/collabTaskService.js'
import { onCollabPush } from '../../collaboration/collabPushSignals.js'
import { setDiagnosticsLogWriterForTests } from '../../utils/diagLogs.js'
import { beginTurn, clearSession, registerSession } from '../services/sessionRegistry.js'

/**
 * 协作任务台账（v1.6.0）回归。
 *
 * 覆盖规划 3.1 的硬要求：状态机（非法流转拒绝）、追加写 + 重放（重启不丢）、
 * 幂等（键 = task.id）、并发写（进程内队列防 lost update），以及事件驱动流转
 * （员工回合开始消费 → accepted → in_progress）。
 */

const PROJECT = 'D:/xxw-p/demo-project'
const PROJECT_B = 'D:/xxw-p/other-project'

describe('协作任务台账 CollabTaskService', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let service: CollabTaskService

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-tasks-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    service = new CollabTaskService()
  })

  afterEach(async () => {
    service.resetForTests()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const baseInput = {
    projectDir: PROJECT,
    fromSessionId: 'supervisor-1',
    toSessionId: 'worker-1',
    title: '实现任务台账',
    content: '按规划 3.1 落地',
  }

  // ── 状态机 ────────────────────────────────────────────────────────────

  it('新任务落为 dispatched，并记录创建历史', async () => {
    const task = await service.createTask(baseInput)
    expect(task.status).toBe('dispatched')
    expect(task.history).toHaveLength(1)
    expect(task.history[0]).toMatchObject({ from: null, to: 'dispatched' })
    expect(task.deliverables).toEqual([])
  })

  it('走完正常链路 dispatch→accepted→in_progress→delivered→verified', async () => {
    const created = await service.createTask(baseInput)
    await service.transitionTask(created.id, 'accepted')
    await service.transitionTask(created.id, 'in_progress')
    await service.reportTask(created.id, { summary: '做完了', deliverables: ['D:/out/a.ts'] })
    const verified = await service.reviewTask(created.id, { verdict: 'pass', note: 'LGTM' })

    expect(verified.status).toBe('verified')
    expect(verified.report).toBe('做完了')
    expect(verified.deliverables).toEqual(['D:/out/a.ts'])
    expect(verified.verdict).toBe('pass')
    expect(verified.history.map((h) => h.to)).toEqual([
      'dispatched',
      'accepted',
      'in_progress',
      'delivered',
      'verified',
    ])
  })

  it('拒绝非法流转：dispatched 不能直接 delivered', async () => {
    const created = await service.createTask(baseInput)
    await expect(service.transitionTask(created.id, 'delivered')).rejects.toThrow(
      /Illegal task transition/,
    )
    // 被拒后状态不变
    expect((await service.getTask(created.id))?.status).toBe('dispatched')
  })

  it('拒绝非法流转：终态 verified 无出边', async () => {
    const created = await service.createTask(baseInput)
    await service.transitionTask(created.id, 'accepted')
    await service.transitionTask(created.id, 'delivered')
    await service.reviewTask(created.id, { verdict: 'pass' })

    await expect(service.transitionTask(created.id, 'in_progress')).rejects.toThrow(
      /Illegal task transition/,
    )
  })

  it('验收不通过流向 rework，可从 rework 再次 in_progress', async () => {
    const created = await service.createTask(baseInput)
    await service.transitionTask(created.id, 'accepted')
    await service.transitionTask(created.id, 'delivered')
    const rework = await service.reviewTask(created.id, { verdict: 'rework', note: '缺少测试' })
    expect(rework.status).toBe('rework')
    expect(rework.verdict).toBe('rework')

    const again = await service.transitionTask(created.id, 'in_progress')
    expect(again.status).toBe('in_progress')
  })

  it('review 只接受 pass|rework', async () => {
    const created = await service.createTask(baseInput)
    await service.transitionTask(created.id, 'accepted')
    await service.transitionTask(created.id, 'delivered')
    // @ts-expect-error 故意传非法值
    await expect(service.reviewTask(created.id, { verdict: 'maybe' })).rejects.toThrow()
  })

  // ── 幂等 ──────────────────────────────────────────────────────────────

  it('幂等：同 id 重复建任务返回同一条，不覆盖、不重复落盘', async () => {
    const first = await service.createTask({ ...baseInput, id: 'fixed-id-1' })
    const second = await service.createTask({ ...baseInput, id: 'fixed-id-1', title: '改标题' })

    expect(second.id).toBe('fixed-id-1')
    expect(second.title).toBe('实现任务台账') // 首次为准，重投不覆盖
    expect(second.createdAt).toBe(first.createdAt)

    const tasks = await service.listTasks({ projectDir: PROJECT })
    expect(tasks).toHaveLength(1)
  })

  it('幂等：重复投递后状态推进仍然只有一条任务', async () => {
    const created = await service.createTask({ ...baseInput, id: 'dup-1' })
    await service.createTask({ ...baseInput, id: 'dup-1' })
    await service.transitionTask(created.id, 'accepted')
    await service.createTask({ ...baseInput, id: 'dup-1' })

    const task = await service.getTask('dup-1')
    expect(task?.status).toBe('accepted')
    expect(await service.listTasks({ projectDir: PROJECT })).toHaveLength(1)
  })

  // ── 重放 ──────────────────────────────────────────────────────────────

  it('重放：新建实例能从 jsonl 还原状态与历史', async () => {
    const created = await service.createTask({ ...baseInput, id: 'replay-1' })
    await service.transitionTask(created.id, 'accepted', { note: '开始' })
    await service.transitionTask(created.id, 'delivered', { report: '完成', deliverables: ['x'] })

    const revived = new CollabTaskService()
    const task = await revived.getTask('replay-1')
    expect(task?.status).toBe('delivered')
    expect(task?.report).toBe('完成')
    expect(task?.deliverables).toEqual(['x'])
    expect(task?.history.map((h) => h.to)).toEqual(['dispatched', 'accepted', 'delivered'])
    revived.resetForTests()
  })

  it('重放：坏行被跳过，不影响其余任务', async () => {
    await service.createTask({ ...baseInput, id: 'good-1' })
    const dir = path.join(tmpDir, 'cc-heihei', 'tasks')
    const files = await fs.readdir(dir)
    const ledger = path.join(dir, files[0]!)
    await fs.appendFile(ledger, '{ this is not json\n', 'utf-8')

    const revived = new CollabTaskService()
    const task = await revived.getTask('good-1')
    expect(task?.status).toBe('dispatched')
    revived.resetForTests()
  })

  it('重放：**缺 deliverables/history 的 created 行**归一为 []，不毁整份台账（v1.7.3 #4）', async () => {
    await service.createTask({ ...baseInput, id: 'ok-1' })
    const dir = path.join(tmpDir, 'cc-heihei', 'tasks')
    const files = await fs.readdir(dir)
    const ledger = path.join(dir, files[0]!)
    // 手写一条缺字段的 created 行（模拟旧版本/手写台账）
    await fs.appendFile(
      ledger,
      JSON.stringify({
        type: 'created',
        task: {
          id: 'legacy-1', projectDir: PROJECT, fromSessionId: 'sup', toSessionId: 'emp',
          title: '旧行', content: '缺字段', status: 'dispatched',
          createdAt: 1, updatedAt: 1,
        },
      }) + '\n',
      'utf-8',
    )

    const revived = new CollabTaskService()
    const legacy = await revived.getTask('legacy-1')
    expect(legacy).not.toBeNull()          // 缺字段**不再**让整份台账加载失败
    expect(legacy?.deliverables).toEqual([])
    expect(legacy?.history).toEqual([])
    expect((await revived.getTask('ok-1'))?.status).toBe('dispatched') // 好行不受影响
    revived.resetForTests()
  })

  it('重放：项目隔离，两个项目各自成账本', async () => {
    await service.createTask({ ...baseInput, id: 'p-a', projectDir: PROJECT })
    await service.createTask({ ...baseInput, id: 'p-b', projectDir: PROJECT_B })

    const revived = new CollabTaskService()
    expect((await revived.listTasks({ projectDir: PROJECT })).map((t) => t.id)).toEqual(['p-a'])
    expect((await revived.listTasks({ projectDir: PROJECT_B })).map((t) => t.id)).toEqual(['p-b'])
    revived.resetForTests()
  })

  // ── 并发写 ────────────────────────────────────────────────────────────

  it('并发建任务：8 条同时写不丢事件（进程内队列串行化）', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `concurrent-${i}`)
    await Promise.all(
      ids.map((id) => service.createTask({ ...baseInput, id, title: `任务 ${id}` })),
    )

    const tasks = await service.listTasks({ projectDir: PROJECT })
    expect(tasks.map((t) => t.id).sort()).toEqual([...ids].sort())
  })

  it('并发流转：不同任务同时推进互不覆盖', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `flow-${i}`)
    await Promise.all(ids.map((id) => service.createTask({ ...baseInput, id })))
    await Promise.all(ids.map((id) => service.transitionTask(id, 'accepted')))
    await Promise.all(ids.map((id) => service.transitionTask(id, 'in_progress')))

    const tasks = await service.listTasks({ projectDir: PROJECT })
    expect(tasks.every((t) => t.status === 'in_progress')).toBe(true)
    expect(tasks.every((t) => t.history.length === 3)).toBe(true)
  })

  // ── 事件驱动流转 ──────────────────────────────────────────────────────

  it('员工回合开始消费 → dispatched 任务推为 accepted 再 in_progress', async () => {
    const workerId = 'worker-turn-1'
    const created = await service.createTask({ ...baseInput, id: 'turn-task', toSessionId: workerId })
    service.startTurnSubscription()

    registerSession(workerId)
    beginTurn(workerId, { awaitSend: false })
    // 订阅回调只排微任务，等一拍让它落盘
    await new Promise((resolve) => setTimeout(resolve, 20))

    const task = await service.getTask(created.id)
    expect(task?.status).toBe('in_progress')
    expect(task?.history.map((h) => h.to)).toEqual(['dispatched', 'accepted', 'in_progress'])
    clearSession(workerId)
  })

  it('回合事件只影响该员工的在办任务，不碰别人的', async () => {
    const createdA = await service.createTask({ ...baseInput, id: 'a', toSessionId: 'worker-a' })
    const createdB = await service.createTask({ ...baseInput, id: 'b', toSessionId: 'worker-b' })
    service.startTurnSubscription()

    registerSession('worker-a')
    beginTurn('worker-a', { awaitSend: false })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect((await service.getTask(createdA.id))?.status).toBe('in_progress')
    expect((await service.getTask(createdB.id))?.status).toBe('dispatched')
    clearSession('worker-a')
  })

  // ── 查询 ──────────────────────────────────────────────────────────────

  it('listTasks 支持 status 过滤并按 updatedAt 倒序', async () => {
    await service.createTask({ ...baseInput, id: 's-1' })
    await service.createTask({ ...baseInput, id: 's-2' })
    await service.transitionTask('s-2', 'accepted')

    const accepted = await service.listTasks({ projectDir: PROJECT, status: 'accepted' })
    expect(accepted.map((t) => t.id)).toEqual(['s-2'])

    const all = await service.listTasks({ projectDir: PROJECT })
    expect(all[0]!.id).toBe('s-2') // 最近更新的在前
  })

  it('getTask 对不存在的 id 返回 null', async () => {
    expect(await service.getTask('nope')).toBeNull()
  })

  // ── v1.6.0 审查修复 ────────────────────────────────────────────────────

  it('压实不丢任务：同一项目的大小写/斜杠双写法（审查 中1，数据丢失级回归）', async () => {
    // Windows 路径大小写不敏感，同一项目会以两种写法出现（随调用来源不同）。
    // 两种写法 projectHash 相同 → 落同一个账本；此前的 sameProject 只做
    // path.resolve 严格串比较，压实快照会把其中一组判为异项目丢弃。
    const upper = 'D:/X/proj'
    const lower = 'd:\\x\\proj'
    const t1 = await service.createTask({ ...baseInput, id: 'dual-upper', projectDir: upper })
    const t2 = await service.createTask({ ...baseInput, id: 'dual-lower', projectDir: lower })
    await service.transitionTask(t2.id, 'accepted')

    // 触发压实：阈值 400 行，直接把该账本的行计数拉满再调私有方法
    // （否则 lineCount 只有 2，compactIfNeeded 会提前 return，测试变空转）
    ;(service as unknown as { lineCount: Map<string, number> }).lineCount.set(upper, 1000)
    await (service as unknown as { compactIfNeeded(dir: string): Promise<void> }).compactIfNeeded(upper)

    // 重启重放：两组任务都必须还在
    const revived = new CollabTaskService()
    const ids = (await revived.listTasks({})).map((t) => t.id)
    expect(ids).toContain(t1.id)
    expect(ids).toContain(t2.id)
    // 状态也从快照恢复
    expect((await revived.getTask(t2.id))?.status).toBe('accepted')
  })

  it('压实失败不再让请求失败：数据已落盘、只记诊断、下次追加重试（v1.7.0 补充裁决二）', async () => {
    // 场景：appendEvent 先把行追加**落盘成功**，随后才做压实。压实 rename 失败
    // 时若把异常抛上去，用户会看到「写入失败」，但数据其实已经在文件里——
    // 重试还会撞 409。压实只是优化，因此只记诊断并吞掉。
    const created = await service.createTask({ ...baseInput, id: 'compact-fail' })
    // 键必须是服务内部用的那个（task.projectDir 已 resolve）
    ;(service as unknown as { lineCount: Map<string, number> }).lineCount.set(
      created.projectDir,
      1000,
    )

    const fsPromises = await import('node:fs/promises')
    const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(() => {
      const error = new Error('locked by indexer') as NodeJS.ErrnoException
      error.code = 'EPERM'
      return Promise.reject(error)
    })
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    setDiagnosticsLogWriterForTests((_level, event, data) => {
      events.push({ event, data: data as Record<string, unknown> })
    })

    try {
      // 不抛：请求照常成功
      await service.transitionTask('compact-fail', 'accepted')
    } finally {
      renameSpy.mockRestore()
      setDiagnosticsLogWriterForTests(null)
    }

    // 状态确实推进了
    expect((await service.getTask('compact-fail'))?.status).toBe('accepted')
    // 压实失败被记成诊断，而不是异常
    expect(events.filter((e) => e.event === 'collab_task_compact_failed')).toHaveLength(1)
    // lineCount 不重置 → 仍超阈值，下次追加还会尝试压实
    const count = (service as unknown as { lineCount: Map<string, number> }).lineCount.get(created.projectDir)
    expect(count).toBeGreaterThanOrEqual(400)

    // 追加的那一行是真的落盘了：新实例重放能看到
    const revived = new CollabTaskService()
    expect((await revived.getTask('compact-fail'))?.status).toBe('accepted')
  })

  it('压实失败后 lineCount 不被重置：**下一次追加会再次尝试压实**（补充裁决二）', async () => {
    // 上一条用例断言了「lineCount 仍 ≥ 阈值」，但那是状态断言。裁决的原意是
    // 「下次追加时**再压实**」——这条直接数 rename 的调用次数来证明压实真的
    // 被第二次触发：若有人把 lineCount 顺手重置回去，这里就会红。
    const created = await service.createTask({ ...baseInput, id: 'compact-retry' })
    const projectDir = created.projectDir
    ;(service as unknown as { lineCount: Map<string, number> }).lineCount.set(projectDir, 1000)

    const fsPromises = await import('node:fs/promises')
    const realRename = fsPromises.rename
    let renameCalls = 0
    const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(
      async (...args: Parameters<typeof realRename>) => {
        renameCalls += 1
        // 第一次压实的全部尝试（retries=6 → 共 7 次）失败；此后放行，让第二次压实成功
        if (renameCalls <= 7) {
          const error = new Error('locked by indexer') as NodeJS.ErrnoException
          error.code = 'EPERM'
          throw error
        }
        return realRename(...args)
      },
    )
    const events: string[] = []
    setDiagnosticsLogWriterForTests((_level, event) => {
      events.push(event)
    })

    try {
      // ── 第一次追加：压实失败（6 次重试耗尽） ──
      await service.transitionTask('compact-retry', 'accepted')
      expect(renameCalls).toBe(7)
      expect(events).toContain('collab_task_compact_failed')
      expect((await service.getTask('compact-retry'))?.status).toBe('accepted')
      expect(
        (service as unknown as { lineCount: Map<string, number> }).lineCount.get(projectDir),
      ).toBeGreaterThanOrEqual(400)

      // ── 第二次追加：lineCount 没被打回 → **再次触发压实**，这次成功 ──
      await service.transitionTask('compact-retry', 'in_progress')
      expect(renameCalls).toBeGreaterThan(7) // ← 关键：第二次确实又压了
      // 压实成功后 lineCount 被重置成任务数（此时只有 1 条任务）
      expect(
        (service as unknown as { lineCount: Map<string, number> }).lineCount.get(projectDir),
      ).toBe(1)

      // 压实后磁盘上就是快照（每任务一行）：任务还在
      // 注：这里只断言任务存在，不断言状态——压实用的是「本次变更之前」的内存态
      // （transitionTask 先 appendEvent 后改内存），那是另一个独立问题，见汇报。
      const revived = new CollabTaskService()
      expect((await revived.listTasks({ projectDir })).map((t) => t.id)).toContain(
        'compact-retry',
      )
    } finally {
      renameSpy.mockRestore()
      setDiagnosticsLogWriterForTests(null)
    }
  })

  it('listTasks 的项目过滤同样按归一标准匹配双写法（审查 中1 附带）', async () => {
    await service.createTask({ ...baseInput, id: 'filter-a', projectDir: 'D:/X/proj' })
    const hits = await service.listTasks({ projectDir: 'd:\\x\\proj' })
    expect(hits.map((t) => t.id)).toEqual(['filter-a'])
  })

  it('启动加载时清扫压实 tmp 残留（审查 低3）', async () => {
    await service.createTask({ ...baseInput, id: 'tmp-seed' })
    // 在账本目录里放一个模拟的陈旧 tmp（加载只认 .jsonl，tmp 会永久占位）
    const ledgerDir = path.join(tmpDir, 'cc-heihei', 'tasks')
    const staleTmp = path.join(ledgerDir, 'deadbeef.jsonl.tmp')
    await fs.writeFile(staleTmp, '{"half":', 'utf-8')

    const revived = new CollabTaskService()
    await revived.listTasks({}) // 触发加载
    await expect(fs.access(staleTmp)).rejects.toThrow()
  })

  it('title 按码点截断，不切坏代理对（审查 低4）', () => {
    // 每个 emoji 占 2 个 UTF-16 码元：按码元切 40 会留下孤立代理
    const emoji = '😀'.repeat(30)
    const truncated = codePointSlice(emoji, 40)
    expect(truncated).toBe('😀'.repeat(30)) // 30 < 40，整体保留
    const cut = codePointSlice(emoji, 10)
    expect(Array.from(cut)).toHaveLength(10)
    expect(cut).toBe('😀'.repeat(10))
    // 不会出现孤立代理（切在码元中间的特征：末尾是高位代理 D800-DBFF）
    const last = cut.charCodeAt(cut.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    // 短文本原样返回
    expect(codePointSlice('短文本', 40)).toBe('短文本')
  })
})

/**
 * 裁决四（任务 5374d7f8）：忙碌期间入队的任务停在 dispatched。
 *
 * 目标忙碌时 beginTurn 幂等短路、不发 turn_changed，消息却已进 CLI 队列，
 * 于是该任务拿不到任何开工信号。采纳方案 A：员工带着正文汇报本身就是「已接手
 * 并完成」的最强证据，reportTask 对仍处 dispatched 的任务显式补链。
 *
 * 本组锁死决策第 5 条列出的每一条约束。
 */
describe('reportTask 补推进（裁决四方案 A）', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let service: CollabTaskService

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-catchup-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    service = new CollabTaskService()
  })

  afterEach(async () => {
    service.resetForTests()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const input = (id: string) => ({
    id,
    projectDir: PROJECT,
    fromSessionId: 'supervisor-1',
    toSessionId: 'worker-1',
    title: '任务',
    content: '正文',
  })

  it('dispatched 任务汇报 → 补链三步，同一时刻、前两条 note 固定且 by=system，第三条是真实汇报', async () => {
    await service.createTask(input('catchup-1'))

    const done = await service.reportTask('catchup-1', {
      summary: '做完了',
      deliverables: ['D:/out/x.ts'],
    })

    expect(done.status).toBe('delivered')
    expect(done.report).toBe('做完了')
    expect(done.deliverables).toEqual(['D:/out/x.ts'])
    expect(done.history.map((h) => h.to)).toEqual([
      'dispatched',
      'accepted',
      'in_progress',
      'delivered',
    ])

    const [created, ...toDelivered] = done.history
    expect(created!.from).toBeNull()
    // 前两条是补推进：固定 note + by 系统 + 正确的 from
    expect(toDelivered.slice(0, 2).map((h) => h.note)).toEqual([
      REPORT_CATCHUP_NOTE,
      REPORT_CATCHUP_NOTE,
    ])
    expect(toDelivered.slice(0, 2).map((h) => h.by)).toEqual(['system', 'system'])
    expect(toDelivered.slice(0, 2).map((h) => h.from)).toEqual(['dispatched', 'accepted'])
    // 第三条是员工真正的汇报，不带系统标记
    expect(toDelivered[2]!.note).toBe('做完了')
    expect(toDelivered[2]!.by).toBeUndefined()
    // 补链三步共用同一个 at（汇报时刻，不伪造更早时间）
    expect(new Set(toDelivered.map((h) => h.at)).size).toBe(1)
  })

  it('补链推送只发最终态 delivered 一次（中间态不推，避免面板闪烁）', async () => {
    await service.createTask(input('catchup-push'))

    const pushed: string[] = []
    const off = onCollabPush((signal) => {
      if (signal.kind === 'task') pushed.push(signal.status)
    })
    try {
      await service.reportTask('catchup-push', { summary: '完成' })
    } finally {
      off()
    }
    expect(pushed).toEqual(['delivered'])
  })

  it('原子性：补链三次写入合成一次 appendFile（要么全写要么不写）', async () => {
    await service.createTask(input('catchup-atomic'))

    const fsPromises = await import('node:fs/promises')
    const spy = spyOn(fsPromises, 'appendFile')
    try {
      await service.reportTask('catchup-atomic', { summary: '完成' })
      expect(spy).toHaveBeenCalledTimes(1)
      const written = String(spy.mock.calls[0]![1])
      expect(written.trim().split('\n')).toHaveLength(3)
    } finally {
      spy.mockRestore()
    }
  })

  it('落盘失败时不留半截补推进：状态与 history 都不动', async () => {
    await service.createTask(input('catchup-fail'))

    const fsPromises = await import('node:fs/promises')
    const spy = spyOn(fsPromises, 'appendFile').mockImplementation(() => {
      throw new Error('disk full')
    })
    try {
      await expect(service.reportTask('catchup-fail', { summary: '完成' })).rejects.toThrow(
        /disk full/,
      )
    } finally {
      spy.mockRestore()
    }

    const task = await service.getTask('catchup-fail')
    expect(task?.status).toBe('dispatched')
    expect(task?.history.map((h) => h.to)).toEqual(['dispatched'])
    expect(task?.report).toBeUndefined()
  })

  it('补链只在 dispatched 起步时触发：accepted / in_progress 仍走单步', async () => {
    await service.createTask(input('step-accepted'))
    await service.transitionTask('step-accepted', 'accepted')
    await service.reportTask('step-accepted', { summary: '完成' })
    const a = await service.getTask('step-accepted')
    expect(a?.status).toBe('delivered')
    expect(a?.history.map((h) => h.by)).toEqual([undefined, undefined, undefined])
    expect(a?.history.map((h) => h.to)).toEqual(['dispatched', 'accepted', 'delivered'])

    await service.createTask(input('step-inprogress'))
    await service.transitionTask('step-inprogress', 'accepted')
    await service.transitionTask('step-inprogress', 'in_progress')
    await service.reportTask('step-inprogress', { summary: '完成' })
    const b = await service.getTask('step-inprogress')
    expect(b?.status).toBe('delivered')
    expect(b?.history.map((h) => h.by)).toEqual([undefined, undefined, undefined, undefined])
  })

  it('rework → delivered 保持原样，不触发补链', async () => {
    await service.createTask(input('rework-path'))
    await service.transitionTask('rework-path', 'accepted')
    await service.transitionTask('rework-path', 'in_progress')
    await service.reportTask('rework-path', { summary: '第一版' })
    await service.reviewTask('rework-path', { verdict: 'rework', note: '改一下' })

    const redone = await service.reportTask('rework-path', { summary: '第二版' })
    expect(redone.status).toBe('delivered')
    expect(redone.history.filter((h) => h.by === 'system')).toHaveLength(0)
    expect(redone.history.at(-1)).toMatchObject({ from: 'rework', to: 'delivered' })
  })

  it('summary 为空 → 400，且不写任何补链', async () => {
    await service.createTask(input('catchup-empty'))
    await expect(service.reportTask('catchup-empty', { summary: '   ' })).rejects.toThrow(
      /summary/,
    )
    const task = await service.getTask('catchup-empty')
    expect(task?.status).toBe('dispatched')
    expect(task?.history).toHaveLength(1)
  })

  it('状态机表未被放宽：dispatched → verified 仍 409，终态无出边', async () => {
    await service.createTask(input('sm-1'))
    await expect(service.transitionTask('sm-1', 'verified')).rejects.toThrow(
      /Illegal task transition/,
    )
    const done = await service.reportTask('sm-1', { summary: '完成' })
    expect(done.status).toBe('delivered')
    // delivered 不能回 dispatched
    await expect(service.transitionTask('sm-1', 'dispatched')).rejects.toThrow(
      /Illegal task transition/,
    )

    await service.createTask(input('sm-2'))
    await service.transitionTask('sm-2', 'accepted')
    await service.transitionTask('sm-2', 'in_progress')
    await service.reportTask('sm-2', { summary: '完成' })
    await service.reviewTask('sm-2', { verdict: 'pass' })
    // verified 是终态：无任何出边
    for (const to of [
      'accepted',
      'in_progress',
      'delivered',
      'rework',
      'failed',
      'cancelled',
    ] as const) {
      await expect(service.transitionTask('sm-2', to)).rejects.toThrow(/Illegal task transition/)
    }
  })

  it('补推进结果可被重放（重启后 history 与 by 标记不丢）', async () => {
    await service.createTask(input('catchup-replay'))
    await service.reportTask('catchup-replay', { summary: '完成' })

    const fresh = new CollabTaskService()
    try {
      const replayed = await fresh.getTask('catchup-replay')
      expect(replayed?.status).toBe('delivered')
      expect(replayed?.history.map((h) => h.to)).toEqual([
        'dispatched',
        'accepted',
        'in_progress',
        'delivered',
      ])
      expect(replayed?.history.filter((h) => h.by === 'system')).toHaveLength(2)
    } finally {
      fresh.resetForTests()
    }
  })

  // ── v1.7.0：压实时机——压实必须发生在「内存已应用本次变更」之后 ─────────
  //
  // 旧实现把压实放在 appendEvents 里，而那一刻调用方还没改内存
  // （transitionTask 先 appendEvent 成功、再赋值 task.status），于是快照写的是
  // **变更前**的状态，刚追加的那一行又被快照覆盖掉 → 重启后状态回退。
  // 修复：appendEvents 只登记 pendingCompaction，由临界区末尾（内存已更新）
  // 统一 flush。

  /** 让下一次追加正好跨过压实阈值 */
  const armCompaction = (projectDir: string): void => {
    ;(service as unknown as { lineCount: Map<string, number> }).lineCount.set(projectDir, 1000)
  }

  it('压实发生在内存更新之后：dispatched→accepted 不回退', async () => {
    const created = await service.createTask(input('lag-basic'))
    armCompaction(created.projectDir)

    await service.transitionTask('lag-basic', 'accepted')

    // 磁盘上应该是**本次变更后**的快照（旧行为下这里是 dispatched）
    const dir = path.join(tmpDir, 'cc-heihei', 'tasks')
    const files = await fs.readdir(dir)
    const lines = (await fs.readFile(path.join(dir, files[0]!), 'utf-8'))
      .split('\n')
      .filter((l) => l.trim())
    expect(lines).toHaveLength(1) // 已被压实成快照
    expect(JSON.parse(lines[0]!).task.status).toBe('accepted')

    const fresh = new CollabTaskService()
    try {
      expect((await fresh.getTask('lag-basic'))?.status).toBe('accepted')
    } finally {
      fresh.resetForTests()
    }
  })

  it('**delivered 不回退**：汇报恰好触发压实，重启后仍是 delivered 且汇报全文在', async () => {
    const created = await service.createTask(input('lag-delivered'))
    await service.transitionTask('lag-delivered', 'accepted')
    await service.transitionTask('lag-delivered', 'in_progress')
    // 让「汇报」这一次写入正好触发压实——旧行为会把 in_progress 写成快照，
    // 汇报记录看起来像没发生。
    armCompaction(created.projectDir)

    await service.reportTask('lag-delivered', {
      summary: '已完成，证据见附',
      deliverables: ['/tmp/a.ts'],
    })

    const fresh = new CollabTaskService()
    try {
      const replayed = await fresh.getTask('lag-delivered')
      expect(replayed?.status).toBe('delivered')
      expect(replayed?.report).toBe('已完成，证据见附')
      expect(replayed?.deliverables).toEqual(['/tmp/a.ts'])
    } finally {
      fresh.resetForTests()
    }
  })

  it('**verified 不回退**：验收恰好触发压实，重启后仍是 verified 且结论在', async () => {
    const created = await service.createTask(input('lag-verified'))
    await service.transitionTask('lag-verified', 'accepted')
    await service.transitionTask('lag-verified', 'in_progress')
    await service.reportTask('lag-verified', { summary: '完成' })
    armCompaction(created.projectDir)

    await service.reviewTask('lag-verified', { verdict: 'pass' })

    const fresh = new CollabTaskService()
    try {
      const replayed = await fresh.getTask('lag-verified')
      expect(replayed?.status).toBe('verified')
      expect(replayed?.verdict).toBe('pass')
    } finally {
      fresh.resetForTests()
    }
  })

  it('压实失败时重放仍得到正确状态（磁盘保持日志形态，追加行还在）', async () => {
    const created = await service.createTask(input('lag-fail'))
    armCompaction(created.projectDir)

    const fsPromises = await import('node:fs/promises')
    const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(() => {
      const error = new Error('locked by indexer') as NodeJS.ErrnoException
      error.code = 'EPERM'
      return Promise.reject(error)
    })
    try {
      await service.transitionTask('lag-fail', 'accepted')
    } finally {
      renameSpy.mockRestore()
    }

    // 压实没成 → 文件仍是追加日志（两行：created + status），重放照样正确
    const dir = path.join(tmpDir, 'cc-heihei', 'tasks')
    const files = await fs.readdir(dir)
    const lines = (await fs.readFile(path.join(dir, files[0]!), 'utf-8'))
      .split('\n')
      .filter((l) => l.trim())
    expect(lines).toHaveLength(2)

    const fresh = new CollabTaskService()
    try {
      expect((await fresh.getTask('lag-fail'))?.status).toBe('accepted')
    } finally {
      fresh.resetForTests()
    }
  })

  it('压实失败后 pending 不堆积：下次成功操作会再次压实，文件不无限增长', async () => {
    const created = await service.createTask(input('lag-retry'))
    armCompaction(created.projectDir)

    const fsPromises = await import('node:fs/promises')
    // 必须在 spyOn **之前**存下真实实现：spyOn 之后模块上的 rename 已被替换，
    // 再 import 拿到的就是 mock 自己，会自递归。
    const realRename = fsPromises.rename
    let fail = true
    const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(
      async (...args: Parameters<typeof realRename>) => {
        if (fail) {
          const error = new Error('locked by indexer') as NodeJS.ErrnoException
          error.code = 'EPERM'
          throw error
        }
        return realRename(...args)
      },
    )

    try {
      await service.transitionTask('lag-retry', 'accepted') // 压实失败
      // 期间又失败若干次，pending 不会因此堆积成多次压实
      await service.transitionTask('lag-retry', 'in_progress')
      fail = false
      await service.transitionTask('lag-retry', 'delivered') // 这次压实成功
    } finally {
      renameSpy.mockRestore()
    }

    const dir = path.join(tmpDir, 'cc-heihei', 'tasks')
    const files = await fs.readdir(dir)
    const lines = (await fs.readFile(path.join(dir, files[0]!), 'utf-8'))
      .split('\n')
      .filter((l) => l.trim())
    expect(lines).toHaveLength(1) // 已压实成快照，没有无限增长
    expect(JSON.parse(lines[0]!).task.status).toBe('delivered')
  })
})

