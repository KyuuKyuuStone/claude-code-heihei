/**
 * CollabReport（员工）—— 汇报完工。
 *
 * 薄 HTTP 客户端（契约 §4.4），**两步且顺序固定**：
 * 1. POST /api/collab-tasks/:id/report 把台账推到 delivered；
 * 2. POST /api/session-messages 投递汇报消息（服务端按台账兜底改投到现任主管）。
 * 顺序反了主管会立刻 review 撞 409，所以第 1 步必在第 2 步之前。
 * 台账推进失败时不伪造状态：照样投递消息 + warnings:['ledger_not_updated']。
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  COLLAB_API_PATHS,
  COLLAB_ERROR_CODES,
  COLLAB_REPORT_LEDGER_RETRY_DELAY_MS,
  COLLAB_TOOL_NAMES,
  COLLAB_WARNING_CODES,
  isOpenTaskStatus,
  isTerminalTaskStatus,
  resolveCollabRole,
  type CollabTaskRecord,
  type TaskStatus,
} from '../../collaboration/collabToolContract.js'
import {
  collabRequest,
  collabToolDeps,
  collabWorkDir,
  getCollabServer,
  supportsCollabTasks,
  writeMailboxFile,
} from '../../collaboration/collabToolClient.js'
import {
  classifyHttpFailure,
  fetchLedgerTask,
  fetchLedgerTasks,
  pickResponseTarget,
  pickRosterEntries,
  pickTaskRecords,
  readCollabRuntime,
  renderCollabOutput,
  requestWithReconnect,
} from './shared.js'

// ── 大正文落盘（P-B1 协作通道限长）────────────────────────────────────────────
//
// 为什么：某个协作会话反复 HTTP 413「Request too large」并卡死——根因之一是工具
// 把超大汇报正文整段塞进 session-messages 的 content，把请求体顶到链路上限。
// 解法必须**优雅**：工具侧无条件处理，不需要用户/主管叮嘱员工别写长汇报。
//
// 落盘目录复用仓库既有的信箱约定（COLLAB_MAILBOX_DIR = '.heihei/dispatch' 的父
// 目录 .heihei/ 之下）。**没有**可直接复用的落盘函数——CollabTools 目录下没有
// diskOutput.ts，通用落盘在 utils/task/diskOutput.ts（按 taskId 追加写、语义是
// 后台任务输出，直接借用会与真实任务文件重名冲突）；因此本文件沿用
// collabToolClient.writeMailboxFile 的**目录约定 + 原子落地风格**（mkdir 递归 →
// 写 .tmp → rename），并把这一点记在此处。文件名沿用其命名风格
// <前缀>-<时间戳>-<随机8位>.<后缀>；后缀故意**不是** .json——否则会被信箱
// watcher 的 isDispatchPayloadName 当成待处理 payload 消费掉。
const COLLAB_REPORT_SPILL_DIR = '.heihei/reports'
const COLLAB_REPORT_SPILL_PREFIX = 'report-'

/** 工具侧内联阈值（UTF-8 字节）env 名；见下方 resolveReportInlineMaxBytes 的取值依据。 */
export const COLLAB_REPORT_INLINE_MAX_BYTES_ENV = 'CC_HEIHEI_COLLAB_REPORT_INLINE_MAX_BYTES'
/** 截断摘要的安全长度（UTF-8 字节）。取值依据见 resolveReportInlineMaxBytes。 */
export const COLLAB_REPORT_EXCERPT_MAX_BYTES = 4 * 1024

/**
 * 工具侧内联阈值默认值：summary 的 UTF-8 字节超过它才落盘。
 *
 * 取值依据：
 * - 服务端兜底总闸（servants.ts 的 DEFAULT_SESSION_MESSAGE_MAX_BYTES）默认 512KiB；
 * - 工具侧必须保证「截断摘要（≤4KiB）+ 路径 + 提示 + 交付物」的投递体，在服务端
 *   追加页脚之后仍**远小于**该总闸与链路常见 413 门槛——约 5KiB 量级，留 ≈100×
 *   余量，正常消息绝不会被误伤；
 * - 32KiB 又足够大，几 KB 的正常汇报/派活完全不受影响（未超阈值时逐字节不变）。
 */
const DEFAULT_REPORT_INLINE_MAX_BYTES = 32 * 1024

/**
 * P2（v1.7.5 返工）：`deliverables` 的内联上限（条数 + 单条字节）。
 *
 * 为什么：`summary` 有落盘/截断，`deliverables` 原先**无工具侧上限**（schema 无界）
 * ⇒ 一次带上几百条超长路径就能把投递体顶到服务端 512KiB 兜底之外，汇报白失败一次
 * （还要等超时才暴露）。策略与 summary **同一套**：超阈值时截断内联 + 全文落盘可查。
 */
export const COLLAB_REPORT_DELIVERABLES_MAX_INLINE = 50
export const COLLAB_REPORT_DELIVERABLE_MAX_BYTES = 1024

/** 正整数 env 解析（跟随 cronScheduler.resolveCronTaskTimeoutMs 的写法）：非法/缺失回退默认。 */
function resolveReportInlineMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[COLLAB_REPORT_INLINE_MAX_BYTES_ENV]?.trim()
  if (!raw) return DEFAULT_REPORT_INLINE_MAX_BYTES
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REPORT_INLINE_MAX_BYTES
}

/** 按 UTF-8 字节截断，且不切碎多字节字符。 */
function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let bytes = 0
  let out = ''
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (bytes + size > maxBytes) break
    out += ch
    bytes += size
  }
  return out
}

const DESCRIPTION = '汇报任务完工（先推台账 delivered，再投递汇报给主管）'

const PROMPT = `员工汇报用。summary 写结论与证据；deliverables 列交付物路径。
不带 taskId 时工具会取你名下唯一的未结任务，有多个会报错并列出候选让你选（不要瞎猜）。
台账会先被推到 delivered，然后汇报才发给主管；台账推进失败也会照样投递，并给出 ledger_not_updated 告警——这种情况如实说明，不要谎报状态。`

const inputSchema = lazySchema(() =>
  z.strictObject({
    summary: z.string().describe('汇报正文（结论、证据、测试结果）'),
    taskId: z.string().optional().describe('任务 ID；省略时取你名下唯一的未结任务'),
    deliverables: z.array(z.string()).optional().describe('交付物列表（文件路径等）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type CollabReportOutput = {
  ok: boolean
  taskId: string
  status?: TaskStatus
  deliveredTo?: string
  redirectedFrom?: string
  messageId?: string
  channel: 'http' | 'mailbox' | 'none'
  queued?: boolean
  mailboxFile?: string
  serverVersion?: string
  /** 台账可用性（旧服务端走花名册回退时标 unsupported） */
  ledger?: 'supported' | 'unsupported'
  /** 收件人是如何定出来的（旧服务端回退路径标 roster_supervisor） */
  resolvedBy?: 'roster_supervisor'
  warnings?: string[]
  error?: string
  message?: string
}

export const CollabReportTool = buildTool({
  name: COLLAB_TOOL_NAMES.report,
  searchHint: 'report task completion back to the dispatcher',
  maxResultSizeChars: 20_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  userFacingName() {
    return COLLAB_TOOL_NAMES.report
  },
  // 协作工具是主路径工具：即使启用 ToolSearch 也要首轮可见
  alwaysLoad: true,
  isEnabled() {
    return resolveCollabRole() === 'servant'
  },
  async call(input) {
    const deps = collabToolDeps()
    const runtime = readCollabRuntime(deps)
    const summary = input.summary.trim()
    const requestedTaskId = input.taskId?.trim() ?? ''
    const deliverables = input.deliverables?.map((item) => item.trim()).filter(Boolean) ?? []

    const fail = (error: string, message?: string): { data: CollabReportOutput } => ({
      data: {
        ok: false,
        taskId: requestedTaskId,
        channel: 'none',
        error,
        ...(message ? { message } : {}),
      },
    })

    if (!runtime) return fail(COLLAB_ERROR_CODES.notCollabSession, '当前会话不是协作会话。')
    if (!summary) return fail(COLLAB_ERROR_CODES.badRequest, 'summary 不能为空。')

    /** 未截断的完整投递体（未超阈值时就是最终投递内容，逐字节不变）。 */
    const fullContent = (): string => {
      const lines = [`【汇报】${summary}`]
      if (deliverables.length > 0) lines.push('交付物：', ...deliverables.map((item) => `- ${item}`))
      return lines.join('\n')
    }

    const inlineMaxBytes = resolveReportInlineMaxBytes(deps.env)

    /**
     * 全文写盘（原子落地：先写 .tmp 再 rename，与 writeMailboxFile 同一风格）。
     * 返回 {ok,file} 或 {ok:false,error}；失败时**绝不**回退成「整段拼进 content」——
     * 那正是要根治的 413 根因。
     */
    const spillReportBody = (body: string): { ok: boolean; file?: string; error?: string } => {
      const dir = join(collabWorkDir(deps), COLLAB_REPORT_SPILL_DIR)
      const name = `${COLLAB_REPORT_SPILL_PREFIX}${deps.now()}-${deps.randomId().slice(0, 8)}.md`
      const target = join(dir, name)
      const tmp = `${target}.tmp`
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(tmp, body, 'utf8')
        renameSync(tmp, target)
        return { ok: true, file: target }
      } catch (error) {
        try {
          rmSync(tmp, { force: true })
        } catch {
          // 清理失败不影响主错误上报
        }
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /** 落盘结果惰性求值且只求值一次：buildContent / buildLedgerSummary 都会调用，不能重复落盘。 */
    let spillResult: { ok: boolean; file?: string; error?: string } | undefined

    /** 只在超阈值时才真正落盘；全程至多一次。 */
    const ensureSpilled = (): { ok: boolean; file?: string; error?: string } => {
      if (!spillResult) spillResult = spillReportBody(fullContent())
      return spillResult
    }

    /**
     * 超阈值时的内联交付物：条数 + 单条字节双上限（未超阈值**不使用**，
     * 保持逐字节原样）。全文（含被截掉的条目）在 `fullContent()` 落盘文件里。
     */
    const inlineDeliverables = (): string[] =>
      deliverables
        .slice(0, COLLAB_REPORT_DELIVERABLES_MAX_INLINE)
        .map((item) => truncateToUtf8Bytes(item, COLLAB_REPORT_DELIVERABLE_MAX_BYTES))

    /** 交付物内联上限说明（仅在有截断时出现）。 */
    const deliverablesTruncationNote = (): string | null => {
      const dropped = deliverables.length - COLLAB_REPORT_DELIVERABLES_MAX_INLINE
      if (dropped <= 0) return null
      return `（交付物过多：另有 ${dropped} 条未内联，完整清单见落盘文件）`
    }

    /** 超阈值时投递体里的截断摘要（未超阈值不调用）。 */
    const buildExcerptLines = (): string[] => {
      const spilled = ensureSpilled()
      // 截断长度同时受「绝对上限」与「阈值的一半」约束：保证投递体（摘要+路径+提示）
      // 无论阈值取多小都仍 < 阈值，且当阈值被 env 调小时截断真的生效（不会退化成全文）。
      const excerptBytes = Math.min(COLLAB_REPORT_EXCERPT_MAX_BYTES, Math.floor(inlineMaxBytes / 2))
      const lines = [`【汇报】${truncateToUtf8Bytes(summary, excerptBytes)}`]
      if (deliverables.length > 0) {
        lines.push('交付物：', ...inlineDeliverables().map((item) => `- ${item}`))
        const note = deliverablesTruncationNote()
        if (note) lines.push(note)
      }
      if (spilled.ok && spilled.file) {
        lines.push(
          `（正文过长：${Buffer.byteLength(summary, 'utf8')} 字节已超过内联上限 ${inlineMaxBytes} 字节，上面为截断摘要）`,
          `完整汇报已落盘：${spilled.file}`,
          '请用 Read 工具读取该文件获取全文。',
        )
      } else {
        lines.push(`（正文过长，落盘失败：${spilled.error ?? 'unknown'}；以上仅为截断摘要）`)
      }
      return lines
    }

    /**
     * 投递内容：未超阈值 ⇒ 原样（逐字节不变）；超阈值 ⇒ 截断摘要 + 落盘路径引用。
     * 由工具侧无条件处理，员工无需自知写没写长汇报。
     */
    const buildContent = (): string => {
      // 阈值按**整条投递体**算（含交付物段），而不是只看 summary——否则一堆
      // 交付物能把总量顶穿上限而此处仍判"没超"（P2 的成因）。
      if (Buffer.byteLength(fullContent(), 'utf8') <= inlineMaxBytes) return fullContent()
      return buildExcerptLines().join('\n')
    }

    /** 是否处于「超内联阈值」形态（台账/信箱载荷的交付物按同一判断收口）。 */
    const isOverInlineLimit = (): boolean =>
      Buffer.byteLength(fullContent(), 'utf8') > inlineMaxBytes

    /** 台账/信箱载荷用的交付物：超阈值才截断（未超阈值逐字节原样）。 */
    const payloadDeliverables = (): string[] =>
      isOverInlineLimit() ? inlineDeliverables() : deliverables

    /**
     * 台账里的 summary：**同一套阈值与截断**（v1.7.5 补齐）。
     * 为什么：工具会把 summary 原文 POST 到 `/api/collab-tasks/:id/report`（与
     * session-messages 同族的通道）⇒ 不截断则同样的 413 根因只是换了个端点。
     * 全文已落盘（与投递体共用**同一个**文件），此处只留截断摘要 + 路径引用；
     * 未超阈值时逐字节原样，台账看到的与从前完全一致。
     */
    const buildLedgerSummary = (): string => {
      if (Buffer.byteLength(summary, 'utf8') <= inlineMaxBytes) return summary
      return buildExcerptLines().join('\n')
    }

    /** 写 report 信箱（第一步失败或投递失败时的降级）。 */
    const queueToMailbox = (taskId: string, targetSessionId = runtime.sessionId): { data: CollabReportOutput } => {
      const payload = {
        /**
         * 有 taskId 时服务端会按台账解析真实收件人（reportTargetResolver，与 HTTP
         * 通道同一套规则）；没有台账时沿用调用方给的已知收件人（花名册回退路径）。
         */
        targetSessionId,
        fromSessionId: runtime.sessionId,
        content: buildContent(),
        ...(taskId ? { taskId } : {}),
        ...(taskId
          ? {
              report: {
                taskId,
                summary: buildLedgerSummary(),
                ...(deliverables.length > 0 ? { deliverables: payloadDeliverables() } : {}),
              },
            }
          : {}),
      }
      const written = writeMailboxFile('report', payload, deps)
      if (!written.ok) return fail(COLLAB_ERROR_CODES.mailboxWriteFailed, written.error)
      return {
        data: {
          ok: true,
          taskId,
          channel: 'mailbox',
          queued: true,
          mailboxFile: written.file,
          warnings: [COLLAB_WARNING_CODES.mailboxQueued],
        },
      }
    }

    const server = await getCollabServer(deps)
    if (!server) {
      if (!requestedTaskId) {
        return fail(
          COLLAB_ERROR_CODES.serverUnreachable,
          '服务不可用，且未带 taskId：离线无法查你名下的未结任务。请带上 taskId 重试。',
        )
      }
      return queueToMailbox(requestedTaskId)
    }

    if (!(await supportsCollabTasks(server, deps))) {
      /**
       * 旧服务端（无台账能力）：走架构裁决二的花名册回退——只用
       * GET /api/servant-sessions?forSession=<self> 的同项目花名册认**唯一**主管。
       * 恰好一名才投递；0 名 / 多名 / 花名册请求失败一律安全拒绝。
       * 绝不从正文、页脚、环境变量或会话记忆里推断收件人（那都是猜）。
       */
      const rosterResult = await collabRequest(
        server,
        'GET',
        `${COLLAB_API_PATHS.servantSessions}?forSession=${encodeURIComponent(runtime.sessionId)}`,
        undefined,
        deps,
      )
      const supervisors = rosterResult.ok
        ? pickRosterEntries((rosterResult.body as { servants?: unknown } | null)?.servants).filter(
            (entry) => entry.supervisor === true,
          )
        : []
      if (supervisors.length !== 1) {
        return fail(
          COLLAB_ERROR_CODES.ledgerUnsupported,
          supervisors.length === 0
            ? '当前服务端没有任务台账能力，且同项目花名册里没有（或查不到）唯一的主管，无法确定汇报对象。已按安全策略拒绝投递，不猜收件人。'
            : `当前服务端没有任务台账能力，且同项目花名册里有 ${supervisors.length} 名主管，无法确定唯一汇报对象。已按安全策略拒绝投递。`,
        )
      }
      const supervisorId = supervisors[0]!.sessionId
      const messageBody = {
        targetSessionId: supervisorId,
        fromSessionId: runtime.sessionId,
        content: buildContent(),
        ...(requestedTaskId ? { taskId: requestedTaskId } : {}),
      }
      const { result } = await requestWithReconnect(
        server,
        'POST',
        COLLAB_API_PATHS.sessionMessages,
        messageBody,
        deps,
      )
      if (result.status === 0) {
        return queueToMailbox(requestedTaskId, supervisorId)
      }
      if (!result.ok) {
        return fail(classifyHttpFailure(result), result.message)
      }
      const responseBody = (result.body ?? {}) as { messageId?: unknown; target?: unknown }
      const targetState = pickResponseTarget(responseBody.target)
      return {
        data: {
          ok: true,
          taskId: requestedTaskId,
          deliveredTo: targetState?.sessionId ?? supervisorId,
          ...(typeof responseBody.messageId === 'string' ? { messageId: responseBody.messageId } : {}),
          channel: 'http',
          ledger: 'unsupported',
          resolvedBy: 'roster_supervisor',
          ...(server.version ? { serverVersion: server.version } : {}),
          warnings: [COLLAB_WARNING_CODES.ledgerUnsupported],
        },
      }
    }

    // ── 定位任务（无 taskId 时取唯一未结任务） ──
    let task: CollabTaskRecord
    if (requestedTaskId) {
      const fetched = await fetchLedgerTask(server, requestedTaskId, deps)
      if (!fetched.ok) return fail(fetched.code, fetched.message)
      task = fetched.value
    } else {
      const ledger = await fetchLedgerTasks(server, { forSessionId: runtime.sessionId }, deps)
      if (!ledger.ok) return fail(ledger.code, ledger.message)
      const open = ledger.value.filter(
        (item) => item.toSessionId === runtime.sessionId && isOpenTaskStatus(item.status),
      )
      if (open.length === 0) {
        return fail(COLLAB_ERROR_CODES.noOpenTask, '你名下没有未结任务。请向主管确认任务 ID。')
      }
      if (open.length > 1) {
        const candidates = open.map((item) => `${item.id}（${item.status}｜${item.title}）`).join('；')
        return fail(
          COLLAB_ERROR_CODES.multipleOpenTasks,
          `你名下有多个未结任务，请在 taskId 里写明要汇报哪一个：${candidates}`,
        )
      }
      task = open[0]
    }
    const taskId = task.id

    const reportPath = `${COLLAB_API_PATHS.collabTasks}/${encodeURIComponent(taskId)}/report`
    const reportBody = {
      // 超阈值 ⇒ 截断摘要 + 落盘路径（同一套阈值/同一个文件，见 buildLedgerSummary）
      summary: buildLedgerSummary(),
      ...(deliverables.length > 0 ? { deliverables: payloadDeliverables() } : {}),
      callerSessionId: runtime.sessionId,
    }
    const postReport = () => requestWithReconnect(server, 'POST', reportPath, reportBody, deps)

    const warnings: string[] = []
    let ledgerStatus: TaskStatus | null = null

    // ── 第 1 步：台账推 delivered ──
    const first = (await postReport()).result
    if (first.status === 0) {
      // 服务失联：不谎报 delivered，走信箱（服务端会先 reportTask 再投递）
      return queueToMailbox(taskId)
    }
    if (first.status === 404) {
      return fail(COLLAB_ERROR_CODES.taskNotFound, first.message ?? `台账里没有任务 ${taskId}。`)
    }
    if (first.status === 409) {
      const current = await fetchLedgerTask(server, taskId, deps)
      const currentStatus = current.ok ? current.value.status : undefined
      if (currentStatus && isTerminalTaskStatus(currentStatus)) {
        return fail(
          COLLAB_ERROR_CODES.taskClosed,
          `任务已结单（${currentStatus}），不再接受汇报。`,
        )
      }
      if (currentStatus === 'dispatched') {
        // 回合事件还没把任务推进到 accepted → 等一拍再试一次（契约 §4.4）
        await deps.sleep(COLLAB_REPORT_LEDGER_RETRY_DELAY_MS)
        const retry = (await postReport()).result
        if (retry.ok) {
          ledgerStatus = 'delivered'
        } else {
          warnings.push(COLLAB_WARNING_CODES.ledgerNotUpdated)
        }
      } else {
        // 状态非法流转（既非终态也不是回合未推进）：如实告警，不伪造状态
        warnings.push(COLLAB_WARNING_CODES.ledgerNotUpdated)
      }
    } else if (!first.ok) {
      return fail(classifyHttpFailure(first), first.message)
    } else {
      const [updated] = pickTaskRecords((first.body as { task?: unknown } | null)?.task ? [(first.body as { task: unknown }).task] : [])
      ledgerStatus = updated?.status ?? 'delivered'
    }

    // ── 第 2 步：投递汇报消息（收件人取台账派活人；服务端仍会按台账兜底改投） ──
    const messageBody = {
      targetSessionId: task.fromSessionId,
      fromSessionId: runtime.sessionId,
      content: buildContent(),
      taskId,
    }
    const { result: messageResult } = await requestWithReconnect(
      server,
      'POST',
      COLLAB_API_PATHS.sessionMessages,
      messageBody,
      deps,
    )
    if (messageResult.status === 0) {
      // 台账可能已推进；消息没送达 → 信箱补投（服务端对已 delivered 的任务只投消息不重复记账）
      const queued = queueToMailbox(taskId)
      if (queued.data.ok && warnings.length > 0) queued.data.warnings = [...warnings, ...(queued.data.warnings ?? [])]
      return queued
    }
    if (!messageResult.ok) {
      return {
        data: {
          ok: false,
          taskId,
          ...(ledgerStatus ? { status: ledgerStatus } : {}),
          channel: 'http',
          error: classifyHttpFailure(messageResult),
          message: messageResult.message,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      }
    }

    const responseBody = (messageResult.body ?? {}) as {
      messageId?: unknown
      redirectedFrom?: unknown
      target?: unknown
    }
    const targetState = pickResponseTarget(responseBody.target)
    return {
      data: {
        ok: true,
        taskId,
        status: ledgerStatus ?? task.status,
        deliveredTo: targetState?.sessionId ?? task.fromSessionId,
        ...(typeof responseBody.redirectedFrom === 'string'
          ? { redirectedFrom: responseBody.redirectedFrom }
          : {}),
        ...(typeof responseBody.messageId === 'string' ? { messageId: responseBody.messageId } : {}),
        channel: 'http',
        ...(server.version ? { serverVersion: server.version } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: renderCollabOutput(content),
    }
  },
} satisfies ToolDef<InputSchema, CollabReportOutput>)
