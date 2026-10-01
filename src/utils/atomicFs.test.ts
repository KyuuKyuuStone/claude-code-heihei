import { describe, expect, test } from 'bun:test'
import { AtomicWriteError, isAtomicWriteError, renameWithRetry, type RenameRetryFs } from './atomicFs.js'
import { setDiagnosticsLogWriterForTests } from './diagLogs.js'

/**
 * rename 重试（v1.4.0 阶段2 · 7）：Defender/索引器短暂持锁 ~/.claude 配置文件
 * 时 fs.rename 抛 EPERM/EBUSY——只对瞬态锁类 errno 重试，其它错误原样抛。
 * fake fs 注入断言：重试次数与 errno 过滤，不吞真实错误。
 */

function fakeFs(script: Array<{ code?: string; fail?: boolean }>): {
  fs: RenameRetryFs
  calls: () => number
} {
  let attempt = 0
  return {
    fs: {
      rename: async () => {
        const step = script[Math.min(attempt, script.length - 1)]
        attempt += 1
        if (step?.fail || step?.code) {
          const error = new Error(`rename failed (${step.code ?? 'generic'})`) as NodeJS.ErrnoException
          if (step.code) error.code = step.code
          throw error
        }
      },
    },
    calls: () => attempt,
  }
}

describe('renameWithRetry', () => {
  test('succeeds on the first try without delay when rename works', async () => {
    const { fs, calls } = fakeFs([{ fail: false }])
    await renameWithRetry(fs, 'a.tmp', 'a.md', { backoffMs: 1 })
    expect(calls()).toBe(1)
  })

  test('retries EPERM/EBUSY/EMFILE and succeeds after the lock clears', async () => {
    for (const code of ['EPERM', 'EBUSY', 'EMFILE']) {
      const { fs, calls } = fakeFs([{ code }, { code }, { fail: false }])
      await renameWithRetry(fs, 'a.tmp', 'a.md', { backoffMs: 1 })
      expect(calls()).toBe(3)
    }
  })

  test('gives up after retries+1 attempts when the lock never clears, and rethrows EPERM', async () => {
    const { fs, calls } = fakeFs([{ code: 'EPERM' }])
    let caught: NodeJS.ErrnoException | null = null
    try {
      await renameWithRetry(fs, 'a.tmp', 'a.md', { retries: 2, backoffMs: 1 })
    } catch (error) {
      caught = error as NodeJS.ErrnoException
    }
    expect(caught?.code).toBe('EPERM')
    expect(calls()).toBe(3) // retries=2 → 总尝试 3
  })

  test('does NOT retry non-transient errors (EACCES/ENOENT fail immediately)', async () => {
    for (const code of ['EACCES', 'ENOENT']) {
      const { fs, calls } = fakeFs([{ code }])
      let caught: NodeJS.ErrnoException | null = null
      try {
        await renameWithRetry(fs, 'a.tmp', 'a.md', { backoffMs: 1 })
      } catch (error) {
        caught = error as NodeJS.ErrnoException
      }
      expect(caught?.code).toBe(code)
      expect(calls()).toBe(1)
    }
  })

  test('rethrows errors without an errno code as-is (single attempt)', async () => {
    const { fs, calls } = fakeFs([{ fail: true }])
    let caught: unknown = null
    try {
      await renameWithRetry(fs, 'a.tmp', 'a.md', { backoffMs: 1 })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toContain('generic')
    expect(calls()).toBe(1)
  })
})

/**
 * v1.7.0 D1：EPERM 加固。
 *
 * 前提更正：EPERM 从来就在可重试集合里，真实缺口是「固定 25ms、总量 75ms
 * 覆盖不了杀软持锁窗口」「缺 ENOTEMPTY」「用尽后裸抛 errno，HTTP 只能 500」。
 * 本组锁住修复后的行为，并确保**既有非原子错误的语义不变**。
 */
describe('renameWithRetry — D1 加固', () => {
  /** 记录每次 rename 调用时刻，用于验证退避是指数递增 */
  function scriptedFs(script: Array<{ code?: string }>): {
    fs: RenameRetryFs
    calls: () => number
    timestamps: () => number[]
  } {
    const stamps: number[] = []
    let attempt = 0
    return {
      fs: {
        rename: async () => {
          stamps.push(Date.now())
          const step = script[Math.min(attempt, script.length - 1)]
          attempt += 1
          if (step?.code) {
            const error = new Error(`rename failed (${step.code})`) as NodeJS.ErrnoException
            error.code = step.code
            throw error
          }
        },
      },
      calls: () => attempt,
      timestamps: () => stamps,
    }
  }

  async function capture(fn: () => Promise<void>): Promise<unknown> {
    try {
      await fn()
      return null
    } catch (error) {
      return error
    }
  }

  test('ENOTEMPTY 与 EPERM/EBUSY/EMFILE 同为可重试', async () => {
    for (const code of ['ENOTEMPTY', 'EPERM', 'EBUSY', 'EMFILE']) {
      const { fs, calls } = scriptedFs([{ code }, { code }, {}])
      await renameWithRetry(fs, 'a.tmp', 'a.md', { backoffMs: 1 })
      expect(calls()).toBe(3)
    }
  })

  test('退避是指数递增（不是固定值）', async () => {
    const { fs, timestamps } = scriptedFs([{ code: 'EPERM' }, { code: 'EPERM' }, { code: 'EPERM' }, {}])
    const started = Date.now()
    await renameWithRetry(fs, 'a.tmp', 'a.md', { retries: 3, backoffMs: 20 })
    const elapsed = Date.now() - started

    const stamps = timestamps()
    expect(stamps).toHaveLength(4)
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!)
    // 期望 20 / 40 / 80（合计约 140ms）；固定退避只有约 60ms。
    // 用总量而不是「末段 > 首段」做判据——固定退避下计时抖动也会让后者偶然成立。
    expect(gaps[1]).toBeGreaterThanOrEqual(gaps[0]!)
    expect(gaps[2]).toBeGreaterThanOrEqual(gaps[1]!)
    expect(elapsed).toBeGreaterThan(100)
  })

  test('正常路径零退避：首次成功不引入等待', async () => {
    const { fs, calls } = scriptedFs([{}])
    const started = Date.now()
    await renameWithRetry(fs, 'a.tmp', 'a.md')
    expect(calls()).toBe(1)
    expect(Date.now() - started).toBeLessThan(20)
  })

  test('重试耗尽 → AtomicWriteError(kind=locked)，code 沿用原 errno（不改变既有 catch 语义）', async () => {
    const { fs, calls } = scriptedFs([{ code: 'EPERM' }])
    const caught = await capture(() =>
      renameWithRetry(fs, 'a.tmp', 'a.md', { retries: 2, backoffMs: 1 }),
    )

    expect(isAtomicWriteError(caught)).toBe(true)
    expect((caught as AtomicWriteError).code).toBe('EPERM')
    expect((caught as AtomicWriteError).atomicWriteKind).toBe('locked')
    expect((caught as Error).message).toContain('locked by another process')
    expect(calls()).toBe(3)
  })

  test('非瞬态错误 → kind=io 且立即失败（不重试、语义不变）', async () => {
    for (const code of ['EACCES', 'ENOENT']) {
      const { fs, calls } = scriptedFs([{ code }])
      const caught = await capture(() => renameWithRetry(fs, 'a.tmp', 'a.md', { backoffMs: 1 }))
      expect((caught as AtomicWriteError).code).toBe(code)
      expect((caught as AtomicWriteError).atomicWriteKind).toBe('io')
      expect(calls()).toBe(1)
    }
  })

  test('无 errno 的未知错误 → kind=io，原始信息保留在 message 中', async () => {
    const { fs, calls } = scriptedFs([{}])
    const boom = new Error('generic failure')
    const failing: RenameRetryFs = {
      rename: async () => {
        throw boom
      },
    }
    const caught = await capture(() => renameWithRetry(failing, 'a.tmp', 'a.md', { backoffMs: 1 }))
    expect((caught as AtomicWriteError).atomicWriteKind).toBe('io')
    expect((caught as Error).message).toContain('generic failure')
    expect((caught as Error).cause).toBe(boom)
    void fs
    void calls
  })

  test('最终失败记诊断：errno + 目标文件 + fallbackEnabled:false', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    setDiagnosticsLogWriterForTests((_level, event, data) => {
      events.push({ event, data: data as Record<string, unknown> })
    })
    try {
      const { fs } = scriptedFs([{ code: 'EPERM' }])
      await capture(() =>
        renameWithRetry(fs, 'a.tmp', 'D:/proj/a.md', { retries: 1, backoffMs: 1 }),
      )
      const failed = events.filter((e) => e.event === 'atomic_write_failed')
      expect(failed).toHaveLength(1)
      expect(failed[0]!.data.errno).toBe('EPERM')
      expect(failed[0]!.data.target).toBe('D:/proj/a.md')
      expect(failed[0]!.data.fallbackEnabled).toBe(false)
      expect(failed[0]!.data.attempts).toBe(2)
    } finally {
      setDiagnosticsLogWriterForTests(null)
    }
  })

  test('本实现只调用 rename：绝不原地写目标文件（原子性未被削弱）', async () => {
    const touched: string[] = []
    const paranoid: RenameRetryFs = {
      rename: async (from, to) => {
        touched.push(`rename:${from}->${to}`)
      },
    }
    await renameWithRetry(paranoid, 'a.tmp', 'a.md', { backoffMs: 1 })
    // 只有一次 rename，没有任何对目标文件的写/复制（接口本身也只有 rename）
    expect(touched).toEqual(['rename:a.tmp->a.md'])
  })
})
