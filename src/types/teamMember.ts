/**
 * 团队成员状态（纯数据形状）。
 *
 * 2026-10-08 G2 批从 `src/server/ws/events.ts` 下沉到 L0：L2 服务 `teamWatcher`
 * 需要它来拼 `team_update` 广播消息，而 L2 → L4（ws/*）的上行 import 是门禁违规
 * （`layer-L2-no-upward`）。纯数据形状放 L0 后，L4 与 L2 都向下引用，方向合法。
 */
export type TeamMemberStatus = {
  agentId: string
  role: string
  status: 'running' | 'idle' | 'completed' | 'error'
  currentTask?: string
}
