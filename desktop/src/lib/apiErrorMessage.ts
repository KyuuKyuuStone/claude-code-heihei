// C1（缺陷裁决九/十）：网络层与超时层错误的用户可读映射。
//
// 纯函数：输入错误分类与原始 message，输出应展示给用户的文本。
// 映射表（逐条枚举，见汇报）：
//   'timeout'  → 'api.error.timeout'  服务暂时无响应（120s 超时）
//   'network'  → 'api.error.network'  本地服务不可达（fetch 失败）
//   'server'   → 'api.error.server'   服务端错误（无业务 message 的 4xx/5xx）
//   'business' → 原样返回 originalMessage（ApiError 业务 message 直出契约不动）
//   undefined  → 原样返回 originalMessage（未经新分类的旧路径/其它调用方，行为不变）
import type { ApiFailureKind } from '../api/client'

type Translate = (key: keyof typeof MAPPING_KEYS) => string

const MAPPING_KEYS = {
  timeout: 'api.error.timeout',
  network: 'api.error.network',
  server: 'api.error.server',
} as const

export function describeApiFailure(
  kind: ApiFailureKind | undefined,
  originalMessage: string,
  t: Translate,
): string {
  const mapped = kind !== undefined ? MAPPING_KEYS[kind] : undefined
  return mapped ? t(mapped) : originalMessage
}
