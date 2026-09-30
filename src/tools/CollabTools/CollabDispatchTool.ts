/**
 * CollabDispatch（主管）—— 把任务派给员工会话。
 *
 * 薄 HTTP 客户端（契约 §4.1）：走 POST /api/session-messages 投递消息，
 * **不调用** POST /api/collab-tasks（那个只建账、不投递）。taskId 由 CLI 在
 * 客户端预生成（UUID），HTTP 与信箱两条通道共用同一个 ID，重试天然幂等。
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  COLLAB_API_PATHS,
  COLLAB_ERROR_CODES,
  COLLAB_TOOL_NAMES,
  resolveCollabRole,
} from '../../collaboration/collabToolContract.js'
import {
  collabToolDeps,
  getCollabServer,
  supportsCollabTasks,
  writeMailboxFile,
} from '../../collaboration/collabToolClient.js'
import {
  classifyHttpFailure,
  fetchRoster,
  looksLikeSessionId,
  pickResponseTarget,
  readCollabRuntime,
  renderCollabOutput,
  requestWithReconnect,
  resolveDispatchTarget,
} from './shared.js'

const DESCRIPTION = '把任务派给某个员工会话（自动寻址、投递与降级，不直接写台账）'

const PROMPT = `主管派活用。to 可写员工 sessionId 或角色名（同名多个会报错，改用 sessionId）。
content 是任务正文；**不要**自己写回邮地址与页脚，服务端会追加。
taskId 只在返工重发或幂等重试时传，平时省略（工具自动生成）。
返回的 taskId 之后交给 CollabReview 验收。
失败处理：not_on_roster 先查花名册确认目标，不要重试同一个目标；cross_project 说明目标不在本项目。`

const inputSchema = lazySchema(() =>
  z.strictObject({
    to: z.string().describe('员工 sessionId，或角色名（如 "前端"）'),
    content: z.string().describe('任务正文；无需写回邮地址，服务端自动追加页脚'),
    title: z.string().optional().describe('任务标题；不填由服务端从正文截取'),
    taskId: z.string().optional().describe('仅返工重发/幂等重试时传，通常省略'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type CollabDispatchOutput = {
  ok: boolean
  taskId: string
  channel: 'http' | 'mailbox' | 'none'
  messageId?: string
  target?: { sessionId: string; role?: string; busy?: boolean }
  /** 台账可用性（旧服务端无台账 → unsupported，消息照投） */
  ledger?: 'supported' | 'unsupported'
  queued?: boolean
  mailboxFile?: string
  serverVersion?: string
  warnings?: string[]
  error?: string
  message?: string
}

export const CollabDispatchTool = buildTool({
  name: COLLAB_TOOL_NAMES.dispatch,
  searchHint: 'assign a task to a teammate session',
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
    return COLLAB_TOOL_NAMES.dispatch
  },
  // 协作工具是主路径工具：即使启用 ToolSearch 也要首轮可见
  alwaysLoad: true,
  // 纵深防御：即使装配出错，非主管会话也拿不到这个工具
  isEnabled() {
    return resolveCollabRole() === 'supervisor'
  },
  async call(input) {
    const deps = collabToolDeps()
    const runtime = readCollabRuntime(deps)
    const taskId = input.taskId?.trim() || deps.randomId()
    const to = input.to.trim()

    const fail = (error: string, message?: string): { data: CollabDispatchOutput } => ({
      data: { ok: false, taskId, channel: 'none', error, ...(message ? { message } : {}) },
    })

    if (!runtime) {
      return fail(COLLAB_ERROR_CODES.notCollabSession, '当前会话不是协作会话，协作工具不可用。')
    }
    if (!to) return fail(COLLAB_ERROR_CODES.badRequest, 'to 不能为空。')
    if (!input.content.trim()) return fail(COLLAB_ERROR_CODES.badRequest, 'content 不能为空。')

    const buildBody = (targetSessionId: string): Record<string, unknown> => ({
      targetSessionId,
      fromSessionId: runtime.sessionId,
      content: input.content,
      taskId,
      ...(input.title ? { title: input.title } : {}),
    })

    const server = await getCollabServer(deps)
    if (!server) {
      // 服务不可用 → 信箱降级。角色名无法离线解析，如实报错而不是猜一个地址。
      if (!looksLikeSessionId(to)) {
        return fail(
          COLLAB_ERROR_CODES.serverUnreachable,
          '服务不可用，且 to 是角色名（离线无法查花名册解析）。请改用 sessionId，或等服务恢复后重试。',
        )
      }
      const written = writeMailboxFile('dispatch', buildBody(to), deps)
      if (!written.ok) {
        return fail(COLLAB_ERROR_CODES.mailboxWriteFailed, written.error)
      }
      return {
        data: {
          ok: true,
          taskId,
          channel: 'mailbox',
          queued: true,
          mailboxFile: written.file,
          target: { sessionId: to },
        },
      }
    }

    const roster = await fetchRoster(server, deps)
    let target: { sessionId: string; role?: string }
    if (roster === null) {
      // 花名册查询失败（服务异常）≠ 目标不存在：只有 sessionId 形态的 to 才能继续
      // （服务端会做权威校验），角色名此时无法解析，如实报错而不是猜。
      if (!looksLikeSessionId(to)) {
        return fail(
          COLLAB_ERROR_CODES.serverUnreachable,
          '花名册查询失败，无法解析角色名。请改用 sessionId 或稍后重试。',
        )
      }
      target = { sessionId: to }
    } else {
      const resolved = resolveDispatchTarget(to, roster, runtime.sessionId)
      if (!resolved.ok) return fail(resolved.code, resolved.message)
      target = {
        sessionId: resolved.entry.sessionId,
        ...(resolved.entry.role ? { role: resolved.entry.role } : {}),
      }
    }

    const ledgerSupported = await supportsCollabTasks(server, deps)
    const body = buildBody(target.sessionId)
    const { result } = await requestWithReconnect(
      server,
      'POST',
      COLLAB_API_PATHS.sessionMessages,
      body,
      deps,
    )

    if (result.status === 0) {
      // 两次解析都连不上 → 信箱降级（目标已解析成真实 sessionId，可安全入信箱）
      const written = writeMailboxFile('dispatch', body, deps)
      if (!written.ok) return fail(COLLAB_ERROR_CODES.mailboxWriteFailed, written.error)
      return {
        data: {
          ok: true,
          taskId,
          channel: 'mailbox',
          queued: true,
          mailboxFile: written.file,
          target: { ...target },
        },
      }
    }

    if (result.status === 404) {
      return fail(
        COLLAB_ERROR_CODES.notOnRoster,
        result.message ?? '目标不在花名册：可能已被移除。请查花名册确认后再派，不要重试同一个目标。',
      )
    }
    if (result.status === 409) {
      return fail(COLLAB_ERROR_CODES.crossProject, result.message ?? '跨项目派活被拒绝。')
    }
    if (!result.ok) {
      return fail(classifyHttpFailure(result), result.message)
    }

    const responseBody = (result.body ?? {}) as { taskId?: unknown; messageId?: unknown; target?: unknown }
    const targetState = pickResponseTarget(responseBody.target)
    return {
      data: {
        ok: true,
        taskId: typeof responseBody.taskId === 'string' ? responseBody.taskId : taskId,
        channel: 'http',
        ...(typeof responseBody.messageId === 'string' ? { messageId: responseBody.messageId } : {}),
        target: {
          sessionId: targetState?.sessionId ?? target.sessionId,
          ...(target.role ? { role: target.role } : {}),
          ...(targetState?.busy !== undefined ? { busy: targetState.busy } : {}),
        },
        ledger: ledgerSupported ? 'supported' : 'unsupported',
        ...(server.version ? { serverVersion: server.version } : {}),
        ...(ledgerSupported ? {} : { warnings: [COLLAB_ERROR_CODES.ledgerUnsupported] }),
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
} satisfies ToolDef<InputSchema, CollabDispatchOutput>)
