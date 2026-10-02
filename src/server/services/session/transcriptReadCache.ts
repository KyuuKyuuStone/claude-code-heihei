/**
 * transcriptReadCache —— 转录整读的**内容寻址缓存**（v1.7.2 P2-a，裁决二十四）。
 *
 * 动机（勘察实证）：一次派活拉起里同一份转录会被**整读 3-5 次**（单播守卫 / 广播守卫 /
 * getSessionLaunchInfo / 各 API 校验），活跃会话转录可达数万行 ⇒ 重成本在「反复整读」。
 *
 * 形态（严格照设计稿）：
 * - 键：`filePath`；值：`{ mtimeMs, size, promise }`——**存 Promise**，天然做 in-flight 去重；
 * - 命中判定：读前 `fs.stat`，`mtimeMs` 与 `size` 均与缓存一致 ⇒ 复用；否则重读并替换；
 * - 容量：LRU，上限 `TRANSCRIPT_READ_CACHE_MAX_ENTRIES = 16`（单项 entries 对象图可达十 MB 级）；
 * - **reject 删条目**：失败不毒化（瞬时 IO 错误不得被固化成永久错误）；
 * - **不加 TTL**：键控已保证正确性（append-only ⇒ 任何追加必然改变 size）。
 *
 * 等价性：派生结果 = f(entries)；键（filePath, mtimeMs, size）相同 ⇒ 文件字节相同 ⇒
 * entries 相同 ⇒ 结果相同。语义不变式成立。
 *
 * ⚠ 已知风险与**为什么接受**（复核员一眼可判）：
 * 1. **同尺寸重写**：`clearSessionTranscript` 重写转录时，若新内容与旧内容**字节数恰好相同**
 *    且 mtime 被同 tick 覆盖，理论上可逃逸 mtime+size 判定 → 读到旧 entries。
 * 2. **mtime 精度**：fat32/U 盘配置目录的 mtime 粒度较粗，同 tick 内追加可能漏检。
 * **为什么接受**：本项目**既有 `sessionListSummaryCache` 用同一把键（mtime+size）**（见
 * `sessionSummaryIndexStore` 的命中判定：同为逐字段比对 + miss 即重扫），故本缓存**同键控口径**；
 * 两处失效路径同源同向（size 变即失效）。**但后果面更大**：摘要缓存承载**列表展示**，本缓存承载
 * **AI 上下文**（读到旧 entries 会污染模型输入）——而这两条风险的**触发概率极低**（同尺寸重写 +
 * 同 tick 覆盖），故接受；**不夸大也不隐瞒**（本项目对措辞夸大零容忍）。
 * **不做的加固**（避免伪正确性）：不加 TTL（键控已保证正确性，TTL 只会引入「TTL 内读旧数据」
 * 这种更难判定的窗口）；不引入内容哈希（转录可达数万行，哈希成本抹平整读收益，与解耦目标相悖）。
 * 若将来 `clearSessionTranscript` 改为「原地等长替换」，**两处缓存需一并复核**（本注释即复核锚点）。
 */

import * as fs from 'node:fs/promises'
import { readJsonlFile } from './jsonlStorage.js'

export const TRANSCRIPT_READ_CACHE_MAX_ENTRIES = 16

type TranscriptEntries = Awaited<ReturnType<typeof readJsonlFile>>

type CacheEntry = {
  mtimeMs: number
  size: number
  promise: Promise<TranscriptEntries>
}

/** Map 迭代顺序 = 插入顺序 ⇒ delete + set 即 LRU 触碰。 */
const cache = new Map<string, CacheEntry>()

/** 加载器：默认 `readJsonlFile`；测试可注入以计数（DI 缝，禁 mock.module）。 */
let loader: (filePath: string) => Promise<TranscriptEntries> = readJsonlFile

export function setTranscriptReadLoaderForTests(
  fn: ((filePath: string) => Promise<TranscriptEntries>) | null,
): void {
  loader = fn ?? readJsonlFile
}

export function resetTranscriptReadCacheForTests(): void {
  cache.clear()
}

/** 仅供观测/自证：当前缓存条目数。 */
export function transcriptReadCacheSize(): number {
  return cache.size
}

/**
 * 整读转录（带内容寻址缓存）。**失败不毒化**：rejected Promise 会立即从缓存移除，
 * 下一次调用重新读盘。
 */
export async function readTranscriptCached(filePath: string): Promise<TranscriptEntries> {
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(filePath)
  } catch (error) {
    // **语义等价**（复核建议①）：`readJsonlFile` 对 ENOENT 返回 `[]`，而缓存版若不处理就会在
    // stat 处**上抛**——三处调用点（getSessionWorkDir / getSessionLaunchInfo /
    // getSessionMessageCwd）都是「if (!found) return null」后直调、无本地 try/catch ⇒
    // 原「降级为空/null」会变成「上抛」。故 stat 阶段 ENOENT **降级走 loader**（它自身容忍
    // ENOENT）：结果与直读逐字一致，且**不缓存**（无有效键可记，避免把「文件不存在」固化）。
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return loader(filePath)
    throw error
  }
  const cached = cache.get(filePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // LRU 触碰后复用（Promise 复用即 in-flight 去重）
    cache.delete(filePath)
    cache.set(filePath, cached)
    return cached.promise
  }

  const entry: CacheEntry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    promise: loader(filePath),
  }
  cache.delete(filePath)
  cache.set(filePath, entry)
  while (cache.size > TRANSCRIPT_READ_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  // 失败不毒化：仅当条目仍是自己时才删（避免误删后来者的新条目）
  void entry.promise.catch(() => {
    if (cache.get(filePath) === entry) cache.delete(filePath)
  })
  return entry.promise
}
