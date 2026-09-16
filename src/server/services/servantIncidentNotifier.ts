/**
 * ServantIncidentNotifier — 员工会话异常事件 → 主动通知其主管
 *
 * 员工 CLI 进程异常崩溃（非刻意停止/回收）时，正在执行的任务会中断。
 * 主动告知主管"任务可能中断 + 建议处理方式"，让中断在一分钟内被看见，
 * 而不是等主管假活巡检或用户人工发现（2026-09-10 实战反馈）。
 *
 * 依赖全部动态导入：本模块被 conversationService（handleProcessExit）调用，
 * 避免 conversationService ↔ servantService/sessionMessenger 静态依赖环。
 */

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
}

const defaultDeps: ServantIncidentDeps = {
  deliver: (targetSessionId, content, serverHost) =>
    sessionMessenger.deliver(targetSessionId, content, serverHost),
  getServant: (sessionId) => servantService.getServant(sessionId),
  listServants: (options) => servantService.listServants(options),
  getServerPort: () => ProviderService.getServerPort(),
  // 动态导入避免与 conversationService 的静态依赖环（本模块正是被它动态导入的）。
  // 走 sendInterrupt（= interruptSessionRuntime 内部第一步调用的同一 SDK 优雅中断通道），
  // 而不走 interruptSessionRuntime：后者依赖 activeUserTurns，对「文件信箱/HTTP 注入式
  // 回合」可能为空，会直接跳过中断并返回 stopped=false（见根因调查报告 §2.3）。
  interrupt: (sessionId) => {
    void import('./conversationService.js')
      .then(({ conversationService }) => {
        conversationService.sendInterrupt(sessionId)
      })
      .catch(() => {})
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

  const all = await incidentDeps
    .listServants({ includeAll: true, forSessionId: input.sessionId })
    .catch(() => [])
  const supervisor = all.find((s) => s.supervisor && s.sessionId !== input.sessionId)
  if (!supervisor) return

  const roleText = entry.role ? `${entry.role}（${entry.description || '未填写特性'}）` : '未命名角色'
  const codeText = input.exitCode === null ? '未知原因' : `exit code ${input.exitCode}`
  const content = [
    `【系统】员工会话异常退出：${roleText}（会话 ID：${entry.sessionId}），${codeText}。其正在执行的任务很可能已中断。`,
    `建议处理：1) 重新派活让其继续（附上原任务要点与已完成部分）；2) 现场混乱时先 POST /api/sessions/${entry.sessionId}/interrupt 清理，再重新派活；3) 已完成部分可从其产出文件核对。`,
  ].join('\n')

  await incidentDeps.deliver(supervisor.sessionId, content, `127.0.0.1:${incidentDeps.getServerPort()}`)
}

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

  // 达到自动续跑上限：升级通知主管一次，之后保持静默等成功轮重置
  if (input.streak > TURN_ERROR_MAX_AUTO_NUDGES) {
    if (!turnErrorEscalated.has(input.sessionId)) {
      turnErrorEscalated.add(input.sessionId)
      const all = await incidentDeps
        .listServants({ includeAll: true, forSessionId: input.sessionId })
        .catch(() => [])
      const supervisor = all.find((s) => s.supervisor && s.sessionId !== input.sessionId)
      if (supervisor) {
        const roleText = entry.role ? `${entry.role}（${entry.description || '未填写特性'}）` : '未命名角色'
        await incidentDeps.deliver(
          supervisor.sessionId,
          `【系统】员工会话连续 ${input.streak} 轮报错，已停止自动续跑，请人工介入：${roleText}（会话 ID：${input.sessionId}）。最近错误摘要：${input.summary || '（无详情）'}`,
          `127.0.0.1:${incidentDeps.getServerPort()}`,
        )
      }
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

  incidentDeps.interrupt(input.sessionId)

  // 同一次连续窗口内只通知一次，避免每多调一次就再吵一次主管
  if (unknownToolTripped.has(input.sessionId)) return true
  unknownToolTripped.add(input.sessionId)

  const supervisor = all.find((s) => s.supervisor && s.sessionId !== input.sessionId)
  if (!supervisor) return true

  const roleText = entry.role ? `${entry.role}（${entry.description || '未填写特性'}）` : '未命名角色'
  const toolText = extractUnknownToolName(input.resultText)
  await incidentDeps.deliver(
    supervisor.sessionId,
    `【系统】员工会话连续 ${streak} 次调用不存在的工具「${toolText}」，已自动中断该轮次（会话与历史保留）：${roleText}（会话 ID：${input.sessionId}）。`,
    `127.0.0.1:${incidentDeps.getServerPort()}`,
  )
  return true
}
