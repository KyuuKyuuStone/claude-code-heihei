/**
 * SDK 启动确认（v1.7.2 裁决二十一④；形态由裁决二十二第 1 条定：落 conversation/ 子模块）。
 *
 * 「SDK connected」是**拉起成功**的必要条件：
 * - 竞速先返回（进程活着但 SDK 未连）时**不得**宣称成功、**不得** markRunning，phase 保持 starting；
 * - 改为**后台**继续等 attach —— ⚠ 绝不让投递方同步等待（deliver 仍 ≤3s 返回、HTTP 201 语义不变）；
 * - 迟到 attach（子预算超时之后才连上）**仍会** markRunning：超时不是终局；
 * - 子预算到点仍未 attach → 记 `cli_start_unconfirmed`(warn)，**phase 保持 starting**
 *   （报 crashed 是误报：进程还在，只是没连上）。可见性 = 该诊断事件 + stallWatcher。
 *
 * 门面（conversationService.ts）依赖以参数注入（`hasSession`），本模块**零 `this`**。
 */

import { diagnosticsService } from '../diagnosticsService.js'
import { markRunning } from '../sessionRegistry.js'
import type { SessionStartOptions } from './cliArgs.js'

/** 子预算毫秒数：默认 {@link SDK_CONFIRM_SUB_BUDGET_MS_DEFAULT}；
 *  测试可经 CC_HEIHEI_SDK_CONFIRM_BUDGET_MS 覆写（每次调用读取，便于按用例设置）。 */
export const SDK_CONFIRM_SUB_BUDGET_MS_DEFAULT = 30_000

export function sdkConfirmSubBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CC_HEIHEI_SDK_CONFIRM_BUDGET_MS ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : SDK_CONFIRM_SUB_BUDGET_MS_DEFAULT
}

/**
 * 本模块对会话对象的最小结构要求（避免把门面的 SessionProcess 类型搬出来——
 * 裁决三：类型随函数搬只适用于「服务于该函数」的窄类型，此处用结构化窄接口更稳）。
 */
export type SdkConfirmSession = {
  sdkSocket: unknown
  sdkAttached: Promise<void>
  proc: { pid?: number }
  workDir: string
  permissionMode: string
  servantNonInteractive: boolean
}

export type SdkConfirmDeps = {
  /** 门面注入的 sessions map（只要求 has——本模块据此判断会话是否已被清理/结束）。 */
  sessions: { has(sessionId: string): boolean }
}

/** 诊断事件名（门面/用例共用，避免字面量漂移）。 */
export const CLI_START_UNCONFIRMED_EVENT = 'cli_start_unconfirmed'

/** SDK 确认连上后才允许宣称「拉起成功」（唯一 markRunning 出口）。幂等：registry 同相 no-op。 */
export function markSdkConfirmedRunning(sessionId: string): void {
  console.log(`[ConversationService] CLI started successfully for ${sessionId}`)
  markRunning(sessionId)
}

/**
 * 拉起收口（门面唯一调用点）：已连上即宣称成功；否则转入后台等待。
 * **同步返回**——不阻塞调用方（竞速窗口结束就返回）。
 */
export function completeSdkStartupConfirmation(
  sessionId: string,
  session: SdkConfirmSession,
  deps: SdkConfirmDeps,
  options?: SessionStartOptions,
): void {
  if (session.sdkSocket) {
    markSdkConfirmedRunning(sessionId)
    return
  }
  confirmSdkAttachmentInBackground(sessionId, session, deps, options)
}

/** 后台确认 SDK 连接（fire-and-forget）。 */
function confirmSdkAttachmentInBackground(
  sessionId: string,
  session: SdkConfirmSession,
  deps: SdkConfirmDeps,
  options?: SessionStartOptions,
): void {
  const budgetMs = sdkConfirmSubBudgetMs()
  const startedAt = Date.now()
  // 迟到 attach：只要连上就转 running（注册在 check 之后同步完成，不会漏掉已连上的情形）。
  void session.sdkAttached.then(() => {
    clearTimeout(warnTimer)
    if (!deps.sessions.has(sessionId)) return // 会话已被清理：不复活
    markSdkConfirmedRunning(sessionId)
  })
  const warnTimer = setTimeout(() => {
    if (session.sdkSocket) return // 已连上
    if (!deps.sessions.has(sessionId)) return // 会话已结束
    void diagnosticsService
      .recordEvent({
        type: CLI_START_UNCONFIRMED_EVENT,
        severity: 'warn',
        sessionId,
        summary: `CLI 已启动但 ${budgetMs}ms 内未建立 SDK 连接，回合无法推进`,
        details: {
          sessionId,
          waitedMs: Date.now() - startedAt,
          pid: session.proc.pid,
          workDir: session.workDir,
          permissionMode: session.permissionMode,
          servantNonInteractive: session.servantNonInteractive,
          startSource: options?.startSource ?? 'unknown',
        },
      })
      .catch(() => {})
  }, budgetMs)
}
