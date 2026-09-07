import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ConversationService,
  ConversationStartupError,
} from '../services/conversationService.js'

describe('ConversationService startup output', () => {
  let service: ConversationService
  let tmpDir: string
  const originalEnv = new Map<string, string | undefined>()
  const envKeys = [
    'CLAUDE_CLI_PATH',
    'CLAUDE_CONFIG_DIR',
    'CC_HEIHEI_DISABLE_TERMINAL_SHELL_ENV',
    'MOCK_SDK_STARTUP_STDOUT',
    'MOCK_SDK_STARTUP_EXIT_CODE',
  ]

  beforeEach(async () => {
    service = new ConversationService()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-startup-output-'))
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key])
    }

    process.env.CLAUDE_CLI_PATH = fileURLToPath(
      new URL('./fixtures/mock-startup-exit-cli.ts', import.meta.url),
    )
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HEIHEI_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.MOCK_SDK_STARTUP_STDOUT = 'provider rejected request: invalid model id'
    delete process.env.MOCK_SDK_STARTUP_EXIT_CODE
  })

  afterEach(async () => {
    await service.stopAllSessionsAndWait(1_000)
    for (const key of envKeys) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    originalEnv.clear()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('includes CLI stdout when the process exits before SDK messages', async () => {
    let startupError: unknown

    try {
      await service.startSession(
        `startup-output-${crypto.randomUUID()}`,
        tmpDir,
        'ws://127.0.0.1:1/sdk/startup-output?token=test-token',
      )
    } catch (error) {
      startupError = error
    }

    expect(startupError).toBeInstanceOf(ConversationStartupError)
    expect(startupError).toMatchObject({ code: 'CLI_START_FAILED' })
    expect((startupError as Error).message).toContain(
      'CLI exited during startup (code 1): provider rejected request: invalid model id',
    )
  }, 10_000)

  test('treats a silent SIGTERM (143) startup exit as a benign reclamation, not a crash', async () => {
    // 预热空闲回收器 stopSession 会让 CLI 以 143 退出：无输出、无 SDK 消息。
    // 这类退出必须给出"正常回收"语义的消息与 exitCode，供日志降级使用。
    process.env.MOCK_SDK_STARTUP_STDOUT = ''
    process.env.MOCK_SDK_STARTUP_EXIT_CODE = '143'
    let startupError: unknown

    try {
      await service.startSession(
        `startup-sigterm-${crypto.randomUUID()}`,
        tmpDir,
        'ws://127.0.0.1:1/sdk/startup-sigterm?token=test-token',
      )
    } catch (error) {
      startupError = error
    }

    expect(startupError).toBeInstanceOf(ConversationStartupError)
    expect(startupError).toMatchObject({ code: 'CLI_START_FAILED', exitCode: 143 })
    expect((startupError as Error).message).toContain('SIGTERM')
    expect((startupError as Error).message).toContain('not a crash')
  }, 10_000)
})
