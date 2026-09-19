import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  TOOL_EXEC_HARD_TIMEOUT_MS,
  withToolExecutionDiagnostics,
} from '../../services/tools/toolExecution.js'
import { setDiagnosticsLogWriterForTests } from '../../utils/diagLogs.js'

/**
 * 工具生命周期埋点 + 硬超时兜底（会话冻结根因报告 P1 · 环节 B）。
 *
 * 诊断事件经 logForDiagnosticsNoPII（生产落 cli-diagnostics.jsonl）。bun 测试
 * 环境下该写入器的 fs 实现会静默失败（实测文件不落盘且无报错），因此经
 * diagLogs 的依赖注入缝（setDiagnosticsLogWriterForTests，参照
 * setServantIncidentDeps 模式）注入同步收集器：调用即入数组、断言无异步沉降，
 * 冷启动下确定性成立。超时用注入的 timeoutMs（withToolExecutionDiagnostics
 * 第三参）避免真实等待。
 */

type DiagCall = { level: string; event: string; data: Record<string, unknown> }
const diagCalls: DiagCall[] = []

const META = {
  toolName: 'Bash',
  toolUseId: 'toolu-test-1',
  sourceToolAssistantUUID: 'assistant-uuid-1',
}

function resultUpdate(toolUseId: string, isError = false) {
  return {
    message: {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: toolUseId,
            content: 'ok',
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
    },
  }
}

async function* oneShotGenerator() {
  yield resultUpdate(META.toolUseId)
}

async function* hangingGenerator(): AsyncGenerator<never, void> {
  await new Promise(() => {}) // 永不产出（模拟工具永久悬挂）
}

describe('withToolExecutionDiagnostics', () => {
  beforeEach(() => {
    diagCalls.length = 0
    setDiagnosticsLogWriterForTests((level, event, data) => {
      diagCalls.push({ level, event, data })
    })
  })

  afterEach(() => {
    setDiagnosticsLogWriterForTests(null)
  })

  test('normal path: yields pass through, lifecycle events logged', async () => {
    const collected: unknown[] = []
    for await (const update of withToolExecutionDiagnostics(oneShotGenerator(), META)) {
      collected.push(update)
    }

    expect(collected).toHaveLength(1)
    const events = diagCalls.map((c) => c.event)
    expect(events).toContain('tool_exec_started')
    expect(events).toContain('tool_result_emitted')
    expect(events).toContain('tool_exec_finished')

    const finished = diagCalls.find((c) => c.event === 'tool_exec_finished')!
    expect(finished.data.toolName).toBe('Bash')
    expect(finished.data.toolUseId).toBe('toolu-test-1')
    expect(finished.data.result_emitted).toBe(true)
    expect(finished.data.timed_out).toBe(false)
    expect(typeof finished.data.duration_ms).toBe('number')
  })

  test('timeout path: forced tool_result injected, orphan tool_use eliminated', async () => {
    const collected: Array<{ message?: { message?: { content?: Array<Record<string, unknown>> } } }> = []
    for await (const update of withToolExecutionDiagnostics(hangingGenerator(), META, {
      timeoutMs: 1050,
    })) {
      collected.push(update as never)
    }

    // 恰好一条兜底 tool_result（孤儿 tool_use 被消灭）
    expect(collected).toHaveLength(1)
    const block = collected[0]!.message!.message!.content![0]!
    expect(block.type).toBe('tool_result')
    expect(block.tool_use_id).toBe(META.toolUseId)
    expect(block.is_error).toBe(true)
    // P3①：文案按注入的 timeoutMs 折算（1050ms → "1 seconds"），不再硬编码 10 分钟
    expect(String(block.content)).toContain('timed out after 1 seconds')

    const events = diagCalls.map((c) => c.event)
    expect(events).toContain('tool_exec_timeout_fallback')
    expect(events).toContain('tool_exec_finished')
    const finished = diagCalls.find((c) => c.event === 'tool_exec_finished')!
    expect(finished.data.timed_out).toBe(true)
    expect(finished.data.result_emitted).toBe(false)
  })

  test('tool_result from a different toolUseId does not count as emitted', async () => {
    async function* foreignResult() {
      yield resultUpdate('someone-else')
    }
    for await (const update of withToolExecutionDiagnostics(foreignResult(), META)) {
      void update
    }
    expect(diagCalls.some((c) => c.event === 'tool_result_emitted')).toBe(false)
    const finished = diagCalls.find((c) => c.event === 'tool_exec_finished')!
    expect(finished.data.result_emitted).toBe(false)
  })

  test('hard timeout constant stays at 10 minutes (covers Bash own timeout cap)', () => {
    expect(TOOL_EXEC_HARD_TIMEOUT_MS).toBe(600_000)
  })
})
