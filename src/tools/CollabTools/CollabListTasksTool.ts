/**
 * CollabListTasks（主管 / 员工）—— 看任务台账。
 *
 * 薄 HTTP 客户端（契约 §4.3）：GET /api/collab-tasks。默认只返回**摘要**
 * （不含正文与汇报全文），要全文时给 taskId 单查——主管的上下文是稀缺资源。
 * 员工只能看到派给自己的任务（mine 强制过滤，服务端过滤留到以后）。
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  COLLAB_DEFAULT_LIST_LIMIT,
  COLLAB_ERROR_CODES,
  COLLAB_TOOL_NAMES,
  isOpenTaskStatus,
  isTaskStatus,
  resolveCollabRole,
  type CollabTaskSummary,
  type TaskStatusFilter,
} from '../../collaboration/collabToolContract.js'
import { collabToolDeps, getCollabServer, supportsCollabTasks } from '../../collaboration/collabToolClient.js'
import {
  fetchLedgerTask,
  fetchLedgerTasks,
  fetchRoster,
  indexRosterBySessionId,
  readCollabRuntime,
  renderCollabOutput,
  toTaskSummary,
} from './shared.js'

const DESCRIPTION = '查看任务台账（摘要；给 taskId 可看单条全文）'

const PROMPT = `看任务台账用。默认返回摘要列表（最新在上），status='open' 表示未结任务（dispatched/accepted/in_progress/rework/delivered）。
员工调用只看得到派给自己的任务。需要某条任务的正文与汇报全文时，传 taskId 单查。
任务状态以台账为准，不要用别处的状态推断。`

const inputSchema = lazySchema(() =>
  z.strictObject({
    status: z
      .string()
      .optional()
      .describe("按状态筛选：dispatched/accepted/in_progress/delivered/verified/rework/failed/cancelled，或 'open'（未结）"),
    mine: z.boolean().optional().describe('只看派给自己（目标 sessionId = 自己）的任务'),
    limit: z.number().int().positive().max(200).optional().describe('返回条数上限，默认 20'),
    taskId: z.string().optional().describe('单查某个任务（返回含正文与汇报全文的完整记录）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type CollabListTasksOutput = {
  ok: boolean
  tasks?: CollabTaskSummary[]
  /** taskId 单查时返回的完整记录（含 content/report） */
  task?: Record<string, unknown>
  channel: 'http' | 'mailbox' | 'none'
  serverVersion?: string
  error?: string
  message?: string
}

export const CollabListTasksTool = buildTool({
  name: COLLAB_TOOL_NAMES.listTasks,
  searchHint: 'list collaboration tasks from the ledger',
  maxResultSizeChars: 40_000,
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
    return COLLAB_TOOL_NAMES.listTasks
  },
  // 协作工具是主路径工具：即使启用 ToolSearch 也要首轮可见
  alwaysLoad: true,
  isEnabled() {
    return resolveCollabRole() !== null
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async call(input) {
    const deps = collabToolDeps()
    const runtime = readCollabRuntime(deps)
    const fail = (error: string, message?: string): { data: CollabListTasksOutput } => ({
      data: { ok: false, channel: 'none', error, ...(message ? { message } : {}) },
    })

    if (!runtime) return fail(COLLAB_ERROR_CODES.notCollabSession, '当前会话不是协作会话。')

    const rawStatus = input.status?.trim()
    let statusFilter: TaskStatusFilter | undefined
    if (rawStatus) {
      if (rawStatus !== 'open' && !isTaskStatus(rawStatus)) {
        return fail(COLLAB_ERROR_CODES.badRequest, `未知的 status: ${rawStatus}`)
      }
      statusFilter = rawStatus as TaskStatusFilter
    }

    const server = await getCollabServer(deps)
    if (!server) {
      // 读操作绝不走信箱（信箱只投递消息，不查台账）
      return fail(COLLAB_ERROR_CODES.serverUnreachable, '桌面服务不可用，读操作不走文件信箱。')
    }
    if (!(await supportsCollabTasks(server, deps))) {
      return fail(COLLAB_ERROR_CODES.ledgerUnsupported, '当前服务端版本没有任务台账能力。')
    }

    // 单查：返回完整记录（正文、汇报、交付物、流转历史）
    const singleId = input.taskId?.trim()
    if (singleId) {
      const single = await fetchLedgerTask(server, singleId, deps)
      if (!single.ok) return fail(single.code, single.message)
      if (runtime.role === 'servant' && single.value.toSessionId !== runtime.sessionId) {
        return fail(COLLAB_ERROR_CODES.invalidTarget, '员工只能查看派给自己的任务。')
      }
      return {
        data: {
          ok: true,
          /**
           * 单查是显式请求全文的场景，如实返回台账字段。
           * 这里重新挑字段（而不是直接透传响应）——保证 schema 里永远不可能
           * 出现服务器可能附带的回合态字段。
           */
          task: {
            taskId: single.value.id,
            title: single.value.title,
            status: single.value.status,
            to: { sessionId: single.value.toSessionId },
            from: single.value.fromSessionId,
            updatedAt: single.value.updatedAt,
            ...(single.value.content !== undefined ? { content: single.value.content } : {}),
            ...(single.value.deliverables ? { deliverables: single.value.deliverables } : {}),
            ...(single.value.report !== undefined ? { report: single.value.report } : {}),
            ...(single.value.verdict !== undefined ? { verdict: single.value.verdict } : {}),
          },
          channel: 'http',
          ...(server.version ? { serverVersion: server.version } : {}),
        },
      }
    }

    // 'open' 是聚合值：服务端只认单个状态，故不带 status 拉取后在客户端过滤
    const ledger = await fetchLedgerTasks(
      server,
      {
        forSessionId: runtime.sessionId,
        ...(statusFilter && statusFilter !== 'open' ? { status: statusFilter } : {}),
      },
      deps,
    )
    if (!ledger.ok) return fail(ledger.code, ledger.message)

    // 花名册仅用于给摘要补 role。查询失败时 fetchRoster 返 null ⇒ 降级为「无 role」
    // 继续返回台账，不因花名册抖动把已拉到的任务整体判失败（与 CollabDispatchTool
    // 「花名册失败 ≠ 目标/任务不存在」同口径）。
    const rosterList = await fetchRoster(server, deps)
    const roster = indexRosterBySessionId(rosterList)
    let tasks = ledger.value
    // 员工：只看派给自己的（mine 强制）；主管可用 mine 主动收窄
    if (runtime.role === 'servant' || input.mine === true) {
      tasks = tasks.filter((task) => task.toSessionId === runtime.sessionId)
    }
    if (statusFilter === 'open') {
      tasks = tasks.filter((task) => isOpenTaskStatus(task.status))
    }
    const limit = input.limit ?? COLLAB_DEFAULT_LIST_LIMIT
    tasks = tasks.slice(0, limit)

    return {
      data: {
        ok: true,
        tasks: tasks.map((task) => toTaskSummary(task, roster)),
        channel: 'http',
        ...(server.version ? { serverVersion: server.version } : {}),
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
} satisfies ToolDef<InputSchema, CollabListTasksOutput>)
