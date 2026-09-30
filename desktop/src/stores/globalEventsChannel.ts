import { wsManager } from '../api/websocket'
import type { ServerMessage } from '../types/chat'

/**
 * 服务端 ws/handler 的全局事件通道（保留会话 ID `_events`）。连接它不绑定任何
 * 真实会话，只接收跨会话事件：servant_turn_changed / servant_roster_changed /
 * session_list_invalidated（事件契约 v1.5.0）。
 *
 * 本模块是通道的唯一 owner：多个订阅方（servantStore / sessionStore）共享同一
 * 条 WS，按订阅计数连接/断开——wsManager.disconnect 会直接关socket，不做引用
 * 计数，裸用会让先退订的一方把别人的通道也掐掉。
 */
export const GLOBAL_EVENTS_SESSION_ID = '_events'

type MessageHandler = (msg: ServerMessage) => void
/** 重连成功回调：断线窗口内的事件可能丢失，订阅方应做一次全量刷新对齐。 */
type ReconnectHandler = () => void

const messageHandlers = new Set<MessageHandler>()
const reconnectHandlers = new Set<ReconnectHandler>()
let subscriptionCount = 0
let detachChannel: (() => void) | null = null

function attachChannel(): void {
  wsManager.connect(GLOBAL_EVENTS_SESSION_ID)

  const offMessage = wsManager.onMessage(GLOBAL_EVENTS_SESSION_ID, (msg) => {
    for (const handler of messageHandlers) handler(msg)
  })

  // reconnecting → connected 的跃迁才算"断线后恢复"；首开 connecting→connected
  // 不算（没有断线窗口要补）。
  let wasReconnecting = false
  const offState = wsManager.onConnectionState(GLOBAL_EVENTS_SESSION_ID, (state) => {
    if (state === 'reconnecting') {
      wasReconnecting = true
      return
    }
    if (state === 'connected' && wasReconnecting) {
      wasReconnecting = false
      for (const handler of reconnectHandlers) handler()
    }
  })

  detachChannel = () => {
    offMessage()
    offState()
    wsManager.disconnect(GLOBAL_EVENTS_SESSION_ID)
    detachChannel = null
  }
}

/**
 * 订阅全局事件。返回退订函数；最后一个订阅方退订时断开通道。
 */
export function subscribeGlobalEvents(
  onMessage: MessageHandler,
  onReconnect?: ReconnectHandler,
): () => void {
  messageHandlers.add(onMessage)
  if (onReconnect) reconnectHandlers.add(onReconnect)
  subscriptionCount += 1
  if (subscriptionCount === 1) attachChannel()

  return () => {
    messageHandlers.delete(onMessage)
    if (onReconnect) reconnectHandlers.delete(onReconnect)
    subscriptionCount -= 1
    if (subscriptionCount <= 0) {
      subscriptionCount = 0
      detachChannel?.()
    }
  }
}

/** 测试用：清空全部订阅并断开通道。 */
export function resetGlobalEventsChannelForTests(): void {
  messageHandlers.clear()
  reconnectHandlers.clear()
  subscriptionCount = 0
  detachChannel?.()
}
