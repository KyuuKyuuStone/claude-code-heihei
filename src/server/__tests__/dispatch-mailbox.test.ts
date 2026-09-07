import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  DispatchMailboxService,
  isDispatchPayloadName,
} from '../services/dispatchMailboxService.js'
import { COLLAB_MAILBOX_DIR } from '../../collaboration/dispatchProtocol.js'

describe('DispatchMailboxService', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-mailbox-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function mailboxPath(name: string): string {
    return path.join(tmpDir, COLLAB_MAILBOX_DIR, name)
  }

  async function writePayload(name: string, payload: unknown): Promise<string> {
    const filePath = mailboxPath(name)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(payload), 'utf-8')
    return filePath
  }

  function buildService(overrides: Partial<DispatchMailboxService['deps']> = {}) {
    const calls: Array<{ targetSessionId: string; content: string; host: string }> = []
    const service = new DispatchMailboxService({
      deliver: async (targetSessionId, content, host) => {
        calls.push({ targetSessionId, content, host })
        return true
      },
      getServant: async () => null,
      getSessionWorkDir: async () => null,
      listServants: async () => [],
      ...overrides,
    })
    return { service, calls }
  }

  async function pathExists(target: string): Promise<boolean> {
    try {
      await fs.access(target)
      return true
    } catch {
      return false
    }
  }

  test('isDispatchPayloadName accepts payload files and rejects artifacts', () => {
    expect(isDispatchPayloadName('dispatch-1.json')).toBe(true)
    expect(isDispatchPayloadName('report-2.json')).toBe(true)
    expect(isDispatchPayloadName('.hidden.json')).toBe(false)
    expect(isDispatchPayloadName('dispatch-1.json.failed')).toBe(false)
    expect(isDispatchPayloadName('dispatch-1.json.error.txt')).toBe(false)
    expect(isDispatchPayloadName('notes.txt')).toBe(false)
  })

  test('delivers a valid payload and deletes the file', async () => {
    const filePath = await writePayload('report-1.json', {
      targetSessionId: 'session-a',
      content: '【汇报】完成',
      fromSessionId: 'session-b',
    })
    const { service, calls } = buildService()

    const result = await service.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'report-1.json')

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].targetSessionId).toBe('session-a')
    expect(calls[0].content).toBe('【汇报】完成')
    expect(calls[0].host).toBe('127.0.0.1:0')
    expect(await pathExists(filePath)).toBe(false)
  })

  test('rejects invalid payloads with a .failed rename and an .error.txt explanation', async () => {
    const dir = path.join(tmpDir, COLLAB_MAILBOX_DIR)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'dispatch-1.json'), '{ not json', 'utf-8')
    const { service, calls } = buildService()

    const result = await service.handleMailboxFile(dir, 'dispatch-1.json')

    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(await pathExists(path.join(dir, 'dispatch-1.json.failed'))).toBe(true)
    const errorText = await fs.readFile(path.join(dir, 'dispatch-1.json.error.txt'), 'utf-8')
    expect(errorText).toContain('Invalid payload')
  })

  test('rejects payloads with a missing targetSessionId', async () => {
    const dir = path.join(tmpDir, COLLAB_MAILBOX_DIR)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'dispatch-2.json'), JSON.stringify({ content: 'hi' }), 'utf-8')
    const { service, calls } = buildService()

    const result = await service.handleMailboxFile(dir, 'dispatch-2.json')

    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(await pathExists(path.join(dir, 'dispatch-2.json.failed'))).toBe(true)
  })

  test('blocks cross-project dispatch: enabled servant in another project', async () => {
    await writePayload('dispatch-3.json', {
      targetSessionId: 'worker-elsewhere',
      content: '【上级派活】跨项目',
      fromSessionId: 'session-b',
    })
    const { service, calls } = buildService({
      getServant: async (id) => (id === 'worker-elsewhere' ? { enabled: true } : null),
      getSessionWorkDir: async () => path.join(tmpDir, 'other-project'),
    })

    const result = await service.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'dispatch-3.json')

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toContain('Cross-project dispatch is not allowed')
    expect(calls).toHaveLength(0)
    expect(await pathExists(path.join(tmpDir, COLLAB_MAILBOX_DIR, 'dispatch-3.json.error.txt'))).toBe(true)
  })

  test('allows dispatch to an enabled servant in the same project', async () => {
    await writePayload('dispatch-4.json', {
      targetSessionId: 'worker-here',
      content: '【上级派活】同项目',
      fromSessionId: 'session-b',
    })
    const { service, calls } = buildService({
      getServant: async (id) => (id === 'worker-here' ? { enabled: true } : null),
      getSessionWorkDir: async () => tmpDir,
    })

    const result = await service.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'dispatch-4.json')

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
  })

  test('marks delivery failure when the messenger cannot deliver', async () => {
    await writePayload('dispatch-5.json', {
      targetSessionId: 'session-a',
      content: '【上级派活】交付失败',
    })
    const failing = new DispatchMailboxService({
      deliver: async () => false,
      getServant: async () => null,
      getSessionWorkDir: async () => null,
      listServants: async () => [],
    })

    const result = await failing.handleMailboxFile(path.join(tmpDir, COLLAB_MAILBOX_DIR), 'dispatch-5.json')

    expect(result.ok).toBe(false)
    const errorText = await fs.readFile(
      path.join(tmpDir, COLLAB_MAILBOX_DIR, 'dispatch-5.json.error.txt'),
      'utf-8',
    )
    expect(errorText).toContain('could not be delivered')
  })

  test('sync watches only projects with enabled servants and closes removed ones', async () => {
    const otherProject = path.join(tmpDir, 'project-b')
    await fs.mkdir(otherProject, { recursive: true })
    const { service } = buildService({
      listServants: async () => [
        {
          sessionId: 'worker-1',
          enabled: true,
          workDir: tmpDir,
          updatedAt: 1,
          title: 'w1',
        },
        {
          sessionId: 'worker-2',
          enabled: false,
          workDir: otherProject,
          updatedAt: 2,
          title: 'w2',
        },
      ],
    })

    service.start(0)
    await service.sync()
    // 只有 enabled 员工的项目被监听
    expect((service as unknown as { watchers: Map<string, unknown> }).watchers.size).toBe(1)
    expect(await pathExists(path.join(tmpDir, COLLAB_MAILBOX_DIR))).toBe(true)
    // 未启用员工的项目不会创建信箱目录
    expect(await pathExists(path.join(otherProject, COLLAB_MAILBOX_DIR))).toBe(false)

    service.stop()
    expect((service as unknown as { watchers: Map<string, unknown> }).watchers.size).toBe(0)
  })
})
