/**
 * sessionService 零散纯工具（v1.7 结构拆分 · 第⑧批 · 纯移动 · 收口批）。
 *
 * 本批是 sessionService 纯移动阶段的**最后一批可搬项**。两个函数体内
 * **零 this.<字段>**、**零 this.<方法>**、**零外部 import 依赖**，
 * 因此本模块**不需要任何 import 语句**——纯函数，逐字可逆。
 *
 * 同名参数遮蔽核查（主管本批点名）：两者签名如下，**均无默认值参数**、
 * 无参数解引用（无 `= (x) => f(x)` 形态），不存在第⑦批 resolveWorkspaceAvailability
 * 那种「裸名被同名参数遮蔽」的语义分叉。已由 check-b8.ts 的
 * paramShadowScan 字段机械确认（两函数均无 `=` 形参默认值）。
 *
 * 历史死委托扫描：两名在 HEAD 中均为**实体方法**，非委托行，
 * historicalDelegateScan 应为空。
 *
 * 路径依赖预检：无 import.meta / __dirname / __filename / process.execPath。
 * 模块级可变状态：无（无顶层 let/var，无缓存对象）。
 */

export function isValidSessionId(id: string): boolean {
  // UUID v4 format
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

export function formatCost(cost: number): string {
  return `$${cost > 0.5 ? (Math.round(cost * 100) / 100).toFixed(2) : cost.toFixed(4)}`
}
