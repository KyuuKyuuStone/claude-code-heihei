/**
 * DispatchMailboxService — 文件信箱：会话间消息的文件降级通道
 *
 * 会话的 Bash 不可用时（典型：Windows 缺 Git Bash，所有命令返回占位符），
 * curl 派活/汇报通道整体瘫痪。该服务监听各协作项目工作目录下的
 * `.heihei/dispatch/*.json`：会话用 Write 工具投递
 * `{targetSessionId, content, fromSessionId?}`，服务端代为投递
 * （等价 POST /api/session-messages，含同样的项目隔离校验）后删除文件；
 * 投递失败把文件改名 `*.failed` 并写 `*.error.txt` 说明原因，供会话 Read 排查。
 * 投递成功删除原文件后同目录回写 `<原文件名>.ack` 回执（v1.4.0 阶段1-A ③，
 * 内容协议见 handleMailboxFile 内注释），员工可 Read 确认送达。
 *
 * 监听范围 = 存在 enabled 员工的项目工作目录（员工登记/移除时经 sync() 收敛）。
 * 主管与员工同项目才能合法派活，所以监听员工工作目录即覆盖全部合法派活/汇报。
 */

import { watch, type FSWatcher } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { COLLAB_MAILBOX_DIR } from '../../collaboration/dispatchProtocol.js'
import { diagnosticsService } from './diagnosticsService.js'
import { forgetReceipt, recordDelivery } from './dispatchReceiptService.js'
import { servantService, type ServantInfo } from './servantService.js'
import { sessionService } from './sessionService.js'
import { sessionMessenger } from './sessionMessenger.js'
import { collabTaskService } from './collabTaskService.js'
import { appendReportFooter, resolveReportTarget } from './reportTargetResolver.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'

export type DispatchPayload = {
  targetSessionId: string
  content: string
  fromSessionId?: string
  /** v1.6.0：派活可选带标题与幂等键（不带给自动建任务） */
  title?: string
  taskId?: string
  /** 广播请求标记（裁决二第 7 条）：信箱本版不支持广播，收到即明确拒绝 */
  broadcast?: boolean
  /**
   * CLI 契约 §五：员工汇报的降级通道。文件里带这段时，信箱服务先调 reportTask
   * 把台账推到 delivered，再投递消息（顺序与 HTTP 两步一致）。旧服务端不认识
   * 这个字段会直接忽略，只投递消息——向后兼容。
   */
  report?: {
    taskId: string
    summary: string
    deliverables?: string[]
  }
}

export type MailboxDeliveryResult =
  | { ok: true }
  | { ok: false; reason: string }

const PROCESS_DELAY_MS = 200
/** Write 工具写大文件非原子：读到半截 JSON 时按此延迟重试 */
const READ_RETRY_DELAYS_MS = [100, 250, 400]
const MAX_FILE_BYTES = 256 * 1024
const MAX_CONTENT_LENGTH = 64 * 1024
/**
 * 周期兜底扫描间隔（30–60s 区间取中值）。watcher 未建立/事后失效/漏事件
 * 三类静默失效的最后防线：最坏一个周期内文件仍会被消费（2026-09-14 实战）。
 */
const RESCAN_INTERVAL_MS = 45_000

type DebouncedFile = { timer: ReturnType<typeof setTimeout>; firstAt: number }

export function isDispatchPayloadName(name: string): boolean {
  return (
    name.endsWith('.json') &&
    !name.endsWith('.failed.json') &&
    !name.startsWith('.') &&
    !name.includes('/')
  )
}

/** 信箱目录位于 <项目>/.heihei/dispatch：由此反推项目根（层级跟随 COLLAB_MAILBOX_DIR） */
function projectRootFromMailboxDir(mailboxDir: string): string {
  const depth = COLLAB_MAILBOX_DIR.split('/').length
  return path.resolve(mailboxDir, ...Array.from({ length: depth }, () => '..'))
}

function parsePayload(raw: string): DispatchPayload {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const targetSessionId = typeof parsed.targetSessionId === 'string' ? parsed.targetSessionId.trim() : ''
  const content = typeof parsed.content === 'string' ? parsed.content : ''
  const fromSessionId = typeof parsed.fromSessionId === 'string' ? parsed.fromSessionId.trim() : ''
  // CLI 契约：taskId 由客户端预生成，HTTP 与信箱两通道同 ID、重试幂等。
  // 信箱载荷里的 taskId 必须原样透传给 recordDispatch，否则补投会另建一条任务，
  // 页脚 ID 与台账对不上、重发还会重复建账。title 同理，丢了会写空标题。
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
  const taskId = typeof parsed.taskId === 'string' ? parsed.taskId.trim() : ''
  if (!targetSessionId) throw new Error('Field "targetSessionId" is required')
  if (!content.trim()) throw new Error('Field "content" is required')
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Field "content" exceeds ${MAX_CONTENT_LENGTH} characters`)
  }
  const report = parseReportField(parsed.report)
  return {
    targetSessionId,
    content,
    ...(fromSessionId ? { fromSessionId } : {}),
    ...(title ? { title } : {}),
    ...(taskId ? { taskId } : {}),
    ...(report ? { report } : {}),
  }
}

/** 解析可选 report 字段（契约 §五）；结构不完整时按「没带」处理，不影响投递 */
function parseReportField(raw: unknown): DispatchPayload['report'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const taskId = typeof obj.taskId === 'string' ? obj.taskId.trim() : ''
  if (!taskId) return undefined
  const summary = typeof obj.summary === 'string' ? obj.summary : ''
  const deliverables = Array.isArray(obj.deliverables)
    ? obj.deliverables.filter((item): item is string => typeof item === 'string')
    : undefined
  return { taskId, summary, ...(deliverables ? { deliverables } : {}) }
}

export class DispatchMailboxService {
  private serverPort = 0
  private watchers = new Map<string, FSWatcher>()
  private debounced = new Map<string, DebouncedFile>()
  private inFlight = new Set<string>()
  private syncing: Promise<void> | null = null
  private stopped = true
  private rescanTimer: ReturnType<typeof setInterval> | null = null
  private rescanning = false

  private readonly deps: {
    deliver: (targetSessionId: string, content: string, serverHost: string) => Promise<boolean>
    listServants: (options: { includeAll: true }) => Promise<ServantInfo[]>
    getServant: (sessionId: string) => Promise<{ enabled: boolean } | null>
    getSessionWorkDir: (sessionId: string) => Promise<string | null | undefined>
  }

  /** 全部依赖可注入（测试用）；缺省使用真实协作服务 */
  constructor(deps: Partial<DispatchMailboxService['deps']> = {}) {
    this.deps = {
      deliver: deps.deliver ?? ((target, content, host) => sessionMessenger.deliver(target, content, host)),
      listServants: deps.listServants ?? ((options) => servantService.listServants(options)),
      getServant: deps.getServant ?? ((sessionId) => servantService.getServant(sessionId)),
      getSessionWorkDir:
        deps.getSessionWorkDir ?? ((sessionId) => sessionService.getSessionWorkDir(sessionId)),
    }
  }

  /** 服务端开始监听后调用（Bun.serve 拿到真实端口之后） */
  start(serverPort: number): void {
    this.serverPort = serverPort
    this.stopped = false
    void this.sync()
    this.startPeriodicRescan()
  }

  stop(): void {
    this.stopped = true
    this.stopPeriodicRescan()
    for (const timer of this.debounced.values()) clearTimeout(timer.timer)
    this.debounced.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }

  /** 员工花名册变化后调用：收敛监听目录（新增/移除） */
  sync(): Promise<void> {
    this.syncing ??= this.syncNow().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async syncNow(): Promise<void> {
    if (this.stopped) return
    const desired = new Set<string>()
    try {
      const servants = await this.deps.listServants({ includeAll: true })
      for (const servant of servants) {
        if (!servant.enabled || !servant.workDir) continue
        desired.add(path.resolve(servant.workDir))
      }
    } catch (error) {
      console.warn(
        `[DispatchMailbox] Failed to list servants: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    for (const [dir, watcher] of this.watchers) {
      if (!desired.has(dir)) {
        watcher.close()
        this.watchers.delete(dir)
      }
    }
    await Promise.all([...desired].map((dir) => this.openWatcher(dir)))
  }

  private mailboxDir(workDir: string): string {
    return path.join(workDir, COLLAB_MAILBOX_DIR)
  }

  /**
   * 周期兜底扫描（2026-09-14 实战：watcher 静默失效导致信箱 40s+ 无响应）。
   * sync() 幂等——openWatcher 会重建缺失/失效的 watcher（含首扫），顺带
   * 覆盖 sync() 首次失败的重试；再对已监听目录全量补扫，兜住漏事件。
   * scheduleProcess 自带 debounce + inFlight 去重，重复扫描天然幂等。
   */
  private startPeriodicRescan(): void {
    this.stopPeriodicRescan()
    this.rescanTimer = setInterval(() => void this.rescanAll(), RESCAN_INTERVAL_MS)
    // 不阻塞进程退出
    this.rescanTimer.unref?.()
  }

  private stopPeriodicRescan(): void {
    if (this.rescanTimer !== null) {
      clearInterval(this.rescanTimer)
      this.rescanTimer = null
    }
  }

  /** 周期任务体。测试直接调用以避免真实等待 setInterval。内部全捕获，永不抛错。 */
  private async rescanAll(): Promise<void> {
    if (this.stopped || this.rescanning) return
    this.rescanning = true
    try {
      await this.sync().catch((error) => {
        console.warn(
          `[DispatchMailbox] Periodic rescan sync failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      const dirs = [...this.watchers.keys()].map((workDir) => this.mailboxDir(workDir))
      await Promise.all(dirs.map((dir) => this.scanExisting(dir)))
    } finally {
      this.rescanning = false
    }
  }

  private async openWatcher(workDir: string): Promise<void> {
    if (this.watchers.has(workDir)) return
    const dir = this.mailboxDir(workDir)
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch (error) {
      console.warn(
        `[DispatchMailbox] Failed to create ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (this.stopped) return

    // mkdir 与 watch 之间的窗口里已有文件也要被消费
    await this.scanExisting(dir)
    if (this.stopped) return
    let watcher: FSWatcher
    try {
      watcher = watch(dir, (_event, fileName) => {
        const name = typeof fileName === 'string' ? fileName : null
        if (!name || !isDispatchPayloadName(name)) return
        this.scheduleProcess(dir, name)
      })
    } catch (error) {
      // 构造期失败（目录被删瞬间/句柄耗尽）：warn 后放弃，周期任务下轮重建
      console.warn(
        `[DispatchMailbox] Failed to watch ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    watcher.on('error', (error) => {
      console.warn(
        `[DispatchMailbox] Watcher error for ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (this.stopped) {
      watcher.close()
      return
    }
    this.watchers.set(workDir, watcher)
    console.log(`[DispatchMailbox] Watching ${dir} (total: ${this.watchers.size})`)
  }

  private async scanExisting(dir: string): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (isDispatchPayloadName(name)) this.scheduleProcess(dir, name)
    }
  }

  private scheduleProcess(dir: string, name: string): void {
    const key = `${dir}::${name}`
    const existing = this.debounced.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => {
        this.debounced.delete(key)
        void this.handleMailboxFile(dir, name)
      }, PROCESS_DELAY_MS)
      return
    }
    const timer = setTimeout(() => {
      this.debounced.delete(key)
      void this.handleMailboxFile(dir, name)
    }, PROCESS_DELAY_MS)
    this.debounced.set(key, { timer, firstAt: Date.now() })
  }

  /**
   * 处理单个信箱文件：成功投递后删除；失败改名 *.failed 并写 *.error.txt。
   * 供监听事件与测试调用。
   */
  async handleMailboxFile(dir: string, name: string): Promise<MailboxDeliveryResult> {
    const filePath = path.join(dir, name)
    const key = `${dir}::${name}`
    if (this.inFlight.has(key)) return { ok: false, reason: 'already processing' }
    this.inFlight.add(key)

    try {
      if (!isDispatchPayloadName(name)) return { ok: false, reason: 'not a dispatch payload name' }

      // C2（v1.5.0）幂等护栏：同名前次消费成功的回执（<name>.ack）已存在 →
      // 该投递早已送达，直接跳过。防「投递成功但 unlink 失败、文件残留」被
      // 45s 周期 rescan 再次投递（重复派活）。
      if (await this.ackExists(dir, name)) {
        return { ok: true }
      }

      let raw: string | null
      try {
        raw = await this.readPayloadWithRetry(filePath)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await this.markFailed(dir, name, `Failed to read payload: ${reason}`)
        return { ok: false, reason }
      }
      if (raw === null) {
        // 文件已被处理/删除（重复事件），不算失败
        return { ok: true }
      }

      // 裁决二第 7 条：信箱本版不支持广播。检查放在 parsePayload **之前**——广播
      // payload 通常不带 targetSessionId，若先进 parsePayload 会被报成「Invalid
      // payload: targetSessionId is required」，掩盖真实原因。明确写 .error.txt
      // 拒绝，不能静默丢弃（静默会让发起方以为广播已送达）。
      try {
        if ((JSON.parse(raw) as Record<string, unknown>).broadcast === true) {
          const reason = '信箱不支持广播，请用 HTTP 或逐个投递'
          await this.markFailed(dir, name, reason)
          return { ok: false, reason }
        }
      } catch {
        // JSON 本身解析失败交给下面的 parsePayload 统一报错，这里不抢报
      }

      let payload: DispatchPayload
      try {
        payload = parsePayload(raw)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await this.markFailed(dir, name, `Invalid payload: ${reason}`)
        return { ok: false, reason }
      }

      const isolationError = await this.checkProjectIsolation(dir, payload)
      if (isolationError) {
        await this.markFailed(dir, name, isolationError)
        return { ok: false, reason: isolationError }
      }

      const host = `127.0.0.1:${this.serverPort}`

      // CLI 契约 §五：信箱 report 字段。这是员工 CLI 在服务不可用时的降级路径：
      // 先把台账推到 delivered，**再**投递消息——顺序与 HTTP 两步完全一致，否则
      // 主管一收到汇报就 review 会撞上 409。
      const reportPayload = payload.report
      const reportTaskId =
        reportPayload && typeof reportPayload.taskId === 'string' ? reportPayload.taskId.trim() : ''
      if (reportTaskId) {
        try {
          await collabTaskService.reportTask(reportTaskId, {
            summary: typeof reportPayload?.summary === 'string' ? reportPayload.summary : '',
            ...(Array.isArray(reportPayload?.deliverables)
              ? {
                  deliverables: reportPayload.deliverables.filter(
                    (item): item is string => typeof item === 'string',
                  ),
                }
              : {}),
          })
        } catch (error) {
          // 记账失败（任务不存在 / 状态非法）**不阻断投递**：汇报正文仍要送达主管。
          // 与 CLI 侧「照样投递消息 + warnings:['ledger_not_updated']」的降级一致，
          // 不伪造状态、也不吞掉原因——留一条 warn 供排查。
          logForDiagnosticsNoPII('warn', 'mailbox_report_task_failed', {
            taskId: reportTaskId,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }

      // v1.6.0（决策 D）：信箱通道与 HTTP 通道共用同一套汇报目标解析，行为必须
      // 一致——否则走信箱的员工汇报仍会投错人。解析在登记回执之前完成，保证
      // 回执记的是真实收件人。
      // taskId 取顶层的（与旧 dispatch payload 一致）；report 字段里的作为兜底，
      // 两者本就应当是同一个值（CLI 写入时同源）。
      const resolutionTaskId = payload.taskId?.trim() || reportTaskId
      const resolution = await resolveReportTarget({
        targetSessionId: payload.targetSessionId,
        ...(payload.fromSessionId ? { fromSessionId: payload.fromSessionId } : {}),
        ...(resolutionTaskId ? { taskId: resolutionTaskId } : {}),
      })
      const targetSessionId = resolution.targetSessionId
      if (resolution.redirectedFrom) {
        logForDiagnosticsNoPII('info', 'collab_report_redirected', {
          requestedTarget: resolution.redirectedFrom,
          resolvedTarget: targetSessionId,
          resolvedBy: resolution.resolvedBy ?? 'unknown',
          workerSessionId: payload.fromSessionId ?? 'unknown',
          channel: 'mailbox',
        })
      } else if (resolution.warning) {
        logForDiagnosticsNoPII('warn', 'collab_report_target_ambiguous', {
          requestedTarget: payload.targetSessionId,
          warning: resolution.warning,
          channel: 'mailbox',
        })
      }

      // 消费回执：信箱是"主管 Bash 不可用"时的降级派活通道，同样要能判定
      // "这条活有没有被接住"。否则经信箱投递的派活对假死告警判定不可见
      // （A4 只覆盖了 HTTP 派活）。与 api/servants.ts 同款：先登记，失败撤回。
      const messageId = crypto.randomUUID()
      recordDelivery({
        messageId,
        targetSessionId,
        ...(payload.fromSessionId ? { fromSessionId: payload.fromSessionId } : {}),
      })
      // 派活判定与 HTTP 通道一致：目标是 enabled 员工、不是主管、且不是汇报。
      const targetServant = await servantService
        .getServant(targetSessionId)
        .catch(() => null)
      const isDispatch =
        Boolean(targetServant?.enabled) && !targetServant?.supervisor && !resolution.isReport
      const dispatchTaskId = isDispatch ? payload.taskId?.trim() || crypto.randomUUID() : ''
      try {
        const delivered = await this.deps.deliver(
          targetSessionId,
          isDispatch
            ? appendReportFooter(payload.content, dispatchTaskId, payload.fromSessionId ?? '')
            : payload.content,
          host,
        )
        if (!delivered) {
          forgetReceipt(messageId)
          const reason = 'Message could not be delivered to the target session'
          await this.markFailed(dir, name, reason)
          return { ok: false, reason }
        }
      } catch (error) {
        forgetReceipt(messageId)
        const reason = error instanceof Error ? error.message : String(error)
        await this.markFailed(dir, name, reason)
        return { ok: false, reason }
      }

      // 派活投递成功 → 任务台账 dispatched。与 HTTP 派活同一实现、同一幂等键。
      if (isDispatch) {
        await collabTaskService.recordDispatch({
          toSessionId: targetSessionId,
          ...(payload.fromSessionId ? { fromSessionId: payload.fromSessionId } : {}),
          content: payload.content,
          taskId: dispatchTaskId,
          ...(payload.title ? { title: payload.title } : {}),
        })
      }

      // C2（v1.5.0，主管裁决）：unlink 失败（Windows 锁）时**仍然写 ack**——
      // 投递已成功，ack 就是幂等护栏：入口见 ack 即跳过，重复投递彻底闭死
      // （此前「unlink 失败不写 ack」会让下轮 rescan 重投一次）。unlink 失败的
      // 事实经 ack 的 unlinkFailed:true 字段 + 一条 warn 诊断留痕，便于排查残留。
      let removed = true
      await fs.unlink(filePath).catch(() => {
        removed = false
      })
      if (!removed) {
        void diagnosticsService
          .recordEvent({
            type: 'dispatch_mailbox_unlink_failed',
            severity: 'warn',
            summary: `信箱文件删除失败（已投递成功，ack 已写入并带 unlinkFailed 标记；文件残留需人工清理）：${name}`,
            details: { dir, name, targetSessionId: payload.targetSessionId, messageId },
          })
          .catch(() => {})
      }

      // 消费回执（v1.4.0 阶段1-A ③，信箱一等化）：原文件删除后同目录回写
      // `<原文件名>.ack`，员工可 Read 确认送达，不必等主管口头确认。
      // 协议：内容为 { ack: true, file, targetSessionId, fromSessionId?,
      // messageId, deliveredAt(ISO8601), unlinkFailed?(仅删除失败时出现) }；
      // .ack 后缀不匹配 isDispatchPayloadName（非 .json 结尾），不会被再次
      // 消费；写入失败仅影响送达确认，不得影响投递主链路（静默吞掉）。
      await fs.writeFile(
        path.join(dir, `${name}.ack`),
        JSON.stringify(
          {
            ack: true,
            file: name,
            targetSessionId: payload.targetSessionId,
            ...(payload.fromSessionId ? { fromSessionId: payload.fromSessionId } : {}),
            messageId,
            deliveredAt: new Date().toISOString(),
            ...(removed ? {} : { unlinkFailed: true }),
          },
          null,
          2,
        ),
        'utf-8',
      ).catch((error) => {
        // 低-1（v1.5.0）：ack 写失败也必须留痕——ack 是幂等护栏，写不进去意味着
        // 下次 rescan 会重投（且员工看不到送达回执）。与 unlinkFailed 留痕对称。
        void diagnosticsService
          .recordEvent({
            type: 'dispatch_mailbox_ack_write_failed',
            severity: 'warn',
            summary: `信箱 .ack 回执写入失败（投递已成功，但幂等护栏与送达确认缺失）：${name}`,
            details: {
              dir,
              name,
              targetSessionId: payload.targetSessionId,
              messageId,
              error: error instanceof Error ? error.message : String(error),
            },
          })
          .catch(() => {})
      })

      return { ok: true }
    } finally {
      this.inFlight.delete(key)
    }
  }

  /** C2（v1.5.0）：该文件的消费回执是否已存在（幂等护栏，任何 IO 异常按不存在处理） */
  private async ackExists(dir: string, name: string): Promise<boolean> {
    try {
      await fs.access(path.join(dir, `${name}.ack`))
      return true
    } catch {
      return false
    }
  }

  private async readPayloadWithRetry(filePath: string): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        const stat = await fs.stat(filePath)
        if (stat.size > MAX_FILE_BYTES) {
          await this.markFailed(path.dirname(filePath), path.basename(filePath), `File exceeds ${MAX_FILE_BYTES} bytes`)
          return null
        }
        return await fs.readFile(filePath, 'utf-8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        if (attempt >= READ_RETRY_DELAYS_MS.length) throw error
        await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt]))
      }
    }
  }

  /**
   * 与 POST /api/session-messages 相同的项目隔离规则：向 enabled 员工派活时，
   * 发送方必须与员工同项目。信箱文件写在某个项目目录里，写入口即是发送方项目。
   */
  private async checkProjectIsolation(
    dir: string,
    payload: DispatchPayload,
  ): Promise<string | null> {
    if (!payload.fromSessionId) return null
    const target = await this.deps.getServant(payload.targetSessionId)
    if (!target?.enabled) return null
    const targetWorkDir = await this.deps.getSessionWorkDir(payload.targetSessionId)
    if (!targetWorkDir) return null
    const projectRoot = projectRootFromMailboxDir(dir)
    return path.resolve(targetWorkDir) === projectRoot
      ? null
      : `Cross-project dispatch is not allowed: mailbox project is ${projectRoot}, worker is in ${targetWorkDir}`
  }

  private async markFailed(dir: string, name: string, reason: string): Promise<void> {
    const filePath = path.join(dir, name)
    const stamp = new Date().toISOString()
    await fs.rename(filePath, `${filePath}.failed`).catch(() => {})
    await fs.writeFile(
      path.join(dir, `${name}.error.txt`),
      `[${stamp}] Dispatch mailbox delivery failed.\n${reason}\n`,
      'utf-8',
    ).catch(() => {})
    console.warn(`[DispatchMailbox] Failed to deliver ${name} in ${dir}: ${reason}`)
  }
}

export const dispatchMailboxService = new DispatchMailboxService()
