/**
 * 协作上下文快照 REST（v1.6.1，架构裁决：架构决策_上下文自动续接.md §二）。
 *
 *   GET /api/collab-context?sessionId=<self>
 *
 * 只读。服务端组装结构化数据，CLI 按固定模板渲染成 compact 续接卡片。
 * 一次请求拿全，减少关键路径往返。
 *
 * 权威源是台账与花名册，绝不读会话回合态——返回字段走白名单，因此天然不含
 * running / turnInProgress / busy / phase 之类字样（有测试静态扫描）。
 *
 * 按调用者身份裁剪：
 *   主管：花名册（角色 → sessionId，不带 description）+ 本项目未结任务
 *        （最多 10 条，delivered 待验收优先；只对 rework 条目附最近一次 note，
 *         绝不放任务正文）
 *   员工：只返回自己的未结任务（最多 5 条），外加 currentTask（那一条的
 *         正文前 800 码点与最近一次返工 note），其余条目只有标题。
 *
 * 未知 sessionId / 不在册：返回明确的 404，而不是拿空数据套壳——CLI 会据此
 * 走「仅身份卡」降级，不能让它误以为是「你确实没有任务」。
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { COLLAB_RULES_DIGEST } from '../../collaboration/dispatchProtocol.js'
import {
  collabTaskService,
  type Task,
  type TaskStatus,
} from '../services/collabTaskService.js'
import { servantService } from '../services/servantService.js'
import { sessionService } from '../services/sessionService.js'

/** 主管卡片最多列出的未结任务条数（§一 表格） */
export const COLLAB_CONTEXT_SUPERVISOR_TASK_LIMIT = 10
/** 员工卡片最多列出的未结任务条数 */
export const COLLAB_CONTEXT_SERVANT_TASK_LIMIT = 5
/** currentTask 正文截断码点数（§一 表格：前 800 码点） */
export const COLLAB_CONTEXT_CURRENT_TASK_CONTENT_MAX = 800

/** delivered（待验收）排最前，其余按 updatedAt 倒序 */
const STATUS_PRIORITY: Record<string, number> = {
  delivered: 0,
  rework: 1,
  in_progress: 2,
  accepted: 3,
  dispatched: 4,
}

const OPEN_STATUSES = new Set<TaskStatus>(['dispatched', 'accepted', 'in_progress', 'rework', 'delivered'])

function countReworks(task: Task): number {
  return task.history.filter((entry) => entry.to === 'rework').length
}

/** 最近一次返工的 note（history 里最后一条 to='rework' 且带 note 的记录） */
function lastReworkNote(task: Task): string | undefined {
  for (let i = task.history.length - 1; i >= 0; i -= 1) {
    const entry = task.history[i]!
    if (entry.to === 'rework' && entry.note) return entry.note
  }
  return undefined
}

function countByStatus(tasks: Task[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1
  }
  return counts
}

function sortOpenTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 99
    const pb = STATUS_PRIORITY[b.status] ?? 99
    if (pa !== pb) return pa - pb
    return b.updatedAt - a.updatedAt
  })
}

/** 主管视角的条目：有 taskId/status/reworkCount，只有 rework 附带 note，无正文 */
function toSupervisorItem(task: Task, roleOf: (sessionId: string) => string | undefined) {
  const note = lastReworkNote(task)
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    toRole: roleOf(task.toSessionId),
    updatedAt: new Date(task.updatedAt).toISOString(),
    reworkCount: countReworks(task),
    ...(task.status === 'rework' && note ? { lastReworkNote: note } : {}),
  }
}

/** 员工视角的条目：自己的任务，含来自谁 */
function toServantItem(task: Task) {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    fromSessionId: task.fromSessionId,
    updatedAt: new Date(task.updatedAt).toISOString(),
    reworkCount: countReworks(task),
  }
}

/** currentTask：优先 in_progress，其次 rework，其次 accepted（§一 表格） */
function pickCurrentTask(tasks: Task[]): Task | undefined {
  for (const status of ['in_progress', 'rework', 'accepted'] as const) {
    const hit = tasks.find((task) => task.status === status)
    if (hit) return hit
  }
  return undefined
}

export async function handleCollabContextApi(req: Request, url: URL): Promise<Response> {
  try {
    if (req.method !== 'GET') {
      throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    }
    const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
    if (!sessionId) {
      throw ApiError.badRequest('Query parameter "sessionId" is required')
    }

    const entry = await servantService.getServant(sessionId).catch(() => null)
    const workDir = await sessionService.getSessionWorkDir(sessionId).catch(() => null)
    if (!entry || !workDir) {
      // 明确失败，不套空数据：CLI 据此走「仅身份卡」降级
      throw ApiError.notFound(`Unknown collaborator session: ${sessionId}`)
    }

    const isSupervisor = entry.supervisor === true
    // 只统计本项目、且只统计未结任务
    const all = await collabTaskService.listTasks({ projectDir: workDir })
    const open = all.filter((task) => OPEN_STATUSES.has(task.status))
    const counts = countByStatus(open)
    const snapshotAt = new Date().toISOString()

    if (isSupervisor) {
      const servants = await servantService.listServants({ forSessionId: sessionId })
      const roleById = new Map(servants.map((s) => [s.sessionId, s.role]))
      const openSorted = sortOpenTasks(open)
      const page = openSorted.slice(0, COLLAB_CONTEXT_SUPERVISOR_TASK_LIMIT)
      return Response.json(
        {
          role: entry.role ?? '',
          supervisor: true,
          ...(entry.description ? { description: entry.description } : {}),
          rulesDigest: COLLAB_RULES_DIGEST,
          // 花名册精简版：角色 → sessionId，不带 description
          roster: servants.map((s) => ({
            role: s.role ?? '',
            sessionId: s.sessionId,
            ...(s.supervisor !== undefined ? { supervisor: s.supervisor } : {}),
          })),
          tasks: {
            counts,
            items: page.map((task) => toSupervisorItem(task, (id) => roleById.get(id))),
            truncated: Math.max(0, openSorted.length - page.length),
          },
          snapshotAt,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    // 员工：只看自己的任务
    const mine = open.filter((task) => task.toSessionId === sessionId)
    const mineSorted = sortOpenTasks(mine)
    const page = mineSorted.slice(0, COLLAB_CONTEXT_SERVANT_TASK_LIMIT)
    const current = pickCurrentTask(mine)
    const currentNote = current ? lastReworkNote(current) : undefined

    return Response.json(
      {
        role: entry.role ?? '',
        supervisor: false,
        ...(entry.description ? { description: entry.description } : {}),
        tasks: {
          counts: countByStatus(mine),
          items: page.map(toServantItem),
          truncated: Math.max(0, mineSorted.length - page.length),
        },
        ...(current
          ? {
              currentTask: {
                taskId: current.id,
                title: current.title,
                status: current.status,
                fromSessionId: current.fromSessionId,
                content: Array.from(current.content).slice(0, COLLAB_CONTEXT_CURRENT_TASK_CONTENT_MAX).join(''),
                contentTruncated:
                  Array.from(current.content).length > COLLAB_CONTEXT_CURRENT_TASK_CONTENT_MAX,
                ...(currentNote ? { lastReworkNote: currentNote } : {}),
              },
            }
          : {}),
        snapshotAt,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return errorResponse(error)
  }
}
