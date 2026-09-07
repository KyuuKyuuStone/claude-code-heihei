/**
 * 本地模型上下文规划 — 按硬件预算选择最大的合理上下文与 KV 缓存类型。
 *
 * Claude Code 的真实负载（系统提示 + 工具定义 + Skills）需要 ≥32K 上下文，
 * 32K 是下限而不是目标：预算充裕时逐级上探（64K 优先保 f16 质量，更高档位
 * 用 q8_0 换更大的上下文，封顶 128K，避免极端值）；预算紧张时向下降档——
 * 先把 KV 从 f16 换成 q8_0（省一半内存，质量损失极小），还不够才按 4K 步进
 * 下调，下限 8K。
 */

export type PlannedContext = {
  /** 规划出的上下文大小（tokens），4K 对齐 */
  ctx: number
  /** KV 缓存类型 */
  kvType: 'f16' | 'q8_0'
  /** 规划说明（如自动换 q8_0、预算受限降档），无则 null */
  note: string | null
}

const RECOMMENDED_CTX = 32768
const FLOOR_CTX = 8192

/** 上探档位：从低到高，取预算内能装下的最高一档 */
const PLANNING_TIERS: Array<{ ctx: number; kvType: 'f16' | 'q8_0' }> = [
  { ctx: 32768, kvType: 'f16' },
  { ctx: 65536, kvType: 'f16' },
  { ctx: 65536, kvType: 'q8_0' },
  { ctx: 98304, kvType: 'q8_0' },
  { ctx: 131072, kvType: 'q8_0' },
]

export function planContextSize(
  kvBytesPerToken: number | null,
  modelSizeMB: number | null,
  memoryGB: number,
  vramMB: number,
): PlannedContext {
  if (!kvBytesPerToken || kvBytesPerToken <= 0) {
    return { ctx: RECOMMENDED_CTX, kvType: 'f16', note: null }
  }

  // 预算与引擎侧对齐：显存留 10% 余量；纯 CPU 按内存 67%（甜点比例）
  const budgetBytes = vramMB > 0
    ? vramMB * 1024 * 1024 * 0.9
    : memoryGB * 1024 ** 3 * 0.67
  const modelBytes = (modelSizeMB ?? 0) * 1024 * 1024
  const fits = (tokens: number, bytesPerToken: number) =>
    modelBytes + tokens * bytesPerToken <= budgetBytes

  for (let i = PLANNING_TIERS.length - 1; i >= 0; i--) {
    const tier = PLANNING_TIERS[i]!
    const bytes = tier.kvType === 'f16' ? kvBytesPerToken : kvBytesPerToken / 2
    if (fits(tier.ctx, bytes)) {
      const note = tier.ctx > RECOMMENDED_CTX
        ? `显存/内存预算充裕，上下文已按硬件规划到 ${Math.round(tier.ctx / 1024)}K`
        : null
      return { ctx: tier.ctx, kvType: tier.kvType, note }
    }
  }

  // 32K f16 装不下：q8_0 再试；仍不够按 4K 步进下调，下限 8K
  const q8Bytes = kvBytesPerToken / 2
  if (fits(RECOMMENDED_CTX, q8Bytes)) {
    return {
      ctx: RECOMMENDED_CTX,
      kvType: 'q8_0',
      note: '内存装不下 f16 KV 缓存，已自动改用 q8_0（省一半内存，质量损失极小）',
    }
  }
  const maxTokensQ8 = Math.floor((budgetBytes - modelBytes) / q8Bytes / 4096) * 4096
  const planned = Math.max(FLOOR_CTX, Math.min(RECOMMENDED_CTX, maxTokensQ8))
  const note = planned < RECOMMENDED_CTX
    ? `内存预算内最多规划 ${Math.round(planned / 1024)}K 上下文（q8_0 KV）。低于 32K 时 Claude Code 真实负载可能放不下，建议换更小的模型`
    : null
  return { ctx: planned, kvType: 'q8_0', note }
}
