import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { servantService } from '../services/servantService.js'
import { sessionService } from '../services/sessionService.js'

/**
 * 花名册被自动清空的高危 bug 回归（v1.5.0）。
 *
 * 原bug：listServants()（GET 路径）拿 getSessionListSummaryForSession() 的 null
 * 当「会话已删除」，直接 writeFile 移除条目。而摘要为 null 的成因远不止删除
 * ——索引未就绪、扫描/IO 抖动、配置目录解析不一致都会让它瞬时为 null。实测
 * 9 条 servant_removed 挤在同一毫秒，整个花名册被一个 GET 请求抹掉，用户在界面上
 * 登记后约 1 秒必被清。
 *
 * 现在的契约：
 * - 读路径（listServants）**永不写盘**；
 * - 摘要取不到时条目照常返回（title 退化为 id 前缀）；
 * - 移除只由明确删除事件触发（pruneForDeletedSessions），且有兜底防线：
 *   「N>0 → 0」或「一次移除多条」一律跳过。
 */

const ID_A = 'aaaa1111-1111-4111-8111-111111111111'
const ID_B = 'bbbb2222-2222-4222-8222-222222222222'
const ID_C = 'cccc3333-3333-4333-8333-333333333333'

function entry(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    role: 'backend',
    enabled: true,
    updatedAt: Date.now(),
    ...extra,
  }
}

describe('花名册高危修复：读路径不删数据', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let rosterPath: string
  let projectDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-roster-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    rosterPath = path.join(tmpDir, 'servant_sessions.json')
    projectDir = path.join(tmpDir, 'projects', 'D--xxw-p-x')
    await fs.mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function writeRoster(entries: Array<Record<string, unknown>>): Promise<void> {
    await fs.writeFile(
      rosterPath,
      JSON.stringify({ schemaVersion: 1, servants: entries }, null, 2),
      'utf-8',
    )
  }

  async function readRoster(): Promise<{ schemaVersion: number; servants: Array<{ sessionId: string }> }> {
    return JSON.parse(await fs.readFile(rosterPath, 'utf-8'))
  }

  /** 造一个真实存在的 transcript 文件（对应会话「存在」） */
  async function writeTranscript(id: string): Promise<void> {
    const line = JSON.stringify({
      type: 'user',
      uuid: `u-${id.slice(0, 4)}`,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: `hello ${id}` },
    })
    await fs.writeFile(path.join(projectDir, `${id}.jsonl`), `${line}\n`, 'utf-8')
  }

  it('摘要全为 null（会话文件都不存在）时：条目照常返回，不清空、不写盘', async () => {
    await writeRoster([entry(ID_A), entry(ID_B), entry(ID_C)])
    const before = await fs.readFile(rosterPath, 'utf-8')

    const list = await servantService.listServants()

    expect(list.map((s) => s.sessionId).sort()).toEqual([ID_A, ID_B, ID_C].sort())
    // 摘要取不到 → title 退化为 id 前缀（条目仍在，不是消失）
    expect(list[0]!.title).toBe(list[0]!.sessionId.slice(0, 8))
    // 读操作没有写盘：文件逐字节未变
    expect(await fs.readFile(rosterPath, 'utf-8')).toBe(before)
  })

  it('刚登记的会话不会在下一次 list 时被删（连续两次 list 都保留）', async () => {
    await writeTranscript(ID_A)
    await writeRoster([entry(ID_A)])

    const first = await servantService.listServants()
    const second = await servantService.listServants()

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect((await readRoster()).servants).toHaveLength(1)
  })

  it('混合场景：存在的会话取真实摘要、不存在的取兜底，都不消失', async () => {
    await writeTranscript(ID_A)
    await writeRoster([entry(ID_A), entry(ID_B)])

    const list = await servantService.listServants()

    expect(list).toHaveLength(2)
    const byId = new Map(list.map((s) => [s.sessionId, s]))
    // 存在的：title 来自 transcript（非 id 前缀兜底）
    expect(byId.get(ID_A)!.title).not.toBe(ID_A.slice(0, 8))
    // 不存在的：兜底 title，但条目仍在
    expect(byId.get(ID_B)!.title).toBe(ID_B.slice(0, 8))
  })

  it('会话文件真实存在、但摘要这一步返回 null（索引未就绪/扫描异常）时也不清空', async () => {
    // 这是 v1.2.7 → v1.4.0 引入的真实回归面：v1.2.7 的存在性判定是
    // listSessions({limit:500})（目录级扫描，结果一致），v1.4.0 为性能改成
    // getSessionListSummaryForSession 单会话直查——而它会因索引未就绪/扫描异常/
    // 配置目录不一致返回 null。旧 listServants 把 null 当「会话已删除」写盘清理，
    // 于是前端 20s 花名册轮询的**一个 GET 请求**就能把花名册抹掉。
    await writeTranscript(ID_A)
    await writeRoster([entry(ID_A), entry(ID_B)])
    const before = await fs.readFile(rosterPath, 'utf-8')

    const spy = spyOn(sessionService, 'getSessionListSummaryForSession').mockResolvedValue(null)
    try {
      const list = await servantService.listServants()
      expect(list.map((s) => s.sessionId).sort()).toEqual([ID_A, ID_B].sort())
      expect(await fs.readFile(rosterPath, 'utf-8')).toBe(before)
    } finally {
      spy.mockRestore()
    }
  })

  it('摘要直查抛异常（扫描失败）时也不清空', async () => {
    await writeTranscript(ID_A)
    await writeRoster([entry(ID_A)])
    const before = await fs.readFile(rosterPath, 'utf-8')

    const spy = spyOn(sessionService, 'getSessionListSummaryForSession').mockRejectedValue(
      new Error('index unavailable'),
    )
    try {
      await expect(servantService.listServants()).rejects.toThrow('index unavailable')
    } finally {
      spy.mockRestore()
    }
    // 即便整条读路径失败，花名册文件也不得被改动（读操作零写入）
    expect(await fs.readFile(rosterPath, 'utf-8')).toBe(before)
  })

  it('pruneForDeletedSessions：单条移除且不会 N>0 → 0 时正常执行', async () => {
    await writeRoster([entry(ID_A), entry(ID_B), entry(ID_C)])

    const removed = await servantService.pruneForDeletedSessions([ID_A])

    expect(removed.map((r) => r.sessionId)).toEqual([ID_A])
    expect((await readRoster()).servants.map((s) => s.sessionId).sort()).toEqual(
      [ID_B, ID_C].sort(),
    )
  })

  it('pruneForDeletedSessions：N>0 → 0 被兜底拦截（不留空花名册）', async () => {
    await writeRoster([entry(ID_A)])
    const before = await fs.readFile(rosterPath, 'utf-8')

    const removed = await servantService.pruneForDeletedSessions([ID_A])

    expect(removed).toEqual([])
    expect(await fs.readFile(rosterPath, 'utf-8')).toBe(before)
  })

  it('pruneForDeletedSessions：一次移除多条被兜底拦截', async () => {
    await writeRoster([entry(ID_A), entry(ID_B), entry(ID_C)])
    const before = await fs.readFile(rosterPath, 'utf-8')

    const removed = await servantService.pruneForDeletedSessions([ID_A, ID_B])

    expect(removed).toEqual([])
    expect(await fs.readFile(rosterPath, 'utf-8')).toBe(before)
  })

  it('pruneForDeletedSessions：空数组或没有匹配条目时是 no-op', async () => {
    await writeRoster([entry(ID_A)])
    const before = await fs.readFile(rosterPath, 'utf-8')

    expect(await servantService.pruneForDeletedSessions([])).toEqual([])
    expect(await servantService.pruneForDeletedSessions([ID_B])).toEqual([])
    expect(await fs.readFile(rosterPath, 'utf-8')).toBe(before)
  })
})
