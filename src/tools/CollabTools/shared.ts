/**
 * 四个 Collab 工具的共享运行逻辑（v1.6.0 第二批）
 *
 * 只做三件事：读会话身份、把 HTTP 结果翻译成契约里的错误码、把台账记录裁成
 * 摘要。**不直写台账、不猜状态**：所有状态字段都来自服务端台账响应。
 */

import {
  COLLAB_API_PATHS,
  COLLAB_ERROR_CODES,
  COLLAB_SESSION_ID_ENV,
  countReworks,
  isTaskStatus,
  resolveCollabRole,
  type CollabRole,
  type CollabTaskRecord,
  type CollabTaskSummary,
  type TaskStatus,
} from '../../collaboration/collabToolContract.js'
import {
  collabRequest,
  collabToolDeps,
  getCollabServer,
  type CollabHttpResult,
  type CollabServerInfo,
  type CollabToolDeps,
} from '../../collaboration/collabToolClient.js'

export type CollabRuntime = { role: CollabRole; sessionId: string }

/** 工具运行身份：非协作会话返回 null（此时工具本不该被注入，属纵深防御） */
export function readCollabRuntime(deps: CollabToolDeps = collabToolDeps()): CollabRuntime | null {
  const role = resolveCollabRole(deps.env)
  const sessionId = deps.env[COLLAB_SESSION_ID_ENV]
  if (!role || !sessionId) return null
  return { role, sessionId }
}

/** 模型可读的工具结果文本（结构化 data 同时返回，供测试与 SDK 消费） */
export function renderCollabOutput(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

/**
 * 花名册条目（白名单字段）。
 * 服务端 ServantInfo 还带 running / turnInProgress / lastActivityAt —— 这些是
 * 会话回合态，**绝不进入工具输出**（任务状态只认台账；见契约铁律与静态断言）。
 */
export type RosterEntry = {
  sessionId: string
  role?: string
  title?: string
  enabled?: boolean
  supervisor?: boolean
}

export function pickRosterEntries(raw: unknown): RosterEntry[] {
  if (!Array.isArray(raw)) return []
  const out: RosterEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.sessionId !== 'string') continue
    out.push({
      sessionId: record.sessionId,
      ...(typeof record.role === 'string' ? { role: record.role } : {}),
      ...(typeof record.title === 'string' ? { title: record.title } : {}),
      ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
      ...(typeof record.supervisor === 'boolean' ? { supervisor: record.supervisor } : {}),
    })
  }
  return out
}

/**
 * 花名册查询（?all=1：包含被禁用条目，便于给出「已禁用」这类可行动提示）。
 * 返回 null = 查询本身失败（服务异常/超时）——与「花名册为空」严格区分：
 * 前者不能当成 not_on_roster 报给模型（会误导成「目标不存在」）。
 */
export async function fetchRoster(
  server: CollabServerInfo,
  deps: CollabToolDeps = collabToolDeps(),
): Promise<RosterEntry[] | null> {
  const result = await collabRequest(
    server,
    'GET',
    `${COLLAB_API_PATHS.servantSessions}?all=1`,
    undefined,
    deps,
  )
  if (!result.ok) return null
  const body = result.body as { servants?: unknown } | null
  return pickRosterEntries(body?.servants)
}

/**
 * 按 sessionId 建索引，供 List 输出补 role。
 *
 * 形参容忍 null/undefined：`fetchRoster` 在花名册查询**失败**时返回 null（与
 * 「花名册为空」严格区分，见其注释）。漏判空会把「服务抖动」升级成**工具崩溃**——
 * v1.7.4 实测：CollabListTasks 在花名册请求 500 时抛
 * `null is not an object (evaluating 'roster')`（打包 sidecar 压缩后为 `... 'q'`），
 * 整个看台账调用失败。花名册只用来补 role，失败时降级为「无 role」即可。
 */
export function indexRosterBySessionId(
  roster: readonly RosterEntry[] | null | undefined,
): Map<string, RosterEntry> {
  const map = new Map<string, RosterEntry>()
  for (const entry of roster ?? []) map.set(entry.sessionId, entry)
  return map
}

// ── 台账读取 ──

export function pickTaskRecords(raw: unknown): CollabTaskRecord[] {
  if (!Array.isArray(raw)) return []
  const out: CollabTaskRecord[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.toSessionId !== 'string') continue
    if (!isTaskStatus(record.status)) continue
    out.push({
      id: record.id,
      toSessionId: record.toSessionId,
      fromSessionId: typeof record.fromSessionId === 'string' ? record.fromSessionId : '',
      title: typeof record.title === 'string' ? record.title : '',
      status: record.status,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      ...(typeof record.content === 'string' ? { content: record.content } : {}),
      ...(Array.isArray(record.deliverables)
        ? { deliverables: record.deliverables.filter((d): d is string => typeof d === 'string') }
        : {}),
      ...(typeof record.report === 'string' ? { report: record.report } : {}),
      ...(typeof record.verdict === 'string' ? { verdict: record.verdict } : {}),
      ...(Array.isArray(record.history)
        ? {
            history: record.history
              .filter((h): h is { from: TaskStatus | null; to: TaskStatus } => !!h && typeof h === 'object')
              .map((h) => ({ from: h.from ?? null, to: h.to })),
          }
        : {}),
    })
  }
  return out
}

export type LedgerRead<T> = { ok: true; value: T } | { ok: false; code: string; message?: string }

/** 按筛选条件拉台账（?forSessionId 项目隔离由服务端保证） */
export async function fetchLedgerTasks(
  server: CollabServerInfo,
  params: { forSessionId?: string; project?: string; status?: TaskStatus },
  deps: CollabToolDeps = collabToolDeps(),
): Promise<LedgerRead<CollabTaskRecord[]>> {
  const query = new URLSearchParams()
  if (params.forSessionId) query.set('forSessionId', params.forSessionId)
  if (params.project) query.set('project', params.project)
  if (params.status) query.set('status', params.status)
  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  const result = await collabRequest(server, 'GET', `${COLLAB_API_PATHS.collabTasks}${suffix}`, undefined, deps)
  if (result.status === 0) {
    return { ok: false, code: COLLAB_ERROR_CODES.serverUnreachable, message: result.message }
  }
  if (!result.ok) {
    return { ok: false, code: classifyHttpFailure(result), message: result.message }
  }
  const body = result.body as { tasks?: unknown } | null
  return { ok: true, value: pickTaskRecords(body?.tasks) }
}

export async function fetchLedgerTask(
  server: CollabServerInfo,
  taskId: string,
  deps: CollabToolDeps = collabToolDeps(),
): Promise<LedgerRead<CollabTaskRecord>> {
  const result = await collabRequest(
    server,
    'GET',
    `${COLLAB_API_PATHS.collabTasks}/${encodeURIComponent(taskId)}`,
    undefined,
    deps,
  )
  if (result.status === 0) {
    return { ok: false, code: COLLAB_ERROR_CODES.serverUnreachable, message: result.message }
  }
  if (result.status === 404) {
    return { ok: false, code: COLLAB_ERROR_CODES.taskNotFound, message: result.message }
  }
  if (!result.ok) return { ok: false, code: classifyHttpFailure(result), message: result.message }
  const body = result.body as { task?: unknown } | null
  const [task] = pickTaskRecords(body?.task ? [body.task] : [])
  if (!task) return { ok: false, code: COLLAB_ERROR_CODES.taskNotFound }
  return { ok: true, value: task }
}

/** 摘要视图：不含 content / report 全文（控制主管上下文），要看全文用 taskId 单查 */
export function toTaskSummary(task: CollabTaskRecord, roster: Map<string, RosterEntry>): CollabTaskSummary {
  const assignee = roster.get(task.toSessionId)
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    to: {
      sessionId: task.toSessionId,
      ...(assignee?.role ? { role: assignee.role } : {}),
    },
    from: task.fromSessionId,
    updatedAt: task.updatedAt,
    reworkCount: countReworks(task),
  }
}

/**
 * 带一次重连的请求（契约 §五：投递失败时立刻清缓存重新解析一次地址）。
 * 只对「网络层失败」（服务重启中/端口换了）重试，HTTP 业务错误不重试——
 * 后者重试没有意义，只会拖慢模型。
 */
export async function requestWithReconnect(
  server: CollabServerInfo,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  deps: CollabToolDeps = collabToolDeps(),
): Promise<{ result: CollabHttpResult; server: CollabServerInfo | null }> {
  const first = await collabRequest(server, method, path, body, deps)
  if (first.status !== 0) return { result: first, server }
  const refreshed = await getCollabServer(deps)
  if (!refreshed) return { result: first, server: null }
  const second = await collabRequest(refreshed, method, path, body, deps)
  return { result: second, server: second.status === 0 ? null : refreshed }
}

/**
 * HTTP 失败 → 契约错误码。只做「按状态码粗分类 + 关键文案识别」，
 * 具体上下文（派活/验收/汇报）再由各工具细化。
 */
export function classifyHttpFailure(result: CollabHttpResult): string {
  if (result.status === 0) return COLLAB_ERROR_CODES.serverUnreachable
  if (result.status === 404) {
    return /unknown api resource/i.test(result.message ?? '')
      ? COLLAB_ERROR_CODES.ledgerUnsupported
      : COLLAB_ERROR_CODES.taskNotFound
  }
  if (result.status === 409) return COLLAB_ERROR_CODES.notReviewable
  if (result.status === 403) return COLLAB_ERROR_CODES.invalidTarget
  return COLLAB_ERROR_CODES.badRequest
}

/** sessionId 形状（UUID v4 形态）——离线降级时用来判断 to 能否直接当地址用 */
export function looksLikeSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export type TargetResolution =
  | { ok: true; entry: RosterEntry }
  | { ok: false; code: string; message: string }

/**
 * 解析派活目标（契约 §4.1）：先按 sessionId 精确匹配，再按角色名匹配；
 * 目标是主管或自己一律本地拒绝（员工不互派，见用户裁决 2）。
 */
export function resolveDispatchTarget(
  to: string,
  roster: readonly RosterEntry[],
  selfSessionId: string,
): TargetResolution {
  if (to === selfSessionId) {
    return { ok: false, code: COLLAB_ERROR_CODES.invalidTarget, message: '不能把任务派给自己（to 就是本会话）。' }
  }
  const byId = roster.find((entry) => entry.sessionId === to)
  if (byId) return acceptEntry(byId)

  const byName = roster.filter((entry) => entry.role === to || entry.title === to)
  if (byName.length === 0) {
    return {
      ok: false,
      code: COLLAB_ERROR_CODES.notOnRoster,
      message: `花名册里没有 "${to}"（既不是会话 ID 也不是角色名）。先用 CollabListTasks 或查花名册确认目标，不要重试同一个目标。`,
    }
  }
  if (byName.length > 1) {
    const ids = byName.map((entry) => entry.sessionId).join('、')
    return {
      ok: false,
      code: COLLAB_ERROR_CODES.ambiguousTarget,
      message: `角色名 "${to}" 匹配到多个员工（${ids}），请改用具体 sessionId。`,
    }
  }
  return acceptEntry(byName[0])
}

function acceptEntry(entry: RosterEntry): TargetResolution {
  if (entry.supervisor) {
    return {
      ok: false,
      code: COLLAB_ERROR_CODES.invalidTarget,
      message: '目标是主管会话：员工不互派、主管之间也不派活，请派给执行角色的员工。',
    }
  }
  return { ok: true, entry }
}

/** 服务端响应里的 target 字段（只取会话忙碌标记，不含回合态） */
export type ResponseTargetState = { sessionId: string; busy?: boolean }

export function pickResponseTarget(raw: unknown): ResponseTargetState | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.sessionId !== 'string') return null
  return {
    sessionId: record.sessionId,
    ...(typeof record.busy === 'boolean' ? { busy: record.busy } : {}),
  }
}
