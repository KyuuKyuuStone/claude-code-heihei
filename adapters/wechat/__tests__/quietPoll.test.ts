import { describe, expect, it } from 'bun:test'
import { createSessionTimeoutThrottle } from '../quietPoll.js'

/** -14 空轮询节流器合同：N 次同类 → 输出条数受控（v1.4.0 阶段2-8）。 */
describe('createSessionTimeoutThrottle', () => {
  it('首次 record 立即输出（保可诊断性），窗口内后续静默累计', () => {
    const seen: string[] = []
    const throttle = createSessionTimeoutThrottle({
      summaryIntervalMs: 5 * 60_000,
      now: () => 0,
      format: (count, lastAtMs) => `x${count}@${lastAtMs}`,
    })
    const first = throttle.record(1000)
    expect(first).not.toBeNull()
    seen.push(first!)
    // 同一时刻连续 100 次：全部静默（v1.3.x 时代是 61 条逐条 warn）
    for (let i = 0; i < 100; i++) {
      const line = throttle.record(1000 + i * 3000)
      if (line) seen.push(line)
    }
    expect(seen).toHaveLength(1)
  })

  it('跨过 summaryIntervalMs 后再输出一条，计数从零重新累计', () => {
    const throttle = createSessionTimeoutThrottle({
      summaryIntervalMs: 5 * 60_000,
      now: () => 0,
      format: (count, lastAtMs) => `x${count}@${lastAtMs}`,
    })
    expect(throttle.record(0)).not.toBeNull() // 首条
    expect(throttle.record(60_000)).toBeNull()
    expect(throttle.record(120_000)).toBeNull()
    const second = throttle.record(6 * 60_000) // 距上次输出 6 分钟
    expect(second).toBe('x3@360000') // 静默期累计 2 次 + 本次 1 次，lastAt 取最近一次
    expect(throttle.record(6 * 60_000 + 1000)).toBeNull() // 重置后再静默
  })

  it('flush：有累计输出一条并清零；再 flush 为 null', () => {
    const throttle = createSessionTimeoutThrottle({
      summaryIntervalMs: 5 * 60_000,
      now: () => 0,
      format: (count, lastAtMs) => `x${count}@${lastAtMs}`,
    })
    expect(throttle.record(1000)).not.toBeNull()
    expect(throttle.record(2000)).toBeNull()
    expect(throttle.record(3000)).toBeNull()
    expect(throttle.flush()).toBe('x2@3000') // 首条之后的 2 次
    expect(throttle.flush()).toBeNull()
  })

  it('无累计时 flush 为 null（正常轮询不产生噪音行）', () => {
    const throttle = createSessionTimeoutThrottle({ now: () => 0 })
    expect(throttle.flush()).toBeNull()
  })

  it('format 注入可见 count 与 lastAt', () => {
    let captured: { count: number; lastAtMs: number } | null = null
    const throttle = createSessionTimeoutThrottle({
      now: () => 0,
      format: (count, lastAtMs) => {
        captured = { count, lastAtMs }
        return 'line'
      },
    })
    expect(throttle.record(42)).toBe('line')
    expect(captured).toEqual({ count: 1, lastAtMs: 42 })
  })

  it('默认汇总行含计数与 ISO 时间戳（供日志检索）', () => {
    const throttle = createSessionTimeoutThrottle({ now: () => 1_700_000_000_000 })
    const line = throttle.record(1_700_000_000_000)
    expect(line).toContain('×1')
    expect(line).toContain('2023-11-14')
  })
})
