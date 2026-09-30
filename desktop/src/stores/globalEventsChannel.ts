import { wsManager, type WebSocketConnectionState } from '../api/websocket'
import type { ServerMessage } from '../types/chat'

/**
 * 服务端 ws/handler 的全局事件通道（保留会话 ID `_events`）。连接它不绑定任何
 * 真实会话，只接收跨会话事件：servant_turn_changed / servant_roster_changed /
 * session_list_invalidated（事件契约 v1.5.0）。
 *
 * 本模块是通道的唯一 owner：多个订阅方共享同一条 WS，按订阅计数连接/断开。
 */
export const GLOBAL_EVENTS_SESSION_ID = '_events'

type MessageHandler = (msg: ServerMessage) => void
type ReconnectHandler = () => void
type ConnectionStateHandler = (state: WebSocketConnectionState) => void

const messageHandlers = new Set<MessageHandler>()
const reconnectHandlers = new Set<ReconnectHandler>()
const connectionStateHandlers = new Set<ConnectionStateHandler>()
let subscriptionCount = 0
let detachChannel: (() => void) | null = null

function attachChannel(): void {
  wsManager.connect(GLOBAL_EVENTS_SESSION_ID)

  const offMessage = wsManager.onMessage(GLOBAL_EVENTS_SESSION_ID, (msg) => {
    for (const handler of messageHandlers) handler(msg)
  })

  let wasReconnecting = false
  const offState = wsManager.onConnectionState(GLOBAL_EVENTS_SESSION_ID, (state) => {
    for (const handler of connectionStateHandlers) handler(state)
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

export function subscribeGlobalEvents(
  onMessage: MessageHandler,
  onReconnect?: ReconnectHandler,
  onConnectionState?: ConnectionStateHandler,
): () => void {
  messageHandlers.add(onMessage)
  if (onReconnect) reconnectHandlers.add(onReconnect)
  if (onConnectionState) connectionStateHandlers.add(onConnectionState)
  subscriptionCount += 1
  if (subscriptionCount === 1) attachChannel()

  return () => {
    messageHandlers.delete(onMessage)
    if (onReconnect) reconnectHandlers.delete(onReconnect)
    if (onConnectionState) connectionStateHandlers.delete(onConnectionState)
    subscriptionCount -= 1
    if (subscriptionCount <= 0) {
      subscriptionCount = 0
      detachChannel?.()
    }
  }
}

export function resetGlobalEventsChannelForTests(): void {
  messageHandlers.clear()
  reconnectHandlers.clear()
  connectionStateHandlers.clear()
  subscriptionCount = 0
  detachChannel?.()
}
