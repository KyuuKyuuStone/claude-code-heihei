/**
 * 协作通道「正文长度总闸」（v1.7.5）
 *
 * 为什么单独成模块：两个**传输边界**（L4）都要用它——`api/servants.ts`
 * （POST /api/session-messages）与 `api/collabTasks.ts`（POST /api/collab-tasks/:id/report）。
 * 而 L4 内部**不许同层互依**（`.dependency-cruiser.cjs` 的 layer-L4-no-same-layer）
 * ⇒ 判定与阈值必须落在低层（L2 领域服务），两家各自向下引用，**共用同一实现**，
 * 不出现第二套阈值。
 *
 * 语义：任何进入协作通道的大正文（消息正文 / 台账 summary / deliverables）超限一律
 * **结构化拒绝**（413 + `{error:'PAYLOAD_TOO_LARGE', message}`，带实测与上限数值），
 * 不静默截断、不 500。根因见 v1.7.5 413 专项：巨型正文会把 HTTP 请求体顶到链路
 * 上限，重试必败、会话卡死。
 *
 * 阈值来源与依据见 `DEFAULT_SESSION_MESSAGE_MAX_BYTES` 注释；可用 env 覆盖。
 */

import { ApiError } from '../middleware/errorHandler.js'

export const SESSION_MESSAGE_MAX_BYTES_ENV = 'CC_HEIHEI_SESSION_MESSAGE_MAX_BYTES'
const DEFAULT_SESSION_MESSAGE_MAX_BYTES = 512 * 1024

/**
 * 正整数 env 解析（跟随 cronScheduler.resolveCronTaskTimeoutMs 写法）：非法/缺失回退默认。
 *
 * 取值依据：工具侧内联阈值默认 32KiB，其落盘后的投递体（截断摘要 ≤4KiB + 路径 +
 * 提示 + 交付物）约 5KiB 量级，服务端再追加页脚也就 +几百字节。总闸取 512KiB，
 * 相对该投递体留 ≈100× 余量 —— 足够大，正常派活/汇报（几 KB~几十 KB）绝不
 * 会被误伤；又足够小，能挡住把链路顶爆的巨型正文。
 */
export function resolveSessionMessageMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SESSION_MESSAGE_MAX_BYTES_ENV]?.trim()
  if (!raw) return DEFAULT_SESSION_MESSAGE_MAX_BYTES
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_MESSAGE_MAX_BYTES
}

/**
 * 通用正文长度校验：超限 ⇒ ApiError(413)（结构化 {error,message}，带实测/上限数值）。
 * `fieldName` 只影响文案（"content" / "summary" / "deliverables"），阈值**同源**。
 */
export function assertPayloadWithinLimit(rawValue: unknown, fieldName: string): void {
  const text = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '')
  const bytes = Buffer.byteLength(text, 'utf8')
  const limit = resolveSessionMessageMaxBytes()
  if (bytes > limit) {
    throw new ApiError(
      413,
      `Field "${fieldName}" is too large: ${bytes} bytes (UTF-8) exceeds the ${limit} byte limit. ` +
        '大正文请先落盘，只发送「摘要 + 文件路径」，不要把全文塞进消息正文。',
      'PAYLOAD_TOO_LARGE',
    )
  }
}
