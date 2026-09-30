/**
 * localIndex SQLite 连接配置的共享实现（v1.5.0 低11）。
 *
 * 此前 database.ts 与 scheduledRunIndex.ts 各自维护一份 PRAGMA 列表且已漂移：
 * database.ts 有 `journal_size_limit`（防 WAL 无限增长），scheduledRunIndex.ts
 * 漏了它——同一目录的两个库跑在不同连接配置下。统一到本函数的单一来源。
 *
 * 不含 `PRAGMA secure_delete`（scheduledRunMigrations 迁移期临时设置）：
 * 那是迁移/重建期的一次性语义，不是连接级配置，留在迁移代码内并附注释。
 */

import type { Database } from 'bun:sqlite'

/** WAL 文件大小上限：超出后 checkpoint 截断（两库一致，防磁盘无限增长） */
export const LOCAL_INDEX_JOURNAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024

/** 应用标准连接配置：busy_timeout / WAL / synchronous / foreign_keys / autocheckpoint / size limit */
export function configureLocalIndexConnection(
  database: Database,
  busyTimeoutMs: number,
): void {
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA wal_autocheckpoint = 1000')
  database.exec(`PRAGMA journal_size_limit = ${LOCAL_INDEX_JOURNAL_SIZE_LIMIT_BYTES}`)
}
