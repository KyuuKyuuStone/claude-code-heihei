/**
 * v1.3.0 阶段3 专项：存在性判定三分类统一。
 *
 * - 6a 操作类（tombstone 短路）：registry.exists（phase !== 'deleted'）——
 *   sessionMessenger.deliver 与 servants 派活检查链前短路，已删会话拒绝投递/复活。
 * - 6c 呈现类：mcp toggle 改读快照（running 语义对拍）；inspection runtimePhase
 *   三态呈现（在 sessions.test.ts 内做 API 级，此处覆盖 registry 层语义）。
 * - tombstone 机制迁移：deletedSessions Set → registry tombstone；恢复路径
 *   （tombstone → registerSession = deleted→registered 合法恢复迁移）；
 *   startSession 守卫（tombstone 会话不得复活，SESSION_DELETED）。
 * - 6b 读历史类（不短路）：无代码改动，行为由既有 sessions.test.ts 全量回归兜底。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { sessionService } from '../services/sessionService.js'
import {
  exists,
  getSessionSnapshot,
  isTombstoned,
  markCrashed,
  markRunning,
  markStarting,
  registerSession,
  resetRegistryForTests,
  tombstoneSession,
} from '../services/sessionRegistry.js'
import { ConversationService, ConversationStartupError } from '../services/conversationService.js'
import { sessionMessenger, setDeliverOverrideForTests } from '../services/sessionMessenger.js'
import { ApiError } from '../middleware/errorHandler.js'
// v1.3.0 阶段4：deliver 拦截改走注入缝（mock.module 写全局模块注册表且跨文件
// 残留——mock.restore 不还原，全量套件互污染，本文件 3 fail 根因）
import { ServantService } from '../services/servantService.js'

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanupTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

function restoreConfigDir(): void {
  if (originalConfigDir) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
}

describe('stage3 · tombstone registry semantics', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetRegistryForTests()
  })

  afterEach(async () => {
    resetRegistryForTests()
    restoreConfigDir()
    await cleanupTmpDir(tmpDir)
  })

  test('tombstone makes exists false while crash keeps it true (操作类 vs 呈现类的地基)', () => {
    registerSession('crash-keep')
    markStarting('crash-keep')
    markRunning('crash-keep')
    markCrashed('crash-keep', { exitCode: 1 })
    expect(exists('crash-keep')).toBe(true)
    expect(getSessionSnapshot('crash-keep')?.phase).toBe('crashed')

    registerSession('gone')
    markStarting('gone')
    markRunning('gone')
    tombstoneSession('gone')
    expect(exists('gone')).toBe(false)
    expect(getSessionSnapshot('gone')?.phase).toBe('deleted')

    // 未登记会话同样 exists=false（存在性单一权威源）
    expect(exists('never-registered')).toBe(false)

    // —— isTombstoned 与 exists 的分工（v1.3.0 回归修复新增）——
    // 操作类站点要的是「只拦显式删除」，故未登记会话在此必须为 false（放行）；
    // 若误用 exists()，app 重启后 registry 清空会把全部存量会话判成 notFound。
    expect(isTombstoned('never-registered')).toBe(false) // 未登记 ≠ 已删除
    expect(isTombstoned('crash-keep')).toBe(false) // 崩溃 ≠ 已删除
    expect(isTombstoned('gone')).toBe(true) // 只有 tombstone 才是
  })

  test('restore path: tombstone → registerSession is a legal deleted→registered recovery', () => {
    registerSession('restore-me')
    markStarting('restore-me')
    markRunning('restore-me')
    tombstoneSession('restore-me')
    expect(exists('restore-me')).toBe(false)

    registerSession('restore-me')
    expect(exists('restore-me')).toBe(true)
    expect(getSessionSnapshot('restore-me')?.phase).toBe('registered')
  })

  test('startSession guard: tombstoned session cannot be resurrected (SESSION_DELETED)', async () => {
    registerSession('guarded')
    markStarting('guarded')
    tombstoneSession('guarded')

    const svc = new ConversationService()
    await expect(
      svc.startSession('guarded', 'C:/does/not/matter'),
    ).rejects.toThrow(ConversationStartupError)
  })
})

describe('stage3 · 6a sessionMessenger.deliver tombstone short-circuit', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetRegistryForTests()
  })

  afterEach(async () => {
    resetRegistryForTests()
    restoreConfigDir()
    await cleanupTmpDir(tmpDir)
  })

  test('deliver to a tombstoned session is rejected with 404 before any disk lookup', async () => {
    registerSession('dead-target')
    markStarting('dead-target')
    tombstoneSession('dead-target')

    let caught: unknown = null
    try {
      await sessionMessenger.deliver('dead-target', 'hello', 'http://127.0.0.1:1')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).statusCode).toBe(404)
    expect((caught as ApiError).message).toContain('dead-target')
  })

  test('未登记会话不被 tombstone 短路拒绝（v1.3.0 回归修复：registry 内存态不重放）', async () => {
    // 旧实现用 !exists() 短路，而 exists() 对「未登记」返回 false——app 重启后
    // registry 清空，存量会话全落在此态，于是全部被误判 notFound（release 级回归）。
    // 修复后短路只看 isTombstoned：未登记=没删过=放行，落到磁盘元数据链。
    expect(exists('no-such-session')).toBe(false) // registry 视角：不认识它
    expect(isTombstoned('no-such-session')).toBe(false) // 但没删过 → 不得短路拒绝

    let caught: unknown = null
    try {
      await sessionMessenger.deliver('no-such-session', 'hello', 'http://127.0.0.1:1')
    } catch (error) {
      caught = error
    }
    // 磁盘也无此会话元数据 → 仍 404，但归因是「磁盘链找不到」，不是 tombstone 短路。
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).statusCode).toBe(404)
  })

  test('deliver to a crashed session passes the short-circuit (crashed ≠ deleted)', async () => {
    registerSession('crashed-target')
    markStarting('crashed-target')
    markRunning('crashed-target')
    markCrashed('crashed-target', { exitCode: 3 })

    // 短路放行后进入 hasSession=false → 走 workDir 元数据链（磁盘无元数据 → 404）。
    // 关键断言：错误不来自 tombstone 短路本身——该会话 exists=true。
    expect(exists('crashed-target')).toBe(true)
    let caught: unknown = null
    try {
      await sessionMessenger.deliver('crashed-target', 'hello', 'http://127.0.0.1:1')
    } catch (error) {
      caught = error
    }
    // 无磁盘元数据 → notFound（与短路同码但路径不同：exists 放行是前置事实）
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).statusCode).toBe(404)
  })
})

describe('stage3 · 6a servants dispatch tombstone short-circuit (API 级)', () => {
  let handleSessionMessagesApi: (
    req: Request,
    url: URL,
    segments: string[],
  ) => Promise<Response>
  let deliverMock: ReturnType<typeof mock>
  let sessionId: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetRegistryForTests()
    deliverMock = mock(async () => true)
    setDeliverOverrideForTests(deliverMock as unknown as Parameters<typeof setDeliverOverrideForTests>[0])
    const mod = await import('../api/servants.js')
    handleSessionMessagesApi = mod.handleSessionMessagesApi
    const servantService = new ServantService()
    const created = await sessionService.createSession(tmpDir)
    sessionId = created.sessionId
    // 花名册在册（enabled 员工），满足派活链的 roster 前置
    await servantService.setServant(sessionId, { role: '后端', enabled: true })
  })

  afterEach(async () => {
    setDeliverOverrideForTests(null)
    mock.restore()
    resetRegistryForTests()
    restoreConfigDir()
    await cleanupTmpDir(tmpDir)
  })

  function jsonReq(url: string, body: Record<string, unknown>): Request {
    return new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('tombstoned target: dispatch is rejected 404 and deliver is never invoked', async () => {
    registerSession(sessionId)
    markStarting(sessionId)
    tombstoneSession(sessionId)

    const res = await handleSessionMessagesApi(
      jsonReq('http://localhost/api/session-messages', {
        targetSessionId: sessionId,
        content: '派活',
      }),
      new URL('http://localhost/api/session-messages'),
      ['api', 'session-messages'],
    )
    expect(res.status).toBe(404)
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('registered target: dispatch passes the short-circuit and reaches deliver', async () => {
    registerSession(sessionId)
    markStarting(sessionId)
    markRunning(sessionId)

    const res = await handleSessionMessagesApi(
      jsonReq('http://localhost/api/session-messages', {
        targetSessionId: sessionId,
        content: '派活',
      }),
      new URL('http://localhost/api/session-messages'),
      ['api', 'session-messages'],
    )
    expect(res.status).toBe(201)
    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe(sessionId)
  })

  test('名册+磁盘在册但 registry 未登记：短路放行、照常投递（v1.3.0 重启回归锁）', async () => {
    // 模拟 app 重启后的真实场景：registry 是内存态、启动不重放（约束 C1），
    // beforeEach 已 resetRegistryForTests，此刻会话在名册与磁盘上依然存活，
    // 却不在 registry 里。旧实现此处 !exists() 会误判 404，把存量员工全拦死。
    expect(exists(sessionId)).toBe(false) // registry 视角：未登记
    expect(isTombstoned(sessionId)).toBe(false) // 但没删过 → 必须放行

    const res = await handleSessionMessagesApi(
      jsonReq('http://localhost/api/session-messages', {
        targetSessionId: sessionId,
        content: '派活',
      }),
      new URL('http://localhost/api/session-messages'),
      ['api', 'session-messages'],
    )
    expect(res.status).toBe(201)
    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe(sessionId)
  })
})
