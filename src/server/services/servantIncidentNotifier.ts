/**
 * ServantIncidentNotifier — 员工会话异常事件 → 主动通知其主管
 *
 * 员工 CLI 进程异常崩溃（非刻意停止/回收）时，正在执行的任务会中断。
 * 主动告知主管"任务可能中断 + 建议处理方式"，让中断在一分钟内被看见，
 * 而不是等主管假活巡检或用户人工发现（2026-09-10 实战反馈）。
 *
 * 依赖注入布局（v1.3.1 · R2b 后）：deliver 经 registerServantIncidentDeliver
 * 由 index.ts 装配（静态依赖环已断）；getServant/listServants 静态 import
 * servantService（7a 后 servantService 不再反向依赖 conversationService）；
 * 对 conversationService 的两处引用（interrupt 的延迟加载 + 被它动态 import
 * 调用）保持动态导入，静态初始化环不存在。
 */

import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { diagnosticsService } from './diagnosticsService.js'
import { onSessionEvent, type SessionEvent } from './sessionEvents.js'
import { subscribeServantTurnIncidents } from './servantIncidentSignals.js'
import { ProviderService } from './providerService.js'
import { servantService } from './servantService.js'

export type ServantCrashInput = {
  sessionId: string
  exitCode: number | null
}

/** 可注入依赖（测试用）；缺省走真实服务 */
export type ServantIncidentDeps = {
  deliver: (targetSessionId: string, content: string, serverHost: string) => Promise<boolean>
  getServant: (sessionId: string) => Promise<{
    sessionId: string
    role?: string
    description?: string
    enabled: boolean
    constraint?: 'readonly'
  } | null>
  listServants: (options: { includeAll: boolean; forSessionId?: string }) => Promise<
    Array<{
      sessionId: string
      role?: string
      description?: string
      title?: string
      enabled: boolean
      supervisor?: boolean
      running?: boolean
      lastActivityAt?: string
    }>
  >
  getServerPort: () => number
  /** 中断指定会话当前轮次（SDK 优雅中断，保留会话与历史） */
  interrupt: (sessionId: string) => void
  /** 写诊断事件（v1.2.3 起：面向主管的"通知"一律降为日志级，只落诊断不再注入会话） */
  recordEvent: (input: {
    type: string
    severity?: 'info' | 'warn' | 'error'
    summary: string
    sessionId?: string
    details?: unknown
  }) => void
}

/**
 * deliver 装配缝（v1.3.1 整批复核 · R2b 断环）：本模块此前静态 import
 * sessionMessenger 作为缺省 deliver——5e 造出
 * conversationService → notifier → sessionMessenger → conversationService
 * 静态依赖环（L2→L3 分层违规）。改为对齐 7a 的 servantInfoSource 模式：
 * 生产入口 index.ts 启动时 registerServantIncidentDeliver 注入真实现，
 * 本模块不再知道 sessionMessenger 存在（静态环消失）。
 * 未装配即调用 = 编程错误，显式抛错（好过静默丢弃崩溃通知）。
 */
let wiredDeliver:
  | ((targetSessionId: string, content: string, serverHost: string) => Promise<boolean>)
  | null = null

/** G2 B-d 批：中断通道实现（装配根接线；未接线时按旧语义留诊断，见 defaultDeps.interrupt）。 */
let wiredInterrupt: ((sessionId: string) => void) | null = null

export function registerServantIncidentDeliver(
  fn: (targetSessionId: string, content: string, serverHost: string) => Promise<boolean>,
): void {
  wiredDeliver = fn
}
/** G2 B-d 批：中断通道接线（原为动态 import conversationService）。 */
export function registerServantIncidentInterrupt(fn: (sessionId: string) => void): void {
  wiredInterrupt = fn
}

/** 测试注入（传 null 复位为「未接线」，与 B-a/B-b 的 setXxxForTests 同款）。 */
export function setServantIncidentInterruptForTests(
  fn: ((sessionId: string) => void) | null,
): void {
  wiredInterrupt = fn
}

const defaultDeps: ServantIncidentDeps = {
  deliver: (targetSessionId, content, serverHost) => {
    if (!wiredDeliver) {
      throw new Error(
        'servantIncidentNotifier deliver not wired — index.ts must call registerServantIncidentDeliver',
      )
    }
    return wiredDeliver(targetSessionId, content, serverHost)
  },
  getServant: (sessionId) => servantService.getServant(sessionId),
  listServants: (options) => servantService.listServants(options),
  getServerPort: () => ProviderService.getServerPort(),
  // G2 B-d 批：原先此处**动态 import** conversationService（no-dynamic-import-in-services +
  // 静态环），改为装配根接线 `registerServantIncidentInterrupt`（形态同本文件的
  // registerServantIncidentDeliver）。未接线 ⇒ 记同一诊断事件（不静默、不炸进程），
  // 与旧实现「投递失败只留痕」的语义逐条一致。
  // 走 sendInterrupt（= interruptSessionRuntime 内部第一步调用的同一 SDK 优雅中断通道），
  // 而不走 interruptSessionRuntime：后者依赖 activeUserTurns，对「文件信箱/HTTP 注入式
  // 回合」可能为空，会直接跳过中断并返回 stopped=false（见根因调查报告 §2.3）。
  interrupt: (sessionId) => {
    if (!wiredInterrupt) {
      logForDiagnosticsNoPII('warn', 'servant_interrupt_delivery_failed', {
        sessionId,
        error: 'not wired — index.ts must call registerServantIncidentInterrupt',
      })
      return
    }
    wiredInterrupt(sessionId)
  },
  recordEvent: (input) => {
    void diagnosticsService.recordEvent(input).catch((error) => {
      // 低12：诊断写失败也要留痕（走 console，避免递归回诊断系统）
      console.warn(
        `[ServantIncident] recordEvent failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  },
}

let incidentDeps: ServantIncidentDeps = defaultDeps

/** 测试注入假依赖；传 null 恢复默认 */
export function setServantIncidentDeps(overrides: Partial<ServantIncidentDeps> | null): void {
  incidentDeps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps
}

export function resetServantIncidentState(): void {
  turnErrorStreaks.clear()
  turnErrorEscalated.clear()
  unknownToolStreaks.clear()
  unknownToolTripped.clear()
}

export async function notifyServantCrash(input: ServantCrashInput): Promise<void> {
  const entry = await incidentDeps.getServant(input.sessionId).catch(() => null)
  if (!entry?.enabled) return

  // v1.2.3 用户规则：对话流只放"需要人响应/决策"的消息（员工汇报）。员工崩溃属于
  // 维护可查的系统事件，降为日志级——写诊断，不再向主管注入会话消息。
  incidentDeps.recordEvent({
    type: 'servant_crash',
    severity: 'error',
    summary: `员工会话异常退出（exit code ${input.exitCode ?? 'unknown'}）：${
      entry.role ? `${entry.role}（${entry.description || '未填写特性'}）` : '未命名角色'
    }`,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    details: {
      sessionId: entry.sessionId,
      exitCode: input.exitCode,
      role: entry.role,
      description: entry.description,
    },
  })
}

/* ── 崩溃通知的订阅式接线（v1.3.0 阶段2 · 5e）─────────────────────────────
 * 原接线：conversationService.handleProcessExit 动态 import 本模块调用
 * notifyServantCrash——观察者硬编码进被观察者，每加一个观察者都要改核心文件。
 * 现接线：本模块顶层订阅 sessionEvents 的 phase_changed(→crashed)，被观察者
 * 只发事件。判定逻辑自 conversationService.cliExitSeverity **原样搬入**（架构
 * 方案 §5e；不静态 import 以免引入依赖环——conversationService 侧剩余的
 * 轮次报错/工具熔断挂钩仍动态 import 本模块）。告警文案/阈值零改动（C3）。
 *
 * 事件顺序保证：markCrashed 时点在 drain 完成与合成 error result 发出之后
 * （阶段2 · 5d），观察者不会先收 crashed 再收 result。
 *
 * startup 拉起失败也走 markCrashed（meta.startup=true），但旧行为不触发崩溃
 * 通知（走 cli_start_failed 诊断）——订阅处保持该区分。
 */

/** 与 conversationService.cliExitSeverity 同源（原样搬入，勿单边改动） */
function cliExitSeverityLocal(code: number | null): 'info' | 'error' {
  if (code === 0 || code === null || code === 143 || code === 137) return 'info'
  return 'error'
}

let crashObserverOff: (() => void) | null = null

function crashObserverHandler(event: SessionEvent): void {
  if (event.type !== 'phase_changed' || event.to !== 'crashed') return
  const meta = (event.meta ?? {}) as { startup?: boolean; exitCode?: number }
  // startup 失败不触发崩溃通知（旧行为保真）
  if (meta.startup === true) return
  if (cliExitSeverityLocal(meta.exitCode ?? null) !== 'error') return
  void notifyServantCrash({ sessionId: event.sessionId, exitCode: meta.exitCode ?? null })
    .catch((error) => {
      // 低12（v1.5.0）：崩溃通知失败必须留痕——「崩溃通知观察者失效」曾整类静默
      logForDiagnosticsNoPII('warn', 'servant_crash_notify_failed', {
        sessionId: event.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
}

/**
 * 订阅 phase_changed(→crashed)（模块加载时调用一次；测试可重置）。
 *
 * R1 收口（v1.3.1 整批复核）：此前用 crashSubscription 引用守卫（已订阅即
 * early return）——而 resetSessionEventsForTests() 会 listeners.clear() 但
 * 清不掉该引用，reset 后再订阅被守卫误判「已订阅」，观察者被静默清空后
 * 永不恢复（崩溃通知零报错失效）。改 ensure 模式：无条件注册（handler 为
 * 模块级稳定引用，onSessionEvent 按 handler 引用去重 → 重复调用幂等），
 * 被清后重调即恢复。消费方（servant-incident.test.ts beforeEach）每次调用
 * 并跑活性自检，将来任何清空都显式报错而非静默失效。
 */
export function subscribeServantCrashObserver(): void {
  crashObserverOff = onSessionEvent(crashObserverHandler, { types: ['phase_changed'] })
}

/** 测试隔离：退订崩溃观察者（配合 resetServantIncidentState） */
export function unsubscribeServantCrashObserver(): void {
  crashObserverOff?.()
  crashObserverOff = null
}

subscribeServantCrashObserver()

// G2 B-d 批：轮次/工具事件改为总线订阅（原先由 conversationService 动态 import 本模块；
// 现在反过来——本模块顶层订阅，conversationService 只发射）。
subscribeServantTurnIncidents({
  onTurnError: onServantTurnError,
  clearTurnErrors: clearServantTurnErrors,
  resetUnknownToolStreak: resetUnknownToolStreak,
  onToolResult: onServantToolResult,
})

/* ── 员工轮次报错自动续跑（有界）─────────────────────────────────────────────
 * 线上模型员工的 API 抖动会让轮次以报错结束、任务停摆——实战验证"注入一条
 * 消息即可救活"。这里把该恢复动作自动化：报错轮自动注入续跑提示（连错 1-2 轮），
 * 第 3 轮起停止自动续跑并升级通知主管人工介入；成功轮重置计数。
 * 状态仅存内存：重启即重置，可接受（最坏情况是重启后再多续跑两次）。
 */

const TURN_ERROR_MAX_AUTO_NUDGES = 2

const turnErrorStreaks = new Map<string, number>()
const turnErrorEscalated = new Set<string>()

export function clearServantTurnErrors(sessionId: string): void {
  turnErrorStreaks.delete(sessionId)
  turnErrorEscalated.delete(sessionId)
}

export async function onServantTurnError(input: {
  sessionId: string
  streak: number
  summary: string
}): Promise<void> {
  const entry = await incidentDeps.getServant(input.sessionId).catch(() => null)
  if (!entry?.enabled) {
    clearServantTurnErrors(input.sessionId)
    return
  }

  // 达到自动续跑上限：升级一次（v1.2.3 起降为日志级），之后保持静默等成功轮重置
  if (input.streak > TURN_ERROR_MAX_AUTO_NUDGES) {
    if (!turnErrorEscalated.has(input.sessionId)) {
      turnErrorEscalated.add(input.sessionId)
      incidentDeps.recordEvent({
        type: 'servant_turn_error_escalated',
        severity: 'warn',
        summary: `员工会话连续 ${input.streak} 轮报错，已停止自动续跑：${
          entry.role ? `${entry.role}（${entry.description || '未填写特性'}）` : '未命名角色'
        }`,
        sessionId: input.sessionId,
        details: {
          sessionId: input.sessionId,
          streak: input.streak,
          summary: input.summary,
        },
      })
    }
    return
  }

  const nudge = [
    `【系统】你上一轮任务因错误中断（自动续跑 ${input.streak}/${TURN_ERROR_MAX_AUTO_NUDGES}）：${input.summary || '（无错误详情）'}`,
    '请从当前进度继续完成任务，完成后按规范向主管汇报。',
    '若同一错误反复出现，改用文件信箱（.heihei/dispatch/）向主管说明卡点，不要原地重试。',
  ].join('\n')
  await incidentDeps.deliver(
    input.sessionId,
    nudge,
    `127.0.0.1:${incidentDeps.getServerPort()}`,
  )
}

/* ── 连续调用不存在工具熔断 ─────────────────────────────────────────────────
 * 员工被 deferred 工具机制/ToolSearch 文案误导时，会反复调用根本不存在的工具
 * 名（CLI 判定为 "No such tool available"，每次都被模型当成"再用一次就好了"），
 * 表现为无限空转、烧配额、任务停摆（交接文档 P1）。
 *
 * 判据来自本仓库自己的工具派发层：src/services/tools/toolExecution.ts:401/406
 * 在 findToolByName 未命中时产出
 *   tool_result.content = `<tool_use_error>Error: No such tool available: <name></tool_use_error>`
 * （is_error: true）。CLI 与 server 是分离进程，服务端无法在该函数内挂钩，
 * 但这条 tool_result 必然随 SDK 消息流回到 handleSdkPayload——故在会话消息流层计数。
 *
 * 语义：连续 N 次「不存在工具」→ 中断该轮次（SDK 优雅中断，保留历史）+ 通知主管；
 * 成功调用任一工具（含工具自身执行报错，因为它证明了该工具存在）或轮次成功即清零。
 * 状态仅存内存：重启即重置，可接受。
 */

/** 连续不存在工具调用次数阈值（N）。达到即熔断。 */
export const UNKNOWN_TOOL_STREAK_LIMIT = 3

/** 不存在工具的判定标记（由 toolExecution.ts 产出，跨版本的稳定措辞）。 */
export const UNKNOWN_TOOL_MARKER = 'No such tool available'

/** 该 tool_result 文本是否表示「工具不存在」 */
export function isUnknownToolResultText(text: string): boolean {
  return typeof text === 'string' && text.includes(UNKNOWN_TOOL_MARKER)
}

function extractUnknownToolName(text: string): string {
  const match = text.match(/No such tool available:\s*([^\s"'<>,;]+)/)
  return match?.[1] ?? '（未能解析工具名）'
}

const unknownToolStreaks = new Map<string, number>()
const unknownToolTripped = new Set<string>()

/** 清零某会话的连续计数与已熔断标记（任一工具成功调用、轮次成功、会话重开时调用） */
export function resetUnknownToolStreak(sessionId: string): void {
  unknownToolStreaks.delete(sessionId)
  unknownToolTripped.delete(sessionId)
}

/**
 * 观察一次工具调用结果（同步判定 + 异步副作用）：
 * 不存在工具 → 计数 +1，达阈值则中断该轮次并通知主管；
 * 其它任何工具结果 → 计数清零。
 *
 * @returns 本次调用（已累计）是否触发了熔断
 */
export async function onServantToolResult(input: {
  sessionId: string
  resultText: string
  /** 该 tool_result 是否 is_error。要求为真，避免"某工具的输出里恰好含该字样"被误判。 */
  isError?: boolean
}): Promise<boolean> {
  const entry = await incidentDeps.getServant(input.sessionId).catch(() => null)
  if (!entry?.enabled) {
    resetUnknownToolStreak(input.sessionId)
    return false
  }

  if (input.isError !== true || !isUnknownToolResultText(input.resultText)) {
    // 工具被成功派发（哪怕它自己执行报错）→ 连续计数清零
    resetUnknownToolStreak(input.sessionId)
    return false
  }

  const streak = (unknownToolStreaks.get(input.sessionId) ?? 0) + 1
  unknownToolStreaks.set(input.sessionId, streak)
  if (streak < UNKNOWN_TOOL_STREAK_LIMIT) return false

  const all = await incidentDeps
    .listServants({ includeAll: true, forSessionId: input.sessionId })
    .catch(() => [])

  // 主管会话本身不自动中断：它由用户直接驱动，熔断会打断用户的现场对话。
  // （员工会话才有"空转烧配额"的问题；主管空转由用户自己看得见。）
  if (all.find((s) => s.sessionId === input.sessionId)?.supervisor) {
    unknownToolStreaks.delete(input.sessionId)
    return false
  }

  // 中断是功能动作，保留（不是通知）。
  incidentDeps.interrupt(input.sessionId)

  // 同一次连续窗口内只记一次诊断，避免刷屏
  if (unknownToolTripped.has(input.sessionId)) return true
  unknownToolTripped.add(input.sessionId)

  const roleText = entry.role ? `${entry.role}（${entry.description || '未填写特性'}）` : '未命名角色'
  const toolText = extractUnknownToolName(input.resultText)
  // v1.2.3 用户规则：这类系统通知不进对话流（客户看到也不能干啥），降为日志级。
  incidentDeps.recordEvent({
    type: 'servant_unknown_tool_circuit',
    severity: 'warn',
    summary: `员工会话连续 ${streak} 次调用不存在的工具「${toolText}」，已自动中断该轮次：${roleText}`,
    sessionId: input.sessionId,
    details: {
      sessionId: input.sessionId,
      toolName: toolText,
      streak,
      action: 'interrupt-turn',
    },
  })
  return true
}
