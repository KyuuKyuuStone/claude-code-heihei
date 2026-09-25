import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { conversationService } from '../services/conversationService.js'
import type { SessionProcess } from '../services/conversationService.js'

/**
 * CLI 静默退出（cli_runtime_exit）诊断增强：
 * 公司电脑实测两次 exit code 4 且 stderr/stdout 零捕获。捕获接线本身无缺陷
 * （spawn 后立即读流、exit 前 drain 等待）——空捕获的真因是子进程零输出即死
 * （运行时级崩溃特征）。本测试锁定三个行为：
 * 1. stderr 尾部捕获正常工作（有输出时必被接住）
 * 2. 读流故障不再静默——留 [stream-read-error] 痕迹（否则与「子进程没输出」无法区分）
 * 3. 空捕获时的 exit 消息明确「管道已排空」语义（区分没接住 vs 真静默）
 */

const svc = conversationService as unknown as {
  readProcessOutputStream: (
    sessionId: string,
    stream: ReadableStream | null | undefined,
    streamName: 'stdout' | 'stderr',
  ) => Promise<void>
  waitForProcessOutputDrain: (
    session: SessionProcess,
    timeoutMs?: number,
  ) => Promise<{ drained: boolean }>
  buildCapturedProcessOutputDetail: (session: SessionProcess | undefined) => string
  buildRuntimeExitMessage: (sessionId: string, exitCode: number) => string
  sessions: Map<string, SessionProcess>
}

function fakeSession(overrides: Partial<SessionProcess> = {}): SessionProcess {
  return {
    proc: null as never,
    outputCallbacks: [],
    workDir: '/tmp/fake',
    permissionMode: 'default',
    sdkSocket: null,
    seenSdkMessageUuids: new Set<string>(),
    startupPending: false,
    startupExitCode: null,
    stdoutLines: [],
    stderrLines: [],
    outputDrain: Promise.resolve(),
    sdkMessages: [],
    sdkMessageBytes: 0,
    initMessage: null,
    pendingOutbound: [],
    ...overrides,
  } as SessionProcess
}

function streamFrom(chunks: string[], failAfter?: Error): ReadableStream {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (failAfter && index >= chunks.length) {
        controller.error(failAfter)
        return
      }
      if (index < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[index]!))
        index++
      } else {
        controller.close()
      }
    },
  })
}

describe('CLI exit diagnostics (cli_runtime_exit capture)', () => {
  let sessionId: string

  beforeEach(() => {
    sessionId = `cli-exit-${Date.now()}`
  })

  afterEach(() => {
    svc.sessions.delete(sessionId)
  })

  test('stderr tail is captured from a live stream', async () => {
    const session = fakeSession()
    svc.sessions.set(sessionId, session)

    await svc.readProcessOutputStream(sessionId, streamFrom(['boom: fatal\n', 'second line\n']), 'stderr')

    expect(session.stderrLines).toEqual(['boom: fatal', 'second line'])
    expect(svc.buildCapturedProcessOutputDetail(session)).toContain('boom: fatal')
  })

  test('stream read failure is NOT silent — leaves a trace line (guards against forged empty capture)', async () => {
    const session = fakeSession()
    svc.sessions.set(sessionId, session)
    const errors: string[] = []
    const originalConsoleError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.join(' '))
    }

    try {
      await svc.readProcessOutputStream(
        sessionId,
        streamFrom(['partial-before-failure'], new Error('EPIPE: broken pipe')),
        'stderr',
      )
    } finally {
      console.error = originalConsoleError
    }

    // 已读到的部分照常进缓冲；故障本身留痕（诊断可区分「没接住」vs「真静默」）
    expect(session.stderrLines).toContain('partial-before-failure')
    expect(session.stderrLines.some((line) => line.includes('[stream-read-error]'))).toBe(true)
    expect(session.stderrLines.some((line) => line.includes('EPIPE'))).toBe(true)
    expect(errors.some((entry) => entry.includes('[stream-read-error]'))).toBe(true)
    // 捕获详情现在非空——空捕获签名不再被读流故障伪造
    expect(svc.buildCapturedProcessOutputDetail(session)).toContain('stream-read-error')
  })

  test('drain outcome is reported so empty captures are interpretable', async () => {
    const drainedSession = fakeSession({ outputDrain: Promise.resolve() })
    const timeoutSession = fakeSession({
      outputDrain: new Promise(() => {}), // 永不完成 → 走超时分支
    })

    expect(await svc.waitForProcessOutputDrain(drainedSession, 50)).toEqual({ drained: true })
    expect(await svc.waitForProcessOutputDrain(timeoutSession, 20)).toEqual({ drained: false })
  })

  test('empty-capture exit message states pipes were drained (runtime-crash signature)', () => {
    const session = fakeSession()
    svc.sessions.set(sessionId, session)

    const message = svc.buildRuntimeExitMessage(sessionId, 4)
    expect(message).toContain('code 4')
    expect(message).toContain('output pipes drained but nothing was captured')
    // 失实风险：静默退出不再与「没接住」混为一谈
    expect(message).toContain('runtime-level failure')
  })

  test('exit message prefers captured stderr detail over the empty-capture fallback', () => {
    const session = fakeSession({ stderrLines: ['bun panic: something fatal'] })
    svc.sessions.set(sessionId, session)

    const message = svc.buildRuntimeExitMessage(sessionId, 4)
    expect(message).toContain('bun panic: something fatal')
    expect(message).not.toContain('output pipes drained but nothing was captured')
  })
})
