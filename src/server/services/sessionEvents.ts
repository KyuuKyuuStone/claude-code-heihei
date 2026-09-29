/**
 * sessionEvents —— 会话状态事件的 typed 总线（v1.3.0 地基重构 · 阶段 0 骨架）。
 *
 * 设计纪律（架构方案 §2 / 硬约束 C5、C7）：
 * - 事件载荷只带 sessionId + 状态字段（防环；不携带回调/对象引用）。
 * - `emitSessionEvent` 仅允许 sessionRegistry 内部调用（见其注释的 lint 锁定意图；
 *   阶段 0 以注释 + 评审双锁，dependency-cruiser 规则随阶段 4 收紧）。
 * - 不做异步队列 / 持久化 / 重放 / 跨进程（防过度设计）。
 * - `resetSessionEventsForTests` 供测试隔离（模块级单例 × bun 同进程多文件，C7）。
 */
import type { SessionPhase, TurnPhase } from './sessionRegistry.js'

export type SessionEvent =
  | { type: 'phase_changed'; sessionId: string; from: SessionPhase; to: SessionPhase; meta?: Record<string, unknown> }
  | { type: 'turn_changed'; sessionId: string; turn: TurnPhase; meta?: Record<string, unknown> }
  | { type: 'permission_changed'; sessionId: string; awaiting: boolean }

export type SessionEventFilter = {
  sessionId?: string
  types?: SessionEvent['type'][]
}

type Listener = {
  handler: (e: SessionEvent) => void
  filter?: SessionEventFilter
}

const listeners = new Set<Listener>()

/** registry 正在向观察者派发事件（重入检测窗口）。 */
let emitting = false

/**
 * 订阅会话事件。返回退订函数（幂等——重复调用无害）。
 * 同步派发：handler 在 emit 调用栈内执行，因此**禁止在 handler 内同步调用
 * registry 写 API**（会被 assertNotReentrant 拦截）；如需反应式写入，请用
 * queueMicrotask/setTimeout 延后。
 *
 * 按 handler 函数引用去重（R1 收口·v1.3.1）：同一 handler 引用 + 同构 filter
 * 至多注册一份——ensure 模式订阅器（崩溃观察者 / dispatchReceipt 补偿 /
 * handler rebind·turn 广播）依赖本语义「重复调用幂等、被清后重调即恢复」。
 * 此前每次调用都 new 包装对象 add 进 Set，同一函数引用被注册多份，事件到达
 * 时 handler 重复执行（行为幂等的订阅器掩盖了泄漏，非幂等的会重复副作用）。
 */
export function onSessionEvent(
  handler: (e: SessionEvent) => void,
  filter?: SessionEventFilter,
): () => void {
  const filterKey = filter ? JSON.stringify(filter) : ''
  const existing = [...listeners].find(
    (listener) =>
      listener.handler === handler &&
      (listener.filter ? JSON.stringify(listener.filter) : '') === filterKey,
  )
  if (existing) {
    return () => {
      listeners.delete(existing)
    }
  }
  const listener: Listener = { handler, filter }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 派发事件。【仅 sessionRegistry 内部调用——lint 锁定意图：阶段 0 以本注释 +
 * 评审双锁执行；阶段 4 落 dependency-cruiser 规则后升级为工具链强制】
 *
 * 先改状态后发（C5）由 registry 保证；此处只负责把事件送达观察者：
 * - 按 filter（sessionId / types）过滤；
 * - 单个观察者异常被捕获并 console.error，不拖垮总线与其他观察者。
 */
export function emitSessionEvent(e: SessionEvent): void {
  emitting = true
  try {
    // 遍历快照：观察者可在回调中退订（含自身），不炸迭代
    for (const listener of [...listeners]) {
      if (listener.filter?.sessionId !== undefined && listener.filter.sessionId !== e.sessionId) continue
      if (listener.filter?.types && !listener.filter.types.includes(e.type)) continue
      try {
        listener.handler(e)
      } catch (error) {
        console.error('[sessionEvents] observer handler threw:', error)
      }
    }
  } finally {
    emitting = false
  }
}

/**
 * 开发期断言：事件派发期间禁止 registry 写 API 重入。
 * registry 的全部写入入口（含 TurnHandle.abort/settle）在开头调用本函数，
 * 保证「先改状态后发」的顺序不被观察者的同步反写破坏。
 */
export function assertNotReentrant(): void {
  if (emitting) {
    throw new Error(
      '[sessionEvents] reentrant registry write inside event handler — '
        + 'defer via queueMicrotask/setTimeout instead of writing synchronously.',
    )
  }
}

/** 测试隔离：清空全部监听器并复位派发窗口（C7）。 */
export function resetSessionEventsForTests(): void {
  listeners.clear()
  emitting = false
}
