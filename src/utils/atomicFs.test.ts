import { describe, expect, test } from 'bun:test'
import { renameWithRetry, type RenameRetryFs } from './atomicFs.js'

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
