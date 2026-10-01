/**
 * CLI 重试/降级消息解析（v1.7 结构拆分 · ws/handler.ts 第①批 · 纯移动 · 绿灯区）。
 *
 * 从 src/server/ws/handler.ts 原样搬出的一条完整解析链：
 *   finiteNumber / normalizeRetryCount / readRetryErrorRecord / readRetryErrorString
 *   （底层数值与错误对象读取）
 *   → toApiRetryServerMessage（api_retry 消息）
 *   → STREAMING_FALLBACK_CAUSES + toStreamingFallbackServerMessage（streaming_fallback 消息）
 *
 * 【三向检查 · 模块级可变状态】handler.ts 有 28 个模块级可变状态（架构师标黄灯）。
 * 本批选段**不含任何可变状态**：7 个绑定中 6 个是纯函数，唯一的非函数绑定
 * STREAMING_FALLBACK_CAUSES 是 **ReadonlySet 常量**（顶层 `new Set([...])`，无副作用、
 * 语义不可变），且其**全部消费方就是同批搬走的 toStreamingFallbackServerMessage**——
 * 故门面搬后对该常量零直读、新模块顶层零对外直读，三向皆干净。已由 check-h1.ts
 * 的 moduleStateTripleCheck 字段机械确认。
 *
 * 【同名参数遮蔽核对（主管点名）】本族 7 个绑定**均无默认值形参**，
 * 不存在 handler 批内潜在的「裸名被同名参数遮蔽」形态（paramShadowScan 确认为空）。
 *
 * 【历史死委托扫描】7 名在 HEAD 中均为**实体声明**，非委托行。
 *
 * 搬移规则：函数体逐字不变，仅缩进归零（原顶层 0 缩进 → 模块级 0 缩进，无变化）；
 * 组内互调本就是裸名（handler.ts 顶层函数互调不用 this.），故**零 this. 改写**。
 * toApiRetryServerMessage / toStreamingFallbackServerMessage 有组外调用点，门面改为
 * 同名函数转发（普通函数，非类字段）；其余 5 项组外调用点为 0，**不留死委托**。
 *
 * 路径依赖预检：无 import.meta / __dirname / __filename / process.execPath。
 */

import type { ServerMessage, StreamingFallbackCause } from './events.js'

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeRetryCount(value: unknown): number | null {
  const numeric = finiteNumber(value)
  if (numeric === null) return null
  return Math.max(0, Math.trunc(numeric))
}

function readRetryErrorRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readRetryErrorString(value: unknown, keys: string[]): string | undefined {
  const record = readRetryErrorRecord(value)
  if (!record) return undefined
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return undefined
}

export function toApiRetryServerMessage(cliMsg: any): ServerMessage | null {
  const attempt = normalizeRetryCount(cliMsg.attempt)
  const maxRetries = normalizeRetryCount(cliMsg.max_retries)
  const retryDelayMs = normalizeRetryCount(cliMsg.retry_delay_ms)
  if (attempt === null || maxRetries === null || retryDelayMs === null) return null

  const embeddedError = readRetryErrorRecord(cliMsg.error)
  const embeddedStatus = embeddedError ? finiteNumber(embeddedError.status) : null
  const rawStatus = cliMsg.error_status === null
    ? null
    : finiteNumber(cliMsg.error_status) ?? embeddedStatus
  const errorType = typeof cliMsg.error === 'string' && cliMsg.error.trim()
    ? cliMsg.error.trim()
    : readRetryErrorString(cliMsg.error, ['type', 'code', 'name'])
  const errorMessage = readRetryErrorString(cliMsg.error, ['message', 'error'])

  return {
    type: 'api_retry',
    attempt,
    maxRetries,
    retryDelayMs,
    errorStatus: rawStatus === null ? null : Math.trunc(rawStatus),
    ...(errorType ? { errorType } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  }
}

const STREAMING_FALLBACK_CAUSES: ReadonlySet<StreamingFallbackCause> = new Set([
  'watchdog',
  'stream_error',
  '404_stream_creation',
  'stream_retry',
])

export function toStreamingFallbackServerMessage(cliMsg: any): ServerMessage {
  // 未识别的 cause 兜底为 unknown 而不是丢消息：提示本身比成因重要。
  const cause: StreamingFallbackCause =
    typeof cliMsg.cause === 'string' && STREAMING_FALLBACK_CAUSES.has(cliMsg.cause as StreamingFallbackCause)
      ? (cliMsg.cause as StreamingFallbackCause)
      : 'unknown'
  return { type: 'streaming_fallback', cause }
}
