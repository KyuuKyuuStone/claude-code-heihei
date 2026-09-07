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
import { collabEnvironmentService } from '../services/collabEnvironmentService.js'
import { dispatchMailboxService } from '../services/dispatchMailboxService.js'
import {
  DISPATCH_PROTOCOL_MD,
  WORK_ORCHESTRATOR_SKILL_NAME,
} from '../../collaboration/dispatchProtocol.js'
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
        // 协作弹窗选择的模型/思考强度：写入会话元数据，员工被自动拉起时生效
        runtimeProviderId: body.runtimeProviderId as string | null | undefined,
        runtimeModelId: body.runtimeModelId as string | undefined,
        effortLevel: body.effortLevel as string | undefined,
      })
      const host = req.headers.get('host') || '127.0.0.1'

      // 新任命的主管：注入履新消息——主管的第一步默认是查看花名册、
      // 了解员工（角色与特性），然后等待用户命令。
      // 失败不阻塞任命本身（身份已落盘）。
      if (entry.supervisor && !previous?.supervisor) {
        void buildSupervisorOrientationAfterEnvCheck()
          .then((orientation) =>
            sessionMessenger.deliver(targetId, orientation, host),
          )
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
      // 花名册变化后收敛文件信箱监听目录（新增/移除员工的项目）
      void dispatchMailboxService.sync()
      return Response.json({ servant: entry })
    }

    // ── DELETE /api/servant-sessions/:sessionId ─────────────────────────
    if (method === 'DELETE' && sessionId) {
      await servantService.removeServant(decodeURIComponent(sessionId))
      void dispatchMailboxService.sync()
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

export type SupervisorOrientationEnv = {
  /** null = 外部 CLI 无法判断，按缺失处理（内联协议兜底） */
  skillAvailable: boolean | null
  shellOk: boolean
}

/**
 * 主管履新消息。不再无条件承诺"技能已对你生效"——技能是否存在由
 * collabEnvironmentService 实测：确认存在才引用技能，否则内联完整派活协议；
 * shell 不可用时明确告知主管改走文件信箱通道（2026-09 外部用户事故教训）。
 */
export function buildSupervisorOrientation(env: SupervisorOrientationEnv): string {
  const lines = [
    '【系统】你已被任命为本项目的主管。',
    '你的职责：接收用户命令 → 拆解任务 → 派给本项目的员工会话 → 验收汇报 → 继续安排，直到用户需求完成。',
    '',
    '现在请立即执行第一步——查看你的员工花名册（角色与角色特性）：',
    'curl -s "$CC_HEIHEI_DESKTOP_SERVER_URL/api/servant-sessions?forSession=$CC_HEIHEI_SESSION_ID"',
    '',
    '看完后用一两句话向用户报告你有哪些员工可用，然后等待用户命令。',
  ]

  if (env.skillAvailable) {
    lines.push(
      `派活、收汇报、验收的具体做法遵循 ${WORK_ORCHESTRATOR_SKILL_NAME} 技能；已确认你的 CLI 内置该技能（可用 /${WORK_ORCHESTRATOR_SKILL_NAME} 随时查看完整规范）。`,
    )
  } else {
    lines.push(
      `无法确认你的 CLI 是否内置 ${WORK_ORCHESTRATOR_SKILL_NAME} 技能（可能因版本较旧或使用外部 CLI），派活请直接按以下内联协议执行：`,
      '',
      DISPATCH_PROTOCOL_MD,
    )
  }

  if (!env.shellOk) {
    lines.push(
      '',
      '警告：本机未检测到可用的 Bash（Git Bash）。你的 Bash 工具很可能无法执行任何命令，' +
        '派活与汇报请直接使用上面协议中的「文件信箱」通道（只需 Write/Read 工具，不依赖 Bash），' +
        '并提示用户在「设置 → 诊断」运行环境体检。',
    )
  }

  return lines.join('\n')
}

/** 组装履新消息前的环境实测：结果只影响消息文案，失败不阻塞任命。 */
async function buildSupervisorOrientationAfterEnvCheck(): Promise<string> {
  const [skill, shell] = await Promise.all([
    collabEnvironmentService.checkWorkOrchestratorSkill().catch(() => ({ available: null as boolean | null })),
    Promise.resolve(collabEnvironmentService.checkShell()),
  ])
  return buildSupervisorOrientation({
    skillAvailable: skill.available,
    shellOk: shell.ok,
  })
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
