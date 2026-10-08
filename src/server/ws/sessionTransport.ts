/**
 * WebSocket 传输枢纽（v1.7.4 结构专项 · T0：从 ws/handler.ts 上提）
 *
 * 本模块是 **叶子**（L4 内最低层）：只依赖 bun 类型、`./events.js` 的类型与
 * L1/L2 服务，**不得** import `ws/handler.ts`，也不得 import 任何反向 import
 * `ws/handler` 的模块（computerUseApprovalService / sessionComponentReloadService /
 * teamWatcher）——否则 `no-circular` 新增违规。handler 与后续各域模块统一从这里
 * 取三张连接表与发送原语。
 *
 * 三张表（activeSessions / globalEventClients / clientOutputCallbacks）只留在本
 * 模块内：外部经原语读写，不再直接触碰表（同 B1-1 / B1-3 口径）。
 *
 * 刻意**未**搬入者（依赖尚未外移的 handler 内部件，搬了必成环，留待后续批）：
 * `bindClientSessionOutput`（调 `translateCliMessage` / `handleCliPermissionModeBroadcast`）、
 * `bindAllClientSessionOutputs`、（同上）、`closeSessionConnection`（调
 * `computerUseApprovalService` + `cleanupSessionRuntimeState`）。
 */

import type { ServerWebSocket } from 'bun'
import { conversationService } from '../services/conversationService.js'
import { addTurnChangeListener } from '../services/dispatchReceiptService.js'
import { setSessionClientAttached } from '../services/sessionRegistry.js'
import type { ServerMessage } from './events.js'

export type WebSocketData = {
  sessionId: string
  connectedAt: number
  channel: 'client' | 'sdk'
  sdkToken: string | null
  serverPort: number
  serverHost: string
}

// Active WebSocket clients, grouped by session. Multiple desktop windows can
// legitimately watch the same running session at the same time.
const activeSessions = new Map<string, Set<ServerWebSocket<WebSocketData>>>()

/**
 * 全局事件通道（保留会话 ID `_events`）：不绑定任何真实会话，只向订阅方
 * 推送跨会话事件（当前仅 servant_turn_changed，来源 dispatchReceiptService
 * 的回合翻转，与花名册 turnInProgress 字段同源）。用于前端状态灯免轮询即时
 * 更新（转圈残留根治·方案B）。
 */
export const GLOBAL_EVENTS_SESSION_ID = '_events'
const globalEventClients = new Set<ServerWebSocket<WebSocketData>>()

const clientOutputCallbacks = new Map<
  ServerWebSocket<WebSocketData>,
  {
    sessionId: string
    callback: (cliMsg: any) => void
  }
>()

export function sendMessage(ws: ServerWebSocket<WebSocketData>, message: ServerMessage) {
  ws.send(JSON.stringify(message))
}

export function sendError(ws: ServerWebSocket<WebSocketData>, message: string, code: string) {
  sendMessage(ws, { type: 'error', message, code })
}

/**
 * Send a message to a specific session's WebSocket (for use by services)
 */
export function sendToSession(sessionId: string, message: ServerMessage): boolean {
  const clients = activeSessions.get(sessionId)
  if (!clients || clients.size === 0) return false
  for (const ws of clients) {
    sendMessage(ws, message)
  }
  return true
}

/** 向所有全局事件通道（_events）订阅方广播一条跨会话事件 */
export function broadcastGlobalEvent(message: ServerMessage): number {
  for (const ws of globalEventClients) {
    sendMessage(ws, message)
  }
  return globalEventClients.size
}

// 回合翻转 → 全局事件广播。状态源与花名册 turnInProgress 完全同源
// （dispatchReceiptService.turnActiveBroadcast 观察流），前端收到即可局部
// 更新，免等轮询。
function broadcastTurnChangeListener(sessionId: string, turnInProgress: boolean): void {
  broadcastGlobalEvent({
    type: 'system_notification',
    subtype: 'servant_turn_changed',
    data: { sessionId, turnInProgress },
  })
}

/**
 * R4b 收口（v1.3.1）：同 ensureRebindOnRunningSubscribed——被
 * resetDispatchReceipts（清 addTurnChangeListener 的 Set）清掉后可重调恢复。
 * Set 直接存函数引用，同一稳定引用天然去重幂等。
 */
export function ensureTurnChangeBroadcastSubscribed(): void {
  addTurnChangeListener(broadcastTurnChangeListener)
}

ensureTurnChangeBroadcastSubscribed()

export function addActiveClient(
  sessionId: string,
  ws: ServerWebSocket<WebSocketData>,
): void {
  let clients = activeSessions.get(sessionId)
  if (!clients) {
    clients = new Set()
    activeSessions.set(sessionId, clients)
  }
  clients.add(ws)
  // P0-b（裁决十九·选 a）：handler 是 clientAttached 的唯一写入方
  setSessionClientAttached(sessionId, true)
  // 中途接入只延长（重置到 15min 档）；幂等，重复 add 无害
  conversationService.onClientAttached(sessionId)
}

export function removeActiveClient(
  sessionId: string,
  ws: ServerWebSocket<WebSocketData>,
): boolean {
  const clients = activeSessions.get(sessionId)
  if (!clients?.has(ws)) return false
  clients.delete(ws)
  if (clients.size === 0) {
    activeSessions.delete(sessionId)
    // P0-b：仅更新在线状态；**断开不降档、不重置**既有计时（裁决十九）
    setSessionClientAttached(sessionId, false)
  }
  return true
}

export function hasActiveClients(sessionId: string): boolean {
  return (activeSessions.get(sessionId)?.size ?? 0) > 0
}

export function getActiveSessionIds(): string[] {
  return Array.from(activeSessions.keys())
}

/** 只读访问器：某会话当前连接的客户端集合（不外泄可写引用给调用方以外的语义）。 */
export function getSessionClients(
  sessionId: string,
): Set<ServerWebSocket<WebSocketData>> | undefined {
  return activeSessions.get(sessionId)
}

/** 摘除并返回某会话的客户端集合（closeSessionConnection 用：原 `get` + `delete` 合并语义）。 */
export function takeSessionClients(
  sessionId: string,
): Set<ServerWebSocket<WebSocketData>> | undefined {
  const clients = activeSessions.get(sessionId)
  if (!clients) return undefined
  activeSessions.delete(sessionId)
  return clients
}

export function subscribeGlobalEvents(ws: ServerWebSocket<WebSocketData>): void {
  globalEventClients.add(ws)
}

export function unsubscribeGlobalEvents(ws: ServerWebSocket<WebSocketData>): void {
  globalEventClients.delete(ws)
}

export function removeClientOutputCallback(ws: ServerWebSocket<WebSocketData>): void {
  const entry = clientOutputCallbacks.get(ws)
  if (!entry) return
  conversationService.removeOutputCallback(entry.sessionId, entry.callback)
  clientOutputCallbacks.delete(ws)
}

export function registerClientOutputCallback(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  callback: (cliMsg: any) => void,
): void {
  clientOutputCallbacks.set(ws, { sessionId, callback })
}

export function forgetClientOutputCallback(ws: ServerWebSocket<WebSocketData>): void {
  clientOutputCallbacks.delete(ws)
}

export function resetSessionTransportForTests(): void {
  activeSessions.clear()
  globalEventClients.clear()
  clientOutputCallbacks.clear()
}
