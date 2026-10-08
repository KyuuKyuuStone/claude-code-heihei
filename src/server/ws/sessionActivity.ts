/**
 * 会话活动状态（v1.7.4 结构专项 B1-1：从 ws/handler.ts 上提「会话活动域」批①）。
 *
 * 活动状态刻意复用权威的 WebSocket 轮次/权限状态（仍在 handler 本地）：只有
 * 「失败终态」与「遗留 REST 队列回退」需要自己的记忆，成功完成直接回到 idle。
 *
 * 三张状态表只留在本模块内 —— handler 通过写入原语改状态、通过只读访问器读状态，
 * 不再直接触碰表。消费方（api/conversations.ts、conversation-status.test.ts）仍从
 * handler 导入同名导出，导入面逐项不变。
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
