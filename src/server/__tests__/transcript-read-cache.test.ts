import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'
import { getProjectsDir, readJsonlFile, sanitizePath } from '../services/session/jsonlStorage.js'
import {
  readTranscriptCached,
  resetTranscriptReadCacheForTests,
  setTranscriptReadLoaderForTests,
  transcriptReadCacheSize,
  TRANSCRIPT_READ_CACHE_MAX_ENTRIES,
} from '../services/session/transcriptReadCache.js'

/**
 * v1.7.2 P2-a（裁决二十四）：转录整读缓存的**行为等价性**判别力自检。
 *
 * 等价性主张：派生结果 = f(entries)；键（filePath, mtimeMs, size）相同 ⇒ 文件字节相同
 * ⇒ entries 相同 ⇒ 结果相同。本文件用**加载器计数**（DI 缝，禁 mock.module）证明
 * 「整读次数 3-5 → 1」，并逐条锁住三个防护（命中判定 / 失效判定 / 失败不毒化）——
 * 每条都附「去掉该防护必须失败」的设计（判别力）。
 */

describe('transcriptReadCache（P2-a）', () => {
  let tmpDir: string
  let file: string
  let loads: string[]

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-trcache-'))
    file = path.join(tmpDir, 'transcript.jsonl')
    loads = []
    resetTranscriptReadCacheForTests()
    // 加载器：计数的同时真读盘（保持语义等价）
    setTranscriptReadLoaderForTests(async (p) => {
      loads.push(p)
      const raw = await fs.readFile(p, 'utf-8')
      return raw
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>) as never
    })
  })

  afterEach(async () => {
    setTranscriptReadLoaderForTests(null)
    resetTranscriptReadCacheForTests()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('自检 a：连续两次读同一文件 ⇒ 只整读 1 次（去掉命中判定须失败）', async () => {
    await fs.writeFile(file, '{"cwd":"/w/a"}\n')
    const first = await readTranscriptCached(file)
    const second = await readTranscriptCached(file)

    expect(loads).toHaveLength(1) // ← 去掉 `cached.mtimeMs/size` 命中判定 ⇒ 变成 2，本断言失败
    expect(second).toBe(first) // 同一个 Promise（in-flight 去重）
  })

  test('自检 b：追加后失效重读，且读到新条目（去掉 mtime/size 校验须失败）', async () => {
    await fs.writeFile(file, '{"cwd":"/w/a"}\n')
    const before = await readTranscriptCached(file)
    expect(before).toHaveLength(1)

    await fs.appendFile(file, '{"cwd":"/w/b"}\n') // append-only ⇒ size 必变
    const after = await readTranscriptCached(file)

    expect(loads).toHaveLength(2) // ← 去掉 mtime/size 校验 ⇒ 仍是 1、且 after 长度仍为 1，本断言失败
    expect(after).toHaveLength(2)
    expect((after[1] as { cwd?: string }).cwd).toBe('/w/b')
  })

  test('自检 c：加载失败**不毒化**——下一次调用重新读盘（去掉 reject 清条目须失败）', async () => {
    await fs.writeFile(file, '{"cwd":"/w/a"}\n')
    let shouldFail = true
    setTranscriptReadLoaderForTests(async (p) => {
      loads.push(p)
      if (shouldFail) throw new Error('transient IO error')
      const raw = await fs.readFile(p, 'utf-8')
      return raw
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>) as never
    })

    await expect(readTranscriptCached(file)).rejects.toThrow('transient IO error')
    expect(transcriptReadCacheSize()).toBe(0) // ← 去掉 reject 清条目 ⇒ 仍为 1，本断言失败

    shouldFail = false
    const ok = await readTranscriptCached(file)
    expect(ok).toHaveLength(1)
    expect(loads).toHaveLength(2)
  })

  test('观测判据：派活拉起链的 3 个读取点（同会话同一文件）⇒ 整读 3 → 1', async () => {
    // 等价于 getSessionWorkDir / getSessionLaunchInfo / getSessionMessageCwd 三处换线后
    // 对**同一个转录文件**的连续读取（三处现在都走 readTranscriptCached）。
    await fs.writeFile(file, '{"cwd":"/w/a"}\n{"uuid":"m1","cwd":"/w/a"}\n')
    await readTranscriptCached(file)
    await readTranscriptCached(file)
    await readTranscriptCached(file)
    expect(loads).toHaveLength(1) // 换线前 = 3 次整读；现在 = 1 次
  })

  test('自检 d：stat 阶段文件不存在（ENOENT）⇒ 与直读**同结果**且不上抛（去掉降级须失败）', async () => {
    // 用**真实** loader（readJsonlFile 自身对 ENOENT 返回 []）——不注入计数缝，走真容忍语义
    setTranscriptReadLoaderForTests(null)
    const missing = path.join(tmpDir, 'vanished.jsonl')
    const viaCache = await readTranscriptCached(missing)
    const viaDirect = await readJsonlFile(missing)
    expect(viaCache).toEqual(viaDirect) // ← 语义等价：二者都是空表
    expect(viaCache).toEqual([]) // ← 去掉 stat ENOENT 降级 ⇒ 此处上抛，本断言失败
    expect(transcriptReadCacheSize()).toBe(0) // 不缓存「文件不存在」
  })

  test('容量：LRU 上限 16，超出后最旧条目被淘汰（不无界驻留）', async () => {
    for (let i = 0; i < TRANSCRIPT_READ_CACHE_MAX_ENTRIES + 3; i++) {
      const p = path.join(tmpDir, `t-${i}.jsonl`)
      await fs.writeFile(p, '{"cwd":"/w/a"}\n')
      await readTranscriptCached(p)
    }
    expect(transcriptReadCacheSize()).toBe(TRANSCRIPT_READ_CACHE_MAX_ENTRIES)
  })
})

// ── 端到端：**换线是否真的生效**（经过真实 findSessionFile 目录布局）────────────
describe('端到端整读计数（P2-a，真实项目目录布局）', () => {
  let cfgDir: string
  let workDir: string
  let sessionId: string
  let loads: string[]
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-e2e-'))
    process.env.CLAUDE_CONFIG_DIR = cfgDir
    workDir = path.join(cfgDir, 'proj')
    await fs.mkdir(workDir, { recursive: true })
    sessionId = crypto.randomUUID()
    // 真实布局：<config>/projects/<sanitizePath(workDir)>/<sessionId>.jsonl
    const projectDir = path.join(getProjectsDir(), sanitizePath(workDir))
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify({ uuid: 'u1', cwd: workDir }) + '\n',
    )
    loads = []
    resetTranscriptReadCacheForTests()
    setTranscriptReadLoaderForTests(async (p) => {
      loads.push(p)
      const raw = await fs.readFile(p, 'utf-8')
      return raw
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>) as never
    })
  })

  afterEach(async () => {
    setTranscriptReadLoaderForTests(null)
    resetTranscriptReadCacheForTests()
    if (originalConfigDir) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    await fs.rm(cfgDir, { recursive: true, force: true })
  })

  test('换线后的三个方法依次调用同一会话 ⇒ 整读 1 次（对照组改回 this.readJsonlFile 时为 3）', async () => {
    const svc = new SessionService()
    // 同一计数器同时挂在**两条路径**上：缓存加载器缝 + 实例的 readJsonlFile（直接路径）。
    // 这样「换线后 = 1 次」「改回直读 = 3 次」用的是同一把尺子，对照才成立。
    const counter = async (p: string) => {
      loads.push(p)
      const raw = await fs.readFile(p, 'utf-8')
      return raw
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>) as never
    }
    setTranscriptReadLoaderForTests(counter)
    ;(svc as unknown as { readJsonlFile: typeof counter }).readJsonlFile = counter
    const wd = await svc.getSessionWorkDir(sessionId)
    const launch = await svc.getSessionLaunchInfo(sessionId)
    const cwd = await svc.getSessionMessageCwd(sessionId, 'u1')

    // 三个方法都真的读到了同一份转录（证明布局构造正确、不是空跑）
    expect(wd).toBe(workDir)
    expect(launch).not.toBeNull()
    expect(cwd).toBe(workDir)
    // 关键：三处换线后**只整读 1 次**
    expect(loads).toHaveLength(1)
    expect(loads[0]).toBe(loads[1] ?? loads[0])
  })
})
