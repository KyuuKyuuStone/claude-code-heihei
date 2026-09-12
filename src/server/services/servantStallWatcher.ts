/**
 * ServantStallWatcher — 员工会话假死自动重推
 *
 * 员工 CLI 运行中但 transcript 长时间无更新（10 分钟）= 假死/卡住。
 * 自动注入一条续跑消息（实战验证：注入即救活），同一卡死 episode 最多
 * 重推 3 次，仍无活动则升级通知主管人工介入。活动恢复即重置计数。
 *
 * 与 servantIncidentNotifier 的分工：那边处理"进程崩溃退出"（事件驱动），
 * 这里处理"进程活着但不动"（时间驱动）。
 */

import { servantService } from './servantService.js'
import { sessionMessenger } from './sessionMessenger.js'
import { ProviderService } from './providerService.js'

const WATCH_INTERVAL_MS = 60_000
/** 运行中但无活动超过该阈值 = 假死 */
const STALL_THRESHOLD_MS = 10 * 60_000
/** 同一卡死 episode 的最大自动重推次数，超过则升级主管 */
const MAX_AUTO_REPUSH = 3

type StallState = { nudges: number; escalated: boolean; lastActivityAtMs: number }

export class ServantStallWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  /** sessionId → 卡死 episode 状态；活动恢复即清除 */
  private stallStates = new Map<string, StallState>()

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.watch().catch(() => {})
    }, WATCH_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async watch(): Promise<void> {
    const servants = await servantService
      .listServants({ includeAll: true })
      .catch(() => [])
    const now = Date.now()

    for (const servant of servants) {
      if (!servant.enabled) continue
      const key = servant.sessionId
      // 进程死了不属于"假死"：可能是用户主动关闭，不自动拉起
      if (!servant.running) {
        this.stallStates.delete(key)
        continue
      }
      if (!servant.lastActivityAt) continue
      const lastActivityMs = Date.parse(servant.lastActivityAt)
      if (!Number.isFinite(lastActivityMs)) continue
      const staleFor = now - lastActivityMs

      if (staleFor < STALL_THRESHOLD_MS) {
        // 有活动 = 恢复正常，重置该 episode
        this.stallStates.delete(key)
        continue
      }

      const state = this.stallStates.get(key) ?? { nudges: 0, escalated: false, lastActivityAtMs: lastActivityMs }
      // 活动时间变了（新 episode）→ 重置计数
      if (state.lastActivityAtMs !== lastActivityMs) {
        this.stallStates.set(key, { nudges: 0, escalated: false, lastActivityAtMs: lastActivityMs })
      }

      const current = this.stallStates.get(key)!
      if (current.escalated) continue
      if (current.nudges >= MAX_AUTO_REPUSH) {
        current.escalated = true
        await this.notifySupervisor(servant, staleFor)
        continue
      }
      current.nudges++
      this.stallStates.set(key, current)

      const roleText = servant.role ? `${servant.role}（${servant.title}）` : servant.title
      const nudge = [
        `【系统】你已经 ${Math.round(staleFor / 60_000)} 分钟没有任何活动，疑似卡住（自动重推 ${current.nudges}/${MAX_AUTO_REPUSH}）。`,
        '请汇报当前状态与卡点：1) 若在等待或重试某个失败操作，改用替代方案；2) 若工具调用报错，用 select:Bash,Read,Write,Glob,Grep 精确加载后继续；3) 完成或无法继续时，用 .heihei/dispatch/ 信箱向主管汇报。',
      ].join('\n')
      try {
        await sessionMessenger.deliver(
          servant.sessionId,
          nudge,
          `127.0.0.1:${ProviderService.getServerPort()}`,
        )
      } catch (error) {
        console.warn(
          `[ServantStallWatcher] nudge failed for ${servant.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  private async notifySupervisor(
    servant: { sessionId: string; role?: string; title: string },
    staleForMs: number,
  ): Promise<void> {
    const all = await servantService
      .listServants({ includeAll: true, forSessionId: servant.sessionId })
      .catch(() => [])
    const supervisor = all.find((s) => s.supervisor && s.sessionId !== servant.sessionId)
    if (!supervisor) return
    const roleText = servant.role ? `${servant.role}（${servant.title}）` : servant.title
    try {
      await sessionMessenger.deliver(
        supervisor.sessionId,
        `【系统】员工会话假死未恢复：${roleText}（会话 ID：${servant.sessionId}）已 ${Math.round(staleForMs / 60_000)} 分钟无活动，自动重推 ${MAX_AUTO_REPUSH} 次无效。建议人工介入：检查该会话现场，或 POST /api/sessions/${servant.sessionId}/interrupt 后重新派活。`,
        `127.0.0.1:${ProviderService.getServerPort()}`,
      )
    } catch (error) {
      console.warn(
        `[ServantStallWatcher] supervisor escalation failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

export const servantStallWatcher = new ServantStallWatcher()
