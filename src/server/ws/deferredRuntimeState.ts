/**
 * 延迟运行时状态族（v1.7 结构拆分 · ws/handler.ts (C) 类批① · 架构师补充裁决十一）。
 *
 * 从 src/server/ws/handler.ts 逐字移出的两个模块级 Map（原 :159-160）+ 类型 RuntimeOverride（原 :151-155）：
 *   deferredRuntimeRestarts : Map<string, RuntimeOverride>  —— 活跃回合期间被推迟的运行时覆盖
 *   deferredPermissionModes : Map<string, PermissionMode>    —— 活跃回合期间被推迟的权限模式
 *
 * 【四条约束的落实】
 * 1) 原语粒度单一：每个导出函数只对应单 Map 的单操作（get / set / delete），机械直译，无额外逻辑。
 * 2) 编排留守原位：两处消费点的 `enqueueRuntimeTransition(...)` 编排、以及 set 时的
 *    `shouldDeferRuntimeRestartForActiveTurn` 判定，全部原样留在门面——本模块只提供存取。
 * 3) 时序逐字不变：门面侧仅把 `deferredX.get(s)` 换成 `getDeferredX(s)`、`.set` 换成 `setDeferredX`、
 *    `.delete` 换成 `deleteDeferredX`，其余逐字不动（由 check-h3.ts 的逐字节比对证实）。
 * 4) 三向检查：定义点唯一（两个 Map 只在本文件定义）+ 门面零直读 + 本模块顶层零直读
 *    （顶层只有 `new Map(...)` 构造，不调用任何原语）。
 *
 * 【拆分为细粒度单操作原语、而非合并成 consume】
 * 门面原代码形如 `const d = map.get(s); if (!d) return; map.delete(s)`。虽可合并为一个
 * consume 原语（delete 不存在的 key 是 no-op、语义等价），但拆成 get+delete 两个单操作
 * 可让门面调用点的 `if (!d) return` 控制流一字不动，最大化「逐字不变」的可证性。
 */

import type { PermissionMode } from './events.js'

export type RuntimeOverride = {
  providerId: string | null
  modelId: string
  effort?: string
}

const deferredRuntimeRestarts = new Map<string, RuntimeOverride>()
const deferredPermissionModes = new Map<string, PermissionMode>()

export function getDeferredRuntimeRestart(sessionId: string): RuntimeOverride | undefined {
  return deferredRuntimeRestarts.get(sessionId)
}

export function setDeferredRuntimeRestart(sessionId: string, override: RuntimeOverride): void {
  deferredRuntimeRestarts.set(sessionId, override)
}

export function deleteDeferredRuntimeRestart(sessionId: string): void {
  deferredRuntimeRestarts.delete(sessionId)
}

export function getDeferredPermissionMode(sessionId: string): PermissionMode | undefined {
  return deferredPermissionModes.get(sessionId)
}

export function setDeferredPermissionMode(sessionId: string, mode: PermissionMode): void {
  deferredPermissionModes.set(sessionId, mode)
}

export function deleteDeferredPermissionMode(sessionId: string): void {
  deferredPermissionModes.delete(sessionId)
}
