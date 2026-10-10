/**
 * 确定性「请求体超限」失败的识别 / 记录 / 升级（v1.7.5 C-B）
 *
 * 背景：员工会话因 API 报错结束轮次时，既有逻辑会**自动续跑**（`servantIncidentNotifier`，
 * 上限 2 次）或**假死重推**（`servantStallWatcher`）。这对**可恢复**错误（429 / 网络抖动 /
 * overloaded）是对的——重发往往就好了。但**请求体超限（413 / request_too_large）是
 * 确定性失败**：请求内容没变，再发一次必然再失败 ⇒ 自动续跑只是**刷屏 + 烧配额**，
 * 还会把真正的卡点（上下文/附件太大）埋在一片重复错误里。
 *
 * 本模块提供三件事，供两个调用点共用**同一口径**：
 * 1. `isDeterministicOversizeError(text)` —— 判定口径（唯一实现，避免两处各写一套）；
 * 2. 每会话「上一回合错误」登记表 —— `servantStallWatcher` 是周期扫描，拿不到
 *    轮次事件的入参，必须能从共享信号里读到（唯一写入方：`conversationService`
 *    观察到 result 事件时）；
 * 3. `notifySupervisorsOfOversizeFailure(...)` —— 升级通道：给**同项目主管**投一条
 *    简短系统通知（镜像 `rosterChangeNotice` 的隔离与投递口径：解析不到 workDir 就
 *    记诊断、不通知；投递失败记诊断、不抛错）。**绝不**往那个已死的员工会话里投。
 *
 * 产品约束：这不是审批点，只是「别再盲目重试了，请人看一眼」的一条通知。
 */

import { servantService } from './servantService.js'
import { sessionService } from './sessionService.js'
import { ProviderService } from './providerService.js'
import { diagnosticsService } from './diagnosticsService.js'
import { requireSessionDelivery } from './sessionDelivery.js'
import { sameProject } from '../../collaboration/projectPath.js'

/**
 * 超限类错误的稳定标记（大小写不敏感）。
 * 口径来源（都必须能命中，且不得命中 429/网络类）：
 * - 我们自己的预检文案：`Request blocked before sending`（errors.ts，v1.7.5 P-A）；
 * - 我们自己的 413 文案：`Request too large`（errors.ts，v1.7.5 批次 1）；
 * - 业务错误码字符串：`request_too_large` / `PAYLOAD_TOO_LARGE`（结构化拒绝形态）；
 * - 链路中间件常见措辞：`Request Entity Too Large`（nginx/网关 413 原文）；
 * - Anthropic 侧 413 原文：`Request too large`（同上）。
 *
 * **刻意不含**：429 / too many requests / overloaded / timeout / ECONNRESET /
 * socket hang up / 5xx —— 那些是可恢复错误，必须继续走自动续跑与重推。
 */
const OVERSIZE_ERROR_MARKERS = [
  'request too large',
  'request blocked before sending',
  'request_too_large',
  'payload_too_large',
  'request entity too large',
  'exceeds the configured limit',
  // 我们自己的协作通道拒绝文案：`Field "summary" is too large: 600000 bytes (UTF-8)
  // exceeds the 524288 byte limit.`（servants.assertPayloadWithinLimit）——同样确定性，
  // 再发必败（内容没变小）。
  // J1（返工，仅记录）：该标记偏宽——任何 `is too large:` 的文案都会被判成
  // 「确定性超限」。当前唯一写入面是**我们自己的**协作通道拒绝文案
  // （`messageSizeLimits.ts` 的 `Field "…" is too large: N bytes (UTF-8) exceeds …`，
  // 见上方注释），输入面窄、误判风险可控；若将来有别的来源也吐出这句，需要收紧成
  // 带字段名的完整前缀匹配。本次不动（避免改动判定口径引入新风险）。
  'is too large:',
] as const

/** 判定：该错误文本是否属于**确定性**的「请求体超限」类（再发必败） */
export function isDeterministicOversizeError(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  const lower = text.toLowerCase()
  return OVERSIZE_ERROR_MARKERS.some((marker) => lower.includes(marker))
}

/* ── 每会话「上一回合错误」登记（供周期扫描读取） ───────────────────────── */

const lastTurnErrorBySession = new Map<string, string>()

/** 记录该会话最新一次**失败轮**的错误摘要（写入方：conversationService） */
export function recordServantTurnError(sessionId: string, summary: string): void {
  if (!sessionId) return
  lastTurnErrorBySession.set(sessionId, summary ?? '')
}

/** 该会话最新一次失败轮的错误摘要（没有失败轮则 undefined） */
export function getServantLastTurnError(sessionId: string): string | undefined {
  return lastTurnErrorBySession.get(sessionId)
}

/** 成功轮/清理时调用：该会话不再有「未化解的失败」 */
export function clearServantTurnError(sessionId: string): void {
  lastTurnErrorBySession.delete(sessionId)
  // R-C 返工（P1）：**成功轮也必须清连续超限计数**。此前只在累加/解锁时清，
  // 于是「连续 2 次」实际退化成「累计 2 次」——第 1 次超限自愈后隔几天偶发
  // 第 2 次就会把健康会话直接锁死，违背本模块「连续」「避免一次抖动就熔断」的本意。
  // 调用点：`conversationService.observeServantTurnResult` 成功分支（与
  // `servantTurnErrorStreak` 同一处清理）。**只清计数、不解锁**：锁死态是显式
  // 修复动作的对偶（修复路径 `unlockSessionPayload`），不能被一轮成功偷偷解除。
  oversizeStreak.delete(sessionId)
}

/** 测试隔离 */
export function resetServantTurnErrorsForTests(): void {
  lastTurnErrorBySession.clear()
}

/* ── R-C（v1.7.5）：连续超限失败 → 锁死态（熔断） ─────────────────────────── */

/**
 * 连触阈值：同一会话**连续** 2 次确定性超限失败即锁死。
 * 为什么是 2：第 1 次已经停掉自动续跑/重推（C-B）并通知了主管；若紧接着第 2 次
 * 仍撞同一确定性失败，说明"内容没变小"这一事实不会自己好转——继续每回合重发
 * 只是把链路和配额烧光。取 2 既避免一次抖动就熔断，又能迅速止住刷屏。
 */
export const OVERSIZE_LOCK_THRESHOLD = 2

type LockInfo = {
  locked: boolean
  /** 连续（未化解的）超限失败次数 */
  streak: number
  lockedAt?: string
  reason?: string
}

const oversizeStreak = new Map<string, number>()
const lockedSessions = new Map<string, { lockedAt: string; reason: string }>()

/** 测试隔离 */
export function resetOversizeLockForTests(): void {
  oversizeStreak.clear()
  lockedSessions.clear()
}

/** C-A 读点：该会话是否处于「请求超限锁死态」 */
export function isSessionPayloadLocked(sessionId: string): boolean {
  return lockedSessions.has(sessionId)
}

/** C-A 读点：完整锁死信息（未锁死也有 streak，便于诊断） */
export function getSessionPayloadLock(sessionId: string): LockInfo {
  const locked = lockedSessions.get(sessionId)
  return {
    locked: locked !== undefined,
    streak: oversizeStreak.get(sessionId) ?? 0,
    ...(locked ? { lockedAt: locked.lockedAt, reason: locked.reason } : {}),
  }
}

/** 手动/程序化置锁（修复失败等场景；正常链路走 noteOversizeFailure） */
export function lockSessionPayload(sessionId: string, reason: string): void {
  if (!sessionId) return
  lockedSessions.set(sessionId, { lockedAt: new Date().toISOString(), reason })
}

/**
 * 修复成功后的解锁：**解锁 + 连续计数归零 + 清掉上一回合错误快照**。
 * 三者必须一起做——只解锁不清计数，下一次超限会立刻再次达到阈值；
 * 不清快照，假死重推仍会按「上一回合超限」跳过。
 */
export function unlockSessionPayload(sessionId: string): void {
  lockedSessions.delete(sessionId)
  oversizeStreak.delete(sessionId)
  lastTurnErrorBySession.delete(sessionId)
}

/**
 * 记一次确定性超限失败：累加连续计数 → 达阈值则**锁死 + 通知主管**。
 * 通知只在「本次刚刚锁死」那一次发出（重复失败不重复轰炸）。
 * 可恢复错误**不**走这里（调用方已用 isDeterministicOversizeError 判过）。
 */
export async function noteOversizeFailure(
  input: OversizeFailureInput,
): Promise<LockInfo> {
  if (!input.sessionId) return { locked: false, streak: 0 }
  const streak = (oversizeStreak.get(input.sessionId) ?? 0) + 1
  oversizeStreak.set(input.sessionId, streak)

  if (streak >= OVERSIZE_LOCK_THRESHOLD && !lockedSessions.has(input.sessionId)) {
    const reason = `连续 ${streak} 次请求体超限（413/request_too_large），已锁死该会话：恢复投递前必须先做修复（POST /api/sessions/${input.sessionId}/shed-payload）`
    lockedSessions.set(input.sessionId, { lockedAt: new Date().toISOString(), reason })
    deps.recordEvent({
      type: 'session_payload_locked',
      severity: 'error',
      summary: `会话已被请求超限锁死（连续 ${streak} 次），已停止对其投递并通知主管：${input.sessionId}`,
      sessionId: input.sessionId,
      details: {
        sessionId: input.sessionId,
        streak,
        source: input.source,
        action: 'lock_and_notify_supervisor',
      },
    })
    await notifySupervisorsOfOversizeFailure({ ...input, attempts: streak, locked: true })
    return getSessionPayloadLock(input.sessionId)
  }
  return getSessionPayloadLock(input.sessionId)
}

/* ── 升级通道：通知同项目主管 ───────────────────────────────────────────── */

export type OversizeFailureDeps = {
  listServants: typeof servantService.listServants
  getSessionWorkDir: (sessionId: string) => Promise<string | null>
  deliver: (targetSessionId: string, content: string, serverHost: string) => Promise<boolean>
  getServerPort: () => number
  recordEvent: (input: {
    type: string
    severity?: 'info' | 'warn' | 'error'
    summary: string
    sessionId?: string
    details?: unknown
  }) => void
}

const defaultDeps: OversizeFailureDeps = {
  listServants: (options) => servantService.listServants(options),
  getSessionWorkDir: (sessionId) => sessionService.getSessionWorkDir(sessionId),
  deliver: async (targetSessionId, content, serverHost) =>
    requireSessionDelivery()(targetSessionId, content, serverHost),
  getServerPort: () => ProviderService.getServerPort(),
  recordEvent: (input) => {
    void diagnosticsService.recordEvent(input).catch(() => {})
  },
}

let deps: OversizeFailureDeps = defaultDeps

/**
 * 测试注入：**在当前 deps 上做局部覆盖**（传 null 复位默认）。
 * 局部覆盖是刻意的——用例常分两步注入（beforeEach 装 deliver，用例内再覆盖 listServants），
 * 若每次都从默认值重建，前一步的注入会被悄悄丢掉。
 */
export function setOversizeFailureDepsForTests(next: Partial<OversizeFailureDeps> | null): void {
  deps = next ? { ...deps, ...next } : defaultDeps
}

export type OversizeFailureInput = {
  /** 出问题的会话（员工） */
  sessionId: string
  /** 触发场景，仅用于文案与诊断 */
  source: 'turn_error' | 'stall_repush'
  role?: string
  description?: string
  /** 已连续失败轮数（turn_error 场景）或已重推次数（stall_repush 场景） */
  attempts?: number
  errorSummary?: string
  /** 本次通知是否因「锁死」而发（R-C）：文案要指向修复动作 */
  locked?: boolean
}

/** 通知文案（纯函数，便于测试） */
export function buildOversizeFailureNotice(input: OversizeFailureInput): string {
  const who = input.role ? `${input.role}（${input.description || '未填写特性'}）` : '未命名的员工会话'
  const attempts =
    input.source === 'stall_repush'
      ? `已自动重推 ${input.attempts ?? 0} 次`
      : `已连续 ${input.attempts ?? 0} 轮报错`
  const tail = (input.errorSummary ?? '').trim().slice(0, 200)
  if (input.locked) {
    return [
      `【系统】${who}（会话 ID：${input.sessionId}）因**请求体超限**已连续失败 ${input.attempts ?? OVERSIZE_LOCK_THRESHOLD} 次，**已锁死**：在修复前，任何派活/消息投递都会被拒绝（不重复重发）。`,
      '修复方式：在桌面端点「修复会话」（或调用 POST /api/sessions/<会话ID>/shed-payload），剥离媒体块与超大文本块后自动解锁。',
      '修复会先备份 transcript，内容落盘可查，不删行、不动 uuid 链。',
      tail ? `错误原文（截断）：${tail}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
  return [
    `【系统】${who}（会话 ID：${input.sessionId}）出现**请求体超限**类错误（413 / request_too_large），${attempts}。`,
    '这是确定性失败：请求内容没变，继续自动续跑/重推只会重复报错。**已停止自动续跑/重推**。',
    '建议：打开该会话执行 /compact 压缩上下文，或清掉大附件/大图片后重新派活。',
    tail ? `错误原文（截断）：${tail}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 升级通知：向**同项目**主管投递一条系统通知。
 * 项目隔离取保守口径（同 `rosterChangeNotice`）：解析不到 workDir ⇒ 记诊断后返回，
 * 宁少通知、不错通知。投递失败只记诊断，绝不抛错（通知是体验项）。
 */
export async function notifySupervisorsOfOversizeFailure(
  input: OversizeFailureInput,
): Promise<void> {
  let workDir: string | null = null
  try {
    workDir = await deps.getSessionWorkDir(input.sessionId)
  } catch {
    workDir = null
  }
  if (!workDir) {
    deps.recordEvent({
      type: 'oversize_failure_notice_skipped',
      severity: 'info',
      summary: '无法解析出问题会话的工作目录，跳过超限失败升级通知（宁少通知不错通知）',
      sessionId: input.sessionId,
      details: { sessionId: input.sessionId, reason: 'no-workdir', source: input.source },
    })
    return
  }

  let supervisors: Awaited<ReturnType<OversizeFailureDeps['listServants']>> = []
  try {
    const all = await deps.listServants({ includeAll: true })
    supervisors = all.filter(
      (s) =>
        s.supervisor &&
        s.sessionId !== input.sessionId &&
        !!s.workDir &&
        sameProject(s.workDir, workDir),
    )
  } catch (error) {
    deps.recordEvent({
      type: 'oversize_failure_notice_skipped',
      severity: 'warn',
      summary: `列举花名册失败，跳过超限失败升级通知：${
        error instanceof Error ? error.message : String(error)
      }`,
      sessionId: input.sessionId,
      details: { sessionId: input.sessionId, reason: 'list-failed', source: input.source },
    })
    return
  }
  if (supervisors.length === 0) return

  const notice = buildOversizeFailureNotice(input)
  const serverHost = `127.0.0.1:${deps.getServerPort()}`
  for (const supervisor of supervisors) {
    try {
      await deps.deliver(supervisor.sessionId, notice, serverHost)
    } catch (error) {
      deps.recordEvent({
        type: 'oversize_failure_notice_failed',
        severity: 'warn',
        summary: `超限失败升级通知投递失败（主管 ${supervisor.sessionId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
        sessionId: input.sessionId,
        details: { sessionId: input.sessionId, target: supervisor.sessionId, source: input.source },
      })
    }
  }
}
