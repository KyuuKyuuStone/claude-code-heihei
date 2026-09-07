/**
 * resolveBenchmarkRunMode — 跑分运行方式判定。
 * 回归点：100% 档在已知 GGUF 层数时 ngl 是具体数字（如 '28'）而非 '-1'，
 * 只认 '-1' 会把真·全 GPU 误判成 "GPU + CPU 混合"（RTX 5070 Ti 实测踩过）。
 */
import { describe, expect, test } from 'bun:test'
import { resolveBenchmarkRunMode } from './services/localModelBenchmark.js'

describe('resolveBenchmarkRunMode', () => {
  test('GPU probe failed → pure CPU regardless of ngl', () => {
    expect(resolveBenchmarkRunMode(false, '-1', 28)).toBe('cpu')
    expect(resolveBenchmarkRunMode(false, '28', 28)).toBe('cpu')
  })

  test('explicit -1 means all layers on GPU', () => {
    expect(resolveBenchmarkRunMode(true, '-1', 28)).toBe('gpu')
    expect(resolveBenchmarkRunMode(true, '-1', null)).toBe('gpu')
  })

  test('numeric ngl covering every GGUF layer counts as full GPU (regression)', () => {
    expect(resolveBenchmarkRunMode(true, '28', 28)).toBe('gpu')
    expect(resolveBenchmarkRunMode(true, '36', 28)).toBe('gpu')
  })

  test('partial offload stays hybrid', () => {
    expect(resolveBenchmarkRunMode(true, '18', 28)).toBe('hybrid')
    expect(resolveBenchmarkRunMode(true, '1', 28)).toBe('hybrid')
  })

  test('unknown layer count keeps the legacy -1-only rule', () => {
    expect(resolveBenchmarkRunMode(true, '28', null)).toBe('hybrid')
    expect(resolveBenchmarkRunMode(true, '18', null)).toBe('hybrid')
  })
})
