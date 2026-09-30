import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CollabTaskService, codePointSlice } from '../services/collabTaskService.js'
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

