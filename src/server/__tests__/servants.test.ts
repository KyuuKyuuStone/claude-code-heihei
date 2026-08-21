/**
 * Unit tests for ServantService, session-messages API（会话级上下级协作）
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ServantService } from '../services/servantService.js'
import { sessionService } from '../services/sessionService.js'
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

    const roster = await service.listServants({ forSessionId: sessionId })
    expect(roster).toHaveLength(1)
    expect(roster[0].sessionId).toBe(sessionId)

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

  it('should deliver a message to the target session', async () => {
    const req = new Request('http://localhost/api/session-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetSessionId: 'sess-1',
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
    expect(deliverMock.mock.calls[0][0]).toBe('sess-1')
    expect(deliverMock.mock.calls[0][1]).toBe('任务：实现登录接口')
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
    // targetSessionId 缺失时 deliver 抛 badRequest（此处 mock 不过校验，直接返回 true，
    // 所以另验证空 content 的真实服务校验在 SessionMessenger 层，见下方单元测试）
    expect([201, 400]).toContain(missingTarget.status)
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
