/**
 * CollabReport（员工）—— 汇报完工。
 *
 * 薄 HTTP 客户端（契约 §4.4），**两步且顺序固定**：
 * 1. POST /api/collab-tasks/:id/report 把台账推到 delivered；
 * 2. POST /api/session-messages 投递汇报消息（服务端按台账兜底改投到现任主管）。
 * 顺序反了主管会立刻 review 撞 409，所以第 1 步必在第 2 步之前。
 * 台账推进失败时不伪造状态：照样投递消息 + warnings:['ledger_not_updated']。
 */

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

    const buildContent = (): string => {
      const lines = [`【汇报】${summary}`]
      if (deliverables.length > 0) lines.push('交付物：', ...deliverables.map((item) => `- ${item}`))
      return lines.join('\n')
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
                summary,
                ...(deliverables.length > 0 ? { deliverables } : {}),
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
      summary,
      ...(deliverables.length > 0 ? { deliverables } : {}),
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
