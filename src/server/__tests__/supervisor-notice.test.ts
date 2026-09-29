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

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

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
    const deliverMock = mock(async () => true)
    setSupervisorNoticeDeps({
      listServants: async () =>
        [
          { sessionId: 'sup-1', supervisor: true, enabled: true },
          { sessionId: 'emp-1', supervisor: false, enabled: true },
        ] as never,
      deliver: deliverMock as never,
    })

    await notifySupervisorsOfProtocolUpdate()

    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe('sup-1')
    expect(deliverMock.mock.calls[0][1]).toContain('硬规则')
    expect(deliverMock.mock.calls[0][1]).toContain('结构性收权')

    // marker 已写入 → 第二次调用（模拟重启）不再投递
    await notifySupervisorsOfProtocolUpdate()
    expect(deliverMock).toHaveBeenCalledTimes(1)
  })

  test('writes the marker even when no supervisors exist (no repeated roster scans)', async () => {
    setSupervisorNoticeDeps({
      listServants: async () => [] as never,
    })

    await notifySupervisorsOfProtocolUpdate()

    const marker = path.join(tmpDir, 'cc-heihei', 'supervisor-protocol-notice-v1.sent')
    await expect(fs.access(marker)).resolves.toBeDefined()
  })
})
