import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as realServantService from '../services/servantService.js'
import * as realSessionMessenger from '../services/sessionMessenger.js'
import * as realProviderService from '../services/providerService.js'

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-notice-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  else delete process.env.CLAUDE_CONFIG_DIR
  mock.restore()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('notifySupervisorsOfProtocolUpdate', () => {
  test('delivers once to registered supervisors and is idempotent across restarts', async () => {
    const deliverMock = mock(async () => true)
    mock.module('../services/servantService.js', () => ({
      servantService: {
        listServants: async () => [
          { sessionId: 'sup-1', supervisor: true, enabled: true },
          { sessionId: 'emp-1', supervisor: false, enabled: true },
        ],
      },
    }))
    mock.module('../services/sessionMessenger.js', () => ({
      sessionMessenger: { deliver: deliverMock },
    }))

    const { notifySupervisorsOfProtocolUpdate } = await import('../services/supervisorProtocolNotice.js')
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
    mock.module('../services/servantService.js', () => ({
      servantService: { listServants: async () => [] },
    }))
    mock.module('../services/sessionMessenger.js', () => ({
      sessionMessenger: { deliver: async () => true },
    }))

    const { notifySupervisorsOfProtocolUpdate } = await import('../services/supervisorProtocolNotice.js')
    await notifySupervisorsOfProtocolUpdate()

    const marker = path.join(tmpDir, 'cc-heihei', 'supervisor-protocol-notice-v1.sent')
    await expect(fs.access(marker)).resolves.toBeDefined()
  })
})

afterAll(async () => {
  mock.module('../services/servantService.js', () => realServantService)
  mock.module('../services/sessionMessenger.js', () => realSessionMessenger)
  mock.module('../services/providerService.js', () => realProviderService)
})
