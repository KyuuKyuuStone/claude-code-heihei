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
}

const defaultDeps: ServantIncidentDeps = {
  deliver: (targetSessionId, content, serverHost) =>
    sessionMessenger.deliver(targetSessionId, content, serverHost),
  getServant: (sessionId) => servantService.getServant(sessionId),
  listServants: (options) => servantService.listServants(options),
  getServerPort: () => ProviderService.getServerPort(),
}

let incidentDeps: ServantIncidentDeps = defaultDeps

/** 测试注入假依赖；传 null 恢复默认 */
export function setServantIncidentDeps(overrides: Partial<ServantIncidentDeps> | null): void {
  incidentDeps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps
}

export function resetServantIncidentState(): void {
  turnErrorStreaks.clear()
  turnErrorEscalated.clear()
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
