/**
 * 项目路径归一与「同项目」判定（唯一真源）。
 *
 * 背景（架构裁决四顺带发现的低危问题）：台账侧早已按归一标准判定同项目
 * （`collabTaskService` 的 projectHash：`path.resolve` + 反斜杠转正斜杠 + 小写），
 * 但花名册与派活侧曾是**原始字符串**比较。同一目录若一处写 `D:\X`、另一处写
 * `d:/x`，花名册判成两个项目（跨项目派活被拒），台账却判成一个——口径不一致会
 * 产生难以理解的行为。
 *
 * 本模块把口径提成共享实现，台账、花名册、派活三处统一引用。基准沿用既有台账
 * 语义（resolve + 反斜杠转正斜杠 + 小写），**不引入新的路径语义**。
 */
import * as path from 'path'

/** 归一化：绝对化（path.resolve）→ 分隔符统一为正斜杠 → 小写（Windows 大小写不敏感）。 */
export function normalizeProjectPath(dir: string): string {
  return path.resolve(dir).replace(/\\/g, '/').toLowerCase()
}

/**
 * 是否同一项目。
 *
 * 三种情形：
 * - 两侧原始值完全相同（**含两侧都为 undefined**）→ true。这一点与历史行为一致：
 *   「每项目最多一名主管」的约束在 workDir 未知的会话之间仍按同项目处理，
 *   归一化不会放宽隔离。
 * - 只有一侧有值 → false（workDir 未知不等于任何具体项目）。
 * - 两侧都有值 → 按 `normalizeProjectPath` 比较，故大小写、正反斜杠、尾部分隔符
 *   等写法差异都判为同一项目。
 */
export function sameProject(a?: string | null, b?: string | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return normalizeProjectPath(a) === normalizeProjectPath(b)
}
