import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  UNKNOWN_TOOL_STREAK_LIMIT,
  isUnknownToolResultText,
  onServantToolResult,
  resetServantIncidentState,
  resetUnknownToolStreak,
  setServantIncidentDeps,
} from '../services/servantIncidentNotifier.js'

/**
 * 连续调用不存在工具的熔断（A2）。
 *
 * 依赖注入而非 mock.module：mock.module 会跨测试文件泄漏（bun 同进程顺序执行，
 * 见交接文档坑④）。本文件不改任何真实模块，也不读运行者 env（如
 * CC_HEIHEI_SUPERVISOR）——主管身份一律走注入的花名册，保证确定性。
 */

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

const deliverMock = mock(async () => true)
const getServantMock = mock(async (_id: string) => null as null | {
  sessionId: string
  role?: string
  description?: string
  enabled: boolean
})
const listServantsMock = mock(async (_options: { includeAll: boolean; forSessionId?: string }) => [] as Array<{
  sessionId: string
  role?: string
  description?: string
  supervisor?: boolean
  enabled: boolean
}>)
const interruptMock = mock((_sessionId: string) => {})
const recordEventMock = mock((_input: {
  type: string
  severity?: 'info' | 'warn' | 'error'
  summary: string
  sessionId?: string
  details?: unknown
}) => {})

/** toolExecution.ts:401 真正产出的文本形状 */
const unknownToolResult = (toolName: string) =>
  `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`

function enableServant(id: string, role = '前端') {
  getServantMock.mockImplementation(async (sessionId: string) =>
    sessionId === id ? { sessionId, role, enabled: true } : null,
  )
}

function withSupervisor(id: string, supervisorId = 'sup-1') {
  listServantsMock.mockImplementation(async () => [
    { sessionId: supervisorId, supervisor: true, enabled: true },
    { sessionId: id, supervisor: false, enabled: true },
  ])
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-breaker-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  deliverMock.mockClear()
  getServantMock.mockClear()
  listServantsMock.mockClear()
  interruptMock.mockClear()
  recordEventMock.mockClear()
  deliverMock.mockImplementation(async () => true)
  getServantMock.mockImplementation(async () => null)
  listServantsMock.mockImplementation(async () => [])
  setServantIncidentDeps({
    deliver: deliverMock,
    getServant: getServantMock,
    listServants: listServantsMock,
    getServerPort: () => 61694,
    interrupt: interruptMock,
    recordEvent: recordEventMock,
  })
  resetServantIncidentState()
})

afterEach(async () => {
  setServantIncidentDeps(null)
  resetServantIncidentState()
  if (originalConfigDir) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  else delete process.env.CLAUDE_CONFIG_DIR
  mock.restore()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('isUnknownToolResultText', () => {
  test('recognizes the tool dispatch layer output and rejects ordinary text', () => {
    expect(isUnknownToolResultText(unknownToolResult('Read'))).toBe(true)
    expect(isUnknownToolResultText(unknownToolResult('mcp__foo__bar'))).toBe(true)
    expect(isUnknownToolResultText('file contents')).toBe(false)
    expect(isUnknownToolResultText('')).toBe(false)
  })
})

describe('onServantToolResult', () => {
  test('counts consecutive unknown-tool calls and trips exactly at the threshold', async () => {
    enableServant('emp-1')
    withSupervisor('emp-1')

    // 递增：阈值前不中断、不通知
    for (let i = 1; i < UNKNOWN_TOOL_STREAK_LIMIT; i += 1) {
      const tripped = await onServantToolResult({
        sessionId: 'emp-1',
        resultText: unknownToolResult('NoSuchTool'),
        isError: true,
      })
      expect(tripped).toBe(false)
    }
    expect(interruptMock).not.toHaveBeenCalled()
    expect(deliverMock).not.toHaveBeenCalled()

    // 达到阈值：中断该轮次（功能动作保留）+ 记一条诊断（不再注入主管会话）
    const tripped = await onServantToolResult({
      sessionId: 'emp-1',
      resultText: unknownToolResult('NoSuchTool'),
      isError: true,
    })
    expect(tripped).toBe(true)
    expect(interruptMock).toHaveBeenCalledTimes(1)
    expect(interruptMock.mock.calls[0][0]).toBe('emp-1')
    expect(deliverMock).not.toHaveBeenCalled()
    expect(recordEventMock).toHaveBeenCalledTimes(1)
    const event = recordEventMock.mock.calls[0][0]
    expect(event.type).toBe('servant_unknown_tool_circuit')
    expect(event.severity).toBe('warn')
    expect(event.sessionId).toBe('emp-1')
    expect(event.summary).toContain('NoSuchTool')
    expect(event.summary).toContain(`连续 ${UNKNOWN_TOOL_STREAK_LIMIT} 次`)
    expect(event.details).toMatchObject({
      sessionId: 'emp-1',
      toolName: 'NoSuchTool',
      streak: UNKNOWN_TOOL_STREAK_LIMIT,
    })

    // 同一连续窗口内继续调用：仍会中断，但不再重复记诊断
    await onServantToolResult({
      sessionId: 'emp-1',
      resultText: unknownToolResult('NoSuchTool'),
      isError: true,
    })
    expect(interruptMock).toHaveBeenCalledTimes(2)
    expect(recordEventMock).toHaveBeenCalledTimes(1)
  })

  test('a successful tool call resets the streak', async () => {
    enableServant('emp-1')
    withSupervisor('emp-1')

    await onServantToolResult({ sessionId: 'emp-1', resultText: unknownToolResult('X'), isError: true })
    await onServantToolResult({ sessionId: 'emp-1', resultText: unknownToolResult('X'), isError: true })
    // 任一工具被成功派发（即便它自己执行报错）→ 清零
    await onServantToolResult({ sessionId: 'emp-1', resultText: 'command exited 1', isError: true })
    expect(interruptMock).not.toHaveBeenCalled()

    // 之后重新从 1 开始计：再两次不达阈值
    await onServantToolResult({ sessionId: 'emp-1', resultText: unknownToolResult('X'), isError: true })
    await onServantToolResult({ sessionId: 'emp-1', resultText: unknownToolResult('X'), isError: true })
    expect(interruptMock).not.toHaveBeenCalled()

    // 第三次才触发
    await onServantToolResult({ sessionId: 'emp-1', resultText: unknownToolResult('X'), isError: true })
    expect(interruptMock).toHaveBeenCalledTimes(1)
  })

  test('resetUnknownToolStreak clears the counter for the next turn', async () => {
    enableServant('emp-1')
    withSupervisor('emp-1')

    await onServantToolResult({ sessionId: 'emp-1', resultText: unknownToolResult('X'), isError: true })
    await onServantToolResult({ sessionId: 'emp-1', resultText: unknownToolResult('X'), isError: true })
    resetUnknownToolStreak('emp-1')
    await onServantToolResult({ sessionId: 'emp-1', resultText: unknownToolResult('X'), isError: true })
    expect(interruptMock).not.toHaveBeenCalled()
  })

  test('is_error must be true: an output that merely contains the marker does not count', async () => {
    enableServant('emp-1')
    withSupervisor('emp-1')

    for (let i = 0; i < UNKNOWN_TOOL_STREAK_LIMIT + 1; i += 1) {
      await onServantToolResult({
        sessionId: 'emp-1',
        resultText: `grep hit: ${unknownToolResult('X')}`,
        isError: false,
      })
    }
    expect(interruptMock).not.toHaveBeenCalled()
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('non-servant sessions are never interrupted or notified', async () => {
    // getServantMock 默认返回 null（非员工）
    for (let i = 0; i < UNKNOWN_TOOL_STREAK_LIMIT + 2; i += 1) {
      await onServantToolResult({ sessionId: 'interactive-1', resultText: unknownToolResult('X'), isError: true })
    }
    expect(interruptMock).not.toHaveBeenCalled()
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('the supervisor session itself is not interrupted (user is driving it)', async () => {
    enableServant('sup-1', '主管')
    listServantsMock.mockImplementation(async () => [
      { sessionId: 'sup-1', supervisor: true, enabled: true },
    ])

    for (let i = 0; i < UNKNOWN_TOOL_STREAK_LIMIT; i += 1) {
      await onServantToolResult({ sessionId: 'sup-1', resultText: unknownToolResult('X'), isError: true })
    }
    expect(interruptMock).not.toHaveBeenCalled()
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('trips and records a diagnostic even when the roster has no supervisor', async () => {
    enableServant('emp-1')
    listServantsMock.mockImplementation(async () => [
      { sessionId: 'emp-1', supervisor: false, enabled: true },
    ])

    for (let i = 0; i < UNKNOWN_TOOL_STREAK_LIMIT; i += 1) {
      await onServantToolResult({ sessionId: 'emp-1', resultText: unknownToolResult('X'), isError: true })
    }
    expect(interruptMock).toHaveBeenCalledTimes(1)
    expect(recordEventMock).toHaveBeenCalledTimes(1)
    expect(deliverMock).not.toHaveBeenCalled()
  })
})
