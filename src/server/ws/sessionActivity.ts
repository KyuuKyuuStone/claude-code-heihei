/**
 * 会话活动状态（v1.7.4 结构专项：从 ws/handler.ts 上提「会话活动域」）
 *
 * 批①（B1-1）＝活动状态三表与写入原语；批②（B1-2）＝后台任务子域（活跃集 +
 * 生命周期解析）。两批的表都只留在本模块内 —— handler 通过写入原语改状态、
 * 通过只读访问器读状态，不再直接触碰表。
 *
 * 活动状态刻意复用权威的 WebSocket 轮次/权限状态（仍在 handler 本地，因为
 * `getSessionChatActivityState` 组合它们）：只有「失败终态」与「遗留 REST 队列
 * 回退」需要自己的记忆，成功完成直接回到 idle。
 *
 * 消费方（api/conversations.ts、conversation-status.test.ts）仍从 handler 导入同名
 * 导出，导入面逐项不变。
 *
 * ⚠ 本模块**不得** import `services/computerUseApprovalService.js`：handler 已
 * import 本模块，而该服务又 import `ws/handler`（既有 known 环）⇒ 会组成新的
 * `no-circular`（2026-10-08 实测）。`getSessionChatActivityState` 留在 handler 正是
 * 为此（它要读该服务的待批请求）。
 */

export type SessionChatActivityState =
  | 'waiting'
  | 'failed'
  | 'review'
  | 'running'
  | 'idle'

const terminalSessionChatStates = new Map<string, 'failed'>()
const legacyQueuedSessionChats = new Set<string>()
const interruptedSessionChats = new Set<string>()

/** 清空某会话的全部活动状态（开始新一轮 / 会话销毁共用）。 */
export function clearSessionChatActivity(sessionId: string): void {
  terminalSessionChatStates.delete(sessionId)
  legacyQueuedSessionChats.delete(sessionId)
  interruptedSessionChats.delete(sessionId)
}

export function beginSessionChatActivity(sessionId: string): void {
  clearSessionChatActivity(sessionId)
}

export function failSessionChatActivity(sessionId: string): void {
  legacyQueuedSessionChats.delete(sessionId)
  interruptedSessionChats.delete(sessionId)
  terminalSessionChatStates.set(sessionId, 'failed')
}

export function settleSessionChatActivity(sessionId: string, cliMsg: any): void {
  if (cliMsg?.type !== 'result') return

  legacyQueuedSessionChats.delete(sessionId)
  if (interruptedSessionChats.has(sessionId)) {
    terminalSessionChatStates.delete(sessionId)
    return
  }
  if (cliMsg.is_error) {
    terminalSessionChatStates.set(sessionId, 'failed')
    return
  }

  // A successful result is complete. Keeping the tab open does not imply that
  // the user has an outstanding review action.
  terminalSessionChatStates.delete(sessionId)
}

/**
 * 显式停止：清掉其余状态并置中断标记。中断标记会抢占尚未到达的 CLI 取消事件，
 * 否则被停止的会话会卡在 waiting，直到那次异步清理到达。
 */
export function markSessionChatInterrupted(sessionId: string): void {
  clearSessionChatActivity(sessionId)
  interruptedSessionChats.add(sessionId)
}

/** 遗留 REST 入队端点：标记为运行中。 */
export function markLegacySessionChatQueued(sessionId: string): void {
  beginSessionChatActivity(sessionId)
  legacyQueuedSessionChats.add(sessionId)
}

// ── 只读访问器：handler 的组合读取用（表不外露，读写都经本模块）─────────────

export function isSessionChatInterrupted(sessionId: string): boolean {
  return interruptedSessionChats.has(sessionId)
}

export function getSessionChatTerminalState(sessionId: string): 'failed' | undefined {
  return terminalSessionChatStates.get(sessionId)
}

export function isSessionChatLegacyQueued(sessionId: string): boolean {
  return legacyQueuedSessionChats.has(sessionId)
}

export function resetSessionChatActivityForTests(): void {
  terminalSessionChatStates.clear()
  legacyQueuedSessionChats.clear()
  interruptedSessionChats.clear()
}

// ── 后台任务子域（B1-2）：CLI 后台任务的活跃集与生命周期解析 ─────────────────

export type CliBackgroundTaskLifecycle = {
  taskId: string
  running: boolean
}

const activeBackgroundTaskIds = new Map<string, Set<string>>()

export function getCliBackgroundTaskLifecycle(cliMsg: any): CliBackgroundTaskLifecycle | null {
  if (cliMsg?.type !== 'system') return null
  const taskId = typeof cliMsg.task_id === 'string' ? cliMsg.task_id.trim() : ''
  if (!taskId) return null

  if (cliMsg.subtype === 'task_started') {
    return { taskId, running: true }
  }

  if (cliMsg.subtype === 'task_notification' && cliMsg.status === 'running') {
    return { taskId, running: true }
  }

  if (
    cliMsg.subtype === 'task_notification' &&
    (cliMsg.status === 'completed' ||
      cliMsg.status === 'failed' ||
      cliMsg.status === 'stopped' ||
      cliMsg.status === 'killed')
  ) {
    return { taskId, running: false }
  }

  return null
}

export function trackCliBackgroundTaskLifecycle(
  sessionId: string,
  cliMsg: any,
): CliBackgroundTaskLifecycle | null {
  const lifecycle = getCliBackgroundTaskLifecycle(cliMsg)
  if (!lifecycle) return null

  if (lifecycle.running) {
    let taskIds = activeBackgroundTaskIds.get(sessionId)
    if (!taskIds) {
      taskIds = new Set()
      activeBackgroundTaskIds.set(sessionId, taskIds)
    }
    taskIds.add(lifecycle.taskId)
    return lifecycle
  }

  const taskIds = activeBackgroundTaskIds.get(sessionId)
  taskIds?.delete(lifecycle.taskId)
  if (taskIds?.size === 0) activeBackgroundTaskIds.delete(sessionId)
  return lifecycle
}

export function hasActiveBackgroundTasks(sessionId: string): boolean {
  return (activeBackgroundTaskIds.get(sessionId)?.size ?? 0) > 0
}

/** 会话销毁：清掉该会话的后台任务活跃集。 */
export function clearActiveBackgroundTasks(sessionId: string): void {
  activeBackgroundTaskIds.delete(sessionId)
}

/** 测试复位：清空全部后台任务活跃集。 */
export function resetActiveBackgroundTasksForTests(): void {
  activeBackgroundTaskIds.clear()
}
