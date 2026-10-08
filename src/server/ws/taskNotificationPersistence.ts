/**
 * 后台任务通知的转录持久化（v1.7.4 结构专项 B1-3：从 ws/handler.ts 拆出）
 *
 * 语义属「转录持久化」而非「会话活动状态」，故**不**并入 ./sessionActivity.ts
 * （见 HANDOVER 条目 9 的拆批理由）。表只留在本模块内：handler 经
 * `persistCliTaskNotification` 写入、经 `forgetSessionTaskNotifications` /
 * `resetTaskNotificationPersistenceForTests` 清理，不再直接触碰表。
 *
 * 键结构 sessionId → (eventKey → 在途写入 Promise)：同一事件的多个观察者共用同一次
 * 写（去重），写失败则回滚该键以便下次重试。
 */

import { sessionService } from '../services/sessionService.js'
import { normalizeCliTaskNotification } from './handlerPures.js'

const taskNotificationPersistence = new Map<string, Map<string, Promise<void>>>()

export function persistCliTaskNotification(
  sessionId: string,
  cliMsg: any,
): Promise<void> | null {
  const notification = normalizeCliTaskNotification(cliMsg)
  if (!notification) return null

  let sessionWrites = taskNotificationPersistence.get(sessionId)
  if (!sessionWrites) {
    sessionWrites = new Map()
    taskNotificationPersistence.set(sessionId, sessionWrites)
  }
  const eventKey = typeof cliMsg.uuid === 'string' && cliMsg.uuid
    ? cliMsg.uuid
    : JSON.stringify(notification)
  const existing = sessionWrites.get(eventKey)
  if (existing) return existing

  const write = sessionService.appendSessionTaskNotification(sessionId, notification)
    .catch((error) => {
      sessionWrites?.delete(eventKey)
      console.warn(
        `[WS] Failed to persist task notification for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    })
  sessionWrites.set(eventKey, write)
  return write
}

export const __persistCliTaskNotificationForTests = persistCliTaskNotification

/** 会话销毁/清理：丢弃该会话的在途写入记录（原 handler 内 `delete(sessionId)`）。 */
export function forgetSessionTaskNotifications(sessionId: string): void {
  taskNotificationPersistence.delete(sessionId)
}

/** 测试复位：清空全部在途写入记录（原 `__resetWebSocketHandlerStateForTests` 内的 `clear()`）。 */
export function resetTaskNotificationPersistenceForTests(): void {
  taskNotificationPersistence.clear()
}
