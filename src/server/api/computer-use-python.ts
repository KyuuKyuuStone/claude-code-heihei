/**
 * 兼容门面（2026-10-08 G2 批）：Python 运行时探测的**实现**已搬到 L2
 * `src/server/services/computerUsePython.ts` —— 原 api/* 同层文件互相 import 触发
 * `layer-L4-no-same-layer`（api/computer-use.ts → api/computer-use-python.ts）。
 *
 * 本文件只做**按名再导出**，导出面与迁移前逐项一致（测试 `computer-use-python.test.ts`
 * 等既有 import 路径不受影响）；L4 → L2 是合法方向。
 */
export {
  detectPythonRuntime,
  isPythonVersionAtLeast,
} from '../services/computerUsePython.js'
export type {
  CommandResult,
  CommandRunner,
  PythonRuntimeResolution,
} from '../services/computerUsePython.js'
