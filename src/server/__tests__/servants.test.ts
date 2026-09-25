/**
 * Unit tests for ServantService, session-messages API（会话级上下级协作）
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ServantService } from '../services/servantService.js'
import { sessionService } from '../services/sessionService.js'
import {
  observeSessionSdkMessage,
  resetDispatchReceipts,
} from '../services/dispatchReceiptService.js'
// 静态引入：在任何 mock.module 之前绑定真实模块
import { SessionMessenger } from '../services/sessionMessenger.js'

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

    // 回合开始（assistant 信号）→ true
    observeSessionSdkMessage(sessionId, 'assistant')
    let servants = await service.listServants()
    expect(servants[0].turnInProgress).toBe(true)

    // 回合边界（result）→ 立刻 false，状态灯不等滑动窗口过期
    observeSessionSdkMessage(sessionId, 'result')
    servants = await service.listServants()
    expect(servants[0].turnInProgress).toBe(false)
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

  it('should drop servants whose session was deleted', async () => {
    await service.setServant(sessionId, { role: '前端', enabled: true })
    await sessionService.deleteSession(sessionId)

    expect(await service.listServants()).toEqual([])
    expect(await service.getServant(sessionId)).toBeNull()
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
    // 删除会话 → listServants 的自动清理路径（第二个静默移除点）
    await sessionService.deleteSession(sessionId)
    expect(await service.listServants()).toEqual([])

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
    mock.module('../services/sessionMessenger.js', () => ({
      sessionMessenger: { deliver: deliverMock },
    }))
    const mod = await import('../api/servants.js')
    handleServantsApi = mod.handleServantsApi
    const created = await sessionService.createSession(tmpDir)
    sessionId = created.sessionId
  })

  afterEach(async () => {
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
    expect(deliverMock.mock.calls[0][1]).toContain('computer-use')

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
    mock.module('../services/sessionMessenger.js', () => ({
      sessionMessenger: { deliver: deliverMock },
    }))

    const mod = await import('../api/servants.js')
    handleSessionMessagesApi = mod.handleSessionMessagesApi
  })

  afterEach(async () => {
    mock.restore()
    restoreConfigDir()
    await cleanupTmpDir(tmpDir)
  })

  /** 登记一个真实会话为在册员工，返回 sessionId（404 语义下投递目标必须在册） */
  async function registerRosterWorker(
    input: { role?: string; enabled?: boolean; supervisor?: boolean } = {},
  ): Promise<string> {
    const worker = await sessionService.createSession(tmpDir)
    const { ServantService } = await import('../services/servantService.js')
    await new ServantService().setServant(worker.sessionId, {
      role: input.role ?? '测试员工',
      enabled: input.enabled ?? true,
      ...(input.supervisor !== undefined ? { supervisor: input.supervisor } : {}),
    })
    return worker.sessionId
  }

  it('should deliver a message to the target session', async () => {
    const target = await registerRosterWorker()
    const req = new Request('http://localhost/api/session-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetSessionId: target,
        content: '任务：实现登录接口',
        fromSessionId: 'boss-1',
      }),
    })
    const resp = await handleSessionMessagesApi(req, new URL(req.url), [
      'api',
      'session-messages',
    ])
    expect(resp.status).toBe(201)
    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe(target)
    expect(deliverMock.mock.calls[0][1]).toBe('任务：实现登录接口')
  })

  it('recovers GBK-encoded Chinese from legacy inline curl bodies', async () => {
    // Windows 控制台的 curl -d 内联中文按 GBK 编码发出（实战复盘 BUG-1）：
    // 服务端严格 UTF-8 解码失败时回退 GBK 解码。"测试" 的 GBK 字节 = B2 E2 CA D4
    const target = await registerRosterWorker()
    const body = Buffer.concat([
      Buffer.from(`{"targetSessionId":"${target}","content":"`, 'utf8'),
      Buffer.from([0xB2, 0xE2, 0xCA, 0xD4]),
      Buffer.from('","fromSessionId":"emp-1"}', 'utf8'),
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
    expect(deliverMock.mock.calls[0][1]).toBe('测试')
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
    const res = await handleSessionMessagesApi(
      new Request('http://localhost/api/session-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          broadcast: true,
          content: '停工',
          fromSessionId: 'someone',
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

  it('should allow same-project dispatch to a servant', async () => {
    const { sessionService: realSessionService } = await import(
      '../services/sessionService.js'
    )
    const worker = await realSessionService.createSession(tmpDir)
    const boss = await realSessionService.createSession(tmpDir)
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
    const resp = await postMessage(supervisor, 'some-worker')
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
  it('should reject empty target and content', async () => {
    const messenger = new SessionMessenger()
    await expect(messenger.deliver(' ', 'hi', 'h')).rejects.toThrow(
      'targetSessionId',
    )
    await expect(messenger.deliver('s', ' ', 'h')).rejects.toThrow('content')
  })

  it('should throw not-found for an unknown session', async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    try {
      const messenger = new SessionMessenger()
      await expect(
        messenger.deliver('no-such-session', 'hi', '127.0.0.1'),
      ).rejects.toThrow('Session not found')
    } finally {
      restoreConfigDir()
      await cleanupTmpDir(tmpDir)
    }
  })
})
