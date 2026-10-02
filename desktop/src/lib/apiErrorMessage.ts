// C1（缺陷裁决九/十）：网络层与超时层错误的用户可读映射。
//
// 纯函数：输入错误分类与原始 message，输出应展示给用户的文本。
// 映射表（逐条枚举，见汇报）：
//   'timeout'  → 'api.error.timeout'  服务暂时无响应（120s 超时）
//   'network'  → 'api.error.network'  本地服务不可达（fetch 失败）
//   'server'   → 'api.error.server'   服务端错误（无业务 message 的 4xx/5xx）
//   'business' → 原样返回 originalMessage（ApiError 业务 message 直出契约不动；
//                 映射表中无此键——Partial 把「可能缺」写进类型）
//   undefined  → 原样返回 originalMessage（未经新分类的旧路径/其它调用方，行为不变）
import type { ApiFailureKind } from '../api/client'
import type { TranslationKey } from '../i18n/locales/en'

const MAPPING_KEYS: Partial<Record<ApiFailureKind, TranslationKey>> = {
  timeout: 'api.error.timeout',
  network: 'api.error.network',
  server: 'api.error.server',
}

// C2a：已知服务端业务错误串的人话映射（服务端 message 精确/前缀匹配；命中即
// 替换，未命中维持业务直出契约原样）。技术详情对 business 一律不补（同既有
// 裁决），被本表命中的串视为已被人话完整表述。
const KNOWN_SERVER_MESSAGES: ReadonlyArray<{ match: RegExp; key: TranslationKey }> = [
  {
    // 服务端 servants.ts：跨项目派活拒绝（sender workDir 无法解析）
    match: /^Cross-project dispatch is not allowed/,
    key: 'api.error.crossProjectDispatch',
  },
]

export function describeApiFailure(
  kind: ApiFailureKind | undefined,
  originalMessage: string,
  t: (key: TranslationKey) => string,
): string {
  if (kind === 'business' || kind === undefined) {
    const known = KNOWN_SERVER_MESSAGES.find((entry) => entry.match.test(originalMessage))
    if (known) return t(known.key)
    return originalMessage
  }
  const mapped = kind !== undefined ? MAPPING_KEYS[kind] : undefined
  return mapped ? t(mapped) : originalMessage
}

/**
 * v1.7.1 P0（设计稿：错误技术详情折叠）：从错误分类与原始串构造 ErrorState 的
 * technicalDetail。business 类的 originalMessage 本身就是人话业务提示（直出
 * 契约），不补「原始错误」块；未分类（undefined）同样不补。
 */
export function technicalDetailFrom(
  kind: ApiFailureKind | undefined,
  originalMessage: string,
): { message: string; kind: string } | undefined {
  if (kind === undefined || kind === 'business') return undefined
  if (originalMessage.trim() === '') return undefined
  return { message: originalMessage, kind }
}
