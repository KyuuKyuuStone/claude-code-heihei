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

import * as crypto from 'node:crypto'
import { servantService } from '../services/servantService.js'
import { conversationService } from '../services/conversationService.js'
import { sessionMessenger } from '../services/sessionMessenger.js'
import { sessionService } from '../services/sessionService.js'
import { collabEnvironmentService } from '../services/collabEnvironmentService.js'
import { dispatchMailboxService } from '../services/dispatchMailboxService.js'
import { isTombstoned } from '../services/sessionRegistry.js'
import { forgetReceipt, getReceipt, listReceipts, recordDelivery } from '../services/dispatchReceiptService.js'
import { diagnosticsService } from '../services/diagnosticsService.js'
import {
  CORE_INLINE_TOOLS_TEXT,
  DISPATCH_PROTOCOL_MD,
  SERVER_ADDRESS_STALENESS_NOTE,
  WORK_ORCHESTRATOR_SKILL_NAME,
} from '../../collaboration/dispatchProtocol.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { collabTaskService } from '../services/collabTaskService.js'
import { withBroadcastLock } from '../services/broadcastLock.js'
import { appendReportFooter, resolveReportTarget } from '../services/reportTargetResolver.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'

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
      // rosterTable：与 JSON 同源的渲染表，供便宜模型直接照表选人（v1.6.0）
      return Response.json({ servants, rosterTable: renderRosterTable(servants) })
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
        // 约束档位：readonly=只读观察；whitelist=目录白名单（writeDirs 必填，真校验在 service 层）。
        // 三态透传（v1.6.0）：传值设档 / null 清除约束（恢复完全执行，writeDirs 一并清空）/ 不传继承旧档。
        constraint: body.constraint as 'readonly' | 'whitelist' | null | undefined,
        writeDirs: body.writeDirs as string[] | undefined,
      })
      const host = req.headers.get('host') || '127.0.0.1'

      // 新任命的主管：注入履新消息——主管的第一步默认是查看花名册、
      // 了解员工（角色与特性），然后等待用户命令。
      // 失败不阻塞任命本身（身份已落盘）。
      if (entry.supervisor && !previous?.supervisor) {
        void buildSupervisorOrientationAfterEnvCheck(targetId, `http://${host}`)
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
            buildWorkerOrientation(entry.role, entry.description, targetId, `http://${host}`),
            host,
          )
          .catch((error) => {
            console.error(
              `[Servants] Failed to deliver worker orientation to ${targetId}:`,
              error,
            )
          })
        void notifySupervisorOfNewWorker(entry)
      }
      // 花名册变化后收敛文件信箱监听目录（新增/移除员工的项目）
      void dispatchMailboxService.sync()
      // 协作身份变化（任命/卸任/改角色）：清主管标记缓存，下次会话启动按最新身份收权
      conversationService.invalidateSupervisorCache(targetId)
      return Response.json({ servant: entry })
    }

    // ── DELETE /api/servant-sessions/:sessionId ─────────────────────────
    if (method === 'DELETE' && sessionId) {
      const targetId = decodeURIComponent(sessionId)
      const removed = await servantService.removeServant(targetId)
      // 与 PUT 对齐：清协作身份缓存，否则被删员工（含 readonly/whitelist/主管
      // 身份）的会话重启后仍按旧身份注入收权 env——删除未真正生效到运行时
      conversationService.invalidateSupervisorCache(targetId)
      // 移除留痕（对称 servant_registered；workDir 会话通常仍在，可查则附上）
      const workDir = await sessionService
        .getSessionWorkDir(targetId)
        .catch(() => null)
      void diagnosticsService
        .recordEvent({
          type: 'servant_removed',
          severity: 'info',
          summary: `员工已移除：${
            removed.role ? `${removed.role}（${removed.description || '未填写特性'}）` : '未命名角色'
          }`,
          sessionId: targetId,
          details: {
            sessionId: targetId,
            role: removed.role,
            description: removed.description,
            ...(workDir ? { workDir } : {}),
            ...(removed.constraint ? { constraint: removed.constraint } : {}),
            ...(removed.supervisor !== undefined ? { supervisor: removed.supervisor } : {}),
            reason: 'explicit-delete',
          },
        })
        .catch(() => {})
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
  url: URL,
  _segments: string[],
): Promise<Response> {
  try {
    // ── GET /api/session-messages ───────────────────────────────────────
    // 查询派活回执：?messageId=<投递响应返回的 id> 或 ?targetSessionId=<看该目标最近的回执>
    if (req.method === 'GET') {
      const messageId = url.searchParams.get('messageId')?.trim()
      if (messageId) {
        const receipt = getReceipt(messageId)
        if (!receipt) throw ApiError.notFound(`Unknown message id: ${messageId}`)
        return Response.json({ ok: true, receipt })
      }
      const targetSessionId = url.searchParams.get('targetSessionId')?.trim()
      if (targetSessionId) {
        return Response.json({ ok: true, receipts: listReceipts(targetSessionId).slice(0, 20) })
      }
      throw ApiError.badRequest('Provide either "messageId" or "targetSessionId"')
    }

    // ── POST /api/session-messages ──────────────────────────────────────
    if (req.method === 'POST') {
      const body = await parseJsonBody(req)

      // 广播：一条消息发给本项目全部 enabled 员工（不含发送者自己）
      if (body.broadcast === true) {
        return await handleBroadcast(req, body)
      }

      const requestedTargetId = body.targetSessionId as string
      const fromSessionId = body.fromSessionId as string | undefined
      const explicitTaskId = typeof body.taskId === 'string' ? body.taskId.trim() : ''

      if (typeof requestedTargetId !== 'string' || !requestedTargetId.trim()) {
        throw ApiError.badRequest('Field "targetSessionId" is required')
      }

      // v1.6.0（决策 D）：员工汇报的收件人以**任务台账**为准，请求正文里的地址
      // 只作参考。解析发生在校验之前——解析出的新目标可能比原目标更权威，若原
      // 目标已失效（例如旧主管卸任），不该先拿它报 404。
      // 主管派活、用户会话发消息不会被解析，行为与之前完全一致。
      const resolution = await resolveReportTarget({
        targetSessionId: requestedTargetId,
        ...(fromSessionId ? { fromSessionId } : {}),
        ...(explicitTaskId ? { taskId: explicitTaskId } : {}),
      })
      const targetSessionId = resolution.targetSessionId

      if (resolution.redirectedFrom) {
        // 改投属于「替用户做决定」，必须全程可审计：诊断事件 + 响应字段。
        logForDiagnosticsNoPII('info', 'collab_report_redirected', {
          requestedTarget: resolution.redirectedFrom,
          resolvedTarget: targetSessionId,
          resolvedBy: resolution.resolvedBy ?? 'unknown',
          workerSessionId: fromSessionId ?? 'unknown',
        })
        void diagnosticsService
          .recordEvent({
            type: 'collab_report_redirected',
            severity: 'info',
            summary: `员工汇报改投：${resolution.redirectedFrom} → ${targetSessionId}`,
            sessionId: targetSessionId,
            details: {
              requestedTarget: resolution.redirectedFrom,
              resolvedTarget: targetSessionId,
              resolvedBy: resolution.resolvedBy,
              workerSessionId: fromSessionId ?? null,
              taskId: explicitTaskId || null,
            },
          })
          .catch(() => {})
      } else if (resolution.warning) {
        // 多来源歧义等：只告警不改投（规则只在台账证据明确时生效）。
        logForDiagnosticsNoPII('warn', 'collab_report_target_ambiguous', {
          requestedTarget: requestedTargetId,
          warning: resolution.warning,
        })
      }

      // 目标不在花名册 → 可行动 404（原先 deliver 失败报 500，主管无法区分
      // 「会话没跑」与「目标已移除」）。主管也在花名册（getServant 非 null），
      // 员工→主管汇报天然放行；被禁用员工仍在册，同样放行（与既有语义一致）。
      // 走到这里说明解析没有更好的人选——沿用原目标校验，不凭空编造收件人。
      const rosterTarget = await servantService.getServant(targetSessionId)
      if (!rosterTarget) {
        throw ApiError.notFound(
          `Target session is not on the roster: ${targetSessionId}. It was removed or never registered — fetch /api/servant-sessions to see current workers, then reassign; do not retry the same target.`,
        )
      }

      // tombstone 短路（v1.3.0 阶段3 · 6a 操作类）：仅拦**显式删除**（tombstone）
      // 的会话，直接拒绝投递，不再往下查磁盘元数据（防软删除会话复活/接收派活）。
      // 不能用 !exists()：registry 内存态、启动不重放，重启后存量会话全为
      // 「未登记」态，exists() 会对其返回 false 而误拦存活员工（v1.3.0 回归）。
      if (isTombstoned(targetSessionId)) {
        throw ApiError.notFound(`Session not found: ${targetSessionId}`)
      }

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

      // 消费回执：投递成功 ≠ 目标已消费。先登记再发送（目标可能极快地处理完并产出
      // 活动信号，晚登记会把信号漏在门外）；发送失败/未送达则撤回，避免留下假回执。
      const messageId = crypto.randomUUID()
      recordDelivery({
        messageId,
        targetSessionId,
        ...(fromSessionId ? { fromSessionId } : {}),
      })
      // v1.6.0（决策 D）：这一条到底是「派活」还是「员工汇报」？
      // 只有派活才①追加系统页脚②记台账。汇报（resolveReportTarget 判定）与
      // 目标是主管的消息都不是派活——后者正是「给主管的每条汇报都凭空造出一条
      // dispatched 任务」那个缺陷的源头。
      const isDispatch =
        rosterTarget.enabled && !rosterTarget.supervisor && !resolution.isReport
      const dispatchTaskId = isDispatch ? explicitTaskId || crypto.randomUUID() : ''
      const content = String(body.content ?? '')

      let sent = false
      try {
        sent = await sessionMessenger.deliver(
          targetSessionId,
          isDispatch
            ? appendReportFooter(content, dispatchTaskId, fromSessionId ?? '')
            : content,
          req.headers.get('host') || '127.0.0.1',
        )
      } catch (error) {
        forgetReceipt(messageId)
        throw error
      }
      if (!sent) {
        forgetReceipt(messageId)
        throw ApiError.internal('Message could not be delivered to the session')
      }
      // 派活投递成功 → 任务台账 dispatched（规划 3.1「投递成功→dispatched」）。
      // 幂等键 = taskId；台账失败不阻塞投递（投递是主线）。
      const trackedTaskId = isDispatch
        ? await collabTaskService.recordDispatch({
            toSessionId: targetSessionId,
            ...(fromSessionId ? { fromSessionId } : {}),
            content,
            taskId: dispatchTaskId,
            ...(typeof body.title === 'string' ? { title: body.title } : {}),
          })
        : null
      // 撞车提醒：目标忙（运行中且最近 3 分钟有活动）时在响应里声明，
      // 主管 AI 可据此决定排队等待或改派他人
      const targetState = await describeTargetState(targetSessionId)
      return Response.json(
        {
          ok: true,
          // 消费回执：投递成功 ≠ 目标已消费。用 GET /api/session-messages?messageId=<id>
          // 轮询 consumed 字段，确认目标是否真的接住了活（不必只靠等汇报）。
          messageId,
          // 派活场景回传 taskId：主管可据此 ReviewTask/查台账；汇报场景为 undefined
          ...(trackedTaskId ? { taskId: trackedTaskId } : {}),
          // 改投审计（决策 D）：员工汇报被服务端改投时，这里说明原目标与依据。
          ...(resolution.redirectedFrom
            ? {
                redirectedFrom: resolution.redirectedFrom,
                resolvedBy: resolution.resolvedBy,
              }
            : {}),
          target: { sessionId: targetSessionId, ...targetState },
        },
        { status: 201 },
      )
    }

    throw new ApiError(405, `Method ${req.method} not allowed on /api/session-messages`, 'METHOD_NOT_ALLOWED')
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** 目标会话忙闲：运行中且最近 3 分钟有 transcript 活动 = busy（撞车提醒用） */
async function describeTargetState(
  targetSessionId: string,
): Promise<{ busy: boolean; lastActivityAt?: string }> {
  const servantInfo = (await servantService
    .listServants({ includeAll: true })
    .catch(() => [])) as Array<{ sessionId: string; running: boolean; lastActivityAt?: string }>
  const info = servantInfo.find((entry) => entry.sessionId === targetSessionId)
  if (info) {
    const staleMs = info.lastActivityAt ? Date.now() - Date.parse(info.lastActivityAt) : Infinity
    return { busy: Boolean(info.running) && staleMs < 180_000, lastActivityAt: info.lastActivityAt }
  }
  return { busy: conversationService.hasSession(targetSessionId) }
}

/** 广播：body {broadcast:true, content, fromSessionId} → 本项目全部 enabled 员工 */
/** 广播里单个目标的投递结果（裁决二第 6 条的 targets[] 元素） */
type BroadcastTargetResult = {
  sessionId: string
  role?: string
  taskId?: string
  messageId?: string
  delivered: boolean
  error?: string
}

/**
 * 广播：`{broadcast:true, content, fromSessionId, broadcastId?}`。
 *
 * 裁决二（2026-09-30）：广播 = **N 条独立单播派活**的语法糖。每个目标单独投递、
 * 单独记账（各自独立的 taskId 与台账记录，broadcastId 只作关联），各自 report/review
 * 互不影响。与单播走同一套 recordDispatch / appendReportFooter，不另起一套。
 */
async function handleBroadcast(req: Request, body: Record<string, unknown>): Promise<Response> {
  const fromSessionId = typeof body.fromSessionId === 'string' ? body.fromSessionId.trim() : ''
  const content = typeof body.content === 'string' ? body.content : ''
  if (!fromSessionId) {
    throw ApiError.badRequest('Field "fromSessionId" is required for broadcast')
  }
  if (!content.trim()) {
    throw ApiError.badRequest('Field "content" is required for broadcast')
  }

  // 裁决二第 5 条：请求体可带 broadcastId 做幂等。注意区分「显式传入」与「自动生成」——
  // 只有显式传入才需要串行化（裁决三）；自动生成的 UUID 每次不同，加锁没有意义。
  const explicitBroadcastId =
    typeof body.broadcastId === 'string' && body.broadcastId.trim() ? body.broadcastId.trim() : ''
  const broadcastId = explicitBroadcastId || crypto.randomUUID()

  // 裁决三：显式 broadcastId 时才进临界区。整段「查幂等记录 → 逐目标投递 → 成功记账」
  // 必须原子，否则并发的两个同 ID 请求会各自查出「还没有任务」而重复投递、重复记账。
  if (explicitBroadcastId) {
    return withBroadcastLock(`broadcast:${broadcastId}`, () =>
      runBroadcast(req, { fromSessionId, content, broadcastId }),
    )
  }
  return runBroadcast(req, { fromSessionId, content, broadcastId })
}

async function runBroadcast(
  req: Request,
  input: { fromSessionId: string; content: string; broadcastId: string },
): Promise<Response> {
  const { fromSessionId, content, broadcastId } = input

  // 裁决二第 1 条：只有主管和非员工会话（如用户会话）可以广播。在册的非主管员工
  // 发起广播返回 403——员工广播没有明确的派活语义，还会把汇报散发给所有人。
  const sender = await servantService.getServant(fromSessionId)
  if (sender?.enabled && !sender.supervisor) {
    throw new ApiError(403, '员工不能广播，请汇报给主管', 'FORBIDDEN')
  }

  // 裁决二第 2 条：目标只含同项目 enabled、supervisor=false、且不是发起者。
  // **主管永远不作为广播目标**（原先只过滤了 enabled，主管也会收到带页脚的派活）。
  const targets = (
    await servantService.listServants({ includeAll: true, forSessionId: fromSessionId })
  ).filter((servant) => servant.enabled && !servant.supervisor && servant.sessionId !== fromSessionId)
  if (targets.length === 0) {
    throw ApiError.notFound('No enabled non-supervisor servants in this project to broadcast to')
  }

  // 发起者身份快照，与单播的 fromRole 规则一致（供汇报改投的交接修正使用）。
  const fromRole = !sender ? 'other' : sender.supervisor ? 'supervisor' : 'servant'

  const host = req.headers.get('host') || '127.0.0.1'
  /** 本次请求真正新投递的目标数；为 0（全部幂等命中）即为去重放行 */
  let actuallyDelivered = 0
  const results = await Promise.all(
    targets.map(async (target): Promise<BroadcastTargetResult> => {
      // 幂等：该目标在同 broadcastId 下已成功投递并记账 → 跳过投递与记账。
      const existing = await collabTaskService.findBroadcastTask(broadcastId, target.sessionId)
      if (existing) {
        return {
          sessionId: target.sessionId,
          ...(target.role ? { role: target.role } : {}),
          taskId: existing.id,
          delivered: true,
        }
      }

      // 每目标独立 taskId：先生成，页脚与台账用**同一个**值（与单播一致），
      // 不存在「页脚里是查不到的一次性 UUID」那种情况。
      const targetTaskId = crypto.randomUUID()
      const messageId = crypto.randomUUID()
      recordDelivery({
        messageId,
        targetSessionId: target.sessionId,
        ...(fromSessionId ? { fromSessionId } : {}),
      })
      try {
        const delivered = await sessionMessenger.deliver(
          target.sessionId,
          appendReportFooter(content, targetTaskId, fromSessionId),
          host,
        )
        if (!delivered) {
          forgetReceipt(messageId)
          return {
            sessionId: target.sessionId,
            ...(target.role ? { role: target.role } : {}),
            messageId,
            delivered: false,
            error: 'Message could not be delivered to the target session',
          }
        }
      } catch (error) {
        forgetReceipt(messageId)
        return {
          sessionId: target.sessionId,
          ...(target.role ? { role: target.role } : {}),
          messageId,
          delivered: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }

      // 投递成功才记账（裁决二第 6 条：失败目标不记账，与单播顺序一致）。
      const taskId = await collabTaskService.recordDispatch({
        toSessionId: target.sessionId,
        fromSessionId,
        fromRole,
        broadcastId,
        content,
        taskId: targetTaskId,
      })
      actuallyDelivered += 1
      return {
        sessionId: target.sessionId,
        ...(target.role ? { role: target.role } : {}),
        ...(taskId ? { taskId } : {}),
        messageId,
        delivered: true,
      }
    }),
  )

  const failed = results.filter((result) => !result.delivered)
  if (failed.length === results.length) {
    throw ApiError.internal('Broadcast failed for all targets')
  }
  return Response.json(
    {
      ok: true,
      broadcast: true,
      broadcastId,
      delivered: results.length - failed.length,
      // 向后兼容：旧调用方只读这两个字段
      ...(failed.length > 0 ? { failed: failed.map((result) => result.sessionId) } : {}),
      targets: results,
      // 裁决三：临界区内重查发现所有目标都已投递过 → 本次没有新投递，标记去重放行。
      // 部分命中（上次有目标失败、本次重试成功）不算——本次确实投递了目标。
      ...(actuallyDelivered === 0 ? { deduplicated: true } : {}),
    },
    { status: 201 },
  )
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  const raw = new Uint8Array(await req.arrayBuffer())
  if (raw.length === 0) return {}
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    // Windows 终端的 curl -d 内联中文按 GBK 编码发出（2026-09-10 实战复盘：
    // 存量会话的旧模板仍是这种写法）。严格 UTF-8 解码失败即按 GBK 解码，
    // 让旧习惯的汇报也能被正确接收。
    text = new TextDecoder('gbk').decode(raw)
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

export type SupervisorOrientationEnv = {
  /** null = 外部 CLI 无法判断，按缺失处理（内联协议兜底） */
  skillAvailable: boolean | null
  shellOk: boolean
  /** 注入消息的随身档案：会话 ID 与服务端地址（环境变量缺失时模型无手段获取） */
  sessionId?: string
  serverUrl?: string
  /** 渲染好的花名册表（角色 → 会话 ID → 角色特性）；履新时若已有员工则内联 */
  rosterTable?: string
}

/**
 * 花名册 → Markdown 表（v1.6.0）。
 * 便宜模型看 JSON 容易漏字段（尤其 description 埋在长对象里），表格能显著降低
 * 「不按角色特性选人」的概率。管道符与换行会破坏表格，先转义。
 */
export function renderRosterTable(
  servants: readonly { sessionId: string; role?: string; description?: string }[],
): string {
  if (servants.length === 0) return '（花名册为空）'
  const rows = servants.map((entry) => {
    const role = (entry.role?.trim() || '（未设角色）').replace(/\|/g, '\\|')
    const rawDesc = (entry.description?.trim() || '—').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
    const desc = rawDesc.length > 80 ? `${rawDesc.slice(0, 80)}…` : rawDesc
    return `| ${role} | ${entry.sessionId} | ${desc} |`
  })
  return ['| 角色 | 会话 ID | 角色特性摘要 |', '| --- | --- | --- |', ...rows].join('\n')
}

/** 随身档案 + 两条硬规则：环境变量/Bash 不可用时，模型凭消息文本本身就能完成汇报与自救 */
function buildPocketCardLines(sessionId?: string, serverUrl?: string): string[] {
  const lines: string[] = []
  if (sessionId || serverUrl) {
    lines.push('随身档案（Bash 或环境变量不可用时，以下值照常可用）：')
    if (sessionId) {
      lines.push(`- 你的会话 ID：${sessionId}（汇报时 fromSessionId / 回邮地址用它）`)
    }
    if (serverUrl) {
      lines.push(
        `- 桌面服务地址：${serverUrl}——注意：此值是**会话启动时注入**的，app 重启换端口后会失效（陈旧风险），投递失败先按下条自愈。`,
      )
      lines.push(
        '- 最新地址优先读固定端口文件 ~/.claude/cc-heihei/desktop-server.json 的 url 字段（服务端每次启动更新，内容严格为 { url, port, pid, startedAt }，port 为实际绑定端口）。**先校验 pid 存活再信 port**——进程被强杀时文件会残留旧值（正常退出才清理）；读到 null / 非法结构 / 死 pid 一律回退 env 或向主管要当前地址。',
      )
      lines.push(
        '- 探活验身份：GET <地址>/api/whoami 必须返回含 "app":"cc-heihei" 的 JSON——空 200 或非 JSON 一律不是本服务（本机存在对任意路径回 200 空 body 的冒名端口）。',
      )
      // 低-4（v1.5.0）：与 dispatchProtocol 共用同一段陈旧判定文案（防漂移）
      lines.push(`- ${SERVER_ADDRESS_STALENESS_NOTE}`)
    }
    lines.push('- 文件信箱：<工作目录>/.heihei/dispatch/report-<序号>.json（Bash 不可用时的汇报通道）')
  }
  lines.push('硬规则：汇报/派活的 HTTP 请求禁止内联中文——Windows 控制台按 GBK 编码会导致服务端收到乱码，必须把 JSON 写入文件后用 --data-binary @file 提交，或走文件信箱。')
  lines.push(`工具找不到时（ToolSearch 报 "No matching deferred tools found"）：关键词搜索只覆盖 deferred 工具——核心工具（${CORE_INLINE_TOOLS_TEXT}）已直接内联可用，直接调用；确需加载 deferred 工具时用精确名，如 select:NotebookEdit,WebFetch。`)
  return lines
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
    '**默认工作方式：收到任务的第一反应是拆解并派活。只有用户点名要你亲自做、或没有合适的员工时才自己动手**——用户设置主管就是为了让你编排，不要先自己干。',
    '',
    '现在请立即执行第一步——查看你的员工花名册（角色与角色特性）：',
    'curl -s "$CC_HEIHEI_DESKTOP_SERVER_URL/api/servant-sessions?forSession=$CC_HEIHEI_SESSION_ID"',
    '返回 JSON 里的 rosterTable 字段就是渲染好的表（**优先看它**，比读 servants 数组省事）。',
    '',
    '看完后用一两句话向用户报告你有哪些员工可用，然后等待用户命令。',
    '',
    '注意：员工会话可能还在创建中（主管往往最先被拉起，员工晚 1~3 分钟）。' +
      '若花名册为空或明显不全，等待约 60 秒后重跑上面的查询（最多重试 5 次）；' +
      '仍为空才向用户报告「暂无员工」，不要凭一次空结果下结论，也不要自己代劳员工的活。',
  ]

  if (env.rosterTable) {
    lines.push(
      '',
      '当前花名册（角色 → 会话 ID → 角色特性）——**每次派活前对照这张表选人**：',
      '',
      env.rosterTable,
    )
  }

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

  lines.push('', ...buildPocketCardLines(env.sessionId, env.serverUrl))

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
async function buildSupervisorOrientationAfterEnvCheck(sessionId: string, serverUrl: string): Promise<string> {
  const [skill, shell, servants] = await Promise.all([
    collabEnvironmentService.checkWorkOrchestratorSkill().catch(() => ({ available: null as boolean | null })),
    Promise.resolve(collabEnvironmentService.checkShell()),
    // 履新时花名册常为空（主管先被拉起，员工晚 1~3 分钟）——查不到就不内联表格，
    // 消息里已有「等 60 秒重查」的指引；查到则直接给表，省掉便宜模型看 JSON 的漏看。
    servantService.listServants({ forSessionId: sessionId }).catch(() => []),
  ])
  return buildSupervisorOrientation({
    skillAvailable: skill.available,
    shellOk: shell.ok,
    sessionId,
    serverUrl,
    ...(servants.length > 0 ? { rosterTable: renderRosterTable(servants) } : {}),
  })
}

function buildWorkerOrientation(
  role: string | undefined,
  description: string | undefined,
  sessionId: string,
  serverUrl: string,
): string {
  const roleLine = role
    ? `你的角色：${role}${description ? `——${description}` : ''}`
    : '你的角色：协作员工（未填写具体角色）'
  return [
    '【系统】你已被登记为本项目的协作员工。',
    roleLine,
    '等待主管派活：主管派来的任务会自动出现在你的会话里。',
    '收到派活任务后，立即开始执行，先回复一句确认（如"收到，开始执行"）再干活，不要等待用户确认。',
    '完工后按派活消息里的要求向主管汇报（写一句话结果 + 产出文件路径）。',
    '',
    ...buildPocketCardLines(sessionId, serverUrl),
  ].join('\n')
}

/**
 * 员工登记的记录（v1.2.3 用户规则：系统通知不进对话流）。
 *
 * 原先这里会向主管注入一条「新员工已加入本项目」。用户拍板：对话流只放"需要人响应/
 * 决策"的消息（员工汇报），这类登记属于维护可查的系统事件 → 降为诊断事件。
 * 关键字段（sessionId / role / description / workDir）全部落到诊断里，
 * 排查"为什么花名册里看不到某员工"时照样能看（含项目隔离导致的情况）。
 */
async function notifySupervisorOfNewWorker(
  entry: { sessionId: string; role?: string; description?: string },
): Promise<void> {
  const roleText = entry.role
    ? `${entry.role}（${entry.description || '未填写特性'}）`
    : '未命名角色'
  // 附上 workDir：花名册按项目隔离过滤，若查不到这位员工，
  // 一眼能核对是不是工作目录不同（而不是登记丢失）
  const workDir = await sessionService
    .getSessionWorkDir(entry.sessionId)
    .catch(() => null)
  void diagnosticsService
    .recordEvent({
      type: 'servant_registered',
      severity: 'info',
      summary: `新员工已登记：${roleText}`,
      sessionId: entry.sessionId,
      details: {
        sessionId: entry.sessionId,
        role: entry.role,
        description: entry.description,
        workDir,
      },
    })
    .catch(() => {})
}
