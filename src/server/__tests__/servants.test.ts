/**
 * Unit tests for ServantService, session-messages API（会话级上下级协作）
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ServantService } from '../services/servantService.js'
import { sessionService } from '../services/sessionService.js'
import {
  observeSessionSdkMessage,
  resetDispatchReceipts,
} from '../services/dispatchReceiptService.js'
// v1.3.0 阶段2（5a）：turn 状态单一权威源迁至 sessionRegistry——观察流「只降不升」，
// 建回合需走注入路径（beginTurn），故用例补 registry 前置
import {
  beginTurn,
  registerSession,
  resetRegistryForTests,
} from '../services/sessionRegistry.js'
// v1.3.0 阶段4：deliver 拦截改走注入缝（mock.module 写全局模块注册表且跨文件
// 残留——mock.restore 不还原，全量套件互污染，阶段4质检 13 fail 根因之一）
import { SessionMessenger, setDeliverOverrideForTests } from '../services/sessionMessenger.js'
import { setDiagnosticsLogWriterForTests } from '../../utils/diagLogs.js'
import { setRosterChangeNoticeDeps } from '../services/rosterChangeNotice.js'
import {
  hasBroadcastLock,
  resetBroadcastLocksForTests,
} from '../services/broadcastLock.js'

// ─── Test helpers ───────────────────────────────────────────────────────────

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

/** 轮询诊断日志直到出现 needle（recordEvent 是异步 fire-and-forget） */
async function readDiagnosticsEventually(needle: string, timeoutMs = 2_000): Promise<string> {
  const diagnosticsPath = path.join(tmpDir, 'cc-heihei', 'diagnostics', 'diagnostics.jsonl')
  const deadline = Date.now() + timeoutMs
  let logged = ''
  while (Date.now() < deadline) {
    logged = await fs.readFile(diagnosticsPath, 'utf-8').catch(() => '')
    if (logged.includes(needle)) return logged
    await new Promise((r) => setTimeout(r, 25))
  }
  return logged
}

// ─── ServantService tests ───────────────────────────────────────────────────

describe('ServantService', () => {
  let service: ServantService
  let sessionId: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    service = new ServantService()
    const created = await sessionService.createSession(tmpDir)
    sessionId = created.sessionId
  })

  afterEach(async () => {
    restoreConfigDir()
    // 回合信号是模块级内存状态：清掉避免向其他用例泄漏（顺序依赖）
    resetDispatchReceipts()
    resetRegistryForTests()
    await cleanupTmpDir(tmpDir)
  })

  it('should return empty list when nothing registered', async () => {
    expect(await service.listServants()).toEqual([])
    expect(await service.getServant(sessionId)).toBeNull()
  })

  it('should register a servant with role and list it', async () => {
    await service.setServant(sessionId, { role: '后端', enabled: true })

    const servants = await service.listServants()
    expect(servants).toHaveLength(1)
    expect(servants[0].sessionId).toBe(sessionId)
    expect(servants[0].role).toBe('后端')
    expect(servants[0].enabled).toBe(true)
    expect(servants[0].title).toBeDefined()
    expect(servants[0].running).toBe(false)
    // 主管区分"执行中"与"假活"的依据：会话最后一次活动时间
    expect(servants[0].lastActivityAt).toBeDefined()
    // 未观察到任何 SDK 消息 → 无进行中回合
    expect(servants[0].turnInProgress).toBe(false)
  })

  it('reflects real turn state via turnInProgress (same source as stall watcher)', async () => {
    await service.setServant(sessionId, { role: '后端', enabled: true })

    // 前置（阶段2 · 5a）：turn 建立走注入路径（registry 单一权威源）
    registerSession(sessionId)
    beginTurn(sessionId, { awaitSend: false })

    // 回合开始（assistant 信号）→ true
    observeSessionSdkMessage(sessionId, 'assistant')
    let servants = await service.listServants()
    expect(servants[0].turnInProgress).toBe(true)

    // 回合边界（result）→ 立刻 false，状态灯不等滑动窗口过期
    observeSessionSdkMessage(sessionId, 'result')
    servants = await service.listServants()
    expect(servants[0].turnInProgress).toBe(false)
  })

  it('resolves roster entries via direct per-session summary, not a full listSessions scan', async () => {
    // v1.4.0 加载性能契约：花名册（渲染端挂载即拉 + 20s 轮询）不得触发
    // listSessions 的全量摘要扫描——冷启动全量扫 + 活跃文件 mtime 失效重扫
    // 曾把事件循环打到分钟级阻塞（实录花名册请求 120s 超时）。
    await service.setServant(sessionId, { role: '后端', enabled: true })
    const listSpy = spyOn(sessionService, 'listSessions')
    try {
      const servants = await service.listServants()
      expect(servants).toHaveLength(1)
      expect(servants[0].sessionId).toBe(sessionId)
      expect(servants[0].title).toBeDefined()
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      listSpy.mockRestore()
    }
  })

  it('读路径不删数据：会话文件消失后条目仍在（title 退化为 id 前缀）', async () => {
    await service.setServant(sessionId, { role: '后端', enabled: true })
    expect(await service.listServants()).toHaveLength(1)

    // 删掉会话文件（模拟「查不到会话」——可能是真被删，也可能只是索引/IO 抖动）
    const found = await sessionService.findSessionFile(sessionId)
    expect(found).not.toBeNull()
    await fs.rm(found!.filePath, { force: true })
    sessionService.invalidateSessionListCachesForTests?.()

    // v1.5.0 花名册高危修复：listServants 是只读操作——查不到会话**不得**移除条目。
    // （旧实现把摘要 null 当「已删除」直接写盘，一次抖动就能清空整个花名册。）
    const roster = await service.listServants()
    expect(roster).toHaveLength(1)
    expect(roster[0].sessionId).toBe(sessionId)
    expect(roster[0].title).toBe(sessionId.slice(0, 8))
    expect(await service.getServant(sessionId)).not.toBeNull()
  })

  it('getSessionListSummaryForSession returns summary for known session, null for unknown', async () => {
    const summary = await sessionService.getSessionListSummaryForSession(sessionId)
    expect(summary).not.toBeNull()
    expect(summary!.title).toBeDefined()
    expect(typeof summary!.messageCount).toBe('number')

    expect(
      await sessionService.getSessionListSummaryForSession('00000000-0000-4000-8000-000000000000'),
    ).toBeNull()
  })

  it('should exclude disabled servants from the roster', async () => {
    await service.setServant(sessionId, { role: '后端', enabled: true })
    await service.setServant(sessionId, { role: '后端', enabled: false })

    expect(await service.listServants()).toEqual([])
    const entry = await service.getServant(sessionId)
    expect(entry?.enabled).toBe(false)
  })

  it('should reject registration for a non-existent session', async () => {
    await expect(
      service.setServant('no-such-session', { enabled: true }),
    ).rejects.toThrow('Session not found')
  })

  it('should reject invalid input', async () => {
    await expect(
      service.setServant(' ', { enabled: true }),
    ).rejects.toThrow('sessionId')
    await expect(
      service.setServant(sessionId, { enabled: 'yes' as unknown as boolean }),
    ).rejects.toThrow('enabled')
  })

  it('should remove a servant and throw when absent', async () => {
    await service.setServant(sessionId, { enabled: true })
    await service.removeServant(sessionId)
    expect(await service.getServant(sessionId)).toBeNull()
    await expect(service.removeServant(sessionId)).rejects.toThrow(
      'not registered',
    )
  })

  it('删除会话不静默清花名册：只有 pruneForDeletedSessions（显式删除事件）才移除', async () => {
    // 两条在册：避开「N>0 → 0」的兜底防线，才能观察到单条移除
    const second = await sessionService.createSession(tmpDir)
    await service.setServant(sessionId, { role: '前端', enabled: true })
    await service.setServant(second.sessionId, { role: '后端', enabled: true })

    await sessionService.deleteSession(sessionId)

    // 读路径不做删除判定——删除会话这件事本身不碰花名册
    expect(await service.listServants()).toHaveLength(2)

    // 显式删除事件钩子才移除
    const removed = await service.pruneForDeletedSessions([sessionId])
    expect(removed.map((entry) => entry.sessionId)).toEqual([sessionId])
    expect(await service.getServant(sessionId)).toBeNull()
    expect(await service.getServant(second.sessionId)).not.toBeNull()
  })

  it('should scope the roster to the requesting session project', async () => {
    const otherDir = path.join(tmpDir, 'other')
    await fs.mkdir(otherDir, { recursive: true })
    const other = await sessionService.createSession(otherDir)
    await service.setServant(sessionId, { role: '后端', enabled: true })
    await service.setServant(other.sessionId, { role: '前端', enabled: true })

    // 同项目过滤 + 自排除（请求者不出现在自己的花名册里）
    const roster = await service.listServants({ forSessionId: sessionId })
    expect(roster).toHaveLength(0)

    const all = await service.listServants()
    expect(all).toHaveLength(2)
  })

  it('should allow only one supervisor per project', async () => {
    const other = await sessionService.createSession(tmpDir)
    await service.setServant(sessionId, { enabled: false, supervisor: true })

    await expect(
      service.setServant(other.sessionId, { enabled: false, supervisor: true }),
    ).rejects.toThrow('already has a supervisor')

    // 另一个项目不受影响
    const elsewhereDir = path.join(tmpDir, 'elsewhere')
    await fs.mkdir(elsewhereDir, { recursive: true })
    const elsewhere = await sessionService.createSession(elsewhereDir)
    await expect(
      service.setServant(elsewhere.sessionId, { enabled: false, supervisor: true }),
    ).resolves.toMatchObject({ supervisor: true })

    // 卸任后可以重新任命
    await service.setServant(sessionId, { enabled: false, supervisor: false })
    await expect(
      service.setServant(other.sessionId, { enabled: false, supervisor: true }),
    ).resolves.toMatchObject({ supervisor: true })
  })

  it('should keep supervisor flag on partial updates', async () => {
    await service.setServant(sessionId, { enabled: true, supervisor: true })
    const updated = await service.setServant(sessionId, {
      role: '后端',
      enabled: true,
    })
    expect(updated.supervisor).toBe(true)
  })

  it('should persist runtime model and effort to session metadata', async () => {
    await service.setServant(sessionId, {
      enabled: true,
      runtimeProviderId: 'provider-1',
      runtimeModelId: 'kimi-k2',
      effortLevel: 'high',
    })

    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    expect(launchInfo.runtimeProviderId).toBe('provider-1')
    expect(launchInfo.runtimeModelId).toBe('kimi-k2')
    expect(launchInfo.effortLevel).toBe('high')
    expect(launchInfo.permissionMode).toBe('bypassPermissions')
  })

  it('should persist runtime fields even when the servant is disabled', async () => {
    await service.setServant(sessionId, {
      enabled: false,
      runtimeProviderId: null,
      runtimeModelId: 'gpt-5',
      effortLevel: 'low',
    })

    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    expect(launchInfo.runtimeProviderId).toBeNull()
    expect(launchInfo.runtimeModelId).toBe('gpt-5')
    expect(launchInfo.effortLevel).toBe('low')
    // 未启用时不写 bypassPermissions
    expect(launchInfo.permissionMode).toBeUndefined()
  })

  it('should ignore an unsupported effort level', async () => {
    await service.setServant(sessionId, { enabled: true, effortLevel: 'ultra' })
    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    expect(launchInfo.effortLevel).toBeUndefined()
  })

  // ─── whitelist 约束档（A3）─────────────────────────────────────────────────

  it('should reject an unsupported constraint value', async () => {
    await expect(
      service.setServant(sessionId, { enabled: true, constraint: 'sandbox' as 'readonly' }),
    ).rejects.toThrow('constraint')
  })

  it('should reject whitelist without writeDirs', async () => {
    await expect(
      service.setServant(sessionId, { enabled: true, constraint: 'whitelist' }),
    ).rejects.toThrow('at least one write directory')
  })

  it('should reject whitelist with an empty writeDirs array', async () => {
    await expect(
      service.setServant(sessionId, { enabled: true, constraint: 'whitelist', writeDirs: [] }),
    ).rejects.toThrow('at least one write directory')
  })

  it('should reject non-absolute and root writeDirs entries', async () => {
    await expect(
      service.setServant(sessionId, {
        enabled: true,
        constraint: 'whitelist',
        writeDirs: ['relative/dir'],
      }),
    ).rejects.toThrow('absolute paths')
    await expect(
      service.setServant(sessionId, {
        enabled: true,
        constraint: 'whitelist',
        writeDirs: [path.parse(tmpDir).root],
      }),
    ).rejects.toThrow('filesystem roots')
  })

  it('should normalize whitelist writeDirs (resolve/trim/dedupe) and persist', async () => {
    const projDir = path.join(tmpDir, 'proj')
    await service.setServant(sessionId, {
      enabled: true,
      constraint: 'whitelist',
      writeDirs: [`  ${projDir}  `, `${projDir}${path.sep}${path.sep}`, `  `, projDir],
    })

    const entry = await service.getServant(sessionId)
    expect(entry?.constraint).toBe('whitelist')
    // 去空、去重、resolve 规范化后恰好一条
    expect(entry?.writeDirs).toEqual([path.resolve(projDir)])
  })

  it('should keep writeDirs when constraint is omitted on later updates', async () => {
    const projDir = path.join(tmpDir, 'proj')
    await service.setServant(sessionId, {
      enabled: true,
      constraint: 'whitelist',
      writeDirs: [projDir],
    })
    // 后续更新不传 constraint/writeDirs：档位与目录都保留
    await service.setServant(sessionId, { enabled: true })
    const entry = await service.getServant(sessionId)
    expect(entry?.constraint).toBe('whitelist')
    expect(entry?.writeDirs).toEqual([path.resolve(projDir)])
  })

  it('should drop writeDirs when switching away from whitelist', async () => {
    const projDir = path.join(tmpDir, 'proj')
    await service.setServant(sessionId, {
      enabled: true,
      constraint: 'whitelist',
      writeDirs: [projDir],
    })
    await service.setServant(sessionId, { enabled: true, constraint: 'readonly' })

    const entry = await service.getServant(sessionId)
    expect(entry?.constraint).toBe('readonly')
    expect(entry?.writeDirs).toBeUndefined()
  })

  // ─── 员工生命周期（增删重入）──────────────────────────────────────────────

  it('should log servant_removed with identity snapshot on session-deleted auto cleanup', async () => {
    await service.setServant(sessionId, {
      role: '策划',
      description: '玩法策划',
      enabled: true,
      constraint: 'readonly',
    })
    // 第二条在册：避开 N>0 → 0 兜底，走正常的单条移除
    const second = await sessionService.createSession(tmpDir)
    await service.setServant(second.sessionId, { role: '前端', enabled: true })

    // 显式删除事件驱动的清理（以前挂在 listServants 的读路径上）
    await sessionService.deleteSession(sessionId)
    await service.pruneForDeletedSessions([sessionId])
    expect(await service.getServant(sessionId)).toBeNull()

    const logged = await readDiagnosticsEventually('servant_removed')
    expect(logged).toContain('session-deleted-auto-cleanup')
    expect(logged).toContain('策划')
    expect(logged).toContain(sessionId)
    // 身份快照：排查「删掉的是什么档位」时有据可查
    expect(logged).toContain('"constraint":"readonly"')
  })

  it('should warn with servant_duplicate_role when registering a same-role worker', async () => {
    await service.setServant(sessionId, { role: '策划', enabled: true })
    const second = await sessionService.createSession(tmpDir)
    await service.setServant(second.sessionId, { role: '策划', enabled: true })

    const logged = await readDiagnosticsEventually('servant_duplicate_role')
    expect(logged).toContain('策划')
    expect(logged).toContain(sessionId)
    expect(logged).toContain(second.sessionId)
    // 不阻断：两条目都在册
    expect(await service.listServants()).toHaveLength(2)
  })

  it('should not warn for a different role registration', async () => {
    await service.setServant(sessionId, { role: '策划', enabled: true })
    const second = await sessionService.createSession(tmpDir)
    await service.setServant(second.sessionId, { role: '前端', enabled: true })

    // 给异步 recordEvent 一个沉降窗口后断言未产生重复角色事件
    await new Promise((r) => setTimeout(r, 150))
    const logged = await fs
      .readFile(path.join(tmpDir, 'cc-heihei', 'diagnostics', 'diagnostics.jsonl'), 'utf-8')
      .catch(() => '')
    expect(logged).not.toContain('servant_duplicate_role')
  })

  // ─── Onboarding 修复包 ────────────────────────────────────────────────────

  it('should exclude the requester from its own roster view (self-exclusion)', async () => {
    const boss = await sessionService.createSession(tmpDir)
    const worker = await sessionService.createSession(tmpDir)
    await service.setServant(boss.sessionId, { enabled: true, supervisor: true })
    await service.setServant(worker.sessionId, { role: '前端', enabled: true })

    const roster = await service.listServants({ forSessionId: boss.sessionId })
    const ids = roster.map((s) => s.sessionId)
    expect(ids).toContain(worker.sessionId)
    // 主管不把自己当员工自派
    expect(ids).not.toContain(boss.sessionId)
  })

  it('should generate the new servant session title from its role', async () => {
    const worker = await sessionService.createSession(tmpDir)
    await service.setServant(worker.sessionId, { role: '运维脚本', enabled: true })

    const { sessions } = await sessionService.listSessions()
    const created = sessions.find((s) => s.id === worker.sessionId)
    expect(created?.title).toBe('运维脚本')
  })

  it('should not overwrite a user-renamed title on later edits', async () => {
    const worker = await sessionService.createSession(tmpDir)
    await service.setServant(worker.sessionId, { role: '运维脚本', enabled: true })
    // 用户随后手动改名
    await sessionService.renameSession(worker.sessionId, '我的脚本员工')
    // 之后改档位（edit 路径）
    await service.setServant(worker.sessionId, { role: '运维脚本', enabled: true, constraint: 'readonly' })

    const { sessions } = await sessionService.listSessions()
    const created = sessions.find((s) => s.id === worker.sessionId)
    expect(created?.title).toBe('我的脚本员工')
  })

  it('should include the roster-emptiness retry guidance in the supervisor orientation', async () => {
    const { buildSupervisorOrientation } = await import('../api/servants.js')
    const text = buildSupervisorOrientation({
      sessionId,
      serverUrl: 'http://127.0.0.1:61694',
      skillAvailable: false,
      shellOk: true,
    })
    expect(text).toContain('60 秒')
    expect(text).toContain('重试 5 次')
  })
})

// ─── Servants API tests ─────────────────────────────────────────────────────

describe('Servants API', () => {
  let handleServantsApi: (
    req: Request,
    url: URL,
    segments: string[],
  ) => Promise<Response>
  let sessionId: string
  let deliverMock: ReturnType<typeof mock>

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    deliverMock = mock(async () => true)
    setDeliverOverrideForTests(deliverMock as unknown as Parameters<typeof setDeliverOverrideForTests>[0])
    const mod = await import('../api/servants.js')
    handleServantsApi = mod.handleServantsApi
    const created = await sessionService.createSession(tmpDir)
    sessionId = created.sessionId
  })

  afterEach(async () => {
    setDeliverOverrideForTests(null)
    mock.restore()
    restoreConfigDir()
    await cleanupTmpDir(tmpDir)
  })

  function jsonReq(
    url: string,
    method: string,
    body?: Record<string, unknown>,
  ): Request {
    return new Request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  }

  it('should run a full servant lifecycle via the API', async () => {
    // empty roster
    const list0 = await handleServantsApi(
      jsonReq('http://localhost/api/servant-sessions', 'GET'),
      new URL('http://localhost/api/servant-sessions'),
      ['api', 'servant-sessions'],
    )
    expect(((await list0.json()) as { servants: unknown[] }).servants).toEqual([])

    // register
    const put = await handleServantsApi(
      jsonReq(`http://localhost/api/servant-sessions/${sessionId}`, 'PUT', {
        role: '前端',
        enabled: true,
      }),
      new URL(`http://localhost/api/servant-sessions/${sessionId}`),
      ['api', 'servant-sessions', sessionId],
    )
    expect(put.status).toBe(200)

    // listed
    const list1 = await handleServantsApi(
      jsonReq('http://localhost/api/servant-sessions', 'GET'),
      new URL('http://localhost/api/servant-sessions'),
      ['api', 'servant-sessions'],
    )
    const roster = ((await list1.json()) as { servants: { sessionId: string; role?: string }[] }).servants
    expect(roster).toHaveLength(1)
    expect(roster[0].role).toBe('前端')

    // remove
    const del = await handleServantsApi(
      jsonReq(`http://localhost/api/servant-sessions/${sessionId}`, 'DELETE'),
      new URL(`http://localhost/api/servant-sessions/${sessionId}`),
      ['api', 'servant-sessions', sessionId],
    )
    expect(del.status).toBe(200)
    const list2 = await handleServantsApi(
      jsonReq('http://localhost/api/servant-sessions', 'GET'),
      new URL('http://localhost/api/servant-sessions'),
      ['api', 'servant-sessions'],
    )
    expect(((await list2.json()) as { servants: unknown[] }).servants).toEqual([])
  })

  it('should reject registering an unknown session', async () => {
    const resp = await handleServantsApi(
      jsonReq('http://localhost/api/servant-sessions/bogus', 'PUT', {
        enabled: true,
      }),
      new URL('http://localhost/api/servant-sessions/bogus'),
      ['api', 'servant-sessions', 'bogus'],
    )
    expect(resp.status).toBe(404)
  })

  it('should deliver an orientation only on first supervisor appointment', async () => {
    // 首次任命：触发履新消息
    const first = await handleServantsApi(
      jsonReq(`http://localhost/api/servant-sessions/${sessionId}`, 'PUT', {
        enabled: false,
        supervisor: true,
      }),
      new URL(`http://localhost/api/servant-sessions/${sessionId}`),
      ['api', 'servant-sessions', sessionId],
    )
    expect(first.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe(sessionId)
    expect(deliverMock.mock.calls[0][1]).toContain('主管')

    // 再次保存（已是主管）：不重复触发
    const again = await handleServantsApi(
      jsonReq(`http://localhost/api/servant-sessions/${sessionId}`, 'PUT', {
        enabled: false,
        supervisor: true,
      }),
      new URL(`http://localhost/api/servant-sessions/${sessionId}`),
      ['api', 'servant-sessions', sessionId],
    )
    expect(again.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(deliverMock).toHaveBeenCalledTimes(1)
  })

  it('should deliver a worker orientation on first registration', async () => {
    const put = await handleServantsApi(
      jsonReq(`http://localhost/api/servant-sessions/${sessionId}`, 'PUT', {
        role: '写作',
        description: '完成文档以及写作需求',
        enabled: true,
      }),
      new URL(`http://localhost/api/servant-sessions/${sessionId}`),
      ['api', 'servant-sessions', sessionId],
    )
    expect(put.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe(sessionId)
    expect(deliverMock.mock.calls[0][1]).toContain('协作员工')
    expect(deliverMock.mock.calls[0][1]).toContain('写作')
    // 随身档案：环境变量/Bash 不可用时，凭消息文本即可完成汇报与自救
    expect(deliverMock.mock.calls[0][1]).toContain(sessionId)
    expect(deliverMock.mock.calls[0][1]).toContain('已直接内联可用')
    // v1.5.0 A7：协作会话已结构性禁用 computer-use（服务端注入
    // CLAUDE_COMPUTER_USE_ENABLED=0），上岗消息不再需要「不要尝试」的文案
    expect(deliverMock.mock.calls[0][1]).not.toContain('computer-use')
    // v1.5.0 低-4：口袋卡补上端口文件陈旧判定（与 dispatchProtocol 共用同一段
    // 常量文本 SERVER_ADDRESS_STALENESS_NOTE）
    expect(deliverMock.mock.calls[0][1]).toContain('陈旧判定')
    expect(deliverMock.mock.calls[0][1]).toContain('startedAt')

    // 再次保存（已是员工）：不重复触发
    const again = await handleServantsApi(
      jsonReq(`http://localhost/api/servant-sessions/${sessionId}`, 'PUT', {
        role: '写作',
        enabled: true,
      }),
      new URL(`http://localhost/api/servant-sessions/${sessionId}`),
      ['api', 'servant-sessions', sessionId],
    )
    expect(again.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(deliverMock).toHaveBeenCalledTimes(1)
  })

  it('should not inject a session message when a new worker is registered (diagnostic only)', async () => {
    const supervisor = await sessionService.createSession(tmpDir)
    await handleServantsApi(
      jsonReq(`http://localhost/api/servant-sessions/${supervisor.sessionId}`, 'PUT', {
        enabled: false,
        supervisor: true,
      }),
      new URL(`http://localhost/api/servant-sessions/${supervisor.sessionId}`),
      ['api', 'servant-sessions', supervisor.sessionId],
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(deliverMock).toHaveBeenCalledTimes(1)

    await handleServantsApi(
      jsonReq(`http://localhost/api/servant-sessions/${sessionId}`, 'PUT', {
        role: '写作',
        description: '完成文档以及写作需求',
        enabled: true,
      }),
      new URL(`http://localhost/api/servant-sessions/${sessionId}`),
      ['api', 'servant-sessions', sessionId],
    )
    await new Promise((r) => setTimeout(r, 100))
    // 只应有两条功能性上岗消息（主管履新 + 员工上岗）；「新员工已加入本项目」
    // 这类系统通知自 v1.2.3 起降为诊断事件，不再注入任何会话
    expect(deliverMock).toHaveBeenCalledTimes(2)
    expect(deliverMock.mock.calls.some((call) => String(call[1]).includes('新员工'))).toBe(false)

    // 但必须能在诊断日志里查到（维护可查）：真实落盘到 <configDir>/cc-heihei/diagnostics
    const diagnosticsPath = path.join(tmpDir, 'cc-heihei', 'diagnostics', 'diagnostics.jsonl')
    let logged = ''
    for (let attempt = 0; attempt < 20; attempt += 1) {
      logged = await fs.readFile(diagnosticsPath, 'utf-8').catch(() => '')
      if (logged.includes('servant_registered')) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(logged).toContain('servant_registered')
    expect(logged).toContain(sessionId)
    expect(logged).toContain('写作')
  })

  it('should log servant_removed on explicit delete and invalidate the identity cache', async () => {
    // 登记为 whitelist 档员工（身份快照应进移除事件）
    await handleServantsApi(
      jsonReq(`http://localhost/api/servant-sessions/${sessionId}`, 'PUT', {
        role: '策划',
        enabled: true,
        constraint: 'whitelist',
        writeDirs: [tmpDir],
      }),
      new URL(`http://localhost/api/servant-sessions/${sessionId}`),
      ['api', 'servant-sessions', sessionId],
    )

    // 预置身份缓存（模拟会话曾拉起读过花名册）
    const { conversationService } = await import('../services/conversationService.js')
    const cache = conversationService as unknown as {
      supervisorSessionCache: Map<string, unknown>
    }
    cache.supervisorSessionCache.set(sessionId, { supervisor: false, constraint: 'whitelist' })

    const del = await handleServantsApi(
      jsonReq(`http://localhost/api/servant-sessions/${sessionId}`, 'DELETE'),
      new URL(`http://localhost/api/servant-sessions/${sessionId}`),
      ['api', 'servant-sessions', sessionId],
    )
    expect(del.status).toBe(200)

    // 缺口 A 修复：删除必须清身份缓存，否则会话重启仍按旧档位注入收权 env
    expect(cache.supervisorSessionCache.has(sessionId)).toBe(false)

    const logged = await readDiagnosticsEventually('servant_removed')
    expect(logged).toContain('explicit-delete')
    expect(logged).toContain('策划')
    expect(logged).toContain('"constraint":"whitelist"')
  })

  // ── v1.7.5：花名册变更必须通知同项目在册主管（此前只有诊断留痕） ──
  // 判红点：删掉 servants.ts 里的 detectRosterChange/notifySupervisorsOfRosterChange
  // 分支，下列用例全部红。
  function stubNoticeDelivery() {
    const deliverMock = mock(async (_t: string, _c: string, _h: string) => true)
    setRosterChangeNoticeDeps({
      // 主管桩与临时会话**同项目**（workDir=tmpDir），否则裁决②的项目隔离会拦下
      listServants: (async () => [
        { sessionId: 'sup-fake', supervisor: true, enabled: true, running: true, workDir: tmpDir },
      ]) as never,
      deliver: deliverMock as never,
      getServerPort: () => 53100,
      recordEvent: () => {},
    })
    return deliverMock
  }

  async function waitForDeliver(m: ReturnType<typeof mock>, n: number) {
    for (let i = 0; i < 60 && m.mock.calls.length < n; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('v1.7.5：删除员工 ⇒ 通知在册主管；取消员工/降级/改角色各自触发一次', async () => {
    const put = (body: Record<string, unknown>) =>
      handleServantsApi(
        jsonReq(`http://localhost/api/servant-sessions/${sessionId}`, 'PUT', body),
        new URL(`http://localhost/api/servant-sessions/${sessionId}`),
        ['api', 'servant-sessions', sessionId],
      )
    const del = () =>
      handleServantsApi(
        jsonReq(`http://localhost/api/servant-sessions/${sessionId}`, 'DELETE'),
        new URL(`http://localhost/api/servant-sessions/${sessionId}`),
        ['api', 'servant-sessions', sessionId],
      )

    // ① 登记（首次登记不是本功能覆盖的跃迁 ⇒ 不通知）
    const d1 = stubNoticeDelivery()
    await put({ role: '前端', enabled: true })
    await waitForDeliver(d1, 1)
    expect(d1).not.toHaveBeenCalled()

    // ② 取消员工身份 ⇒ disabled
    await put({ role: '前端', enabled: false })
    await waitForDeliver(d1, 1)
    expect(d1).toHaveBeenCalledTimes(1)
    expect(d1.mock.calls[0][0]).toBe('sup-fake')
    expect(String(d1.mock.calls[0][1])).toContain('取消员工身份')

    // ③ 重新启用后升为主管，再卸任 ⇒ demoted
    await put({ role: '前端', enabled: true, supervisor: true })
    await put({ role: '前端', enabled: true, supervisor: false })
    await waitForDeliver(d1, 2)
    expect(d1).toHaveBeenCalledTimes(2)
    expect(String(d1.mock.calls[1][1])).toContain('卸任主管')

    // ④ 改角色 ⇒ role_changed
    await put({ role: '后端', enabled: true })
    await waitForDeliver(d1, 3)
    expect(d1).toHaveBeenCalledTimes(3)
    expect(String(d1.mock.calls[2][1])).toContain('前端')
    expect(String(d1.mock.calls[2][1])).toContain('后端')

    // ⑤ 删除 ⇒ removed
    await del()
    await waitForDeliver(d1, 4)
    expect(d1).toHaveBeenCalledTimes(4)
    expect(String(d1.mock.calls[3][1])).toContain('已被移除')

    setRosterChangeNoticeDeps(null)
  })

  it('v1.7.5：重复提交相同值不重复通知（幂等闸门 = 只在真有跃迁时通知一次）', async () => {
    const put = (body: Record<string, unknown>) =>
      handleServantsApi(
        jsonReq(`http://localhost/api/servant-sessions/${sessionId}`, 'PUT', body),
        new URL(`http://localhost/api/servant-sessions/${sessionId}`),
        ['api', 'servant-sessions', sessionId],
      )

    const d = stubNoticeDelivery()
    await put({ role: '前端', enabled: true })
    await put({ role: '前端', enabled: true })
    await put({ role: '前端', enabled: true })
    await waitForDeliver(d, 1)
    expect(d).not.toHaveBeenCalled() // 无跃迁 ⇒ 一次都不通知

    await put({ role: '前端', enabled: false })
    await waitForDeliver(d, 1)
    expect(d).toHaveBeenCalledTimes(1)
    // 再重复禁用：仍是同一个"已禁用"状态 ⇒ 不再通知
    await put({ role: '前端', enabled: false })
    await waitForDeliver(d, 2)
    expect(d).toHaveBeenCalledTimes(1)

    setRosterChangeNoticeDeps(null)
  })
})

// ─── Session Messages API tests ─────────────────────────────────────────────

describe('Session Messages API', () => {
  let handleSessionMessagesApi: (
    req: Request,
    url: URL,
    segments: string[],
  ) => Promise<Response>
  let deliverMock: ReturnType<typeof mock>

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir

    deliverMock = mock(async () => true)
    setDeliverOverrideForTests(deliverMock as unknown as Parameters<typeof setDeliverOverrideForTests>[0])

    const mod = await import('../api/servants.js')
    handleSessionMessagesApi = mod.handleSessionMessagesApi
  })

  afterEach(async () => {
    setDeliverOverrideForTests(null)
    mock.restore()
    restoreConfigDir()
    await cleanupTmpDir(tmpDir)
  })

  /** 登记一个真实会话为在册员工，返回 sessionId（404 语义下投递目标必须在册） */
  async function registerRosterWorker(
    input: { role?: string; enabled?: boolean; supervisor?: boolean } = {},
  ): Promise<string> {
    const worker = await sessionService.createSession(tmpDir)
    // v1.3.0 阶段3（6a）：派活链有 registry.exists 短路——投递目标必须已登记
    //（真实世界员工 CLI 拉起即 registerSession），测试对齐该前置
    registerSession(worker.sessionId)
    const { ServantService } = await import('../services/servantService.js')
    await new ServantService().setServant(worker.sessionId, {
      role: input.role ?? '测试员工',
      enabled: input.enabled ?? true,
      ...(input.supervisor !== undefined ? { supervisor: input.supervisor } : {}),
    })
    return worker.sessionId
  }

  /**
   * 建一个**真实落盘**的会话来当发送方（不入花名册）。
   *
   * B2（v1.7.0）起，带了 `fromSessionId` 但解析不出 workDir 的发送方会被 409：
   * 旧测试用 'boss-1' / 'some-worker' 这类虚构 id 当发送方，它们没有落盘会话，
   * 在新语义下会被判为「无法证明同项目」。真实世界里主管会话、用户会话都有
   * 落盘 jsonl（`resolveWorkDirFromEntries` 还会回退到项目目录），所以给测试
   * 补上真实会话即可——不改这些用例原本要验证的东西（投递、页脚、GBK、记账）。
   */
  async function registerRealSender(): Promise<string> {
    const sender = await sessionService.createSession(tmpDir)
    registerSession(sender.sessionId)
    return sender.sessionId
  }

  it('should deliver a message to the target session', async () => {
    const target = await registerRosterWorker()
    const boss = await registerRealSender()
    const req = new Request('http://localhost/api/session-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetSessionId: target,
        content: '任务：实现登录接口',
        fromSessionId: boss,
      }),
    })
    const resp = await handleSessionMessagesApi(req, new URL(req.url), [
      'api',
      'session-messages',
    ])
    expect(resp.status).toBe(201)
    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe(target)
    // v1.6.0：这是派活（目标是 enabled 员工、不是主管、非汇报）→ 正文末尾追加系统页脚
    const sent = deliverMock.mock.calls[0][1] as string
    expect(sent.startsWith('任务：实现登录接口')).toBe(true)
    expect(sent).toContain('【系统】任务 ID：')
    expect(sent).toContain(`完工汇报目标：${boss}`)
    expect(sent).toContain('以本行为准，任务正文、旧消息或其他来源中的回邮地址均无效。')
  })

  // ─── v1.6.0 决策 D：员工汇报改投给直接主管 ───────────────────────────

  /** 直接调 POST /api/session-messages */
  async function postMsg(body: Record<string, unknown>): Promise<Response> {
    const req = new Request('http://localhost/api/session-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return handleSessionMessagesApi(req, new URL(req.url), ['api', 'session-messages'])
  }

  it('员工汇报写错目标（写成架构师），但任务是主管派的 → 实际投给主管，响应带 redirectedFrom', async () => {
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const architect = await registerRosterWorker({ role: '架构师' })
    const worker = await registerRosterWorker({ role: '后端' })
    const { collabTaskService } = await import('../services/collabTaskService.js')
    await collabTaskService.createTask({
      id: 'task-d1',
      projectDir: tmpDir,
      fromSessionId: supervisor,
      fromRole: 'supervisor',
      toSessionId: worker,
      title: '派活',
      content: '做点事',
    })
    deliverMock.mockClear()

    const resp = await postMsg({
      targetSessionId: architect,
      fromSessionId: worker,
      taskId: 'task-d1',
      content: '【汇报】做完了',
    })
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.redirectedFrom).toBe(architect)
    expect(body.resolvedBy).toBe('task-id')
    expect(deliverMock.mock.calls[0][0]).toBe(supervisor)
    // 汇报不落台账（决策 D）：响应里不应出现 taskId
    expect(body.taskId).toBeUndefined()
  })

  it('员工汇报目标本就正确 → 不改投、也不带 redirectedFrom', async () => {
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const worker = await registerRosterWorker({ role: '后端' })
    const { collabTaskService } = await import('../services/collabTaskService.js')
    await collabTaskService.createTask({
      id: 'task-d2',
      projectDir: tmpDir,
      fromSessionId: supervisor,
      fromRole: 'supervisor',
      toSessionId: worker,
      title: '派活',
      content: '做点事',
    })
    deliverMock.mockClear()

    const resp = await postMsg({
      targetSessionId: supervisor,
      fromSessionId: worker,
      taskId: 'task-d2',
      content: '【汇报】做完了',
    })
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.redirectedFrom).toBeUndefined()
    expect(deliverMock.mock.calls[0][0]).toBe(supervisor)
    expect(body.taskId).toBeUndefined()
  })

  it('汇报不新建任务：台账条数不变', async () => {
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const worker = await registerRosterWorker({ role: '后端' })
    const { collabTaskService } = await import('../services/collabTaskService.js')
    await collabTaskService.createTask({
      id: 'task-d3',
      projectDir: tmpDir,
      fromSessionId: supervisor,
      fromRole: 'supervisor',
      toSessionId: worker,
      title: '派活',
      content: '做点事',
    })
    const before = (await collabTaskService.listTasks({})).length

    await postMsg({
      targetSessionId: supervisor,
      fromSessionId: worker,
      taskId: 'task-d3',
      content: '【汇报】做完了',
    })

    expect((await collabTaskService.listTasks({})).length).toBe(before)
  })

  it('旧主管派的任务，旧主管卸任（不再是主管）、新主管上任后 → 汇报投给新主管', async () => {
    const oldSupervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const worker = await registerRosterWorker({ role: '后端' })
    const { collabTaskService } = await import('../services/collabTaskService.js')
    await collabTaskService.createTask({
      id: 'task-d4',
      projectDir: tmpDir,
      fromSessionId: oldSupervisor,
      fromRole: 'supervisor',
      toSessionId: worker,
      title: '派活',
      content: '做点事',
    })

    // 旧主管卸任 + 新主管上任（同项目）
    const { ServantService } = await import('../services/servantService.js')
    const svc = new ServantService()
    await svc.setServant(oldSupervisor, { enabled: true, supervisor: false })
    const newSupervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    deliverMock.mockClear()

    const resp = await postMsg({
      targetSessionId: oldSupervisor,
      fromSessionId: worker,
      taskId: 'task-d4',
      content: '【汇报】做完了',
    })
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.resolvedBy).toBe('successor-supervisor')
    expect(body.redirectedFrom).toBe(oldSupervisor)
    expect(deliverMock.mock.calls[0][0]).toBe(newSupervisor)
  })

  it('员工带的 taskId 在台账查不到 → 记可审计告警，且仍按 fallback 投递', async () => {
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const worker = await registerRosterWorker({ role: '后端' })
    const logs: Array<{ level: string; event: string; data?: Record<string, unknown> }> = []
    setDiagnosticsLogWriterForTests((level, event, data) => {
      logs.push({ level, event, data: data as Record<string, unknown> | undefined })
    })
    try {
      deliverMock.mockClear()
      const resp = await postMsg({
        targetSessionId: worker, // 错的目标，台账也查不到这个 taskId
        fromSessionId: worker,
        taskId: 'no-such-task',
        content: '【汇报】做完了',
      })
      expect(resp.status).toBe(201)
      const warn = logs.find((entry) => entry.event === 'collab_report_task_not_found')
      expect(warn).toBeDefined()
      expect(warn?.level).toBe('warn')
      expect(warn?.data).toMatchObject({
        requestedTaskId: 'no-such-task',
        workerSessionId: worker,
        requestedTarget: worker,
      })
      // fallback 结果不变：台账无果 → 同项目现任主管
      expect(deliverMock.mock.calls[0][0]).toBe(supervisor)
    } finally {
      setDiagnosticsLogWriterForTests(null)
    }
  })

  it('taskId 正常存在时，不产生 task-not-found 告警', async () => {
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const worker = await registerRosterWorker({ role: '后端' })
    const { collabTaskService } = await import('../services/collabTaskService.js')
    await collabTaskService.createTask({
      id: 'task-ok',
      projectDir: tmpDir,
      fromSessionId: supervisor,
      fromRole: 'supervisor',
      toSessionId: worker,
      title: '派活',
      content: '做点事',
    })
    const events: string[] = []
    setDiagnosticsLogWriterForTests((_level, event) => {
      events.push(event)
    })
    try {
      const resp = await postMsg({
        targetSessionId: supervisor,
        fromSessionId: worker,
        taskId: 'task-ok',
        content: '【汇报】做完了',
      })
      expect(resp.status).toBe(201)
      expect(events).not.toContain('collab_report_task_not_found')
    } finally {
      setDiagnosticsLogWriterForTests(null)
    }
  })

  it('旧主管卸任、员工汇报已正确写现任主管 → 保持该目标，不被逆改回旧主管', async () => {
    const oldSupervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const worker = await registerRosterWorker({ role: '后端' })
    const { collabTaskService } = await import('../services/collabTaskService.js')
    await collabTaskService.createTask({
      id: 'task-d6',
      projectDir: tmpDir,
      fromSessionId: oldSupervisor,
      fromRole: 'supervisor',
      toSessionId: worker,
      title: '派活',
      content: '做点事',
    })
    const { ServantService } = await import('../services/servantService.js')
    await new ServantService().setServant(oldSupervisor, { enabled: true, supervisor: false })
    const newSupervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    deliverMock.mockClear()

    const resp = await postMsg({
      // 员工按系统页脚写对了现任主管——交接分支不得把它逆改回旧派活人
      targetSessionId: newSupervisor,
      fromSessionId: worker,
      taskId: 'task-d6',
      content: '【汇报】做完了',
    })
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.redirectedFrom).toBeUndefined()
    expect(body.resolvedBy).toBeUndefined()
    expect(deliverMock.mock.calls[0][0]).toBe(newSupervisor)
  })

  it('员工名下两条未结任务、派活人不同、汇报不带 taskId → 不改投，只告警', async () => {
    const bossA = await registerRosterWorker({ role: '主管', supervisor: true })
    const bossB = await registerRosterWorker({ role: '用户' })
    const worker = await registerRosterWorker({ role: '后端' })
    const { collabTaskService } = await import('../services/collabTaskService.js')
    await collabTaskService.createTask({
      id: 'task-d5a',
      projectDir: tmpDir,
      fromSessionId: bossA,
      fromRole: 'supervisor',
      toSessionId: worker,
      title: 'a',
      content: 'a',
    })
    await collabTaskService.createTask({
      id: 'task-d5b',
      projectDir: tmpDir,
      fromSessionId: bossB,
      fromRole: 'other',
      toSessionId: worker,
      title: 'b',
      content: 'b',
    })
    deliverMock.mockClear()

    const resp = await postMsg({
      targetSessionId: bossA,
      fromSessionId: worker,
      content: '【汇报】做完了',
    })
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.redirectedFrom).toBeUndefined()
    expect(deliverMock.mock.calls[0][0]).toBe(bossA)
  })

  it('同项目无主管、台账也查不到 → 按原目标投递', async () => {
    const worker = await registerRosterWorker({ role: '后端' })
    const other = await registerRosterWorker({ role: '前端' })
    deliverMock.mockClear()
    const resp = await postMsg({
      targetSessionId: other,
      fromSessionId: worker,
      content: '【汇报】做完了',
    })
    expect(resp.status).toBe(201)
    expect(deliverMock.mock.calls[0][0]).toBe(other)
  })

  it('原目标不在册且解析不出更好人选 → 保留可行动 404', async () => {
    const worker = await registerRosterWorker({ role: '后端' })
    const resp = await postMsg({
      targetSessionId: '11111111-2222-4333-8444-555555555555',
      fromSessionId: worker,
      content: '【汇报】做完了',
    })
    expect(resp.status).toBe(404)
  })

  it('主管派活永远是派活：不改投、记台账、带页脚', async () => {
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const worker = await registerRosterWorker({ role: '后端' })
    deliverMock.mockClear()
    const resp = await postMsg({
      targetSessionId: worker,
      fromSessionId: supervisor,
      content: '派活：做个功能',
    })
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.redirectedFrom).toBeUndefined()
    expect(typeof body.taskId).toBe('string') // 派活才记台账
    const sent = deliverMock.mock.calls[0][1] as string
    expect(sent).toContain(`完工汇报目标：${supervisor}`)
  })

  it('用户会话（发送方不在花名册）派活给员工 → 永不改投，正常记台账', async () => {
    const worker = await registerRosterWorker({ role: '后端' })
    deliverMock.mockClear()
    // 真实用户会话：落盘但不在花名册（B2 起发送方必须有可解析的 workDir）
    const userSession = await registerRealSender()
    const resp = await postMsg({
      targetSessionId: worker,
      fromSessionId: userSession,
      content: '用户发的消息',
    })
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as Record<string, unknown>
    // 不在花名册的发送方不参与汇报解析，但目标仍是 enabled 员工 → 这是派活，照旧记账
    expect(body.redirectedFrom).toBeUndefined()
    expect(typeof body.taskId).toBe('string')
  })

  it('recovers GBK-encoded Chinese from legacy inline curl bodies', async () => {
    // Windows 控制台的 curl -d 内联中文按 GBK 编码发出（实战复盘 BUG-1）：
    // 服务端严格 UTF-8 解码失败时回退 GBK 解码。"测试" 的 GBK 字节 = B2 E2 CA D4
    const target = await registerRosterWorker()
    const sender = await registerRealSender()
    const body = Buffer.concat([
      Buffer.from(`{"targetSessionId":"${target}","content":"`, 'utf8'),
      Buffer.from([0xB2, 0xE2, 0xCA, 0xD4]),
      Buffer.from(`","fromSessionId":"${sender}"}`, 'utf8'),
    ])
    const res = await handleSessionMessagesApi(
      new Request('http://localhost/api/session-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
      new URL('http://localhost/api/session-messages'),
      ['api', 'session-messages'],
    )
    expect(res.status).toBe(201)
    // v1.6.0：这是派活 → 正文末尾追加了系统页脚，用 contains 而非全等
    expect(deliverMock.mock.calls[0][1]).toContain('测试')
    expect(deliverMock.mock.calls[0][1]).toContain('【系统】任务 ID：')
  })

  it('should reject invalid payloads', async () => {
    const missingTarget = await handleSessionMessagesApi(
      new Request('http://localhost/api/session-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hi' }),
      }),
      new URL('http://localhost/api/session-messages'),
      ['api', 'session-messages'],
    )
    // targetSessionId 缺失 → 前置校验 400（原先落到 deliver 层，mock 下会假成功 201；
    // 生命周期改造后由 API 层先行拒绝；空 content 的校验仍在 SessionMessenger 层）
    expect(missingTarget.status).toBe(400)
  })

  // ─── v1.6.0 裁决二：广播 = N 条独立单播派活（各自独立 taskId 与台账） ──

  it('发送方 workDir 解析不出时广播 409（B2 同款：不跨项目、不给后门）', async () => {
    // 项目里照常有人，唯一的问题是发送方身份解析不出来——
    // 此时 listServants 的 workDir 过滤会被整段跳过，若不拦就是跨项目广播。
    await registerRosterWorker({ role: '主管', supervisor: true })
    await registerRosterWorker({ role: '后端' })

    const resp = await postMsg({
      broadcast: true,
      fromSessionId: 'ghost-session-never-registered',
      content: '做功能',
    })
    expect(resp.status).toBe(409)
    // 错误响应体是 { message }（与 B2 单播那条测试同一结构）
    const body = (await resp.json()) as { message: string }
    expect(body.message).toContain('workDir could not be resolved')
  })

  it('主管向 3 名员工广播：3 个独立 taskId、台账 broadcastId 相同、页脚逐一对齐', async () => {
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const a = await registerRosterWorker({ role: '前端' })
    const b = await registerRosterWorker({ role: '后端' })
    const c = await registerRosterWorker({ role: '测试' })
    deliverMock.mockClear()

    const resp = await postMsg({ broadcast: true, fromSessionId: supervisor, content: '做功能' })
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as {
      broadcastId: string
      delivered: number
      targets: Array<{ sessionId: string; taskId?: string; delivered: boolean }>
    }
    expect(body.broadcastId).toBeTruthy()
    expect(body.delivered).toBe(3)
    expect(body.targets).toHaveLength(3)

    const taskIds = body.targets.map((t) => t.taskId)
    expect(taskIds.every((id) => typeof id === 'string')).toBe(true)
    expect(new Set(taskIds).size).toBe(3) // 各自独立，不是同一个

    // 每个员工收到的页脚里 taskId 与本人在响应中的 taskId 一致，回邮目标都是发起者
    for (const target of body.targets) {
      const call = deliverMock.mock.calls.find((args) => args[0] === target.sessionId)
      expect(call).toBeDefined()
      const sent = call![1] as string
      expect(sent).toContain(`任务 ID：${target.taskId}`)
      expect(sent).toContain(`完工汇报目标：${supervisor}`)
    }
    expect(deliverMock.mock.calls.map((args) => args[0]).sort()).toEqual([a, b, c].sort())

    const { collabTaskService } = await import('../services/collabTaskService.js')
    const tasks = await collabTaskService.listTasks({})
    const broadcastTasks = tasks.filter((task) => task.broadcastId === body.broadcastId)
    expect(broadcastTasks).toHaveLength(3)
    expect(broadcastTasks.every((task) => task.fromSessionId === supervisor)).toBe(true)
    expect(broadcastTasks.every((task) => task.status === 'dispatched')).toBe(true)
  })

  // ─── v1.6.0 裁决三：broadcastId 单进程并发保护 ────────────────────────

  it('同 broadcastId 并发两请求 → 每目标仅一次投递、台账恰 3 条、taskId 一致、后响应 deduplicated', async () => {
    resetBroadcastLocksForTests()
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    await registerRosterWorker({ role: '前端' })
    await registerRosterWorker({ role: '后端' })
    await registerRosterWorker({ role: '测试' })
    const broadcastId = 'bc-concurrent-1'

    // 确定性 barrier：让**第一次**投递挂在 gate 上，从而第一个请求确实已进入临界区
    // 且尚未记账；第二个请求此时发起，应因同 key 串行而排队。不依赖 sleep。
    let firstDeliverStarted!: () => void
    const firstDeliverStartedP = new Promise<void>((resolve) => {
      firstDeliverStarted = resolve
    })
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    let blockOnce = true
    deliverMock.mockClear()
    deliverMock.mockImplementation(async () => {
      if (blockOnce) {
        blockOnce = false
        firstDeliverStarted()
        await gate
      }
      return true
    })

    const req1 = postMsg({ broadcast: true, fromSessionId: supervisor, content: '做', broadcastId })
    await firstDeliverStartedP // 此刻 req1 已在临界区内的投递中（持锁）
    const req2 = postMsg({ broadcast: true, fromSessionId: supervisor, content: '做', broadcastId })
    openGate() // 放行 req1

    const [res1, res2] = await Promise.all([req1, req2])
    expect(res1.status).toBe(201)
    expect(res2.status).toBe(201)
    const body1 = (await res1.json()) as {
      targets: Array<{ sessionId: string; taskId?: string }>
      deduplicated?: boolean
    }
    const body2 = (await res2.json()) as {
      targets: Array<{ sessionId: string; taskId?: string }>
      deduplicated?: boolean
    }

    // 每个目标恰好投递一次（并发没有放大投递）
    expect(deliverMock).toHaveBeenCalledTimes(3)
    // 台账恰好 3 条
    const { collabTaskService } = await import('../services/collabTaskService.js')
    const tasks = (await collabTaskService.listTasks({})).filter(
      (task) => task.broadcastId === broadcastId,
    )
    expect(tasks).toHaveLength(3)
    // 两个响应给出**相同**的 taskId
    const ids1 = new Map(body1.targets.map((t) => [t.sessionId, t.taskId]))
    for (const target of body2.targets) {
      expect(target.taskId).toBe(ids1.get(target.sessionId))
    }
    // 后到的请求被幂等放行，带可区分标记；先到的正常投递不带
    expect(body2.deduplicated).toBe(true)
    expect(body1.deduplicated).toBeUndefined()
    // 结束后无残留锁
    expect(hasBroadcastLock(`broadcast:${broadcastId}`)).toBe(false)
  })

  it('不同 broadcastId 并行互不阻塞', async () => {
    resetBroadcastLocksForTests()
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    await registerRosterWorker({ role: '前端' })
    await registerRosterWorker({ role: '后端' })
    await registerRosterWorker({ role: '测试' })

    let firstDeliverStarted!: () => void
    const firstDeliverStartedP = new Promise<void>((resolve) => {
      firstDeliverStarted = resolve
    })
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    let blockOnce = true
    deliverMock.mockClear()
    deliverMock.mockImplementation(async () => {
      if (blockOnce) {
        blockOnce = false
        firstDeliverStarted()
        await gate
      }
      return true
    })

    const slow = postMsg({ broadcast: true, fromSessionId: supervisor, content: '做', broadcastId: 'bc-x' })
    await firstDeliverStartedP // bc-x 卡在投递中
    // bc-y 使用不同键，不应等 bc-x 的锁
    const fast = await postMsg({ broadcast: true, fromSessionId: supervisor, content: '做', broadcastId: 'bc-y' })
    expect(fast.status).toBe(201)
    const fastBody = (await fast.json()) as { delivered: number }
    expect(fastBody.delivered).toBe(3) // 在 bc-x 未完成时就跑完了

    openGate()
    expect((await slow).status).toBe(201)
  })

  it('临界区异常后释放锁，后续同 broadcastId 请求正常成功', async () => {
    resetBroadcastLocksForTests()
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    await registerRosterWorker({ role: '前端' })
    await registerRosterWorker({ role: '后端' })
    await registerRosterWorker({ role: '测试' })
    const broadcastId = 'bc-recover'

    // 第一轮：所有投递都抛错 → 全失败 → 500（临界区以异常结束）
    deliverMock.mockClear()
    deliverMock.mockImplementation(async () => {
      throw new Error('boom')
    })
    const bad = await postMsg({ broadcast: true, fromSessionId: supervisor, content: '做', broadcastId })
    expect(bad.status).toBe(500)
    // 异常没有把锁卡死：键已释放
    expect(hasBroadcastLock(`broadcast:${broadcastId}`)).toBe(false)

    // 后续同 ID 请求正常成功
    deliverMock.mockImplementation(async () => true)
    const good = await postMsg({ broadcast: true, fromSessionId: supervisor, content: '做', broadcastId })
    expect(good.status).toBe(201)
    const goodBody = (await good.json()) as { delivered: number }
    expect(goodBody.delivered).toBe(3)
    expect(hasBroadcastLock(`broadcast:${broadcastId}`)).toBe(false)
  })

  it('不带 broadcastId 的广播不进锁，请求后锁表为空', async () => {
    resetBroadcastLocksForTests()
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    await registerRosterWorker({ role: '后端' })
    deliverMock.mockClear()
    const resp = await postMsg({ broadcast: true, fromSessionId: supervisor, content: '做' })
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as { broadcastId: string; deduplicated?: boolean }
    expect(body.broadcastId).toBeTruthy() // 自动生成
    expect(body.deduplicated).toBeUndefined()
    expect(hasBroadcastLock(`broadcast:${body.broadcastId}`)).toBe(false)
  })

  it('主管永远不作为广播目标（用户会话发起时也排除主管）', async () => {
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const worker = await registerRosterWorker({ role: '后端' })
    deliverMock.mockClear()
    // 用**用户会话**发起：主管此时是「enabled 且非发起者」，只有 !supervisor 这一条
    // 能把它排除。若换成主管自己发起，「非发起者」会顺带排除，测不出主管过滤。
    // B2（v1.7.0 广播同项目守卫，d419b5d）：发送方必须是**可解析 workDir 的真实落盘
    // 会话**，否则一律 409——原夹具的幽灵 id 在旧语义下侥幸通过。registerRealSender
    // 建的会话不入花名册、也不是主管，上面这条设计意图保持不变。
    const userSender = await registerRealSender()
    const resp = await postMsg({
      broadcast: true,
      fromSessionId: userSender,
      content: '做功能',
    })
    expect(resp.status).toBe(201)
    const targets = deliverMock.mock.calls.map((args) => args[0])
    expect(targets).toContain(worker)
    expect(targets).not.toContain(supervisor)
  })

  it('在册非主管员工发起广播 → 403，且不投递、不记账', async () => {
    await registerRosterWorker({ role: '主管', supervisor: true })
    const worker = await registerRosterWorker({ role: '后端' })
    const peer = await registerRosterWorker({ role: '前端' })
    const { collabTaskService } = await import('../services/collabTaskService.js')
    const before = (await collabTaskService.listTasks({})).length
    deliverMock.mockClear()

    const resp = await postMsg({ broadcast: true, fromSessionId: worker, content: '都去做' })
    expect(resp.status).toBe(403)
    expect(deliverMock).not.toHaveBeenCalled()
    expect((await collabTaskService.listTasks({})).length).toBe(before)
    void peer
  })

  it('广播中有一个目标投递失败 → 只记成功目标的账，失败项无 taskId', async () => {
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const a = await registerRosterWorker({ role: '前端' })
    const b = await registerRosterWorker({ role: '后端' })
    const failing = await registerRosterWorker({ role: '测试' })
    deliverMock.mockClear()
    deliverMock.mockImplementation(async (targetId: string) => targetId !== failing)

    const resp = await postMsg({ broadcast: true, fromSessionId: supervisor, content: '做功能' })
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as {
      broadcastId: string
      delivered: number
      failed?: string[]
      targets: Array<{ sessionId: string; taskId?: string; delivered: boolean }>
    }
    expect(body.delivered).toBe(2)
    expect(body.failed).toEqual([failing])

    const failedItem = body.targets.find((t) => t.sessionId === failing)
    expect(failedItem?.delivered).toBe(false)
    expect(failedItem?.taskId).toBeUndefined()

    const { collabTaskService } = await import('../services/collabTaskService.js')
    const tasks = (await collabTaskService.listTasks({})).filter(
      (task) => task.broadcastId === body.broadcastId,
    )
    expect(tasks).toHaveLength(2) // 失败目标不记账
    expect(tasks.map((task) => task.toSessionId).sort()).toEqual([a, b].sort())
  })

  it('同一 broadcastId 重复提交 → 已成功目标不重复投递与记账', async () => {
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const a = await registerRosterWorker({ role: '前端' })
    const b = await registerRosterWorker({ role: '后端' })
    const broadcastId = 'bc-idempotent-1'
    deliverMock.mockClear()

    const first = await postMsg({ broadcast: true, fromSessionId: supervisor, content: '做功能', broadcastId })
    expect(first.status).toBe(201)
    expect(deliverMock).toHaveBeenCalledTimes(2)
    const firstBody = (await first.json()) as { targets: Array<{ sessionId: string; taskId?: string }> }
    const firstTaskIds = new Map(firstBody.targets.map((t) => [t.sessionId, t.taskId]))

    deliverMock.mockClear()
    const second = await postMsg({ broadcast: true, fromSessionId: supervisor, content: '做功能', broadcastId })
    expect(second.status).toBe(201)
    const secondBody = (await second.json()) as { targets: Array<{ sessionId: string; taskId?: string }> }
    // 幂等命中：不再重复投递
    expect(deliverMock).not.toHaveBeenCalled()
    // 返回的仍是上一轮那批 taskId
    for (const target of secondBody.targets) {
      expect(target.taskId).toBe(firstTaskIds.get(target.sessionId))
    }

    const { collabTaskService } = await import('../services/collabTaskService.js')
    const tasks = (await collabTaskService.listTasks({})).filter(
      (task) => task.broadcastId === broadcastId,
    )
    expect(tasks).toHaveLength(2) // 没有重复记账
    expect(tasks.map((task) => task.toSessionId).sort()).toEqual([a, b].sort())
  })

  it('员工带广播任务页脚里的 taskId 汇报 → 投给主管，不生成新任务', async () => {
    const supervisor = await registerRosterWorker({ role: '主管', supervisor: true })
    const worker = await registerRosterWorker({ role: '后端' })
    deliverMock.mockClear()
    const broadcast = await postMsg({ broadcast: true, fromSessionId: supervisor, content: '做功能' })
    const broadcastBody = (await broadcast.json()) as {
      targets: Array<{ sessionId: string; taskId?: string }>
    }
    const taskId = broadcastBody.targets.find((t) => t.sessionId === worker)?.taskId
    expect(typeof taskId).toBe('string')

    const { collabTaskService } = await import('../services/collabTaskService.js')
    const before = (await collabTaskService.listTasks({})).length
    deliverMock.mockClear()

    // 员工按页脚汇报：目标写主管（页脚里的回邮目标），taskId 用广播那条
    const resp = await postMsg({
      targetSessionId: supervisor,
      fromSessionId: worker,
      taskId: taskId!,
      content: '【汇报】做完了',
    })
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.redirectedFrom).toBeUndefined() // 第 ① 步直接命中，无歧义
    expect(deliverMock.mock.calls[0][0]).toBe(supervisor)
    expect((await collabTaskService.listTasks({})).length).toBe(before) // 汇报不新建任务
  })

  it('should broadcast to enabled servants in the project, skipping disabled and sender', async () => {
    const mod = await import('../api/servants.js')
    const handleServantsApi = mod.handleServantsApi
    const service = new ServantService()
    const supervisor = await sessionService.createSession(tmpDir)
    const workerA = await sessionService.createSession(tmpDir)
    const workerB = await sessionService.createSession(tmpDir)
    const workerOff = await sessionService.createSession(tmpDir)
    await service.setServant(supervisor.sessionId, { enabled: true, supervisor: true })
    await service.setServant(workerA.sessionId, { role: '前端', enabled: true })
    await service.setServant(workerB.sessionId, { role: '测试', enabled: true })
    await service.setServant(workerOff.sessionId, { enabled: false })

    const res = await handleSessionMessagesApi(
      new Request('http://localhost/api/session-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          broadcast: true,
          content: '停工待命',
          fromSessionId: supervisor.sessionId,
        }),
      }),
      new URL('http://localhost/api/session-messages'),
      ['api', 'session-messages'],
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.delivered).toBe(2)
    const targets = deliverMock.mock.calls.map((call) => call[0])
    expect(targets).toContain(workerA.sessionId)
    expect(targets).toContain(workerB.sessionId)
    expect(targets).not.toContain(workerOff.sessionId)
    expect(targets).not.toContain(supervisor.sessionId)
  })

  it('should 404 a broadcast when no enabled servants exist', async () => {
    // B2（v1.7.0 广播同项目守卫）：发送方须为可解析 workDir 的真实落盘会话，
    // 否则新守卫会在走到「无 enabled 员工」判定之前就返回 409。用 registerRealSender
    // 建真实会话后，仍无任何在册员工 → 期望值保持 404 不变。
    const sender = await registerRealSender()
    const res = await handleSessionMessagesApi(
      new Request('http://localhost/api/session-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          broadcast: true,
          content: '停工',
          fromSessionId: sender,
        }),
      }),
      new URL('http://localhost/api/session-messages'),
      ['api', 'session-messages'],
    )
    expect(res.status).toBe(404)
  })

  it('should block cross-project dispatch to a servant', async () => {
    // mock 的 deliver 返回 true；跨项目检查在 deliver 之前
    const { sessionService: realSessionService } = await import(
      '../services/sessionService.js'
    )
    const workerDir = path.join(tmpDir, 'worker')
    const bossDir = path.join(tmpDir, 'boss')
    await fs.mkdir(workerDir, { recursive: true })
    await fs.mkdir(bossDir, { recursive: true })
    const worker = await realSessionService.createSession(workerDir)
    const boss = await realSessionService.createSession(bossDir)
    // 阶段3（6a）：exists 短路要求投递目标已登记（同 registerRosterWorker 前置）
    registerSession(worker.sessionId)
    const { ServantService } = await import('../services/servantService.js')
    await new ServantService().setServant(worker.sessionId, {
      role: '后端',
      enabled: true,
    })

    const req = new Request('http://localhost/api/session-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetSessionId: worker.sessionId,
        content: '任务',
        fromSessionId: boss.sessionId,
      }),
    })
    const resp = await handleSessionMessagesApi(req, new URL(req.url), [
      'api',
      'session-messages',
    ])
    expect(resp.status).toBe(409)
    expect(deliverMock).not.toHaveBeenCalled()
  })

  it('B2：派活方带了 fromSessionId 但 workDir 解析不出 → 409（不再静默跳过拦截）', async () => {
    // v1.7.0 边界漏洞：旧 guard `fromWorkDir && targetWorkDir && …` 会让「带 id
    // 但查不到 workDir」的发送方整段跳过检查。裁决：与其他跨项目场景一致，拒绝。
    const { sessionService: realSessionService } = await import(
      '../services/sessionService.js'
    )
    const worker = await realSessionService.createSession(tmpDir)
    registerSession(worker.sessionId)
    const { ServantService } = await import('../services/servantService.js')
    await new ServantService().setServant(worker.sessionId, {
      role: '后端',
      enabled: true,
    })

    const spy = spyOn(sessionService, 'getSessionWorkDir').mockImplementation(async (id) =>
      id === worker.sessionId ? tmpDir : null,
    )
    try {
      const req = new Request('http://localhost/api/session-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetSessionId: worker.sessionId,
          content: '任务',
          fromSessionId: 'ghost-session-without-workdir',
        }),
      })
      const resp = await handleSessionMessagesApi(req, new URL(req.url), [
        'api',
        'session-messages',
      ])
      expect(resp.status).toBe(409)
      const body = (await resp.json()) as { message: string }
      expect(body.message).toContain('could not be resolved')
      expect(deliverMock).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('B2：完全没带 fromSessionId 的调用方维持现状（不被新拦截误伤）', async () => {
    const { sessionService: realSessionService } = await import(
      '../services/sessionService.js'
    )
    const worker = await realSessionService.createSession(tmpDir)
    registerSession(worker.sessionId)
    const { ServantService } = await import('../services/servantService.js')
    await new ServantService().setServant(worker.sessionId, {
      role: '后端',
      enabled: true,
    })

    const req = new Request('http://localhost/api/session-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetSessionId: worker.sessionId,
        content: '任务',
        // 无 fromSessionId：用户/脚本本机信任域路径，不进跨项目分支
      }),
    })
    const resp = await handleSessionMessagesApi(req, new URL(req.url), [
      'api',
      'session-messages',
    ])
    expect(resp.status).toBe(201)
    expect(deliverMock).toHaveBeenCalledTimes(1)
  })

  it('should treat case/slash variants of one directory as the same project（归一后不再误拒）', async () => {
    // 架构裁决四：派活侧原先是原始串比较，同一目录写成 `D:\X` 与 `d:/x` 会被
    // 误判成跨项目而拒绝。这里把派活方的 workDir 注入成同一个目录的另一种写法，
    // 派活必须成功——归一化只收紧不了隔离，也**不该**误伤同项目。
    const { sessionService: realSessionService } = await import(
      '../services/sessionService.js'
    )
    const worker = await realSessionService.createSession(tmpDir)
    const boss = await realSessionService.createSession(tmpDir)
    registerSession(worker.sessionId)
    const { ServantService } = await import('../services/servantService.js')
    await new ServantService().setServant(worker.sessionId, {
      role: '后端',
      enabled: true,
    })

    const variant = `${tmpDir.toUpperCase().replace(/\//g, '\\')}\\`
    const spy = spyOn(sessionService, 'getSessionWorkDir').mockImplementation(async (id) =>
      id === worker.sessionId ? tmpDir : variant,
    )
    try {
      const req = new Request('http://localhost/api/session-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetSessionId: worker.sessionId,
          content: '任务',
          fromSessionId: boss.sessionId,
        }),
      })
      const resp = await handleSessionMessagesApi(req, new URL(req.url), [
        'api',
        'session-messages',
      ])
      expect(resp.status).toBe(201)
      expect(deliverMock).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('should allow same-project dispatch to a servant', async () => {
    const { sessionService: realSessionService } = await import(
      '../services/sessionService.js'
    )
    const worker = await realSessionService.createSession(tmpDir)
    const boss = await realSessionService.createSession(tmpDir)
    // 阶段3（6a）：exists 短路要求投递目标已登记（同 registerRosterWorker 前置）
    registerSession(worker.sessionId)
    const { ServantService } = await import('../services/servantService.js')
    await new ServantService().setServant(worker.sessionId, {
      role: '后端',
      enabled: true,
    })

    const req = new Request('http://localhost/api/session-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetSessionId: worker.sessionId,
        content: '任务',
        fromSessionId: boss.sessionId,
      }),
    })
    const resp = await handleSessionMessagesApi(req, new URL(req.url), [
      'api',
      'session-messages',
    ])
    expect(resp.status).toBe(201)
    expect(deliverMock).toHaveBeenCalledTimes(1)
  })

  // ─── 生命周期：不在册目标的可行动 404 与主管放行 ─────────────────────────

  async function postMessage(targetSessionId: string, fromSessionId = 'boss-1'): Promise<Response> {
    const req = new Request('http://localhost/api/session-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSessionId, content: '任务', fromSessionId }),
    })
    return handleSessionMessagesApi(req, new URL(req.url), [
      'api',
      'session-messages',
    ])
  }

  it('should 404 with actionable text when the target is not on the roster', async () => {
    const resp = await postMessage('never-registered')
    expect(resp.status).toBe(404)
    const body = (await resp.json()) as { error?: { message?: string } | string }
    const text = JSON.stringify(body)
    expect(text).toContain('not on the roster')
    expect(text).toContain('reassign')
    // 不投递（避免"看起来成功了"的误导）
    expect(deliverMock).not.toHaveBeenCalled()
  })

  it('should 404 after the target has been removed from the roster', async () => {
    const worker = await registerRosterWorker()
    const { ServantService } = await import('../services/servantService.js')
    await new ServantService().removeServant(worker)

    const resp = await postMessage(worker)
    expect(resp.status).toBe(404)
    expect(deliverMock).not.toHaveBeenCalled()
  })

  it('should still deliver worker-to-supervisor reports (supervisor is on the roster)', async () => {
    const supervisor = await registerRosterWorker({ supervisor: true })
    const worker = await registerRealSender()
    const resp = await postMessage(supervisor, worker)
    expect(resp.status).toBe(201)
    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe(supervisor)
  })

  it('should still deliver to a disabled (but still registered) worker', async () => {
    const worker = await registerRosterWorker({ enabled: false })
    const resp = await postMessage(worker)
    expect(resp.status).toBe(201)
    expect(deliverMock).toHaveBeenCalledTimes(1)
  })
})

// ─── SessionMessenger validation tests ─────────────────────────────────────

describe('SessionMessenger validation', () => {
  // v1.7.2 P0-a：deliver 入口新增 serverHost 校验（host:port + 端口 1..65535）。
  // 本组用例传**合法** host，才能走到它们真正要守护的校验（空 target/content、未知会话）；
  // 断言与期望错误一字未改——只让校验顺序变化不再遮蔽原语义。
  it('should reject empty target and content', async () => {
    const messenger = new SessionMessenger()
    await expect(messenger.deliver(' ', 'hi', '127.0.0.1:53100')).rejects.toThrow(
      'targetSessionId',
    )
    await expect(messenger.deliver('s', ' ', '127.0.0.1:53100')).rejects.toThrow('content')
  })

  it('should throw not-found for an unknown session', async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    try {
      const messenger = new SessionMessenger()
      await expect(
        messenger.deliver('no-such-session', 'hi', '127.0.0.1:53100'),
      ).rejects.toThrow('Session not found')
    } finally {
      restoreConfigDir()
      await cleanupTmpDir(tmpDir)
    }
  })
})
