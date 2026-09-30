/**
 * CollabReview（主管）—— 验收任务台账。
 *
 * 薄 HTTP 客户端（契约 §4.2）：POST /api/collab-tasks/:id/review；verdict=rework
 * 时**自动**用同一个 taskId 向原员工投递返工消息（省主管的 token，也不给
 * 「忘记重发」留口子）。状态一律以台账响应为准，工具不猜也不改。
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  COLLAB_API_PATHS,
  COLLAB_ERROR_CODES,
  COLLAB_TOOL_NAMES,
  COLLAB_WARNING_CODES,
  isTerminalTaskStatus,
  resolveCollabRole,
  type TaskStatus,
} from '../../collaboration/collabToolContract.js'
import {
  collabToolDeps,
  getCollabServer,
  supportsCollabTasks,
  writeMailboxFile,
} from '../../collaboration/collabToolClient.js'
import {
  classifyHttpFailure,
  fetchLedgerTask,
  pickTaskRecords,
  readCollabRuntime,
  renderCollabOutput,
  requestWithReconnect,
} from './shared.js'

const DESCRIPTION = '验收任务（pass 结单 / rework 返工，返工自动通知原员工）'

const PROMPT = `主管验收用。taskId 取 CollabDispatch 返回的那个。
verdict=pass 结单；verdict=rework 必须写 note，工具会自动把【返工】消息发给原员工（同一 taskId，台账不新增任务）。
状态以任务台账为准：还没汇报（未 delivered）时返回 not_reviewable，等员工汇报后再验收。
对已结单任务重复验收会返回 already_final 告警，不算失败。`

const inputSchema = lazySchema(() =>
  z.strictObject({
    taskId: z.string().describe('任务 ID（CollabDispatch 返回值）'),
    verdict: z.enum(['pass', 'rework']).describe('pass=通过结单；rework=返工'),
    note: z.string().optional().describe('验收意见；verdict=rework 时必填'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type CollabReviewOutput = {
  ok: boolean
  taskId: string
  status?: TaskStatus
  reworkMessageId?: string
  channel: 'http' | 'mailbox' | 'none'
  serverVersion?: string
  warnings?: string[]
  error?: string
  message?: string
}

export const CollabReviewTool = buildTool({
  name: COLLAB_TOOL_NAMES.review,
  searchHint: 'approve or send back a delivered task',
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
    return COLLAB_TOOL_NAMES.review
  },
  // 协作工具是主路径工具：即使启用 ToolSearch 也要首轮可见
  alwaysLoad: true,
  isEnabled() {
    return resolveCollabRole() === 'supervisor'
  },
  async call(input) {
    const deps = collabToolDeps()
    const runtime = readCollabRuntime(deps)
    const taskId = input.taskId.trim()

    const fail = (
      error: string,
      extra?: { message?: string; status?: TaskStatus },
    ): { data: CollabReviewOutput } => ({
      data: {
        ok: false,
        taskId,
        channel: 'none',
        error,
        ...(extra?.message ? { message: extra.message } : {}),
        ...(extra?.status ? { status: extra.status } : {}),
      },
    })

    if (!runtime) return fail(COLLAB_ERROR_CODES.notCollabSession, { message: '当前会话不是协作会话。' })
    if (!taskId) return fail(COLLAB_ERROR_CODES.badRequest, { message: 'taskId 不能为空。' })
    if (input.verdict === 'rework' && !input.note?.trim()) {
      return fail(COLLAB_ERROR_CODES.badRequest, { message: 'verdict=rework 时必须写 note（返工要求）。' })
    }

    const server = await getCollabServer(deps)
    if (!server) {
      // 读/改操作绝不走信箱：写进去也没人替你验收，只会假装成功
      return fail(COLLAB_ERROR_CODES.serverUnreachable, {
        message: '桌面服务不可用。验收是写操作，不走文件信箱——请等服务恢复后重试。',
      })
    }
    if (!(await supportsCollabTasks(server, deps))) {
      return fail(COLLAB_ERROR_CODES.ledgerUnsupported, {
        message: '当前服务端版本没有任务台账能力，无法验收。',
      })
    }

    // 先读一次：既为拿到 toSessionId（返工投递用），也为识别「对终态重复验收」
    const before = await fetchLedgerTask(server, taskId, deps)
    if (!before.ok) {
      return fail(before.code, { message: before.message })
    }

    const { result } = await requestWithReconnect(
      server,
      'POST',
      `${COLLAB_API_PATHS.collabTasks}/${encodeURIComponent(taskId)}/review`,
      {
        verdict: input.verdict,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        callerSessionId: runtime.sessionId,
      },
      deps,
    )

    if (result.status === 0) {
      return fail(COLLAB_ERROR_CODES.serverUnreachable, { message: result.message })
    }
    if (result.status === 404) {
      return fail(COLLAB_ERROR_CODES.taskNotFound, { message: result.message })
    }
    if (result.status === 409) {
      // 契约 §4.2：不改状态、如实报当前状态，提示等员工汇报
      return fail(COLLAB_ERROR_CODES.notReviewable, {
        status: before.value.status,
        message: `${result.message ?? '当前状态不能验收'}（台账当前状态：${before.value.status}）。等员工汇报（delivered）后再验收。`,
      })
    }
    if (!result.ok) {
      return fail(classifyHttpFailure(result), { message: result.message })
    }

    const responseBody = (result.body ?? {}) as { task?: unknown }
    const [reviewed] = pickTaskRecords(responseBody.task ? [responseBody.task] : [])
    const task = reviewed ?? before.value
    const warnings: string[] = []
    // 验收前已是终态 → 这次是幂等重复（服务端 200，如实报 ok 并告警）
    if (isTerminalTaskStatus(before.value.status)) warnings.push(COLLAB_WARNING_CODES.alreadyFinal)

    const output: CollabReviewOutput = {
      ok: true,
      taskId,
      status: task.status,
      channel: 'http',
      ...(server.version ? { serverVersion: server.version } : {}),
    }

    if (input.verdict === 'rework') {
      const content = `【返工】${input.note?.trim() ?? ''}`
      const body = {
        targetSessionId: task.toSessionId,
        fromSessionId: runtime.sessionId,
        content,
        taskId,
      }
      const { result: messageResult } = await requestWithReconnect(
        server,
        'POST',
        COLLAB_API_PATHS.sessionMessages,
        body,
        deps,
      )
      if (messageResult.status === 0) {
        // 台账已改（rework），只是通知没送达 → 走信箱，不把已完成的验收说成失败
        const written = writeMailboxFile('dispatch', body, deps)
        warnings.push(
          written.ok ? COLLAB_WARNING_CODES.reworkMessageQueued : COLLAB_ERROR_CODES.mailboxWriteFailed,
        )
      } else if (messageResult.ok) {
        const messageBody = (messageResult.body ?? {}) as { messageId?: unknown }
        if (typeof messageBody.messageId === 'string') output.reworkMessageId = messageBody.messageId
      } else {
        warnings.push(`rework_message_failed:${messageResult.status}`)
      }
    }

    if (warnings.length > 0) output.warnings = warnings
    return { data: output }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: renderCollabOutput(content),
    }
  },
} satisfies ToolDef<InputSchema, CollabReviewOutput>)
