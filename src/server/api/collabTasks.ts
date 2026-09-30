/**
 * 协作任务台账 REST（v1.6.0，L4 传输层——只做编解码与路由，不含业务）。
 *
 * 路径为 /api/collab-tasks 而**不是**规划里写的 /api/tasks：后者已被上游 CLI 的
 * agents/tasks 处理器占用（src/server/router.ts 的 `case 'tasks'` → handleAgentsApi，
 * 背后是 CLI Task V2 的 ~/.claude/tasks/<listId>/）。同名会互相吞路由，故协作
 * 台账独立命名，语义也更清晰。此偏离在完工汇报里已向主管说明。
 *
 *   GET  /api/collab-tasks?project=<dir>|forSessionId=<id>&status=<status>
 *   GET  /api/collab-tasks/:id
 *   POST /api/collab-tasks                    — 显式建任务（幂等键 body.id）
 *   POST /api/collab-tasks/:id/report         — 员工交付 { summary, deliverables? }
 *   POST /api/collab-tasks/:id/review         — 主管验收 { verdict: pass|rework, note? }
 */

import * as path from 'path'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { collabTaskService, isTaskStatus, type Task } from '../services/collabTaskService.js'
import { servantService } from '../services/servantService.js'
import { sessionService } from '../services/sessionService.js'

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown
    if (!body || typeof body !== 'object') {
      throw ApiError.badRequest('Request body must be a JSON object')
    }
    return body as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('Invalid JSON body')
  }
}

/**
 * 解析任务所属项目目录：优先显式 project，其次 forSessionId / toSessionId
 * 的会话工作目录（派活场景调用方只会给会话 id）。
 */
async function resolveProjectDir(input: {
  project?: unknown
  forSessionId?: unknown
}): Promise<string> {
  const project = typeof input.project === 'string' ? input.project.trim() : ''
  if (project) return path.resolve(project)

  const sessionId = typeof input.forSessionId === 'string' ? input.forSessionId.trim() : ''
  if (sessionId) {
    const workDir = await sessionService.getSessionWorkDir(sessionId).catch(() => null)
    if (!workDir) {
      throw ApiError.notFound(`Session not found or has no workDir: ${sessionId}`)
    }
    return path.resolve(workDir)
  }

  throw ApiError.badRequest('Either "project" or "forSessionId" is required')
}

export async function handleCollabTasksApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const taskId = segments[2]
    const action = segments[3]

    // ── GET /api/collab-tasks ───────────────────────────────────────────
    if (method === 'GET' && !taskId) {
      const statusParam = url.searchParams.get('status')?.trim()
      if (statusParam && !isTaskStatus(statusParam)) {
        throw ApiError.badRequest(`Unknown task status: ${statusParam}`)
      }
      const projectParam =
        url.searchParams.get('project') || url.searchParams.get('forSessionId') || undefined
      const projectDir = projectParam
        ? await resolveProjectDir(
            url.searchParams.get('project')
              ? { project: projectParam }
              : { forSessionId: projectParam },
          )
        : undefined
      const tasks = await collabTaskService.listTasks({
        ...(projectDir ? { projectDir } : {}),
        ...(statusParam ? { status: statusParam } : {}),
      })
      return Response.json({ tasks })
    }

    // ── GET /api/collab-tasks/:id ───────────────────────────────────────
    if (method === 'GET' && taskId && !action) {
      const task = await collabTaskService.getTask(decodeURIComponent(taskId))
      if (!task) throw ApiError.notFound(`Task not found: ${taskId}`)
      return Response.json({ task })
    }

    // ── POST /api/collab-tasks ──────────────────────────────────────────
    if (method === 'POST' && !taskId) {
      const body = await parseJsonBody(req)
      const toSessionId = typeof body.toSessionId === 'string' ? body.toSessionId.trim() : ''
      const fromSessionId = typeof body.fromSessionId === 'string' ? body.fromSessionId.trim() : ''
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const content = typeof body.content === 'string' ? body.content : ''
      if (!toSessionId) throw ApiError.badRequest('Field "toSessionId" is required')
      if (!fromSessionId) throw ApiError.badRequest('Field "fromSessionId" is required')
      if (!title) throw ApiError.badRequest('Field "title" is required')

      const projectDir = await resolveProjectDir({
        project: body.project,
        // 未显式给项目时按接收方会话的工作目录归档
        forSessionId: body.project ? undefined : (body.forSessionId ?? toSessionId),
      })
      const task = await collabTaskService.createTask({
        ...(typeof body.id === 'string' && body.id.trim() ? { id: body.id.trim() } : {}),
        projectDir,
        fromSessionId,
        toSessionId,
        title,
        content,
      })
      return Response.json({ task })
    }

    // ── POST /api/collab-tasks/:id/report ───────────────────────────────
    if (method === 'POST' && taskId && action === 'report') {
      const body = await parseJsonBody(req)
      const summary = typeof body.summary === 'string' ? body.summary : ''
      if (!summary.trim()) throw ApiError.badRequest('Field "summary" is required')
      const deliverables = Array.isArray(body.deliverables)
        ? body.deliverables.filter((item): item is string => typeof item === 'string')
        : undefined
      const id = decodeURIComponent(taskId)
      // v1.6.0 CLI 契约 §三：带 callerSessionId 时校验调用方身份，闭合审查「低 1」。
      // 不带时维持现状（兼容旧调用方），v1.7 再改成必填。
      const callerSessionId = readCallerSessionId(body)
      if (callerSessionId) {
        const existing = await collabTaskService.getTask(id)
        // 任务不存在交给 reportTask 抛 404；存在但不是派给调用方 → 403
        if (existing && existing.toSessionId !== callerSessionId) {
          throw new ApiError(403, 'callerSessionId is not the assignee of this task', 'FORBIDDEN')
        }
      }
      const task = await collabTaskService.reportTask(id, {
        summary,
        ...(deliverables ? { deliverables } : {}),
      })
      return Response.json({ task })
    }

    // ── POST /api/collab-tasks/:id/review ───────────────────────────────
    if (method === 'POST' && taskId && action === 'review') {
      const body = await parseJsonBody(req)
      const verdict = body.verdict
      if (verdict !== 'pass' && verdict !== 'rework') {
        throw ApiError.badRequest('Field "verdict" must be "pass" or "rework"')
      }
      const note = typeof body.note === 'string' ? body.note : undefined
      const id = decodeURIComponent(taskId)
      const callerSessionId = readCallerSessionId(body)
      if (callerSessionId) {
        const existing = await collabTaskService.getTask(id)
        if (existing && !(await isAllowedReviewer(existing, callerSessionId))) {
          throw new ApiError(
            403,
            'callerSessionId is neither the dispatcher nor the current supervisor of this task',
            'FORBIDDEN',
          )
        }
      }
      const task = await collabTaskService.reviewTask(id, {
        verdict,
        ...(note ? { note } : {}),
      })
      return Response.json({ task })
    }

    throw new ApiError(
      405,
      `Method ${method} not allowed on /api/collab-tasks${taskId ? `/${taskId}` : ''}`,
      'METHOD_NOT_ALLOWED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}

/** body.callerSessionId 的读取（契约 §三）：缺省/空白视为「未带」，维持旧行为 */
function readCallerSessionId(body: Record<string, unknown>): string {
  return typeof body.callerSessionId === 'string' ? body.callerSessionId.trim() : ''
}

/**
 * review 的调用方是否合法验收人（契约 §三）：
 * - 派活人 task.fromSessionId 本人；或
 * - 该任务所属项目**现任**主管——交接后新主管可以验收旧任务。
 * 其余一律拒绝（403），用来闭合审查「低 1」：此前 report/review 不校验调用者身份。
 */
async function isAllowedReviewer(task: Task, callerSessionId: string): Promise<boolean> {
  if (task.fromSessionId === callerSessionId) return true
  const supervisor = await servantService.findSupervisorForProject(task.projectDir)
  return supervisor?.sessionId === callerSessionId
}
