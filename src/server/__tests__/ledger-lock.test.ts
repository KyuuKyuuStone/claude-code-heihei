import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CollabTaskService } from '../services/collabTaskService.js'
import {
  LedgerLock,
  configureLedgerLock,
  setLedgerLockOverrideForTests,
} from '../services/ledgerLock.js'

/**
 * A6：台账单写者锁（v1.7.0，数据丢失级）。
 *
 * 台账是 JSONL，压实会把整个文件重写成快照。两个实例并存时，B 的快照重写会
 * 把 A 期间追加的行整段抹掉。方案：单写者 pid 锁——非持有者只读，写操作 503。
 *
 * 这里用**两个独立的 LedgerLock 对象**模拟两个进程：它们的 pid 相同（同一测试
 * 进程）且存活，但 instanceId 不同——所以第二个会被正确判为「他人持有」。
 * 这正是 instanceId 参与判定的意义所在。
 */

const PROJECT = 'D:/xxw-p/ledger-lock-proj'

describe('A6 台账单写者锁', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let lockPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-lock-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    lockPath = path.join(tmpDir, 'cc-heihei', 'tasks', 'ledger.lock')
    // 每个用例一把全新的锁实例，避免 checked/持有状态跨用例残留
    setLedgerLockOverrideForTests(new LedgerLock(() => lockPath))
  })

  afterEach(async () => {
    // 还原成模块装配时的那把「真实」锁，避免覆盖泄漏到其它测试文件
    configureLedgerLock(() => path.join(tmpDir, 'cc-heihei', 'tasks', 'ledger.lock'))
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const taskInput = (id: string) => ({
    id,
    projectDir: PROJECT,
    fromSessionId: 'supervisor-1',
    toSessionId: 'worker-1',
    title: '任务',
    content: '正文',
  })

  // ── LedgerLock 本身 ───────────────────────────────────────────────────

  it('第一个实例拿到锁，第二个（同 pid、不同 instanceId）判为他人持有', async () => {
    const first = new LedgerLock(() => lockPath)
    const second = new LedgerLock(() => lockPath)

    const a = await first.tryAcquire()
    expect(a.acquired).toBe(true)

    const b = await second.tryAcquire()
    expect(b.acquired).toBe(false)
    expect(b.holder?.instanceId).toBe(first.instanceId)
    expect(b.holder?.pid).toBe(process.pid)
  })

  it('锁文件格式含 pid / startedAt / instanceId', async () => {
    const lock = new LedgerLock(() => lockPath)
    await lock.tryAcquire()

    const raw = JSON.parse(await fs.readFile(lockPath, 'utf-8')) as Record<string, unknown>
    expect(raw.pid).toBe(process.pid)
    expect(typeof raw.startedAt).toBe('string')
    expect(typeof raw.instanceId).toBe('string')
  })

  it('陈旧锁（持有者 pid 已不存在）→ 新实例接管', async () => {
    // 造一个「已死进程」留下的锁：pid 用一个几乎不可能存在的大值
    await fs.mkdir(path.dirname(lockPath), { recursive: true })
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999_999, startedAt: '2000-01-01T00:00:00.000Z', instanceId: 'dead' }),
      'utf-8',
    )

    const lock = new LedgerLock(() => lockPath)
    const result = await lock.tryAcquire()
    expect(result.acquired).toBe(true)
    const raw = JSON.parse(await fs.readFile(lockPath, 'utf-8')) as Record<string, unknown>
    expect(raw.instanceId).toBe(lock.instanceId)
  })

  it('坏锁文件（截断 JSON）→ 按陈旧处理并接管', async () => {
    await fs.mkdir(path.dirname(lockPath), { recursive: true })
    await fs.writeFile(lockPath, '{ "pid": 123', 'utf-8')

    const lock = new LedgerLock(() => lockPath)
    expect((await lock.tryAcquire()).acquired).toBe(true)
  })

  it('正常释放：文件消失，下一个实例可获取', async () => {
    const first = new LedgerLock(() => lockPath)
    await first.tryAcquire()
    first.release()

    await expect(fs.access(lockPath)).rejects.toThrow()

    const second = new LedgerLock(() => lockPath)
    expect((await second.tryAcquire()).acquired).toBe(true)
  })

  it('重复获取是幂等的（自己已持有 → 仍返回 acquired）', async () => {
    const lock = new LedgerLock(() => lockPath)
    await lock.tryAcquire()
    const again = await lock.tryAcquire()
    expect(again.acquired).toBe(true)
  })

  // ── 与台账服务的集成 ──────────────────────────────────────────────────

  /** 模拟「另一个进程」先拿到锁，并把本服务降级为只读 */
  async function makeReadonlyService(): Promise<CollabTaskService> {
    const otherProcess = new LedgerLock(() => lockPath)
    await otherProcess.tryAcquire() // 以不同的 instanceId 占住锁
    const mine = new LedgerLock(() => lockPath)
    setLedgerLockOverrideForTests(mine)
    const service = new CollabTaskService()
    await service.ensureLoaded()
    return service
  }

  it('只读实例：读正常，写返回 503 LEDGER_READONLY', async () => {
    const service = await makeReadonlyService()

    // 读不受限
    expect(await service.listTasks({ projectDir: PROJECT })).toEqual([])

    // 写被拒
    let caught: unknown = null
    try {
      await service.createTask(taskInput('write-attempt'))
    } catch (error) {
      caught = error
    }
    expect((caught as { statusCode?: number })?.statusCode).toBe(503)
    expect((caught as { code?: string })?.code).toBe('LEDGER_READONLY')
    // 说明里带人工恢复方式（pid 复用等极端情况下可自助）
    const message = (caught as Error).message
    expect(message).toContain('ledger.lock')
    // 文案必须与**实测**一致（2026-10-01）：只删锁文件**不生效**——只读判定
    // 缓存在本实例内存里；必须「删锁 + 重启本实例」才会重新判定。旧文案写的是
    // 「delete ... and retry」，照着做依然 503。
    expect(message).toContain('RESTART')
    expect(message).not.toContain('and retry')
  })

  it('只读实例被拒后**内存逐字段一致**（写失败绝不动内存）', async () => {
    // 先由持有者建好一个任务并推进到 accepted
    const seeder = new CollabTaskService()
    await seeder.createTask(taskInput('frozen'))
    await seeder.transitionTask('frozen', 'accepted')

    // 再把自己降级为只读实例（锁已被 seeder 以别的 instanceId 持有）
    const service = await makeReadonlyService()
    const before = await service.getTask('frozen')
    expect(before?.status).toBe('accepted')

    // 尝试写 → 503（注意 LEDGER_READONLY 是 error.code，不在 message 里，
    // 所以不能用 toThrow 匹配）
    let caught: unknown = null
    try {
      await service.transitionTask('frozen', 'in_progress')
    } catch (error) {
      caught = error
    }
    expect((caught as { statusCode?: number })?.statusCode).toBe(503)
    expect((caught as { code?: string })?.code).toBe('LEDGER_READONLY')

    // 内存里该任务逐字段与尝试前完全一致（不能出现「拒绝了但内存已改」）
    expect(await service.getTask('frozen')).toEqual(before)
    // 磁盘也没变：重放仍是 accepted
    const revived = new CollabTaskService()
    expect((await revived.getTask('frozen'))?.status).toBe('accepted')
  })

  it('**不丢数据**：只读实例写入被拒后，持有者已写入的行一条不少', async () => {
    // A（本进程持有者）先写两条
    const owner = new CollabTaskService()
    await owner.createTask(taskInput('owner-1'))
    await owner.createTask(taskInput('owner-2'))
    const ledgerFile = path.join(tmpDir, 'cc-heihei', 'tasks')

    const files = (await fs.readdir(ledgerFile)).filter((n) => n.endsWith('.jsonl'))
    expect(files).toHaveLength(1)
    const ledgerPath = path.join(ledgerFile, files[0]!)

    const before = await fs.readFile(ledgerPath, 'utf-8')
    const beforeLines = before.trim().split('\n').length
    expect(before).toContain('owner-1')
    expect(before).toContain('owner-2')

    // B：只读实例尝试写 → 被拒
    const readonly = await makeReadonlyService()
    await expect(readonly.createTask(taskInput('intruder'))).rejects.toThrow(/read-only/)

    // 磁盘逐字节不变：没有新行、没有丢行
    const after = await fs.readFile(ledgerPath, 'utf-8')
    expect(after).toBe(before)
    expect(after.trim().split('\n').length).toBe(beforeLines)
    expect(after).not.toContain('intruder')
  })

  it('只读实例也不能压实（压实是写操作，同样被拒）', async () => {
    const owner = new CollabTaskService()
    await owner.createTask(taskInput('compact-owner'))

    const readonly = await makeReadonlyService()
    await expect(readonly.createTask(taskInput('compact-intruder'))).rejects.toThrow(
      /read-only/,
    )
    // 顺带确认只读实例的读路径能看到持有者写的数据（同一账本）
    const tasks = await readonly.listTasks({ projectDir: PROJECT })
    expect(tasks.map((t) => t.id)).toContain('compact-owner')
  })

  // ── 不写盘的幂等路径不应误报 503（主管第 3 条） ────────────────────────

  it('三种不写盘路径不返回 503：同态流转 / createTask 命中已有 id / 重复 pass', async () => {
    // 先用持有者把数据准备好
    const owner = new CollabTaskService()
    await owner.createTask(taskInput('idem-1'))
    await owner.createTask(taskInput('idem-2'))
    await owner.transitionTask('idem-2', 'accepted')
    await owner.transitionTask('idem-2', 'in_progress')
    await owner.reportTask('idem-2', { summary: '完成' })
    await owner.reviewTask('idem-2', { verdict: 'pass' })

    const readonly = await makeReadonlyService()

    // ① 同态流转（from === to）→ 幂等返回，不落盘，不 503
    const same = await readonly.transitionTask('idem-2', 'verified')
    expect(same.status).toBe('verified')

    // ② createTask 命中已有 id → 直接返回已有任务，不覆盖、不落盘
    const dup = await readonly.createTask(taskInput('idem-1'))
    expect(dup.id).toBe('idem-1')

    // ③ 重复 pass（verified → verified）→ 幂等返回，不 503
    const again = await readonly.reviewTask('idem-2', { verdict: 'pass' })
    expect(again.status).toBe('verified')
  })

  // ── 单实例路径与改动前完全一致 ────────────────────────────────────────

  it('单实例完整业务流：派活→回合推进→汇报→验收，全程无 503', async () => {
    const service = new CollabTaskService()
    await service.createTask(taskInput('flow-1'))
    await service.transitionTask('flow-1', 'accepted')
    await service.transitionTask('flow-1', 'in_progress')
    await service.reportTask('flow-1', { summary: '做完了', deliverables: ['a.ts'] })
    const verified = await service.reviewTask('flow-1', { verdict: 'pass' })

    expect(verified.status).toBe('verified')
    expect(verified.report).toBe('做完了')
    // 持锁实例确实留下了锁文件（读内容比 access 更强的断言）
    const raw = await fs.readFile(lockPath, 'utf-8')
    expect(raw).toContain(String(process.pid))
    expect(JSON.parse(raw).pid).toBe(process.pid)
  })

  it('未装配锁时（getLedgerLock 为 null）维持旧行为，不误伤', async () => {
    setLedgerLockOverrideForTests(null)
    const service = new CollabTaskService()
    const task = await service.createTask(taskInput('nolock-1'))
    expect(task.status).toBe('dispatched')
  })
})
