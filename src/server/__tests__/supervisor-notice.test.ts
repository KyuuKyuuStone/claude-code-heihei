import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  notifySupervisorsOfProtocolUpdate,
  setSupervisorNoticeDeps,
} from '../services/supervisorProtocolNotice.js'

// v1.3.0 阶段4：本文件原用 mock.module 替换 servantService/sessionMessenger
// 模块——bun 的 mock.module 写全局注册表且跨文件残留（mock.restore 不还原），
// 全量套件互污染（stage3-tombstone 3 fail 根因之一）。改 deps 注入缝，
// afterEach 复原，与批次6「禁 mock.module，用 DI 注入缝」纪律一致。
//
// v1.7.2 P0-a（裁决二十①②）：①只对**正在运行**的主管投递（不再代为拉起）；
// ②投递地址取真实端口。故本文件的主管桩必须显式带 `running`。

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

/** 组装一整套 deps：默认端口 53100、诊断事件收集到数组，便于逐条断言。 */
function makeDeps(overrides: Record<string, unknown> = {}) {
  const events: Array<Record<string, unknown>> = []
  return {
    events,
    deps: {
      getServerPort: () => 53100,
      recordEvent: (input: Record<string, unknown>) => {
        events.push(input)
      },
      ...overrides,
    },
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-notice-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  setSupervisorNoticeDeps(null)
  if (originalConfigDir) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  else delete process.env.CLAUDE_CONFIG_DIR
  mock.restore()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('notifySupervisorsOfProtocolUpdate', () => {
  test('delivers once to registered supervisors and is idempotent across restarts', async () => {
    const deliverMock = mock(async (_target: string, _content: string, _host: string) => true)
    const { deps } = makeDeps({
      listServants: async () =>
        [
          { sessionId: 'sup-1', supervisor: true, enabled: true, running: true },
          { sessionId: 'emp-1', supervisor: false, enabled: true, running: true },
        ] as never,
      deliver: deliverMock as never,
    })
    setSupervisorNoticeDeps(deps as never)

    await notifySupervisorsOfProtocolUpdate()

    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe('sup-1')
    expect(deliverMock.mock.calls[0][1]).toContain('硬规则')
    expect(deliverMock.mock.calls[0][1]).toContain('结构性收权')
    // 裁决二十②：投递地址必须是**真实端口**，不得再出现端口 0 的假值
    expect(deliverMock.mock.calls[0][2]).toBe('127.0.0.1:53100')

    // marker 已写入 → 第二次调用（模拟重启）不再投递
    await notifySupervisorsOfProtocolUpdate()
    expect(deliverMock).toHaveBeenCalledTimes(1)
  })

  test('writes the marker even when no supervisors exist (no repeated roster scans)', async () => {
    const { deps } = makeDeps({ listServants: async () => [] as never })
    setSupervisorNoticeDeps(deps as never)

    await notifySupervisorsOfProtocolUpdate()

    const marker = path.join(tmpDir, 'cc-heihei', 'supervisor-protocol-notice-v1.sent')
    await expect(fs.access(marker)).resolves.toBeDefined()
  })

  // ── v1.7.2 P0-a 判据 1：删 marker + 预置未运行主管 → 无 CLI 拉起 + 跳过事件 + marker 正常写入
  test('判据1：未运行的主管**不被拉起**，只记跳过诊断，marker 照常写入', async () => {
    const deliverMock = mock(async (_target: string, _content: string, _host: string) => true)
    const { deps, events } = makeDeps({
      listServants: async () =>
        [{ sessionId: 'sup-idle', supervisor: true, enabled: true, running: false }] as never,
      deliver: deliverMock as never,
    })
    setSupervisorNoticeDeps(deps as never)

    await notifySupervisorsOfProtocolUpdate()

    // 关键：deliver 一次都不能调用（否则就会 startSession → 僵尸会话）
    expect(deliverMock).not.toHaveBeenCalled()

    const skipped = events.filter((e) => e.type === 'supervisor_protocol_notice_skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.sessionId).toBe('sup-idle')
    expect((skipped[0]!.details as { reason?: string }).reason).toBe('not-running')

    const marker = path.join(tmpDir, 'cc-heihei', 'supervisor-protocol-notice-v1.sent')
    await expect(fs.access(marker)).resolves.toBeDefined()
  })

  test('判据1（混排）：只投运行中的主管，未运行者跳过且各自记事件', async () => {
    const deliverMock = mock(async (_target: string, _content: string, _host: string) => true)
    const { deps, events } = makeDeps({
      listServants: async () =>
        [
          { sessionId: 'sup-running', supervisor: true, enabled: true, running: true },
          { sessionId: 'sup-idle', supervisor: true, enabled: true, running: false },
        ] as never,
      deliver: deliverMock as never,
    })
    setSupervisorNoticeDeps(deps as never)

    await notifySupervisorsOfProtocolUpdate()

    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe('sup-running')
    expect(events.filter((e) => e.type === 'supervisor_protocol_notice_skipped')).toHaveLength(1)
  })

  // ── v1.7.2 P0-a 判据 4：marker 存在 → early return，行为逐字不变
  test('判据4：marker 已存在时 early return —— 不投递、不记事件、不读花名册', async () => {
    const marker = path.join(tmpDir, 'cc-heihei', 'supervisor-protocol-notice-v1.sent')
    await fs.mkdir(path.dirname(marker), { recursive: true })
    await fs.writeFile(marker, 'already-sent', 'utf-8')

    const deliverMock = mock(async (_target: string, _content: string, _host: string) => true)
    const listMock = mock(async () => [] as never)
    const { deps, events } = makeDeps({ listServants: listMock as never, deliver: deliverMock as never })
    setSupervisorNoticeDeps(deps as never)

    await notifySupervisorsOfProtocolUpdate()

    expect(deliverMock).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)
    expect(listMock).not.toHaveBeenCalled()
    // marker 内容不被改写
    expect(await fs.readFile(marker, 'utf-8')).toBe('already-sent')
  })
})
