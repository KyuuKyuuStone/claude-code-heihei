/**
 * 会话列表摘要的持久化索引（v1.5.0 · C11）。
 *
 * 动机：进程内的 sessionListSummaryCache 只在本次运行有效——服务端每次重启，
 * 会话列表的第一次请求都要把所有会话文件流式扫一遍（单项目 127MB 目录实测秒级）。
 * 本模块把「文件 mtime+size → 摘要」落到磁盘，重启后 mtime+size 未变的文件
 * **零成本复用**；只有真正变化的文件（正在写入的活跃会话）才重扫。
 *
 * 键：会话文件绝对路径；值：{ mtimeMs, size, summary, lastUsedAt }。
 * mtime+size 任一变化即视为失效（与内存缓存同款判定，见 sessionService
 * getCachedSessionListSummary）。
 *
 * 落盘策略：写入标脏 → 防抖 2s 合并 → tmp + rename 原子替换（atomicFs），
 * 失败只记 warn（索引是加速项，缺失只是回到"重扫一次"的旧行为）。
 *
 * 分层：L2 领域服务（依赖 utils 的 atomicFs/envUtils 与 localIndex 的类型）。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { renameWithRetry } from '../../utils/atomicFs.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import type { SessionListSummary } from './localIndex/types.js'

export const SESSION_SUMMARY_INDEX_FILENAME = 'session-summary-index.json'
const SCHEMA_VERSION = 1

/** 持久化条目数上限：超出按 lastUsedAt 淘汰（防文件无限膨胀） */
export const SESSION_SUMMARY_INDEX_MAX_ENTRIES = 5_000

/** 落盘防抖窗口：连续写入合并为一次原子替换 */
export const SESSION_SUMMARY_INDEX_SAVE_DEBOUNCE_MS = 2_000

/**
 * 会话级 token 用量合计（v1.5.0 窗口模式配套）。
 *
 * 口径与 desktop/src/stores/chatStore.ts 的 summarizeTokenUsageFromHistory
 * **逐项一致**（前端据此展示，字段名不能改）：
 * - 累加每条消息 message.usage 的四个字段（缺失或非有限数按 0 计）；
 * - 四项全 0 → 整体为 null；
 * - cache_read_tokens / cache_creation_tokens 仅在 > 0 时出现（源字段是
 *   cache_read_input_tokens / cache_creation_input_tokens，输出名去掉 input）。
 */
export type SessionUsageTotals = {
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

type StoredEntry = {
  mtimeMs: number
  size: number
  /** 真实摘要（尾部时间戳条目可能只挂 tailModifiedAt，尚无摘要） */
  summary?: SessionListSummary
  lastUsedAt: number
  /**
   * 会话级 token 用量合计。`null` 表示**已算过且四项全 0**（有效值，不要与
   * 「未缓存」混淆）；字段本身缺失才是未缓存。
   */
  usageTotals?: SessionUsageTotals | null
  /**
   * v1.5.0 C11：文件尾部内容时间戳（最后一条 user/assistant 消息的 timestamp），
   * 用于列表排序——列表的 modifiedAt 语义来自**内容**而非 mtime（metadata-only
   * 写入会改 mtime 却不该改变排序），所以排序键必须能廉价拿到该值。
   * 旧索引无此字段 → 视为未命中，重新扫一次尾部窗口。
   */
  tailModifiedAt?: string
}

type StoredFile = {
  schemaVersion: number
  entries: Record<string, StoredEntry>
}

/** 索引文件里的 usageTotals 是否可用（null = 已算过全 0，对象 = 有效合计） */
function isUsableUsageTotals(value: unknown): boolean {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const finite = (input: unknown): boolean =>
    typeof input === 'number' && Number.isFinite(input)
  return (
    finite(record.input_tokens) &&
    finite(record.output_tokens) &&
    (record.cache_read_tokens === undefined || finite(record.cache_read_tokens)) &&
    (record.cache_creation_tokens === undefined || finite(record.cache_creation_tokens))
  )
}

export class SessionSummaryIndexStore {
  private entries = new Map<string, StoredEntry>()
  private loadedForDir: string | null = null
  private loadPromise: Promise<void> | null = null
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  /** 索引文件路径（随 configDir 变化——测试注入 CLAUDE_CONFIG_DIR 时自然隔离） */
  getIndexPath(): string {
    return path.join(getClaudeConfigHomeDir(), 'cc-heihei', SESSION_SUMMARY_INDEX_FILENAME)
  }

  /** 懒加载（首次使用 + configDir 变化时重载）；失败按空索引处理 */
  async ensureLoaded(): Promise<void> {
    const indexPath = this.getIndexPath()
    if (this.loadedForDir === indexPath) return
    if (this.loadPromise) {
      await this.loadPromise
      if (this.loadedForDir === indexPath) return
    }
    this.loadPromise = this.loadFrom(indexPath)
    try {
      await this.loadPromise
    } finally {
      this.loadPromise = null
    }
  }

  private async loadFrom(indexPath: string): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(indexPath, 'utf-8')
    } catch {
      // 不存在（首次运行）或不可读：空索引起步
      this.entries = new Map()
      this.loadedForDir = indexPath
      return
    }
    try {
      const parsed = JSON.parse(raw) as StoredFile
      if (
        parsed?.schemaVersion !== SCHEMA_VERSION ||
        typeof parsed.entries !== 'object' ||
        parsed.entries === null
      ) {
        throw new Error('unsupported schema')
      }
      const entries = new Map<string, StoredEntry>()
      for (const [filePath, entry] of Object.entries(parsed.entries)) {
        if (typeof entry?.mtimeMs === 'number' && typeof entry.size === 'number') {
          const summaryOk =
            entry.summary && typeof (entry.summary as SessionListSummary).modifiedAt === 'string'
          const tailOk = typeof entry.tailModifiedAt === 'string'
          const usageOk = isUsableUsageTotals(entry.usageTotals)
          if (summaryOk || tailOk || usageOk) {
            entries.set(filePath, {
              mtimeMs: entry.mtimeMs,
              size: entry.size,
              lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : 0,
              ...(summaryOk ? { summary: entry.summary } : {}),
              ...(tailOk ? { tailModifiedAt: entry.tailModifiedAt } : {}),
              ...(usageOk ? { usageTotals: entry.usageTotals as SessionUsageTotals | null } : {}),
            })
          }
        }
      }
      this.entries = entries
      this.loadedForDir = indexPath
    } catch (error) {
      // 坏索引：丢弃重来（不阻断列表；下一轮会重建）
      this.entries = new Map()
      this.loadedForDir = indexPath
      logForDiagnosticsNoPII('warn', 'session_summary_index_corrupt', {
        indexPath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 命中（mtime+size 一致且有真实摘要）则返回摘要并刷新 lastUsedAt；否则 null。
   *
   * 低2（v1.5.0 第二批）：命中**不标脏**。lastUsedAt 只更新内存值（LRU 淘汰
   * 按内存序判断，足够），随下次真实写入（set/setTailModifiedAt/pruneMissing）
   * 一并落盘。原实现每次命中都 markDirty → 花名册 20s 轮询 × 多客户端下
   * 索引文件每 2s 被防抖整份重写（可达 5000 条 + rename 的写放大）。
   * 代价：纯命中进程重启后 LRU 序号退回上次落盘值——只影响淘汰先后，无害。
   */
  get(filePath: string, mtimeMs: number, size: number, now = Date.now()): SessionListSummary | null {
    const entry = this.entries.get(filePath)
    if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) return null
    if (!entry.summary) return null
    entry.lastUsedAt = now
    return entry.summary
  }

  /** 写入/更新条目（标脏，防抖落盘） */
  set(
    filePath: string,
    mtimeMs: number,
    size: number,
    summary: SessionListSummary,
    now = Date.now(),
  ): void {
    this.entries.set(filePath, { mtimeMs, size, summary, lastUsedAt: now })
    this.enforceCapacity()
    this.markDirty()
  }

  private enforceCapacity(): void {
    if (this.entries.size <= SESSION_SUMMARY_INDEX_MAX_ENTRIES) return
    const sorted = [...this.entries.entries()].sort(
      (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
    )
    const overflow = this.entries.size - SESSION_SUMMARY_INDEX_MAX_ENTRIES
    for (let i = 0; i < overflow; i += 1) {
      this.entries.delete(sorted[i]![0])
    }
  }

  /** 尾部内容时间戳命中查询（同一 mtime+size 才复用；命中不标脏，同 get 的低2说明） */
  getTailModifiedAt(filePath: string, mtimeMs: number, size: number, now = Date.now()): string | null {
    const entry = this.entries.get(filePath)
    if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) return null
    if (typeof entry.tailModifiedAt !== 'string' || !entry.tailModifiedAt) return null
    entry.lastUsedAt = now
    return entry.tailModifiedAt
  }

  /** 写入尾部内容时间戳（保留已有摘要；只有 tail 的条目 summary 仍缺省） */
  setTailModifiedAt(
    filePath: string,
    mtimeMs: number,
    size: number,
    tailModifiedAt: string,
    now = Date.now(),
  ): void {
    const existing = this.entries.get(filePath)
    if (existing && existing.mtimeMs === mtimeMs && existing.size === size) {
      existing.tailModifiedAt = tailModifiedAt
      existing.lastUsedAt = now
    } else {
      this.entries.set(filePath, { mtimeMs, size, tailModifiedAt, lastUsedAt: now })
    }
    this.enforceCapacity()
    this.markDirty()
  }

  /**
   * 会话级 token 用量合计命中查询（同一 mtime+size 才复用）。
   *
   * 返回 **undefined = 未缓存**（需要调用方扫一次文件），**null = 已算过且四项
   * 全 0**（有效结果，直接回给前端）。命中同样不标脏（低2：命中不写盘）。
   */
  getUsageTotals(
    filePath: string,
    mtimeMs: number,
    size: number,
    now = Date.now(),
  ): SessionUsageTotals | null | undefined {
    const entry = this.entries.get(filePath)
    if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) return undefined
    if (!('usageTotals' in entry)) return undefined
    entry.lastUsedAt = now
    return entry.usageTotals ?? null
  }

  /** 写入会话级 token 用量合计（保留已有摘要/tail；标脏防抖落盘） */
  setUsageTotals(
    filePath: string,
    mtimeMs: number,
    size: number,
    usageTotals: SessionUsageTotals | null,
    now = Date.now(),
  ): void {
    const existing = this.entries.get(filePath)
    if (existing && existing.mtimeMs === mtimeMs && existing.size === size) {
      existing.usageTotals = usageTotals
      existing.lastUsedAt = now
    } else {
      this.entries.set(filePath, { mtimeMs, size, usageTotals, lastUsedAt: now })
    }
    this.enforceCapacity()
    this.markDirty()
  }

  /** 剔除已消失的会话文件（列表发现阶段调用，防僵尸条目常驻） */
  pruneMissing(presentPaths: ReadonlySet<string>): void {
    let removed = false
    for (const filePath of [...this.entries.keys()]) {
      if (!presentPaths.has(filePath)) {
        this.entries.delete(filePath)
        removed = true
      }
    }
    if (removed) this.markDirty()
  }

  private markDirty(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, SESSION_SUMMARY_INDEX_SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
  }

  /** 落盘（原子）。失败只记 warn——索引是加速项。 */
  async flush(): Promise<void> {
    if (!this.dirty) return
    const indexPath = this.getIndexPath()
    if (this.loadedForDir !== indexPath) return // 目录已切换：旧数据不覆盖新目录
    this.dirty = false
    const payload: StoredFile = {
      schemaVersion: SCHEMA_VERSION,
      entries: Object.fromEntries(this.entries),
    }
    const tmpPath = `${indexPath}.${process.pid}.tmp`
    try {
      await fs.mkdir(path.dirname(indexPath), { recursive: true })
      await fs.writeFile(tmpPath, JSON.stringify(payload), 'utf-8')
      await renameWithRetry(fs, tmpPath, indexPath)
    } catch (error) {
      logForDiagnosticsNoPII('warn', 'session_summary_index_write_failed', {
        indexPath,
        error: error instanceof Error ? error.message : String(error),
      })
      await fs.rm(tmpPath, { force: true }).catch(() => {})
    }
  }

  /** 测试辅助：立刻冲刷（跳过防抖） */
  async flushForTests(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.flush()
  }

  /** 测试隔离 */
  resetForTests(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.entries = new Map()
    this.loadedForDir = null
    this.loadPromise = null
    this.dirty = false
  }

  sizeForTests(): number {
    return this.entries.size
  }
}

export const sessionSummaryIndexStore = new SessionSummaryIndexStore()
