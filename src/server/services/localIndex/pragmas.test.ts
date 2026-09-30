import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOCAL_INDEX_JOURNAL_SIZE_LIMIT_BYTES,
  configureLocalIndexConnection,
} from './pragmas.js'

/**
 * v1.5.0 低11：连接配置共享函数。
 *
 * 此前 database.ts 与 scheduledRunIndex.ts 各写一份 PRAGMA 列表并已漂移
 * （后者漏了 journal_size_limit）。这里锁住共享函数自身把全套配置都设上，
 * 防未来再漂移。journal_size_limit 是连接级设置，必然在**同一连接**上断言。
 */
describe('configureLocalIndexConnection', () => {
  // 用真实文件库：:memory: 不支持 WAL（journal_mode 恒为 memory），断言无意义
  function withTmpDatabase(fn: (db: Database) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'cc-heihei-pragmas-'))
    const db = new Database(join(dir, 'test.sqlite'))
    try {
      fn(db)
    } finally {
      db.close(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('applies the full pragma set including journal_size_limit (low-11)', () => {
    withTmpDatabase((db) => {

      configureLocalIndexConnection(db, 100)

      expect(db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
      expect(db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous).toBe(1)
      expect(db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
      expect(db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()?.timeout).toBe(100)
      expect(
        db.query<{ wal_autocheckpoint: number }, []>('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint,
      ).toBe(1000)
      expect(
        db.query<{ journal_size_limit: number }, []>('PRAGMA journal_size_limit').get()?.journal_size_limit,
      ).toBe(LOCAL_INDEX_JOURNAL_SIZE_LIMIT_BYTES)
    })
  })

  test('honours the caller-provided busy timeout', () => {
    withTmpDatabase((db) => {
      configureLocalIndexConnection(db, 2_500)
      expect(db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()?.timeout).toBe(2_500)
    })
  })
})
