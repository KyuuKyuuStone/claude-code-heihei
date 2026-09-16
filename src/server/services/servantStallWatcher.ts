/**
 * ServantStallWatcher — 员工会话假死自动重推
 *
 * "假死"分两类（2026-09-16 根因分析，见 cc-heihei-交接/批次3_假死重推根因分析）：
 * - **进程活着但不动**：CLI 运行中但 transcript 长时间无更新（10 分钟）→ 自动注入
 *   一条续跑消息（实战验证：注入即救活），同一 episode 最多重推 3 次，仍无活动
 *   则升级通知主管人工介入。活动恢复即重置计数。
 * - **进程不在了但花名册仍启用**（服务端重启后 CLI 成孤儿、CLI 自行退出、被回收）：
 *   自动重推对它没有意义（要投递就得先拉起会话，等于替用户做"自动拉起"决策），
 *   一期口径是**只告警不自动拉起**，让主管手动唤醒/重新派活。
 *   —— 旧实现把这一类直接 `continue` 静默跳过，正是"该重推却一声不吭"的根因。
 *
 * 与 servantIncidentNotifier 的分工：那边处理"进程崩溃退出"（事件驱动），
 * 这里处理"进程活着但不动 / 进程不在了却没动静"（时间驱动）。
 */

import { diagnosticsService } from './diagnosticsService.js'
import { servantService } from './servantService.js'
import { sessionMessenger } from './sessionMessenger.js'
import { ProviderService } from './providerService.js'

const WATCH_INTERVAL_MS = 60_000
/** 运行中但无活动超过该阈值 = 假死 */
export const STALL_THRESHOLD_MS = 10 * 60_000
/** 同一卡死 episode 的最大自动重推次数，超过则升级主管 */
export const MAX_AUTO_REPUSH = 3

type StallState = { nudges: number; escalated: boolean; lastActivityAtMs: number }

/** 假死扫描用到的员工字段（服务端 listServants 的子集） */
export type StallServantInfo = {
  sessionId: string
  role?: string
  title?: string
  enabled: boolean
  supervisor?: boolean
  running?: boolean
  lastActivityAt?: string
}

/** 可注入依赖（测试用）；缺省走真实服务。模式同 servantIncidentNotifier。 */
export type ServantStallWatcherDeps = {
  listServants: (options: { includeAll: boolean; forSessionId?: string }) => Promise<StallServantInfo[]>
  /** 投递消息；返回 false 表示未送达（例如网络环境刷新失败），调用方不得计入重推次数 */
  deliver: (targetSessionId: string, content: string, serverHost: string) => Promise<boolean>
  getServerPort: () => number
  recordEvent: (input: {
    type: string
    severity?: 'info' | 'warn' | 'error'
    summary: string
    sessionId?: string
    details?: unknown
  }) => void
  now: () => number
}

const defaultDeps: ServantStallWatcherDeps = {
  listServants: (options) => servantService.listServants(options),
  deliver: (targetSessionId, content, serverHost) =>
    sessionMessenger.deliver(targetSessionId, content, serverHost),
  getServerPort: () => ProviderService.getServerPort(),
  recordEvent: (input) => {
    void diagnosticsService.recordEvent(input).catch(() => {})
  },
  now: () => Date.now(),
}

export class ServantStallWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  /** sessionId → 卡死 episode 状态；活动恢复即清除 */
  private stallStates = new Map<string, StallState>()
  /** sessionId → 已告警过的「无运行进程」episode 的活动时间戳（同一 episode 只告警一次） */
  private noProcessAlertedAt = new Map<string, number>()

  constructor(private deps: ServantStallWatcherDeps = defaultDeps) {}

  /** 测试注入假依赖；传 null 恢复默认 */
  setDeps(overrides: Partial<ServantStallWatcherDeps> | null): void {
    this.deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps
  }

  /** 清空全部 episode 状态（测试隔离用） */
  resetState(): void {
    this.stallStates.clear()
    this.noProcessAlertedAt.clear()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.watch().catch((error) => {
        // 不再静默：整轮异常也要留痕
        this.report('error', 'scan-failed', `假死扫描整轮异常：${describeError(error)}`)
      })
    }, WATCH_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private report(
    severity: 'info' | 'warn' | 'error',
    action: string,
    summary: string,
    sessionId?: string,
    details?: Record<string, unknown>,
  ): void {
    try {
      this.deps.recordEvent({
        type: 'servant_stall',
        severity,
        summary,
        ...(sessionId ? { sessionId } : {}),
        details: { action, ...details },
      })
    } catch {
      // 诊断本身不能反过来打断扫描
    }
  }

  async watch(): Promise<void> {
    let servants: StallServantInfo[]
    try {
      servants = await this.deps.listServants({ includeAll: true })
    } catch (error) {
      // 旧实现 `.catch(() => [])`：名单读取失败 = 整轮静默空转，现场毫无痕迹。
      this.report(
        'error',
        'list-failed',
        `员工名单读取失败，本轮假死扫描跳过：${describeError(error)}`,
      )
      return
    }

    const now = this.deps.now()

    for (const servant of servants) {
      if (!servant.enabled) continue
      const key = servant.sessionId

      // 主管会话豁免：它由用户直接驱动，重推/告警只会打扰用户的现场对话
      if (servant.supervisor) {
        this.stallStates.delete(key)
        this.noProcessAlertedAt.delete(key)
        continue
      }

      if (!servant.lastActivityAt) {
        this.report('warn', 'skip-missing-activity', '员工会话缺少 lastActivityAt，跳过假死判定', key)
        continue
      }
      const lastActivityMs = Date.parse(servant.lastActivityAt)
      if (!Number.isFinite(lastActivityMs)) {
        this.report(
          'warn',
          'skip-bad-activity',
          `员工会话 lastActivityAt 无法解析（${servant.lastActivityAt}），跳过假死判定`,
          key,
        )
        continue
      }
      const staleFor = now - lastActivityMs

      if (staleFor < STALL_THRESHOLD_MS) {
        // 有活动 = 恢复正常，重置该 episode
        this.stallStates.delete(key)
        this.noProcessAlertedAt.delete(key)
        continue
      }

      if (!servant.running) {
        await this.alertNoProcess(servant, staleFor, lastActivityMs)
        continue
      }
      this.noProcessAlertedAt.delete(key)

      // 2026-09-16 修复的致命 bug：旧写法是
      //   const state = this.stallStates.get(key) ?? { …lastActivityAtMs }  ← 新建的对象
      //   if (state.lastActivityAtMs !== lastActivityMs) { set(...) }         ← 恒为 false，不落 map
      //   const current = this.stallStates.get(key)!                          ← undefined → 抛 TypeError
      // 于是**首次跨过阈值就崩**，异常被 start() 的 .catch 吞掉：整轮扫描中断，
      // 该会话与名单里它之后的会话从此永不重推、永不升级（这就是"该重推却一声不吭"）。
      // 现在改成"取不到就建并落 map"，map 才可能真正被填充。
      let current = this.stallStates.get(key)
      if (!current || current.lastActivityAtMs !== lastActivityMs) {
        // 新 episode（含首次进入）→ 计数从 0 起
        current = { nudges: 0, escalated: false, lastActivityAtMs: lastActivityMs }
        this.stallStates.set(key, current)
      }
      if (current.escalated) continue
      if (current.nudges >= MAX_AUTO_REPUSH) {
        current.escalated = true
        await this.notifySupervisor(servant, staleFor)
        continue
      }

      const roleText = servant.role ? `${servant.role}（${servant.title}）` : servant.title
      const nudge = [
        `【系统】你已经 ${Math.round(staleFor / 60_000)} 分钟没有任何活动，疑似卡住（自动重推 ${current.nudges + 1}/${MAX_AUTO_REPUSH}）。`,
        '请汇报当前状态与卡点：1) 若在等待或重试某个失败操作，改用替代方案；2) 若工具调用报错：核心工具（Bash/Read/Write/Glob/Grep）本就内联可用，直接调用即可，不要用 ToolSearch 反复加载；3) 完成或无法继续时，用 .heihei/dispatch/ 信箱向主管汇报。',
      ].join('\n')

      // 投递成功才计入次数：旧实现在投递【之前】就 nudges++，投递失败也会吃掉一次额度。
      const delivered = await this.tryDeliver(servant.sessionId, nudge)
      if (!delivered) {
        this.report(
          'warn',
          'nudge-failed',
          `假死重推投递失败（未计入重推次数）：${roleText}（会话 ID：${servant.sessionId}）`,
          servant.sessionId,
          { staleForMs: staleFor, running: true },
        )
        continue
      }

      current.nudges++
      this.stallStates.set(key, current)
      this.report(
        'info',
        'nudge',
        `假死重推 ${current.nudges}/${MAX_AUTO_REPUSH} 已送达：${roleText}（会话 ID：${servant.sessionId}）`,
        servant.sessionId,
        { staleForMs: staleFor, running: true, nudges: current.nudges },
      )
    }
  }

  /**
   * 进程不在了（running=false）但会话长时间无活动：只告警，不自动拉起。
   *
   * 为什么不自动拉起：投递通道 `sessionMessenger.deliver()` 对未运行会话会
   * `startSession()`（`sessionMessenger.ts:40-73`），等于替用户做"自动重开会话"的
   * 决定——一期口径是保守的，交给主管手动唤醒/重新派活（自动拉起列二期选项）。
   */
  private async alertNoProcess(
    servant: StallServantInfo,
    staleForMs: number,
    lastActivityMs: number,
  ): Promise<void> {
    const key = servant.sessionId
    if (this.noProcessAlertedAt.get(key) === lastActivityMs) return
    this.noProcessAlertedAt.set(key, lastActivityMs)

    const all = await this.listSafely(servant.sessionId)
    const supervisor = all.find((s) => s.supervisor && s.sessionId !== servant.sessionId)

    const roleText = servant.role ? `${servant.role}（${servant.title}）` : servant.title
    this.report(
      'warn',
      'no-process-alert',
      `员工会话已无运行进程且 ${Math.round(staleForMs / 60_000)} 分钟无活动，不会自愈：${roleText}（会话 ID：${servant.sessionId}）`,
      servant.sessionId,
      { staleForMs, running: false },
    )

    if (!supervisor) return
    await this.tryDeliver(
      supervisor.sessionId,
      `【系统】员工会话假死且**已无运行进程**：${roleText}（会话 ID：${servant.sessionId}）已 ${Math.round(staleForMs / 60_000)} 分钟无活动（running=false，staleForMs=${staleForMs}）。这类会话不会自愈，自动重推对其无效。建议手动唤醒：向该会话注入一条消息（投递通道会自动重新拉起会话），或直接重新派活；若已不需要，请在花名册里禁用它。`,
    )
  }

  private async listSafely(forSessionId: string): Promise<StallServantInfo[]> {
    try {
      return await this.deps.listServants({ includeAll: true, forSessionId })
    } catch (error) {
      this.report(
        'warn',
        'roster-read-failed',
        `读取花名册（用于找回主管）失败：${describeError(error)}`,
        forSessionId,
      )
      return []
    }
  }

  private async tryDeliver(targetSessionId: string, content: string): Promise<boolean> {
    try {
      return await this.deps.deliver(
        targetSessionId,
        content,
        `127.0.0.1:${this.deps.getServerPort()}`,
      )
    } catch (error) {
      this.report(
        'warn',
        'deliver-threw',
        `消息投递异常：${describeError(error)}`,
        targetSessionId,
      )
      return false
    }
  }

  private async notifySupervisor(servant: StallServantInfo, staleForMs: number): Promise<void> {
    const all = await this.listSafely(servant.sessionId)
    const supervisor = all.find((s) => s.supervisor && s.sessionId !== servant.sessionId)
    const roleText = servant.role ? `${servant.role}（${servant.title}）` : servant.title
    this.report(
      'warn',
      'escalate',
      `假死自动重推 ${MAX_AUTO_REPUSH} 次无效，升级主管：${roleText}（会话 ID：${servant.sessionId}）`,
      servant.sessionId,
      { staleForMs, running: true },
    )
    if (!supervisor) return
    await this.tryDeliver(
      supervisor.sessionId,
      `【系统】员工会话假死未恢复：${roleText}（会话 ID：${servant.sessionId}）已 ${Math.round(staleForMs / 60_000)} 分钟无活动，自动重推 ${MAX_AUTO_REPUSH} 次无效。建议人工介入：检查该会话现场，或 POST /api/sessions/${servant.sessionId}/interrupt 后重新派活。`,
    )
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const servantStallWatcher = new ServantStallWatcher()
