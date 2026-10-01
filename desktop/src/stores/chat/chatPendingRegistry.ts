// v1.7.0 结构拆分第⑦批（chatStore 第①批：与拓扑无关的常量/枚举 + 纯注册表）：
// 流式合并 pending 注册表从 stores/chatStore.ts 逐字移出（原 358-412、
// 526-583 行），逻辑零改动；门面保留为入口。六个模块级 Map 是唯一的
// pending 状态定义（状态单一定义检查项）。Map 的读写一律经本文件导出的
// 函数进行：正文函数逐字移自门面，另有一组返工新增的受控原语（文末，
// 复核指出门面 flush 编排直读三个 Map）——每个原语对应单 Map 单操作，
// 机械直译，不改任何时序语义（flush 编排与 setTimeout 留守门面原位）。

const pendingTaskToolUseIdsBySession = new Map<string, Set<string>>()
const pendingToolParentUseIdsBySession = new Map<string, Map<string, string>>()

export function addPendingTaskToolUseId(sessionId: string, toolUseId: string): void {
  const ids = pendingTaskToolUseIdsBySession.get(sessionId) ?? new Set<string>()
  ids.add(toolUseId)
  pendingTaskToolUseIdsBySession.set(sessionId, ids)
}

export function consumePendingTaskToolUseId(sessionId: string, toolUseId: string): boolean {
  const ids = pendingTaskToolUseIdsBySession.get(sessionId)
  if (!ids?.has(toolUseId)) return false
  ids.delete(toolUseId)
  if (ids.size === 0) pendingTaskToolUseIdsBySession.delete(sessionId)
  return true
}

export function clearPendingTaskToolUseIds(sessionId: string): void {
  pendingTaskToolUseIdsBySession.delete(sessionId)
}

export function consumeAllPendingTaskToolUseIds(sessionId: string): boolean {
  const hasPendingTaskTools =
    (pendingTaskToolUseIdsBySession.get(sessionId)?.size ?? 0) > 0
  pendingTaskToolUseIdsBySession.delete(sessionId)
  return hasPendingTaskTools
}

export function rememberPendingToolParentUseId(
  sessionId: string,
  toolUseId: string | null | undefined,
  parentToolUseId: string | undefined,
): void {
  if (!toolUseId || !parentToolUseId) return
  const parentUseIds = pendingToolParentUseIdsBySession.get(sessionId) ?? new Map<string, string>()
  parentUseIds.set(toolUseId, parentToolUseId)
  pendingToolParentUseIdsBySession.set(sessionId, parentUseIds)
}

export function getPendingToolParentUseId(sessionId: string, toolUseId: string): string | undefined {
  return pendingToolParentUseIdsBySession.get(sessionId)?.get(toolUseId)
}

export function consumePendingToolParentUseId(sessionId: string, toolUseId: string): string | undefined {
  const parentUseIds = pendingToolParentUseIdsBySession.get(sessionId)
  if (!parentUseIds) return undefined
  const parentToolUseId = parentUseIds.get(toolUseId)
  parentUseIds.delete(toolUseId)
  if (parentUseIds.size === 0) pendingToolParentUseIdsBySession.delete(sessionId)
  return parentToolUseId
}

export function clearPendingToolParentUseIds(sessionId: string): void {
  pendingToolParentUseIdsBySession.delete(sessionId)
}

const pendingDeltaBySession = new Map<string, string>()
const flushTimerBySession = new Map<string, ReturnType<typeof setTimeout>>()
const pendingToolInputDeltaBySession = new Map<string, string>()
const toolInputFlushTimerBySession = new Map<string, ReturnType<typeof setTimeout>>()

export function consumePendingDelta(sessionId: string): string {
  const flushTimer = flushTimerBySession.get(sessionId)
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimerBySession.delete(sessionId)
  }
  const text = pendingDeltaBySession.get(sessionId) ?? ''
  pendingDeltaBySession.delete(sessionId)
  return text
}

export function appendPendingDelta(sessionId: string, text: string): void {
  pendingDeltaBySession.set(
    sessionId,
    `${pendingDeltaBySession.get(sessionId) ?? ''}${text}`,
  )
}

export function clearPendingDelta(sessionId: string): void {
  const flushTimer = flushTimerBySession.get(sessionId)
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimerBySession.delete(sessionId)
  }
  pendingDeltaBySession.delete(sessionId)
}

export function consumePendingToolInputDelta(sessionId: string): string {
  const flushTimer = toolInputFlushTimerBySession.get(sessionId)
  if (flushTimer) {
    clearTimeout(flushTimer)
    toolInputFlushTimerBySession.delete(sessionId)
  }
  const text = pendingToolInputDeltaBySession.get(sessionId) ?? ''
  pendingToolInputDeltaBySession.delete(sessionId)
  return text
}

export function appendPendingToolInputDelta(sessionId: string, text: string): void {
  pendingToolInputDeltaBySession.set(
    sessionId,
    `${pendingToolInputDeltaBySession.get(sessionId) ?? ''}${text}`,
  )
}

export function clearPendingToolInputDelta(sessionId: string): void {
  const flushTimer = toolInputFlushTimerBySession.get(sessionId)
  if (flushTimer) {
    clearTimeout(flushTimer)
    toolInputFlushTimerBySession.delete(sessionId)
  }
  pendingToolInputDeltaBySession.delete(sessionId)
}

// ── 返工新增：受控原语（复核指出门面 flush 编排与 disconnect 清理直读三个
// Map；每个原语对应单 Map 单操作，机械直译，暴露面最小）──

export function hasPendingDelta(sessionId: string): boolean {
  return pendingDeltaBySession.has(sessionId)
}

export function peekPendingDelta(sessionId: string): string | undefined {
  return pendingDeltaBySession.get(sessionId)
}

export function dropPendingDelta(sessionId: string): void {
  pendingDeltaBySession.delete(sessionId)
}

export function hasPendingDeltaFlushTimer(sessionId: string): boolean {
  return flushTimerBySession.has(sessionId)
}

export function setPendingDeltaFlushTimer(sessionId: string, timer: ReturnType<typeof setTimeout>): void {
  flushTimerBySession.set(sessionId, timer)
}

export function clearPendingDeltaFlushTimer(sessionId: string): void {
  flushTimerBySession.delete(sessionId)
}

export function hasPendingToolInputFlushTimer(sessionId: string): boolean {
  return toolInputFlushTimerBySession.has(sessionId)
}

export function setPendingToolInputFlushTimer(sessionId: string, timer: ReturnType<typeof setTimeout>): void {
  toolInputFlushTimerBySession.set(sessionId, timer)
}
