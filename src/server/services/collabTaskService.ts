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
import { renameWithRetry } from '../../utils/atomicFs.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { emitCollabPush } from '../../collaboration/collabPushSignals.js'
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
  const normalized = path.resolve(projectDir).replace(/\\/g, '/').toLowerCase()
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16)
}

function tasksDir(): string {
  return path.join(getCcHeiheiDir(), 'tasks')
}

function tasksFileFor(projectDir: string): string {
  return path.join(tasksDir(), `${projectHash(projectDir)}.jsonl`)
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    deliverables: [...task.deliverables],
    history: task.history.map((entry) => ({ ...entry })),
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
 */
function sameProject(a: string, b: string): boolean {
  return projectHash(a) === projectHash(b)
}

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

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation)
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 加载 tasks 目录下全部项目账本（幂等；首次访问时惰性触发） */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      this.tasks.clear()
      this.projectOf.clear()
      this.lineCount.clear()

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
        if (name.endsWith('.jsonl.tmp')) {
          await fs.rm(path.join(tasksDir(), name), { force: true }).catch(() => {})
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
        const task = event.task
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
      const from = task.status
      if (from === to) return cloneTask(task)
      if (!ALLOWED_TRANSITIONS[from].includes(to)) {
        throw ApiError.conflict(`Illegal task transition: ${from} -> ${to} (task ${id})`)
      }

      const at = Date.now()
      await this.appendEvent(task.projectDir, {
        type: 'status',
        id,
        from,
        to,
        at,
        ...(patch.note ? { note: patch.note } : {}),
        ...(patch.report !== undefined ? { report: patch.report } : {}),
        ...(patch.deliverables !== undefined ? { deliverables: patch.deliverables } : {}),
        ...(patch.verdict !== undefined ? { verdict: patch.verdict } : {}),
      })

      task.status = to
      task.updatedAt = at
      task.history.push({ at, from, to, ...(patch.note ? { note: patch.note } : {}) })
      if (patch.report !== undefined) task.report = patch.report
      if (patch.deliverables !== undefined) task.deliverables = patch.deliverables
      if (patch.verdict !== undefined) task.verdict = patch.verdict

      emitCollabPush({ kind: 'task', taskId: id, projectDir: task.projectDir, change: 'status', status: to })
      return cloneTask(task)
    })
  }

  /** 员工交付：→ delivered（带 summary / deliverables） */
  async reportTask(id: string, input: { summary: string; deliverables?: string[] }): Promise<Task> {
    if (!input.summary || !input.summary.trim()) {
      throw ApiError.badRequest('Field "summary" is required')
    }
    return this.transitionTask(id, 'delivered', {
      report: input.summary,
      note: input.summary,
      ...(input.deliverables ? { deliverables: input.deliverables } : {}),
    })
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
    const filePath = tasksFileFor(projectDir)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf-8')
    this.lineCount.set(projectDir, (this.lineCount.get(projectDir) ?? 0) + 1)
    await this.compactIfNeeded(projectDir)
  }

  /**
   * 行数超阈值时压实：把内存态整体写成快照（每任务一行 created），
   * 经 atomicFs 的 renameWithRetry 原子替换——Windows 上 Defender 短暂持锁
   * 会让裸 rename 偶发 EPERM/EBUSY。
   */
  private async compactIfNeeded(projectDir: string): Promise<void> {
    if ((this.lineCount.get(projectDir) ?? 0) < COMPACT_THRESHOLD) return
    const filePath = tasksFileFor(projectDir)
    const tasks = [...this.tasks.values()].filter((task) => sameProject(task.projectDir, projectDir))
    const snapshot = tasks.map((task) => JSON.stringify({ type: 'created', task })).join('\n')
    const tmpPath = `${filePath}.tmp`
    // 第二道防线（审查 v1.6.0 低3）：加载期清扫只覆盖启动时点，这里再清一次，
    // 防止上一次压实异常退出留下的同名 tmp 被误认作本次结果。
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    await fs.writeFile(tmpPath, snapshot ? `${snapshot}\n` : '', 'utf-8')
    await renameWithRetry(fs, tmpPath, filePath)
    this.lineCount.set(projectDir, tasks.length)
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
