import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConversationService } from '../services/conversationService.js'
import { getSessionSnapshot, resetRegistryForTests } from '../services/sessionRegistry.js'

/**
 * v1.7.2 裁决二十一④ 集成用例：**「SDK connected」是拉起成功的必要条件**。
 *
 * 夹具 mock-sdk-idle-cli 起得来但**永不连 SDK**（真实缺陷形态：CLI 拨了不可达/端口 0 的地址）。
 * 子预算经 CC_HEIHEI_SDK_CONFIRM_BUDGET_MS 覆写，避免真等 30s（产品默认仍 30s）。
 *
 * 覆盖：a) 超时未连 → cli_start_unconfirmed(warn) + phase 保持 starting
 *       b) 迟到 attach → markRunning + 成功日志（超时不是终局）
 *       c) deliver 不被确认阻塞（startSession 远早于子预算返回）
 */

const DIAG_REL = path.join('cc-heihei', 'diagnostics', 'diagnostics.jsonl')

describe('ConversationService SDK 连接确认（裁决二十一④）', () => {
  let service: ConversationService
  let tmpDir: string
  const originalEnv = new Map<string, string | undefined>()
  const envKeys = [
    'CLAUDE_CLI_PATH',
    'CLAUDE_CONFIG_DIR',
    'CC_HEIHEI_DISABLE_TERMINAL_SHELL_ENV',
    'CC_HEIHEI_SDK_CONFIRM_BUDGET_MS',
    'MOCK_SDK_IDLE_HOLD_MS',
  ]

  beforeEach(async () => {
    service = new ConversationService()
    resetRegistryForTests()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-sdk-confirm-'))
    for (const key of envKeys) originalEnv.set(key, process.env[key])

    process.env.CLAUDE_CLI_PATH = fileURLToPath(
      new URL('./fixtures/mock-sdk-idle-cli.ts', import.meta.url),
    )
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HEIHEI_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.MOCK_SDK_IDLE_HOLD_MS = '60000'
    delete process.env.CC_HEIHEI_SDK_CONFIRM_BUDGET_MS
  })

  afterEach(async () => {
    await service.stopAllSessionsAndWait(1_500)
    for (const key of envKeys) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    originalEnv.clear()
    resetRegistryForTests()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function readDiagnostics(): Promise<Array<Record<string, unknown>>> {
    try {
      const raw = await fs.readFile(path.join(tmpDir, DIAG_REL), 'utf-8')
      return raw
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    } catch {
      return []
    }
  }

  /** 起一个「进程活着但永不连 SDK」的会话；startSession 走完 3s 竞速后返回。 */
  async function startIdleSession(sessionId: string): Promise<void> {
    await service.startSession(
      sessionId,
      tmpDir,
      `ws://127.0.0.1:1/sdk/${sessionId}?token=test-token`,
    )
  }

  test('a) 超时未连 → 记 cli_start_unconfirmed(warn)，phase 保持 starting（不 markRunning、不打成功）', async () => {
    process.env.CC_HEIHEI_SDK_CONFIRM_BUDGET_MS = '150'
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const sid = `sdk-confirm-a-${crypto.randomUUID()}`
      await startIdleSession(sid)

      // 竞速先返回：此刻**不得**宣称成功/转 running
      expect(getSessionSnapshot(sid)?.phase).toBe('starting')
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('CLI started successfully'))).toBe(false)

      // 等子预算到点
      await sleep(500)

      expect(getSessionSnapshot(sid)?.phase).toBe('starting')
      const events = await readDiagnostics()
      const hit = events.filter((e) => e.type === 'cli_start_unconfirmed')
      expect(hit).toHaveLength(1)
      expect(hit[0]!.severity).toBe('warn')
      const data = (hit[0]!.details ?? {}) as Record<string, unknown>
      expect(data.sessionId).toBe(sid)
      expect(data.startSource).toBe('unknown') // 未标注来源时的降级值
      expect(typeof data.waitedMs).toBe('number')
      // 仍未宣称成功
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('CLI started successfully'))).toBe(false)
    } finally {
      logSpy.mockRestore()
    }
  }, 20_000)

  test('b) 迟到 attach（超时之后才连上）→ markRunning + 成功日志：超时不是终局', async () => {
    process.env.CC_HEIHEI_SDK_CONFIRM_BUDGET_MS = '150'
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const sid = `sdk-confirm-b-${crypto.randomUUID()}`
      await startIdleSession(sid)
      expect(getSessionSnapshot(sid)?.phase).toBe('starting')

      // 先让它超时（记下 unconfirmed）
      await sleep(500)
      expect((await readDiagnostics()).some((e) => e.type === 'cli_start_unconfirmed')).toBe(true)
      expect(getSessionSnapshot(sid)?.phase).toBe('starting')

      // 超时之后才真正连上（等价于 sidecar 侧 WS open → attachSdkConnection）
      service.attachSdkConnection(sid, { send: () => {} })
      await sleep(50)

      expect(getSessionSnapshot(sid)?.phase).toBe('running')
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('CLI started successfully'))).toBe(true)
    } finally {
      logSpy.mockRestore()
    }
  }, 20_000)

  test('c) 未被 SDK 确认阻塞：startSession 在子预算之前返回（deliver 仍 ≤3s，201 语义不变）', async () => {
    // 用产品默认子预算（30s）：若实现改回「同步等确认」，本用例会耗时 30s+ 而失败
    delete process.env.CC_HEIHEI_SDK_CONFIRM_BUDGET_MS
    const sid = `sdk-confirm-c-${crypto.randomUUID()}`
    const t0 = Date.now()
    await startIdleSession(sid)
    const elapsed = Date.now() - t0

    expect(getSessionSnapshot(sid)?.phase).toBe('starting')
    // 只断言「远早于 30s 子预算」，不写死 3s 真实等待
    expect(elapsed).toBeLessThan(10_000)
  }, 20_000)
})
