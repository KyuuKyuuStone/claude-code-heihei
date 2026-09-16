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

  // —— 周期兜底扫描（三类静默失效的最后防线）——

  /** PROCESS_DELAY_MS(200) debounce 之后的确定性结算窗口 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

  function enabledWorkerList(workDir: string) {
    return [
      {
        sessionId: 'worker-1',
        enabled: true,
        workDir,
        updatedAt: 1,
        title: 'w1',
      },
    ]
  }

  test('periodic rescan rebuilds a dead watcher and consumes pending files', async () => {
    const { service, calls } = buildService({
      listServants: async () => enabledWorkerList(tmpDir),
    })
    service.start(0)
    await service.sync()
    // 模拟 watcher 事后失效：关闭并清空（等价于 watcher 从未建立/已被系统回收）
    const internal = service as unknown as { watchers: Map<string, { close(): void }> }
    for (const w of internal.watchers.values()) w.close()
    internal.watchers.clear()

    await writePayload('report-20.json', {
      targetSessionId: 'session-a',
      content: '【汇报】兜底投递',
    })
    const result = await (service as unknown as { rescanAll(): Promise<void> }).rescanAll()
    expect(result).toBeUndefined()
    await settle()

    expect(calls).toHaveLength(1)
    expect(calls[0].targetSessionId).toBe('session-a')
    expect(await pathExists(mailboxPath('report-20.json'))).toBe(false)
    service.stop()
  })

  test('periodic rescan recovers after an initial sync failure', async () => {
    let listFails = true
    const { service, calls } = buildService({
      listServants: async () => {
        if (listFails) throw new Error('roster unreadable')
        return enabledWorkerList(tmpDir)
      },
    })
    service.start(0)
    await service.sync()
    // start 时 sync 失败：没有任何 watcher 建立
    expect((service as unknown as { watchers: Map<string, unknown> }).watchers.size).toBe(0)

    await writePayload('dispatch-21.json', {
      targetSessionId: 'session-a',
      content: '【上级派活】延迟恢复',
    })
    // 第一轮周期任务：吞掉 sync 失败不抛错；故障恢复后第二轮重建并消费
    await (service as unknown as { rescanAll(): Promise<void> }).rescanAll()
    listFails = false
    await (service as unknown as { rescanAll(): Promise<void> }).rescanAll()
    await settle()

    expect(calls).toHaveLength(1)
    expect(await pathExists(mailboxPath('dispatch-21.json'))).toBe(false)
    service.stop()
  })

  test('scanExisting is idempotent: repeated scans deliver exactly once', async () => {
    const { service, calls } = buildService({
      listServants: async () => enabledWorkerList(tmpDir),
    })
    service.start(0)
    await service.sync()

    await writePayload('report-22.json', {
      targetSessionId: 'session-a',
      content: '【汇报】幂等',
    })
    const dir = path.join(tmpDir, COLLAB_MAILBOX_DIR)
    const scan = (service as unknown as { scanExisting(d: string): Promise<void> }).scanExisting.bind(service)
    // watcher 事件 + 三次手动补扫同时到达：debounce/inFlight 必须合并为一次投递
    await scan(dir)
    await scan(dir)
    await scan(dir)
    await settle()

    expect(calls).toHaveLength(1)
    expect(await pathExists(path.join(dir, 'report-22.json'))).toBe(false)
    // 文件已消费后再扫：readdir 看不到，不产生新投递
    await scan(dir)
    await settle()
    expect(calls).toHaveLength(1)
    service.stop()
  })

  test('periodic rescan timer lifecycle: created on start, cleared on stop', async () => {
    const { service } = buildService()
    service.start(0)
    const withTimer = service as unknown as { rescanTimer: unknown }
    expect(withTimer.rescanTimer).not.toBeNull()
    service.stop()
    expect(withTimer.rescanTimer).toBeNull()
  })
})
