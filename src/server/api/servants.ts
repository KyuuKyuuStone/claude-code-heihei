/**
 * Servant Sessions & Session Messages REST API — 会话级上下级协作
 *
 * GET    /api/servant-sessions              — 员工花名册（服务其他会话的会话列表）
 * PUT    /api/servant-sessions/:sessionId   — 设置会话协作身份 {role?, enabled}
 * DELETE /api/servant-sessions/:sessionId   — 移除协作身份
 *
 * POST   /api/session-messages              — 会话间消息投递
 *         {targetSessionId, content, fromSessionId?}
 *         主管给员工派活、员工给主管汇报共用此端点。
 */

import { servantService } from '../services/servantService.js'
import { sessionMessenger } from '../services/sessionMessenger.js'
import { sessionService } from '../services/sessionService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

export async function handleServantsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const sessionId = segments[2] // /api/servant-sessions/:sessionId

    // ── GET /api/servant-sessions ───────────────────────────────────────
    // 默认只返回 enabled 的花名册（主管找员工）；?all=1 返回全部（UI 徽标）
    // ?forSession=<id> 项目隔离：只返回与该会话同项目的员工
    if (method === 'GET' && !sessionId) {
      const servants = await servantService.listServants({
        includeAll: url.searchParams.get('all') === '1',
        forSessionId: url.searchParams.get('forSession') || undefined,
      })
      return Response.json({ servants })
    }

    // ── PUT /api/servant-sessions/:sessionId ────────────────────────────
    if (method === 'PUT' && sessionId) {
      const body = await parseJsonBody(req)
      const targetId = decodeURIComponent(sessionId)
      const previous = await servantService.getServant(targetId)
      const entry = await servantService.setServant(targetId, {
        role: body.role as string | undefined,
        description: body.description as string | undefined,
        enabled: body.enabled as boolean,
        supervisor: body.supervisor as boolean | undefined,
      })
      const host = req.headers.get('host') || '127.0.0.1'

      // 新任命的主管：注入履新消息——主管的第一步默认是查看花名册、
      // 了解员工（角色与特性），然后等待用户命令。
      // 失败不阻塞任命本身（身份已落盘）。
      if (entry.supervisor && !previous?.supervisor) {
        void sessionMessenger
          .deliver(targetId, buildSupervisorOrientation(), host)
          .catch((error) => {
            console.error(
              `[Servants] Failed to deliver supervisor orientation to ${targetId}:`,
              error,
            )
          })
      }

      // 员工首次登记（enabled 从 false/未登记 变为 true）：
      // 1) 注入上岗消息——会话从此有内容、会落盘，关闭不再消失，
      //    员工一启动就明确自己的角色与职责；
      // 2) 通知同项目的主管——有新员工加入了。
      // 失败不阻塞登记本身（身份已落盘）。
      if (entry.enabled && !previous?.enabled) {
        void sessionMessenger
          .deliver(
            targetId,
            buildWorkerOrientation(entry.role, entry.description),
            host,
          )
          .catch((error) => {
            console.error(
              `[Servants] Failed to deliver worker orientation to ${targetId}:`,
              error,
            )
          })
        void notifySupervisorOfNewWorker(entry, host)
      }
      return Response.json({ servant: entry })
    }

    // ── DELETE /api/servant-sessions/:sessionId ─────────────────────────
    if (method === 'DELETE' && sessionId) {
      await servantService.removeServant(decodeURIComponent(sessionId))
      return Response.json({ ok: true })
    }

    throw new ApiError(
      405,
      `Method ${method} not allowed on /api/servant-sessions${sessionId ? `/${sessionId}` : ''}`,
      'METHOD_NOT_ALLOWED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}

export async function handleSessionMessagesApi(
  req: Request,
  _url: URL,
  _segments: string[],
): Promise<Response> {
  try {
    // ── POST /api/session-messages ──────────────────────────────────────
    if (req.method === 'POST') {
      const body = await parseJsonBody(req)
      const targetSessionId = body.targetSessionId as string
      const fromSessionId = body.fromSessionId as string | undefined

      // 项目隔离（模式 A）：向员工会话派活时，发送方必须与员工同项目。
      // 员工向主管汇报不受此限（主管不是 enabled 员工）。
      if (fromSessionId && targetSessionId) {
        const target = await servantService.getServant(targetSessionId)
        if (target?.enabled) {
          const [fromWorkDir, targetWorkDir] = await Promise.all([
            sessionService.getSessionWorkDir(fromSessionId),
            sessionService.getSessionWorkDir(targetSessionId),
          ])
          if (fromWorkDir && targetWorkDir && fromWorkDir !== targetWorkDir) {
            throw ApiError.conflict(
              `Cross-project dispatch is not allowed: sender is in ${fromWorkDir}, worker is in ${targetWorkDir}`,
            )
          }
        }
      }

      const delivered = await sessionMessenger.deliver(
        targetSessionId,
        body.content as string,
        req.headers.get('host') || '127.0.0.1',
      )
      if (!delivered) {
        throw ApiError.internal('Message could not be delivered to the session')
      }
      return Response.json({ ok: true }, { status: 201 })
    }

    throw new ApiError(405, `Method ${req.method} not allowed on /api/session-messages`, 'METHOD_NOT_ALLOWED')
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function buildSupervisorOrientation(): string {
  return [
    '【系统】你已被任命为本项目的主管。',
    '你的职责：接收用户命令 → 拆解任务 → 派给本项目的员工会话 → 验收汇报 → 继续安排，直到用户需求完成。',
    '',
    '现在请立即执行第一步——查看你的员工花名册（角色与角色特性）：',
    'curl -s "$CC_HEIHEI_DESKTOP_SERVER_URL/api/servant-sessions?forSession=$CC_HEIHEI_SESSION_ID"',
    '',
    '看完后用一两句话向用户报告你有哪些员工可用，然后等待用户命令。',
    '派活、收汇报、验收的具体做法遵循 work-orchestrator 技能；该技能已对你生效。',
  ].join('\n')
}

function buildWorkerOrientation(role?: string, description?: string): string {
  const roleLine = role
    ? `你的角色：${role}${description ? `——${description}` : ''}`
    : '你的角色：协作员工（未填写具体角色）'
  return [
    '【系统】你已被登记为本项目的协作员工。',
    roleLine,
    '等待主管派活：主管派来的任务会自动出现在你的会话里。',
    '收到派活任务后，立即开始执行，先回复一句确认（如"收到，开始执行"）再干活，不要等待用户确认。',
    '完工后按派活消息里的要求，用一条命令向主管汇报（写一句话结果 + 产出文件路径）。',
  ].join('\n')
}

async function notifySupervisorOfNewWorker(
  entry: { sessionId: string; role?: string; description?: string },
  host: string,
): Promise<void> {
  try {
    const all = await servantService.listServants({
      includeAll: true,
      forSessionId: entry.sessionId,
    })
    const supervisor = all.find((s) => s.supervisor)
    if (!supervisor || supervisor.sessionId === entry.sessionId) return

    const roleText = entry.role
      ? `${entry.role}（${entry.description || '未填写特性'}）`
      : '未命名角色'
    await sessionMessenger.deliver(
      supervisor.sessionId,
      `【系统】新员工已加入本项目：${roleText}。花名册已更新，你现在可以给这位员工派活了。`,
      host,
    )
  } catch (error) {
    console.error(
      `[Servants] Failed to notify supervisor about new worker ${entry.sessionId}:`,
      error,
    )
  }
}
