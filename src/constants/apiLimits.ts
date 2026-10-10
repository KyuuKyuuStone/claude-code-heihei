/**
 * Anthropic API Limits
 *
 * These constants define server-side limits enforced by the Anthropic API.
 * Keep this file dependency-free to prevent circular imports.
 *
 * Last verified: 2026-06-01
 * Source: Claude Vision API docs and api/api/config.py
 *
 * Future: See issue #13240 for dynamic limits fetching from server.
 */

// =============================================================================
// IMAGE LIMITS
// =============================================================================

/**
 * Maximum base64-encoded image size (API enforced).
 * The API rejects images where the base64 string length exceeds this value.
 * Note: This is the base64 length, NOT raw bytes. Base64 increases size by ~33%.
 */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024 // 5 MB

/**
 * Target raw image size to stay under base64 limit after encoding.
 * Base64 encoding increases size by 4/3, so we derive the max raw size:
 * raw_size * 4/3 = base64_size → raw_size = base64_size * 3/4
 */
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4 // 3.75 MB

/**
 * API-enforced maximum dimensions for image inputs.
 *
 * Note: The API internally resizes images whose long edge is larger than
 * 1568px, but that is handled server-side and doesn't cause errors. Keep this
 * limit aligned with the API's rejection threshold so common tall screenshots
 * are not locally resized or rejected just because they exceed 2000px.
 *
 * The API_IMAGE_MAX_BASE64_SIZE (5MB) is the actual hard limit that causes
 * API errors for ordinary screenshots before dimensions usually matter.
 */
export const IMAGE_MAX_WIDTH = 8000
export const IMAGE_MAX_HEIGHT = 8000

// =============================================================================
// PDF LIMITS
// =============================================================================

/**
 * Maximum raw PDF file size that fits within the API request limit after encoding.
 * The API has a 32MB total request size limit. Base64 encoding increases size by
 * ~33% (4/3), so 20MB raw → ~27MB base64, leaving room for conversation context.
 */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024 // 20 MB

/**
 * Maximum number of pages in a PDF accepted by the API.
 */
export const API_PDF_MAX_PAGES = 100

/**
 * Size threshold above which PDFs are extracted into page images
 * instead of being sent as base64 document blocks. This applies to
 * first-party API only; non-first-party always uses extraction.
 */
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024 // 3 MB

/**
 * Maximum PDF file size for the page extraction path. PDFs larger than
 * this are rejected to avoid processing extremely large files.
 */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024 // 100 MB

/**
 * Max pages the Read tool will extract in a single call with the pages parameter.
 */
export const PDF_MAX_PAGES_PER_READ = 20

/**
 * PDFs with more pages than this get the reference treatment on @ mention
 * instead of being inlined into context.
 */
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10

// =============================================================================
// MEDIA LIMITS
// =============================================================================

/**
 * Maximum number of media items (images + PDFs) allowed per API request.
 * The API rejects requests exceeding this limit with a confusing error.
 * We validate client-side to provide a clear error message.
 */
export const API_MAX_MEDIA_PER_REQUEST = 100

// =============================================================================
// REQUEST BODY BYTE LIMITS (v1.7.5：发送前字节级预检)
// =============================================================================

/**
 * 整个请求体（messages + system + tools 的 JSON 字节数）的服务端上限。
 *
 * 32MB 是**官方网关**公布的量级（此前只写在 `PDF_TARGET_RAW_SIZE` 的注释里，
 * 未成为可执行常量 ⇒ 出 413 时只能猜）。**注意：客户真实链路经中转时上限可能
 * 远小**（nginx 默认 `client_max_body_size 1m` 是经典元凶），因此该值**必须可
 * 配置**：见 `getApiRequestMaxBytes()` 的 env 覆盖。
 */
export const API_REQUEST_MAX_BYTES = 32 * 1024 * 1024 // 32 MB

/**
 * 触发「发送前降体积 pass」的阈值（留 ~12.5% 余量）。
 *
 * 为什么留余量：测量点与实际发送之间存在少量增长（`stream: true` 等字段、
 * body 序列化差异、中转侧按不同口径计数），且降体积本身有成本——只在该阈值
 * 以上才动。低于阈值时**行为与不做预检逐字节一致**。
 */
export const API_REQUEST_TRIGGER_BYTES = 28 * 1024 * 1024 // 28 MB

/**
 * 单次请求里**媒体块（image/document）**允许占用的字节上限。
 *
 * 由来：`API_MAX_MEDIA_PER_REQUEST`(100) 只封**条数**不封**字节** ⇒ 100 张
 * 5MB 图片（≈33MB base64）可以撑爆 32MB 请求体而完全绕过条数上限。取上限的
 * 一半作预算，给 system/tools/历史文本留空间；超出即按**最旧优先**丢弃媒体
 * （实现口径见 `mediaBudget.stripExcessMediaItems`：按消息/块出现顺序＝时间顺序依次
 * 丢弃；发送前预检那层的**由大到小**只是"先剥哪条"的候选排序，与此不同）。
 */
export const API_REQUEST_MEDIA_BYTES_BUDGET = Math.floor(
  API_REQUEST_MAX_BYTES / 2,
) // 16 MB

/** 读取整数型 env 覆盖（非正整数/非法一律忽略，回落默认值） */
function positiveIntFromEnv(name: string): number | null {
  const raw = process.env[name]
  if (!raw) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 生效的请求体上限（字节）。env `CC_HEIHEI_API_REQUEST_MAX_BYTES` 覆盖，
 * 用于客户机确认为「中转小上限」时把阈值调小——**改配置不改代码**。
 */
export function getApiRequestMaxBytes(): number {
  return positiveIntFromEnv('CC_HEIHEI_API_REQUEST_MAX_BYTES') ?? API_REQUEST_MAX_BYTES
}

/**
 * 生效的触发阈值（字节）。env `CC_HEIHEI_API_REQUEST_TRIGGER_BYTES` 覆盖；
 * 未覆盖时 = 上限 × (API_REQUEST_TRIGGER_BYTES / API_REQUEST_MAX_BYTES)
 * ——跟着上限等比缩放，保证覆盖上限后余量比例仍成立。
 */
export function getApiRequestTriggerBytes(): number {
  const explicit = positiveIntFromEnv('CC_HEIHEI_API_REQUEST_TRIGGER_BYTES')
  if (explicit !== null) return explicit
  const max = getApiRequestMaxBytes()
  return Math.floor((max * API_REQUEST_TRIGGER_BYTES) / API_REQUEST_MAX_BYTES)
}

/** 生效的媒体字节预算（env 覆盖上限时按同比例缩放） */
export function getApiRequestMediaBytesBudget(): number {
  const max = getApiRequestMaxBytes()
  return Math.floor((max * API_REQUEST_MEDIA_BYTES_BUDGET) / API_REQUEST_MAX_BYTES)
}
