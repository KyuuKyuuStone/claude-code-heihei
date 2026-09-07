import { describe, expect, test } from 'vitest'
import { planContextSize } from './localModelPlan'

/** 与 RTX 5070 Ti 跑分实测同量级的 KV 字节数：32K KV ≈ 3.28GB → ~102.4KB/token */
const KV_100KB = 102400

describe('planContextSize', () => {
  test('budget-rich GPU machine plans above 32K instead of capping at it', () => {
    // 16GB 显存 + 61GB 内存 + 5GB 模型：KV 预算 ~8.5GB，128K q8_0（6.7GB）装得下
    const result = planContextSize(KV_100KB, 5069, 61, 15360)

    expect(result).toMatchObject({ ctx: 131072, kvType: 'q8_0' })
    expect(result.note).toContain('128K')
  })

  test('prefers longer context on q8_0 over shorter on f16 when both fit', () => {
    // 8GB 显存 - 2GB 模型：KV 预算 ~5.2GB，96K q8_0（5.0GB）装得下、128K q8_0 装不下
    const result = planContextSize(KV_100KB, 2000, 32, 8192)

    expect(result).toMatchObject({ ctx: 98304, kvType: 'q8_0' })
    expect(result.note).toContain('96K')
  })

  test('pure-CPU machines plan from the memory budget (67%)', () => {
    // 16GB 内存纯 CPU - 5GB 模型：KV 预算 ~5.8GB，96K q8_0（5.0GB）装得下
    const result = planContextSize(KV_100KB, 5069, 16, 0)

    expect(result).toMatchObject({ ctx: 98304, kvType: 'q8_0' })
  })

  test('falls back to q8_0 when f16 cannot fit 32K', () => {
    // 8GB 显存 - 5GB 模型：f16 32K（3.28GB）装不下，q8_0 32K（1.64GB）可以
    const result = planContextSize(KV_100KB, 5069, 32, 8192)

    expect(result).toMatchObject({ ctx: 32768, kvType: 'q8_0' })
    expect(result.note).toContain('q8_0')
  })

  test('shrinks context in 4K steps down to the 8K floor on tiny budgets', () => {
    // 4GB 内存纯 CPU、2GB 模型：KV 预算 ~0.7GB，q8_0 只装得下 ~12K
    const result = planContextSize(KV_100KB, 2000, 4, 0)

    expect(result.ctx).toBe(12288)
    expect(result.kvType).toBe('q8_0')
    expect(result.note).toContain('12K')
  })

  test('returns the 32K f16 default when KV size is unknown', () => {
    expect(planContextSize(null, 5069, 61, 15360)).toEqual({
      ctx: 32768,
      kvType: 'f16',
      note: null,
    })
  })
})
