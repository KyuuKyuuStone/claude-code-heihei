/**
 * 员工轮次/工具事件总线（G2 B-d 批）。
 *
 * 动机：`conversationService` 观察员工回合结果后要通知 `servantIncidentNotifier`
 * （报错轮续跑 / 清零熔断计数），原先是**四处动态 import**（绕静态环）⇒
 * `no-dynamic-import-in-services` + notifier 反向动态 import conversationService
 * ⇒ `no-circular`。改为事件总线：发射方只依赖本模块（L2→L2 合法、无环），
 * 订阅方在**模块顶层**订阅（与 `subscribeServantCrashObserver` 同款 house style）。
 *
 * 语义（与旧链路逐条对齐）：
 *  - 旧实现里 `.catch(error => logForDiagnosticsNoPII('warn','servant_incident_notify_failed', …))`
 *    的吞错留痕**原样保留**：钩子同步抛或返回 rejected promise，都在 `fanout` 里
 *    记同一条诊断（事件名/字段不变）⇒ 通知链失效仍然可查，不静默。
 *  - **0 订阅者 = 无操作**：总线是广播，没有订阅方就没有动作（不是「装配坏」）；
 *    生产侧由 `server/index.ts` 的 side-effect import 保证 notifier 已加载并订阅。
 *
 * 本模块不 import 任何业务模块（只依赖 L0 诊断日志）。
 */
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'

export type ServantTurnErrorInput = {
  sessionId: string
  streak: number
  summary: string
}

export type ServantToolResultInput = {
  sessionId: string
  resultText: string
  /** 与 servantIncidentNotifier.onServantToolResult 入参同形（可选：只有显式 true 才算「是报错」）。 */
  isError?: boolean
}

export type ServantTurnIncidentHooks = {
  onTurnError: (input: ServantTurnErrorInput) => void | Promise<unknown>
  clearTurnErrors: (sessionId: string) => void | Promise<unknown>
  resetUnknownToolStreak: (sessionId: string) => void | Promise<unknown>
  onToolResult: (input: ServantToolResultInput) => void | Promise<unknown>
}

const subscribers = new Set<ServantTurnIncidentHooks>()

/** 订阅（模块顶层调用；返回退订函数）。同一钩子对象重复订阅只算一次。 */
export function subscribeServantTurnIncidents(
  hooks: ServantTurnIncidentHooks,
): () => void {
  subscribers.add(hooks)
  return () => {
    subscribers.delete(hooks)
  }
}

/** 测试隔离：清空订阅者。 */
export function resetServantTurnIncidentSubscribersForTests(): void {
  subscribers.clear()
}

function reportFailure(hook: string, sessionId: string, error: unknown): void {
  logForDiagnosticsNoPII('warn', 'servant_incident_notify_failed', {
    sessionId,
    hook,
    error: error instanceof Error ? error.message : String(error),
  })
}

function fanout(
  hook: string,
  sessionId: string,
  call: (h: ServantTurnIncidentHooks) => void | Promise<unknown>,
): void {
  for (const hooks of subscribers) {
    try {
      const result = call(hooks)
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch((error) => reportFailure(hook, sessionId, error))
      }
    } catch (error) {
      reportFailure(hook, sessionId, error)
    }
  }
}

/** 报错轮（连续报错计数由调用方维护并传入）。 */
export function emitServantTurnError(input: ServantTurnErrorInput): void {
  fanout('onServantTurnError', input.sessionId, (h) => h.onTurnError(input))
}

/** 轮次恢复正常 ⇒ 清零报错连续计数。 */
export function emitServantTurnErrorsCleared(sessionId: string): void {
  fanout('clearServantTurnErrors', sessionId, (h) => h.clearTurnErrors(sessionId))
}

/** 轮次成功 ⇒ 清零「连续调用不存在工具」计数。 */
export function emitServantUnknownToolStreakReset(sessionId: string): void {
  fanout('resetUnknownToolStreak', sessionId, (h) => h.resetUnknownToolStreak(sessionId))
}

/** 观察到一条 tool_result。 */
export function emitServantToolResult(input: ServantToolResultInput): void {
  fanout('onServantToolResult', input.sessionId, (h) => h.onToolResult(input))
}
