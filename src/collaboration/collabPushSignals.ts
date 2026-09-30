/**
 * 协作推送信号缝（v1.5.0 · A6/C12 服务端侧）。
 *
 * 问题：花名册与会话列表的"变化"发生在 L1/L2（sessionRegistry / servantService /
 * sessionService），而唯一合法的广播出口在 L4（ws/handler 的
 * broadcastGlobalEvent，_events 通道）。让下层反向 import ws 层会破坏分层
 * （lint:layers 门禁）。
 *
 * 方案：本模块是零依赖的**信号中继**——下层只 emit 事实（谁变了），ws 层订阅后
 * 翻译成协议事件。与 servantInfoSource（注入缝）同族，但方向相反：这里是
 * 一对多广播，且不关心订阅者是谁/有几个（无订阅者时 emit 是 no-op）。
 *
 * 分层位置：仅依赖 utils 叶子（诊断日志），不 import 任何业务模块，
 * L1 及以上均可安全引用。
 */

import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'

/** 花名册条目变化（字段名与契约 §2 的 fields 对齐） */
export type RosterChangeKind = 'added' | 'updated' | 'removed'

export type CollabPushSignal =
  | {
      kind: 'roster'
      sessionId: string
      change: RosterChangeKind
      /** 变化的字段名集合（change=removed 时为空） */
      fields: string[]
    }
  | {
      kind: 'session_list'
      /** 单调递增；服务端在广播前做 250ms 合并，只发最大 epoch */
      epoch: number
    }
  | {
      /** 任务台账变化（v1.6.0）：前端面板据此增量更新，轮询只做分钟级兜底 */
      kind: 'task'
      taskId: string
      projectDir: string
      /** created=新任务；status=状态流转（含 report/review 带来的字段更新） */
      change: 'created' | 'status'
      /** 变化后的状态（change=status 时必填） */
      status?: string
    }

export type CollabPushListener = (signal: CollabPushSignal) => void

const listeners = new Set<CollabPushListener>()

/**
 * 订阅者异常只在**首次**记一条诊断（低4，v1.5.0 第二批）：持续抛错的订阅者
 * 会让推送静默退化为纯轮询，无迹可查；但逐条刷日志会覆盖真正的日志窗口。
 */
let subscriberErrorReported = false

/** 订阅（返回退订函数）。ws 层装配时订阅一次。 */
export function onCollabPush(listener: CollabPushListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 广播一条变化事实。**订阅者异常必须被隔离**：推送是加速路径，任何订阅方
 * 抛错都不能影响触发它的业务写入（花名册落盘、会话列表缓存失效）。
 */
export function emitCollabPush(signal: CollabPushSignal): void {
  for (const listener of listeners) {
    try {
      listener(signal)
    } catch (error) {
      // 隔离：推送只是加速，绝不影响业务写入。但异常要留痕（一次性，与 M1 同型）——
      // 否则订阅者持续抛错时，推送静默退化为纯轮询而无人知晓。
      if (!subscriberErrorReported) {
        subscriberErrorReported = true
        logForDiagnosticsNoPII('debug', 'collab_push_subscriber_failed', {
          kind: signal.kind,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}

/** 测试隔离：清空订阅 */
export function resetCollabPushForTests(): void {
  listeners.clear()
  subscriberErrorReported = false
}

/** 测试辅助：当前订阅者数量 */
export function collabPushListenerCountForTests(): number {
  return listeners.size
}
