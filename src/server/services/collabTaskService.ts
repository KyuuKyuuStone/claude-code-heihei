/**
 * CollabTaskService — 协作任务台账（v1.6.0，L3 编排层）
 *
 * 规划真源：D:/xxw_p/cc-heihei-plan/软件规划与底层架构_20260929.md 第三节 3.1。
 *
 * 职责：任务实体 + 状态机 + 持久化 + 事件驱动流转。设计约束（规划「一件事实
 * 一个权威源」）：**任务状态只由本服务写**，前端与 CLI 只读、靠推送更新。
 *
 * 命名：仓库里已有 `taskService.ts`（上游 CLI Task V2 的只读查询，落在
 * `~/.claude/tasks/<listId>/`，状态是 pending/in_progress/completed）。本文件是
 * 协作任务台账，语义与目录都不同，故独立成 `collabTaskService` 以免混淆。
 *
 * 持久化：每项目一个 `~/.claude/cc-heihei/tasks/<项目hash>.jsonl`，**追加写**事件行
 * （created / status），进程启动后 fold 重放成内存态——重启不丢、坏行跳过。
 * 追加行数超过阈值时用 atomicFs（renameWithRetry）原子压实成快照。
 *
 * 幂等：键 = task.id。重复投递（信箱重试、派活重发）命中已有任务直接返回。
 *
 * 流转无人工审批点：投递成功 → dispatched；员工回合开始消费 → accepted →
 * in_progress；员工 Report → delivered；主管 Review → verified / rework。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import { getCcHeiheiDir } from '../../utils/envUtils.js'
import { BACKGROUND_WRITE_RETRY, renameWithRetry } from '../../utils/atomicFs.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { emitCollabPush } from '../../collaboration/collabPushSignals.js'
import { normalizeProjectPath, sameProject } from '../../collaboration/projectPath.js'
import { configureLedgerLock, getLedgerLock, resolveConfiguredLockPath } from './ledgerLock.js'
import { onSessionEvent } from './sessionEvents.js'
import { sessionService } from './sessionService.js'
import { servantService } from './servantService.js'
import { ApiError } from '../middleware/errorHandler.js'

export type TaskStatus =
  | 'dispatched'
  | 'accepted'
  | 'in_progress'
  | 'delivered'
  | 'verified'
  | 'rework'
  | 'failed'
  | 'cancelled'

export type TaskHistoryEntry = {
  at: number
  /** null = 创建（没有前驱态） */
  from: TaskStatus | null
  to: TaskStatus
  note?: string
  /**
   * 流转发起者。缺省 = 正常业务流转（派活/回合推进/员工汇报）。
   * 目前只有 'system'：reportTask 对停在 dispatched 的任务做补推进（裁决四）。
   * 有了它，审计上能区分「正常推进」和「补推进」，不必靠猜 history 的 note。
   */
  by?: 'system'
}

/**
 * 派活人当时的身份快照（v1.6.0 汇报改投用）。
 * - supervisor：派活人是主管，如果它后来卸任，汇报要改投同项目现任主管；
 * - servant：派活人是员工；
 * - other：用户会话等，或旧台账缺该字段的记录（不触发交接修正）。
 */
export type DispatcherRole = 'supervisor' | 'servant' | 'other'

export type Task = {
  id: string
  projectDir: string
  fromSessionId: string
  /** 派活人当时的身份快照；旧台账无此字段，读取时按 'other' 处理 */
  fromRole?: DispatcherRole
  /**
   * 广播关联键（裁决二）：一次广播 = N 条独立单播任务，同值 broadcastId 把它们
   * 串起来，只用于展示与幂等查询，**不参与状态流转**。单播任务无此字段。
   */
  broadcastId?: string
  toSessionId: string
  title: string
  content: string
  status: TaskStatus
  deliverables: string[]
  report?: string
  verdict?: string
  createdAt: number
  updatedAt: number
  history: TaskHistoryEntry[]
}

export const TASK_STATUSES: readonly TaskStatus[] = [
  'dispatched',
  'accepted',
  'in_progress',
  'delivered',
  'verified',
  'rework',
  'failed',
  'cancelled',
]

/**
 * 合法流转表。终态（verified/failed/cancelled）无出边——要继续做就新开任务，
 * 「返工了几次」在台账上于是天然可数。
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  dispatched: ['accepted', 'in_progress', 'failed', 'cancelled'],
  accepted: ['in_progress', 'delivered', 'failed', 'cancelled'],
  in_progress: ['delivered', 'failed', 'cancelled'],
  delivered: ['verified', 'rework', 'failed'],
  rework: ['in_progress', 'delivered', 'failed', 'cancelled'],
  verified: [],
  failed: [],
  cancelled: [],
}

/** 追加行数超过该值时压实为快照（每任务一行 created） */
const COMPACT_THRESHOLD = 400

/**
 * 补推进前两条 history 的固定 note（裁决四第 1 条，措辞固定便于检索）。
 * 见 `reportTask`：员工忙碌期间入队的任务拿不到开工信号，汇报时补齐中间态。
 */
export const REPORT_CATCHUP_NOTE = '汇报时补推进：回合中途入队未收到开工信号'

type CreatedEvent = { type: 'created'; task: Task }
type StatusEvent = {
  type: 'status'
  id: string
  from: TaskStatus
  to: TaskStatus
  at: number
  note?: string
  report?: string
  deliverables?: string[]
  verdict?: string
  /** 见 TaskHistoryEntry.by */
  by?: 'system'
}
type TaskEvent = CreatedEvent | StatusEvent

export type CreateTaskInput = {
  /** 幂等键；缺省时生成 UUID。已存在则直接返回已有任务（不覆盖） */
  id?: string
  projectDir: string
  fromSessionId: string
  /** 派活人身份快照；缺省按 'other'（见 DispatcherRole） */
  fromRole?: DispatcherRole
  /** 广播关联键（裁决二）；单播不传 */
  broadcastId?: string
  toSessionId: string
  title: string
  content: string
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

/** 项目目录 → 文件名 hash（分隔符/大小写归一后哈希；Windows 路径大小写不敏感） */
function projectHash(projectDir: string): string {
  return crypto.createHash('sha1').update(normalizeProjectPath(projectDir)).digest('hex').slice(0, 16)
}

function tasksDir(): string {
  return path.join(getCcHeiheiDir(), 'tasks')
}

function tasksFileFor(projectDir: string): string {
  return path.join(tasksDir(), `${projectHash(projectDir)}.jsonl`)
}

/** 单写者锁文件（A6）：与台账同目录，随配置目录走 */
export const LEDGER_LOCK_FILENAME = 'ledger.lock'

// 模块加载即装配锁（获取仍是懒的：见 ensureLedgerLock）。路径用闭包求值，
// 这样测试切换 CLAUDE_CONFIG_DIR 后能跟上，也不需要在服务端装配层多一处调用。
configureLedgerLock(() => path.join(tasksDir(), LEDGER_LOCK_FILENAME))

function cloneTask(task: Task): Task {
  // v1.7.3 #4：缺失字段一律归一为 []（与 fromRole 的旧数据兼容口径一致）——
  // 否则读路径展开时抛错，会让**整份台账**不可用（一行坏数据毁掉全部）。
  return {
    ...task,
    deliverables: [...(task.deliverables ?? [])],
    history: (task.history ?? []).map((entry) => ({ ...entry })),
  }
}

/**
 * 是否同一项目（用于压实快照筛选与 listTasks 过滤）。
 *
 * v1.6.0 修复（审查 中1，数据丢失级）：复用 projectHash 的归一标准，而不是
 * 只做 path.resolve 的严格串比较。原先两个函数标准分叉——Windows 下同一项目
 * 以 `D:\X` 与 `d:/x` 两种写法创建任务时，projectHash 归一到同一个账本文件，
 * 但压实快照筛选把不匹配的那组判为异项目丢弃，其 created 行随压实消失，
 * 重启 replay 后任务永久丢失。
 *
 * 现已提为共享实现（`src/collaboration/projectPath.ts`），台账、花名册、派活
 * 三处统一引用同一个口径，避免再次分叉。本文件的 `projectHash` 也复用它。
 */
export class CollabTaskService {
  /** taskId → Task（全部已加载项目） */
  private tasks = new Map<string, Task>()
  /** taskId → projectDir（流转时定位落盘文件） */
  private projectOf = new Map<string, string>()
  /** projectDir → 该账本已累计的行数（压实判断） */
  private lineCount = new Map<string, number>()
  private loaded = false
  private loading: Promise<void> | null = null
  private unsubscribeTurn: (() => void) | null = null

  /** 进程内写队列：并发创建/流转串行执行，防事件交错与 lost update */
  private writeQueue: Promise<unknown> = Promise.resolve()
  /**
   * 待压实项目（v1.7.0：压实时机修正）。
   *
   * 追加跨过阈值时只登记，**不在 appendEvents 里当场压实**——那一刻内存还是
   * 「本次变更之前」的状态（调用方要先 append 落盘、成功后才改内存），当场
   * 压实会把旧状态写成快照，导致磁盘回退。改为在临界区末尾（内存已更新）
   * 统一 flush。
   */
  private pendingCompaction = new Set<string>()

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(
      async () => {
        const result = await operation()
        // operation **成功**后才 flush；抛错时不 flush（自然行为，不加特判）。
        // 于是：append 失败、A6 只读 503 → 内存未被改动，也不会有压实。
        await this.flushPendingCompaction()
        return result
      },
      async () => {
        const result = await operation()
        await this.flushPendingCompaction()
        return result
      },
    )
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 懒获取台账写锁（A6）。
   *
   * **获取时机**：首次访问台账时（本方法由 ensureLoaded 调用），不是进程启动
   * 那一刻——等价时机，且不必改服务端装配层。语义是**先写者胜**：两个实例
   * 都空闲时，谁先碰台账谁持有写锁，另一个降级只读。
   *
   * **绝不抛错**：拿不到锁只是降级只读，启动/加载/读取路径全部照常。
   */
  private async ensureLedgerLock(): Promise<void> {
    const lock = getLedgerLock()
    if (!lock || lock.isChecked()) return
    try {
      const result = await lock.tryAcquire()
      if (!result.acquired) {
        logForDiagnosticsNoPII('warn', 'collab_task_ledger_readonly_mode', {
          holderPid: result.holder?.pid,
          holderStartedAt: result.holder?.startedAt,
          lockFile: resolveConfiguredLockPath(),
        })
      }
    } catch (error) {
      // 锁本身出错也不能挡住读写（例如目录权限异常）：按「未启用锁」继续
      logForDiagnosticsNoPII('warn', 'collab_task_ledger_lock_acquire_error', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 写前守卫：非持有者一律 503 LEDGER_READONLY。
   *
   * 只在**真的要落盘**时调用（appendEvents 开头）。这样 `transitionTask` 的
   * 同态幂等返回、`createTask` 命中已有 id、`reviewTask` 重复 pass 这些
   * 不写盘的路径不会被误报 503。
   *
   * 未装配锁时（单测直接 new 服务、或功能未启用）维持旧行为。
   */
  private assertLedgerWritable(operation: string): void {
    const lock = getLedgerLock()
    if (!lock || !lock.isChecked()) return
    if (lock.isAcquired()) return
    const holder = lock.currentHolder()
    logForDiagnosticsNoPII('warn', 'collab_task_ledger_readonly_rejected', {
      operation,
      holderPid: holder?.pid,
      holderStartedAt: holder?.startedAt,
      lockFile: resolveConfiguredLockPath(),
    })
    const holderText = holder ? ` (held by pid ${holder.pid} since ${holder.startedAt})` : ''
    const lockPath = resolveConfiguredLockPath()
    throw new ApiError(
      503,
      `The collaboration ledger is read-only in this instance${holderText}. ` +
        // pid 复用等极端情况下无法自动判定，给出人工恢复方式（管理员可自助）。
        // 实测（2026-10-01）：只删锁文件**不生效**——只读判定结果缓存在本进程
        // 内存里，删掉文件后本实例仍然照旧拒绝写；必须删锁 + **重启本实例**
        // 才会重新判定。文案必须写准，否则管理员会照着做却依然 503。
        (lockPath
          ? `If the other instance is gone, delete ${lockPath} and then RESTART this instance ` +
            `(deleting the file alone has no effect while this instance keeps running). `
          : '') +
        `Close the other instance, or restart this one to take over writing.`,
      'LEDGER_READONLY',
    )
  }

  /** 加载 tasks 目录下全部项目账本（幂等；首次访问时惰性触发） */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      this.tasks.clear()
      this.projectOf.clear()
      this.lineCount.clear()

      await this.ensureLedgerLock()
      const writable = getLedgerLock()?.isAcquired() ?? true

      let files: string[] = []
      try {
        files = await fs.readdir(tasksDir())
      } catch {
        // 目录不存在 = 还没有任何任务
        this.loaded = true
        this.loading = null
        return
      }

      for (const name of files) {
        // 压实 tmp 残留清扫（审查 v1.6.0 低3）：进程若在 writeFile 与 rename
        // 之间退出，会留下 <hash>.jsonl.tmp。它不影响加载（下面的 endsWith
        // 不认它），但会永久占位。启动时顺手清掉。
        // A6：清扫是**写操作**，只读实例不动别人的文件。
        if (name.endsWith('.jsonl.tmp')) {
          if (writable) {
            await fs.rm(path.join(tasksDir(), name), { force: true }).catch(() => {})
          }
          continue
        }
        if (!name.endsWith('.jsonl')) continue
        const filePath = path.join(tasksDir(), name)
        try {
          const raw = await fs.readFile(filePath, 'utf-8')
          const projectDir = this.replay(raw)
          if (projectDir) this.lineCount.set(projectDir, countLines(raw))
        } catch (error) {
          logForDiagnosticsNoPII('warn', 'collab_task_ledger_replay_failed', {
            file: name,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      this.loaded = true
      this.loading = null
    })()
    return this.loading
  }

  /**
   * 重放一个账本（坏行跳过——一行脏数据不该毁掉整个台账）。
   * 返回该账本所属 projectDir（从任务里反查；空账本返回 null）。
   */
  private replay(raw: string): string | null {
    let projectDir: string | null = null
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let event: TaskEvent
      try {
        event = JSON.parse(trimmed) as TaskEvent
      } catch {
        continue
      }
      if (event.type === 'created' && event.task?.id) {
        // v1.7.3 #4：旧版本 / 手写台账可能缺 deliverables、history（fromRole 早有同类
        // 兼容先例）——此处**入口归一**，缺失补 []；补过就记一条诊断（可观测、不静默）。
        const raw = event.task
        const task: Task = {
          ...raw,
          deliverables: raw.deliverables ?? [],
          history: raw.history ?? [],
        }
        if (!raw.deliverables || !raw.history) {
          logForDiagnosticsNoPII('warn', 'collab_task_ledger_row_normalized', {
            taskId: task.id,
            missing: [!raw.deliverables ? 'deliverables' : null, !raw.history ? 'history' : null].filter(Boolean),
          })
        }
        this.tasks.set(task.id, task)
        this.projectOf.set(task.id, task.projectDir)
        projectDir = task.projectDir
      } else if (event.type === 'status' && event.id) {
        const task = this.tasks.get(event.id)
        if (!task) continue
        task.status = event.to
        task.updatedAt = event.at
        task.history.push({
          at: event.at,
          from: event.from,
          to: event.to,
          ...(event.note ? { note: event.note } : {}),
          ...(event.by ? { by: event.by } : {}),
        })
        if (event.report !== undefined) task.report = event.report
        if (event.deliverables !== undefined) task.deliverables = event.deliverables
        if (event.verdict !== undefined) task.verdict = event.verdict
      }
    }
    return projectDir
  }

  /**
   * 建任务（幂等）。id 已存在 → 返回已有任务，不新建、不覆盖。
   * 这是「信箱重复投递/重试天然去重」的落点。
   */
  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.ensureLoaded()
    const projectDir = path.resolve(input.projectDir)
    const id = input.id?.trim() || crypto.randomUUID()

    return this.enqueueWrite(async () => {
      const existing = this.tasks.get(id)
      if (existing) return cloneTask(existing)

      const now = Date.now()
      const task: Task = {
        id,
        projectDir,
        fromSessionId: input.fromSessionId,
        fromRole: input.fromRole ?? 'other',
        ...(input.broadcastId ? { broadcastId: input.broadcastId } : {}),
        toSessionId: input.toSessionId,
        title: input.title,
        content: input.content,
        status: 'dispatched',
        deliverables: [],
        createdAt: now,
        updatedAt: now,
        history: [{ at: now, from: null, to: 'dispatched' }],
      }
      await this.appendEvent(projectDir, { type: 'created', task })
      this.tasks.set(id, task)
      this.projectOf.set(id, projectDir)
      emitCollabPush({ kind: 'task', taskId: id, projectDir, change: 'created', status: 'dispatched' })
      return cloneTask(task)
    })
  }

  /**
   * 派活投递成功后登记台账（HTTP 派活与信箱派活共用一处实现；幂等键 = taskId）。
   * 调用方须先确认「目标是 enabled 员工」——员工→主管的汇报不是任务，不入台账。
   * 失败只记日志并返回 null：投递是主线，台账是记录，不能因台账写不进去就让
   * 主管的派活失败。
   */
  async recordDispatch(input: {
    toSessionId: string
    fromSessionId?: string
    content: string
    title?: string
    taskId?: string
    /** 广播关联键（裁决二）；单播不传。只作关联，不参与状态流转。 */
    broadcastId?: string
    /** 经 resolveReportTarget 判定为「员工汇报」的消息——不记账 */
    isReport?: boolean
  }): Promise<string | null> {
    try {
      // v1.6.0（决策 D）：不再让「员工给主管的汇报」凭空造出一条 dispatched 任务。
      // 原先调用方只判了 target.enabled，而主管条目本身也是 enabled:true，于是员工
      // 发给主管的每条汇报都会生成一个假任务，污染「待接单」显示与台账统计。
      // 现在三个条件任一成立就不记账：① 已被判定为汇报；② 目标是主管。
      if (input.isReport) return null
      const target = await servantService.getServant(input.toSessionId)
      if (!target?.enabled || target.supervisor) return null

      const workDir = await sessionService.getSessionWorkDir(input.toSessionId)
      if (!workDir) return null
      const explicitTitle = input.title?.trim() ?? ''
      const explicitId = input.taskId?.trim() ?? ''
      const broadcastId = input.broadcastId?.trim() ?? ''
      // 派活人身份快照：只有快照是 supervisor 的旧任务才需要在主管卸任后改投
      const dispatcher = input.fromSessionId
        ? await servantService.getServant(input.fromSessionId.trim())
        : null
      const fromRole: DispatcherRole = !input.fromSessionId?.trim()
        ? 'other'
        : dispatcher?.supervisor
          ? 'supervisor'
          : dispatcher
            ? 'servant'
            : 'other'
      const task = await this.createTask({
        ...(explicitId ? { id: explicitId } : {}),
        projectDir: workDir,
        fromSessionId: input.fromSessionId?.trim() || 'unknown',
        fromRole,
        ...(broadcastId ? { broadcastId } : {}),
        toSessionId: input.toSessionId,
        title: explicitTitle || codePointSlice(input.content, 40),
        content: input.content,
      })
      return task.id
    } catch (error) {
      logForDiagnosticsNoPII('warn', 'collab_task_dispatch_record_failed', {
        targetSessionId: input.toSessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * 状态流转；非法流转拒绝（409）。
   * patch 里 report/deliverables/verdict 随事件一并落盘，重放可还原。
   */
  async transitionTask(
    id: string,
    to: TaskStatus,
    patch: { note?: string; report?: string; deliverables?: string[]; verdict?: string } = {},
  ): Promise<Task> {
    await this.ensureLoaded()

    return this.enqueueWrite(async () => {
      const task = this.tasks.get(id)
      if (!task) throw ApiError.notFound(`Task not found: ${id}`)
      const at = Date.now()
      const moved = await this.applyTransitionLocked(task, to, patch, at)
      if (!moved) return cloneTask(task)

      emitCollabPush({ kind: 'task', taskId: id, projectDir: task.projectDir, change: 'status', status: to })
      return cloneTask(task)
    })
  }

  /**
   * 单步流转原语——**必须在 enqueueWrite 临界区内调用**（不再自己入队，
   * 否则嵌套入队会死锁）。
   *
   * 校验沿用 ALLOWED_TRANSITIONS（本版未新增任何边）。返回是否真的发生了流转
   * （from === to 时幂等返回 false，与旧行为一致）。
   */
  private async applyTransitionLocked(
    task: Task,
    to: TaskStatus,
    patch: { note?: string; report?: string; deliverables?: string[]; verdict?: string; by?: 'system' },
    at: number,
  ): Promise<boolean> {
    const from = task.status
    if (from === to) return false
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw ApiError.conflict(`Illegal task transition: ${from} -> ${to} (task ${task.id})`)
    }

    await this.appendEvent(task.projectDir, {
      type: 'status',
      id: task.id,
      from,
      to,
      at,
      ...(patch.note ? { note: patch.note } : {}),
      ...(patch.report !== undefined ? { report: patch.report } : {}),
      ...(patch.deliverables !== undefined ? { deliverables: patch.deliverables } : {}),
      ...(patch.verdict !== undefined ? { verdict: patch.verdict } : {}),
      ...(patch.by ? { by: patch.by } : {}),
    })

    task.status = to
    task.updatedAt = at
    task.history.push({
      at,
      from,
      to,
      ...(patch.note ? { note: patch.note } : {}),
      ...(patch.by ? { by: patch.by } : {}),
    })
    if (patch.report !== undefined) task.report = patch.report
    if (patch.deliverables !== undefined) task.deliverables = patch.deliverables
    if (patch.verdict !== undefined) task.verdict = patch.verdict
    return true
  }

  /**
   * 员工交付：→ delivered（带 summary / deliverables）。
   *
   * 裁决四（采纳方案 A）：任务仍停在 `dispatched` 时，说明它是在员工忙碌期间
   * 入队、且从未收到开工信号（`beginTurn` 幂等短路不发 turn_changed）。此时
   * 员工带着正文汇报本身就是「已接手并完成」的最强证据，故在同一临界区内补写
   * `dispatched→accepted→in_progress→delivered`：
   * - 三条共用同一个 `at`（汇报时刻），不伪造更早时间；
   * - 前两条 note 固定、`by` 记 'system'，审计上与正常推进可区分；
   * - **不给 ALLOWED_TRANSITIONS 加边**：补链只走已有的合法转移，其他路径上的
   *   `dispatched→delivered` 仍然非法；
   * - 三次写入合成一次 appendFile（要么全写要么不写），失败不留下半截状态；
   * - 推送只发最终态 delivered 一次。
   */
  async reportTask(id: string, input: { summary: string; deliverables?: string[] }): Promise<Task> {
    if (!input.summary || !input.summary.trim()) {
      throw ApiError.badRequest('Field "summary" is required')
    }
    await this.ensureLoaded()

    return this.enqueueWrite(async () => {
      const task = this.tasks.get(id)
      if (!task) throw ApiError.notFound(`Task not found: ${id}`)

      const at = Date.now()
      const reportPatch = {
        report: input.summary,
        note: input.summary,
        ...(input.deliverables ? { deliverables: input.deliverables } : {}),
      }

      if (task.status === 'dispatched') {
        await this.catchUpToDeliveredLocked(task, reportPatch, at)
      } else {
        const moved = await this.applyTransitionLocked(task, 'delivered', reportPatch, at)
        if (!moved) return cloneTask(task)
      }

      // 推送只发最终态一次（补链的中间态不推送，避免面板闪烁）
      emitCollabPush({
        kind: 'task',
        taskId: id,
        projectDir: task.projectDir,
        change: 'status',
        status: 'delivered',
      })
      return cloneTask(task)
    })
  }

  /**
   * 补链落盘（**临界区内**，原子）。
   *
   * 先在内存里校验三步全部合法，再一次性写三行事件；任一步不合法就整体抛错，
   * 不写任何一行、也不改内存态。
   */
  private async catchUpToDeliveredLocked(
    task: Task,
    reportPatch: { report: string; note: string; deliverables?: string[] },
    at: number,
  ): Promise<void> {
    const chain: TaskStatus[] = ['accepted', 'in_progress', 'delivered']
    // 校验：三步都必须沿已有合法边推进（不新增状态机边）
    let cursor = task.status
    for (const step of chain) {
      if (!ALLOWED_TRANSITIONS[cursor].includes(step)) {
        throw ApiError.conflict(`Illegal task transition: ${cursor} -> ${step} (task ${task.id})`)
      }
      cursor = step
    }

    const events: StatusEvent[] = []
    let from = task.status
    for (const step of chain) {
      const isFinal = step === 'delivered'
      events.push({
        type: 'status',
        id: task.id,
        from,
        to: step,
        at,
        // 前两步是补推进；最后一步是员工真正的汇报，note 用 summary
        ...(isFinal
          ? { note: reportPatch.note, report: reportPatch.report }
          : { note: REPORT_CATCHUP_NOTE, by: 'system' }),
        ...(isFinal && reportPatch.deliverables ? { deliverables: reportPatch.deliverables } : {}),
      })
      from = step
    }

    // 一次写盘：要么三行都落，要么一行都不落
    await this.appendEvents(task.projectDir, events)

    // 写盘成功后才改内存态
    let prev = task.status
    for (const step of chain) {
      const isFinal = step === 'delivered'
      task.history.push({
        at,
        from: prev,
        to: step,
        ...(isFinal
          ? { note: reportPatch.note }
          : { note: REPORT_CATCHUP_NOTE, by: 'system' as const }),
      })
      prev = step
    }
    task.status = 'delivered'
    task.updatedAt = at
    task.report = reportPatch.report
    if (reportPatch.deliverables !== undefined) task.deliverables = reportPatch.deliverables
  }

  /** 主管验收：pass → verified；rework → rework */
  async reviewTask(id: string, input: { verdict: 'pass' | 'rework'; note?: string }): Promise<Task> {
    if (input.verdict !== 'pass' && input.verdict !== 'rework') {
      throw ApiError.badRequest('Field "verdict" must be "pass" or "rework"')
    }
    return this.transitionTask(id, input.verdict === 'pass' ? 'verified' : 'rework', {
      verdict: input.verdict,
      ...(input.note ? { note: input.note } : {}),
    })
  }

  /**
   * 广播幂等（裁决二第 5 条）：同一 broadcastId 下、派给某目标的已存在任务。
   * 命中即说明该目标上一轮已成功投递并记账，本轮跳过投递与记账。
   */
  async findBroadcastTask(broadcastId: string, toSessionId: string): Promise<Task | null> {
    await this.ensureLoaded()
    for (const task of this.tasks.values()) {
      if (task.broadcastId === broadcastId && task.toSessionId === toSessionId) {
        return cloneTask(task)
      }
    }
    return null
  }

  /**
   * 发送方名下**未结**的派活任务（决策 D 解析顺序第 2 步用）。
   * 未结 = dispatched / accepted / in_progress；按 updatedAt 倒序，
   * 取第一条即「最近一条未结任务」。
   */
  async findOpenTasksForWorker(
    workerSessionId: string,
    filter: { projectDir?: string } = {},
  ): Promise<Task[]> {
    await this.ensureLoaded()
    const OPEN: readonly TaskStatus[] = ['dispatched', 'accepted', 'in_progress']
    return [...this.tasks.values()]
      .filter((task) => task.toSessionId === workerSessionId)
      .filter((task) => OPEN.includes(task.status))
      .filter((task) => (filter.projectDir ? sameProject(task.projectDir, filter.projectDir) : true))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(cloneTask)
  }

  async getTask(id: string): Promise<Task | null> {
    await this.ensureLoaded()
    const task = this.tasks.get(id)
    return task ? cloneTask(task) : null
  }

  async listTasks(filter: { projectDir?: string; status?: TaskStatus } = {}): Promise<Task[]> {
    await this.ensureLoaded()
    return [...this.tasks.values()]
      .filter((task) => (filter.projectDir ? sameProject(task.projectDir, filter.projectDir) : true))
      .filter((task) => (filter.status ? task.status === filter.status : true))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(cloneTask)
  }

  /**
   * 员工回合开始消费 → accepted → in_progress。复用 sessionRegistry 的回合事件
   * （不另造状态源），只对「该员工名下仍处 dispatched/accepted 的任务」生效。
   */
  startTurnSubscription(): void {
    if (this.unsubscribeTurn) return
    this.unsubscribeTurn = onSessionEvent((event) => {
      if (event.type !== 'turn_changed') return
      if (event.turn !== 'turn_in_progress') return
      const sessionId = event.sessionId
      // 订阅回调在 registry 的同步派发栈内执行：这里只排微任务，不在栈内做 IO。
      queueMicrotask(() => {
        void this.advanceOnTurnStart(sessionId).catch((error) => {
          logForDiagnosticsNoPII('warn', 'collab_task_turn_advance_failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      })
    }, { types: ['turn_changed'] })
  }

  stopTurnSubscription(): void {
    this.unsubscribeTurn?.()
    this.unsubscribeTurn = null
  }

  /** 测试隔离：清空内存态、允许重新加载 */
  resetForTests(): void {
    this.stopTurnSubscription()
    this.tasks.clear()
    this.projectOf.clear()
    this.lineCount.clear()
    this.loaded = false
    this.loading = null
    this.writeQueue = Promise.resolve()
    this.pendingCompaction.clear()
  }

  private async advanceOnTurnStart(sessionId: string): Promise<void> {
    await this.ensureLoaded()
    const targets = [...this.tasks.values()].filter(
      (task) =>
        task.toSessionId === sessionId &&
        (task.status === 'dispatched' || task.status === 'accepted'),
    )
    for (const task of targets) {
      if (task.status === 'dispatched') {
        await this.transitionTask(task.id, 'accepted', { note: '员工回合开始消费' })
      }
      await this.transitionTask(task.id, 'in_progress')
    }
  }

  private async appendEvent(projectDir: string, event: TaskEvent): Promise<void> {
    await this.appendEvents(projectDir, [event])
  }

  /**
   * 批量追加（**一次 appendFile 写全部行**）。
   *
   * 补推进（reportTask 的 dispatched→accepted→in_progress→delivered）要求
   * 「要么全部写入、要么一条都不写」：逐条 append 会在中途失败时留下半截状态。
   * 单次 appendFile 让这三行成为一个写操作，失败则一行都没落盘，内存态也不推进。
   */
  private async appendEvents(projectDir: string, events: TaskEvent[]): Promise<void> {
    if (events.length === 0) return
    // A6：只有真要落盘时才拒绝——不写盘的幂等路径（同态流转、createTask 命中
    // 已有 id、重复 pass）不在守卫范围内，不会被误报 503。
    this.assertLedgerWritable('append')
    const filePath = tasksFileFor(projectDir)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf-8')
    this.lineCount.set(projectDir, (this.lineCount.get(projectDir) ?? 0) + events.length)
    // 只登记，不在这里压实——此刻内存还是旧态（见 pendingCompaction 注释）。
    // 临界区末尾（enqueueWrite）会 flush。压实失败时 lineCount 不重置，下次
    // 追加会再次登记，所以不会漏压、文件也不会无限增长。
    if ((this.lineCount.get(projectDir) ?? 0) >= COMPACT_THRESHOLD) {
      this.pendingCompaction.add(projectDir)
    }
  }

  /** 临界区末尾压实：此时 operation 已成功、内存已是本次变更后的状态 */
  private async flushPendingCompaction(): Promise<void> {
    if (this.pendingCompaction.size === 0) return
    const dirs = [...this.pendingCompaction]
    // 先清空再压实：压实失败时靠 lineCount 未重置在下次追加时重新登记，
    // 而不是靠这个集合一直挂着。
    this.pendingCompaction.clear()
    for (const dir of dirs) {
      await this.compactIfNeeded(dir)
    }
  }

  /**
   * 行数超阈值时压实：把内存态整体写成快照（每任务一行 created），
   * 经 atomicFs 的 renameWithRetry 原子替换——Windows 上 Defender 短暂持锁
   * 会让裸 rename 偶发 EPERM/EBUSY。
   *
   * **压实失败不抛**（架构评估 v1.7.0 补充裁决二）：调用方是在 appendEvents
   * 追加**已经落盘之后**才走到这里，此时再把异常抛上去，用户会看到写入失败，
   * 但数据其实已经在文件里了——重试还会撞 409（幂等键已存在）。压实只是把
   * 追加日志折叠成快照的优化，不是数据本身，所以这里只记诊断并吞掉异常；
   * `lineCount` 不重置，下次追加时会再试一次。
   *
   * 退避用后台档位（约 1.9s）：没有人在等这个请求的压实结果。
   */
  private async compactIfNeeded(projectDir: string): Promise<void> {
    if ((this.lineCount.get(projectDir) ?? 0) < COMPACT_THRESHOLD) return
    const filePath = tasksFileFor(projectDir)
    const tasks = [...this.tasks.values()].filter((task) => sameProject(task.projectDir, projectDir))
    const snapshot = tasks.map((task) => JSON.stringify({ type: 'created', task })).join('\n')
    const tmpPath = `${filePath}.tmp`
    try {
      // 第二道防线（审查 v1.6.0 低3）：加载期清扫只覆盖启动时点，这里再清一次，
      // 防止上一次压实异常退出留下的同名 tmp 被误认作本次结果。
      await fs.rm(tmpPath, { force: true }).catch(() => {})
      await fs.writeFile(tmpPath, snapshot ? `${snapshot}\n` : '', 'utf-8')
      await renameWithRetry(fs, tmpPath, filePath, BACKGROUND_WRITE_RETRY)
      this.lineCount.set(projectDir, tasks.length)
    } catch (error) {
      logForDiagnosticsNoPII('warn', 'collab_task_compact_failed', {
        projectDir,
        error: error instanceof Error ? error.message : String(error),
      })
      // tmp 留着也无害：下次压实的 rm(force) 会清掉
      await fs.rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}

/**
 * 按**码点**截断（审查 v1.6.0 低4）。
 * String.prototype.slice 按 UTF-16 码元切，正好切在代理对中间时会产出孤立
 * 代理（半个 emoji），下游 JSON/前端渲染都可能出问题；Array.from 按码点切。
 */
export function codePointSlice(text: string, max: number): string {
  const points = Array.from(text)
  return points.length <= max ? text : points.slice(0, max).join('')
}

/** 计非空行数（与 replay 的行计数口径一致） */
function countLines(raw: string): number {
  let count = 0
  for (const line of raw.split('\n')) {
    if (line.trim()) count++
  }
  return count
}

export const collabTaskService = new CollabTaskService()
