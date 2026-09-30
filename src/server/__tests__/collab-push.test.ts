/**
 * v1.5.0 A6/C12：协作推送（信号缝 + 活动巡检节流 + 摘要索引持久化）。
 *
 * 契约：D:\xxw_p\cc-heihei-plan\事件契约_v1.5.0.md
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  emitCollabPush,
  onCollabPush,
  resetCollabPushForTests,
  type CollabPushSignal,
} from '../../collaboration/collabPushSignals.js'
import { ServantService, servantService } from '../services/servantService.js'
import { sessionService } from '../services/sessionService.js'
import {
  collabPushService,
  LAST_ACTIVITY_THROTTLE_MS,
} from '../services/collabPushService.js'
import { SessionSummaryIndexStore } from '../services/sessionSummaryIndexStore.js'
import type { SessionListSummary } from '../services/localIndex/types.js'
import { setDiagnosticsLogWriterForTests } from '../../utils/diagLogs.js'

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `cc-heihei-collab-push-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

beforeEach(async () => {
  tmpDir = await createTmpDir()
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetCollabPushForTests()
})

afterEach(async () => {
  resetCollabPushForTests()
  collabPushService.resetForTests()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function collect(): CollabPushSignal[] {
  const seen: CollabPushSignal[] = []
  onCollabPush((signal) => seen.push(signal))
  return seen
}

describe('collabPushSignals（L0 信号缝）', () => {
  it('broadcasts to every subscriber and stops after unsubscribe', () => {
    const a = collect()
    const b = collect()
    const off = onCollabPush(() => {})

    emitCollabPush({ kind: 'session_list', epoch: 7 })

    expect(a).toHaveLength(1)
    expect(b).toEqual([{ kind: 'session_list', epoch: 7 }])
    off()
  })

  it('isolates a throwing subscriber (push is an accelerator, never a failure source)', () => {
    const seen: CollabPushSignal[] = []
    onCollabPush(() => {
      throw new Error('subscriber blew up')
    })
    onCollabPush((signal) => seen.push(signal))

    expect(() => emitCollabPush({ kind: 'session_list', epoch: 1 })).not.toThrow()
    expect(seen).toHaveLength(1)
  })

  // 低4（v1.5.0 第二批）：隔离之外还要留痕——订阅者持续抛错会让推送静默
  // 退化为纯轮询；一次性 debug 诊断让这种退化可见，又不淹没日志窗口。
  it('reports the first subscriber failure as a one-off diagnostic (低4)', () => {
    const logs: Array<{ event: string; data: Record<string, unknown> }> = []
    setDiagnosticsLogWriterForTests((_level, event, data) => {
      logs.push({ event, data })
    })
    try {
      onCollabPush(() => {
        throw new Error('boom-1')
      })
      onCollabPush(() => {
        throw new Error('boom-2')
      })

      emitCollabPush({ kind: 'session_list', epoch: 1 })
      emitCollabPush({ kind: 'roster', sessionId: 's1', change: 'added', fields: [] })

      const failures = logs.filter((entry) => entry.event === 'collab_push_subscriber_failed')
      expect(failures).toHaveLength(1)
      expect(failures[0]!.data.error).toBe('boom-1')
    } finally {
      setDiagnosticsLogWriterForTests(null)
    }
  })
})

describe('servantService → roster signals（A6）', () => {
  it('emits added / updated / removed for roster mutations', async () => {
    const service = new ServantService()
    const created = await sessionService.createSession(tmpDir)
    const sessionId = created.sessionId
    const seen = collect()

    await service.setServant(sessionId, { role: '后端', enabled: true })
    await service.setServant(sessionId, { role: '前端', enabled: true })
    await service.removeServant(sessionId)

    // 只看花名册信号：createSession / title 写入同时会发 session_list（C12 接线），
    // 那是另一条通路，这里断言的是 roster 序列
    const rosterChanges = seen
      .filter((s): s is Extract<CollabPushSignal, { kind: 'roster' }> => s.kind === 'roster')
      .map((s) => s.change)
    expect(rosterChanges).toEqual(['added', 'updated', 'removed'])
    const added = seen.find((s) => s.kind === 'roster')
    if (added?.kind === 'roster') {
      expect(added.sessionId).toBe(sessionId)
      expect(added.fields).toContain('role')
    }
  })
})

describe('collabPushService 活动巡检（A6 节流）', () => {
  /** 用 spyOn 直接喂花名册视图：被测点是节流/比对逻辑，不是花名册读取 */
  function stubRoster(entries: Array<{ sessionId: string; lastActivityAt?: string; title?: string }>) {
    spyOn(servantService, 'listServants').mockImplementation(async () =>
      entries.map((e) => ({
        sessionId: e.sessionId,
        title: e.title ?? 'T',
        enabled: true,
        turnInProgress: false,
        running: true,
        updatedAt: Date.now(),
        ...(e.lastActivityAt ? { lastActivityAt: e.lastActivityAt } : {}),
      })),
    )
  }

  // 低1（v1.5.0 第二批）：慢 IO 让一轮巡检超过 3s tick 时，并发进入会让快照/
  // 节流 map 交错写（可能重复或漏发）。单飞守卫在途即跳过下一轮。
  it('skips a tick while a sweep is still in flight (低1)', async () => {
    let listCalls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    spyOn(servantService, 'listServants').mockImplementation(async () => {
      listCalls += 1
      await gate
      return []
    })

    // 直接驱动定时器路径用的单飞包装（私有方法，按实现细节调用）
    const single = collabPushService as unknown as {
      runSweepSingleFlight: () => Promise<void>
    }
    const first = single.runSweepSingleFlight()
    const second = single.runSweepSingleFlight()
    release()
    await Promise.all([first, second])

    expect(listCalls).toBe(1)
    // 守卫在结束后释放：下一轮正常进入
    await single.runSweepSingleFlight()
    expect(listCalls).toBe(2)
  })

  it('pushes lastActivityAt changes, then throttles within the 5s window', async () => {
    const now = Date.now()
    stubRoster([{ sessionId: 's-1', lastActivityAt: '2026-09-29T10:00:00.000Z' }])
    const seen = collect()

    // 首次巡检只建快照（不推送，避免启动刷屏）
    await collabPushService.sweepActivity(now)
    expect(seen).toHaveLength(0)

    // 活动推进 → 推送
    stubRoster([{ sessionId: 's-1', lastActivityAt: '2026-09-29T10:00:30.000Z' }])
    await collabPushService.sweepActivity(now + 100)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'roster', sessionId: 's-1', change: 'updated' })
    if (seen[0]?.kind === 'roster') expect(seen[0].fields).toContain('lastActivityAt')

    // 窗口内再次推进 → 静默（节流）
    stubRoster([{ sessionId: 's-1', lastActivityAt: '2026-09-29T10:01:00.000Z' }])
    await collabPushService.sweepActivity(now + 200)
    expect(seen).toHaveLength(1)

    // 窗口过后 → 再推
    stubRoster([{ sessionId: 's-1', lastActivityAt: '2026-09-29T10:01:30.000Z' }])
    await collabPushService.sweepActivity(now + LAST_ACTIVITY_THROTTLE_MS + 300)
    expect(seen).toHaveLength(2)
  })

  it('drops snapshots for sessions no longer on the roster', async () => {
    stubRoster([{ sessionId: 's-2', lastActivityAt: '2026-09-29T10:00:00.000Z' }])
    await collabPushService.sweepActivity(Date.now())
    stubRoster([])
    await collabPushService.sweepActivity(Date.now() + 10_000)
    expect(collabPushService['activitySnapshot'].has('s-2')).toBe(false)
  })
})

describe('SessionSummaryIndexStore（C11 持久化摘要索引）', () => {
  const summary: SessionListSummary = {
    title: 'T',
    createdAt: '2026-09-29T00:00:00.000Z',
    modifiedAt: '2026-09-29T01:00:00.000Z',
    messageCount: 3,
    workDir: 'D:/proj',
  }

  it('round-trips through disk with mtime+size reuse', async () => {
    const store = new SessionSummaryIndexStore()
    await store.ensureLoaded()
    store.set('D:/proj/a.jsonl', 111, 222, summary)
    await store.flushForTests()

    const reloaded = new SessionSummaryIndexStore()
    await reloaded.ensureLoaded()
    expect(reloaded.get('D:/proj/a.jsonl', 111, 222)?.title).toBe('T')
    // mtime 或 size 变化 → 失效
    expect(reloaded.get('D:/proj/a.jsonl', 112, 222)).toBeNull()
    expect(reloaded.get('D:/proj/a.jsonl', 111, 223)).toBeNull()
  })

  it('treats a corrupt index as empty and keeps working', async () => {
    const store = new SessionSummaryIndexStore()
    await store.ensureLoaded()
    await fs.mkdir(path.dirname(store.getIndexPath()), { recursive: true })
    await fs.writeFile(store.getIndexPath(), '{ not json', 'utf-8')

    const reloaded = new SessionSummaryIndexStore()
    await reloaded.ensureLoaded()
    expect(reloaded.sizeForTests()).toBe(0)
    reloaded.set('D:/proj/b.jsonl', 1, 1, summary)
    await reloaded.flushForTests()
    expect(await fs.readFile(reloaded.getIndexPath(), 'utf-8')).toContain('b.jsonl')
  })

  it('prunes entries whose files disappeared', async () => {
    const store = new SessionSummaryIndexStore()
    await store.ensureLoaded()
    store.set('D:/proj/keep.jsonl', 1, 1, summary)
    store.set('D:/proj/gone.jsonl', 1, 1, summary)
    store.pruneMissing(new Set(['D:/proj/keep.jsonl']))
    expect(store.get('D:/proj/gone.jsonl', 1, 1)).toBeNull()
    expect(store.get('D:/proj/keep.jsonl', 1, 1)?.title).toBe('T')
  })

  // 低2（v1.5.0 第二批）：命中不再标脏。原实现每次 get 命中都 markDirty，
  // 花名册 20s 轮询 × 多客户端下索引文件每 2s 被防抖整份重写（写放大）。
  it('does not rewrite the index file on cache hits (低2)', async () => {
    const store = new SessionSummaryIndexStore()
    await store.ensureLoaded()
    store.set('D:/proj/hit.jsonl', 7, 8, summary)
    await store.flushForTests()

    const before = await fs.stat(store.getIndexPath())
    for (let i = 0; i < 5; i += 1) {
      expect(store.get('D:/proj/hit.jsonl', 7, 8)?.title).toBe('T')
      expect(store.getTailModifiedAt('D:/proj/hit.jsonl', 7, 8)).toBeNull()
    }
    await store.flushForTests()

    const after = await fs.stat(store.getIndexPath())
    expect(after.mtimeMs).toBe(before.mtimeMs)
    // LRU 序仍在内存里更新（淘汰仍按最近使用）
    expect(store.sizeForTests()).toBe(1)
  })
})
