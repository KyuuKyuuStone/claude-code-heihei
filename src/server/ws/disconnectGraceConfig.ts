/**
 * Disconnect grace period (issue #764) —— 最后一个客户端断开后、会话被回收前的空闲宽限。
 *
 * 取值原本存在 H5 访问设置里（可配置的断连宽限秒数），随 H5 特性整体删除
 * 后不再有可配来源，回归内置默认值。WebSocket 的 `close` 处理是同步热路径，故这里以
 * 常量（+ 测试覆写钩子）暴露，避免让热路径去碰磁盘。
 */

export const DEFAULT_DISCONNECT_GRACE_MS = 30_000

let cachedGraceMs = DEFAULT_DISCONNECT_GRACE_MS

/** Synchronous accessor for the disconnect cleanup grace period, in ms. */
export function getDisconnectGraceMs(): number {
  return cachedGraceMs
}

/** Test hook: override the cached value directly. */
export function __setDisconnectGraceMsForTests(value: number): void {
  cachedGraceMs = value
}

/** Test hook: reset to the built-in default. */
export function __resetDisconnectGraceMsForTests(): void {
  cachedGraceMs = DEFAULT_DISCONNECT_GRACE_MS
}
