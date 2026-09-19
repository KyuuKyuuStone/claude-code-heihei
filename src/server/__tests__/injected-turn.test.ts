import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  beginInjectedUserTurn,
  resetInjectedTurnsForTests,
} from '../ws/handler.js'
import { conversationService } from '../services/conversationService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

/**
 * 注入式回合的 turn 建立（会话冻结根因报告 P1 · 环节 C）：
 * 信箱/HTTP 注入路径此前从不 set activeUserTurns → interrupt 报 already idle、
 * stall watcher 误判。beginInjectedUserTurn 建轻量 turn 并挂 result 监听清理，
 * 返回 abort 句柄供 sendMessage 失败时对称清理（审查 P2：防 turn 泄漏）。
 * 测试直接操作单例 conversationService 的 sessions map（模拟「CLI 在跑」），
 * 诊断事件落临时 CLAUDE_CONFIG_DIR 轮询断言。
 */

describe('beginInjectedUserTurn (injected turn lifecycle)', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-injected-turn-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetTerminalShellEnvironmentCacheForTests()
  })

  afterEach(async () => {
    // 审查 P3②：清掉本用例建立的注入 turn（含 result 监听），防跨用例泄漏
    resetInjectedTurnsForTests()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    // 清掉测试注入的假会话，防止跨用例泄漏
    const svc = conversationService as unknown as {
      sessions: Map<string, unknown>
    }
    for (const id of [...svc.sessions.keys()]) {
      if (id.startsWith('injected-turn-')) svc.sessions.delete(id)
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function registerFakeCliSession(sessionId: string): void {
    ;(conversationService as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, {
      outputCallbacks: [] as Array<(msg: any) => void>,
      sdkMessages: [],
      seenSdkMessageUuids: new Set<string>(),
      pendingPermissionRequests: new Map(),
    })
  }

  function emitResult(sessionId: string, msg: Record<string, unknown>): void {
    const session = (
      conversationService as unknown as {
        sessions: Map<string, { outputCallbacks: Array<(m: any) => void> }>
      }
    ).sessions.get(sessionId)
    for (const callback of session?.outputCallbacks ?? []) callback(msg)
  }

  async function readDiagnostics(): Promise<string> {
    const diagnosticsPath = path.join(tmpDir, 'cc-heihei', 'diagnostics', 'diagnostics.jsonl')
    return fs.readFile(diagnosticsPath, 'utf-8').catch(() => '')
  }

  /** recordEvent 异步落盘：轮询直到出现 needle */
  async function readDiagnosticsEventually(needle: string, timeoutMs = 2_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let logged = ''
    while (Date.now() < deadline) {
      logged = await readDiagnostics()
      if (logged.includes(needle)) return logged
      await new Promise((r) => setTimeout(r, 25))
    }
    return logged
  }

  test('establishes a turn, is idempotent, and clears on result', async () => {
    const sessionId = 'injected-turn-basic'
    registerFakeCliSession(sessionId)

    expect(beginInjectedUserTurn(sessionId)).not.toBeNull()
    // 幂等：活跃 turn 存在时不重复建立（不覆盖 WS 语义下的既有 turn）
    expect(beginInjectedUserTurn(sessionId)).toBeNull()

    // CLI result 流经 → turn 清理 → 可再次建立
    emitResult(sessionId, { type: 'result', is_error: false })
    expect(beginInjectedUserTurn(sessionId)).not.toBeNull()

    const logged = await readDiagnosticsEventually('turn_finished')
    expect(logged).toContain('turn_started')
    expect(logged).toContain('turn_finished')
    expect(logged).toContain(sessionId)
  })

  test('records turn_finished with is_error for failed turns', async () => {
    const sessionId = 'injected-turn-error'
    registerFakeCliSession(sessionId)
    expect(beginInjectedUserTurn(sessionId)).not.toBeNull()

    emitResult(sessionId, { type: 'result', is_error: true })

    const logged = await readDiagnosticsEventually('turn_finished')
    expect(logged).toContain('turn_finished')
    expect(logged).toContain('"is_error":true')
  })

  test('non-result messages do not clear the turn', async () => {
    const sessionId = 'injected-turn-noise'
    registerFakeCliSession(sessionId)
    expect(beginInjectedUserTurn(sessionId)).not.toBeNull()

    emitResult(sessionId, { type: 'assistant', message: { content: [] } })

    // turn 仍在：再次 begin 返回 null（幂等守卫）
    expect(beginInjectedUserTurn(sessionId)).toBeNull()
  })

  // 审查 P2：sendMessage 失败路径的对称清理——句柄 abort 后 turn 不残留
  test('abort clears the turn so it does not leak (interrupt stays accurate)', async () => {
    const sessionId = 'injected-turn-abort'
    registerFakeCliSession(sessionId)

    const handle = beginInjectedUserTurn(sessionId)
    expect(handle).not.toBeNull()
    // turn 活跃中：再次 begin 被幂等守卫拦下
    expect(beginInjectedUserTurn(sessionId)).toBeNull()

    // 模拟 deliver 的 sendMessage 失败路径：handle.abort() 对称清理
    handle!.abort()

    // turn 已清理：可再次建立（interrupt 不会永久 busy）
    expect(beginInjectedUserTurn(sessionId)).not.toBeNull()

    const logged = await readDiagnosticsEventually('turn_started')
    expect(logged).toContain('turn_started')
  })
})
