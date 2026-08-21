import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { withStreamRetry } from './streamRetry.js'
import { RetriableStreamError } from './withRetry.js'

const RETRY_ENV = 'CLAUDE_STREAM_TRANSIENT_RETRY_MAX'

// getAssistantMessageFromError() (invoked when retries are exhausted) consults
// isClaudeAISubscriber(), which throws if no auth is configured. We only assert
// that an assistant error message is produced, so a dummy key suffices. In
// production this path always runs with real auth already in place.
let priorApiKey: string | undefined
beforeAll(() => {
  priorApiKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test'
})
afterAll(() => {
  if (priorApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  }
})

/** A RetriableStreamError wrapping a realistic mid-stream api_error (no status). */
function retriableError(): RetriableStreamError {
  const body = {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Failed to generate a valid tool call.',
    },
  }
  return new RetriableStreamError(
    new APIError(undefined, body, JSON.stringify(body), undefined),
  )
}

// biome-ignore lint/suspicious/noExplicitAny: test harness collects heterogeneous stream messages
async function collect(gen: AsyncGenerator<any, void>): Promise<any[]> {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const out: any[] = []
  for await (const m of gen) out.push(m)
  return out
}

describe('withStreamRetry', () => {
  test('retries after a transient mid-stream error and yields the successful attempt', async () => {
    process.env[RETRY_ENV] = '2'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        if (calls === 1) {
          // A failed attempt may have already emitted partials before throwing.
          yield { type: 'stream_event', event: { type: 'message_start' } }
          throw retriableError()
        }
        yield { type: 'assistant', message: { content: [] }, uuid: 'ok' }
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(2)
    expect(out).toContainEqual(expect.objectContaining({
      type: 'system',
      subtype: 'streaming_fallback',
      cause: 'stream_retry',
    }))
    const assistants = out.filter(m => m.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].uuid).toBe('ok')
    // The successful retry must NOT be reported as an API error.
    expect(out.some(m => m.isApiErrorMessage)).toBe(false)
    delete process.env[RETRY_ENV]
  })

  test('exhausts retries and surfaces an API-error assistant message', async () => {
    process.env[RETRY_ENV] = '2'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw retriableError()
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(3) // 1 initial attempt + 2 retries
    expect(out.filter(
      m => m.type === 'system' && m.subtype === 'streaming_fallback' && m.cause === 'stream_retry',
    )).toHaveLength(2)
    const last = out.at(-1)
    expect(last?.type).toBe('assistant')
    expect(last?.isApiErrorMessage).toBe(true)
    delete process.env[RETRY_ENV]
  })

  // Transport disconnects reach this wrapper as a bare Error, not an APIError —
  // the first RetriableStreamError payload that is not an SDK error object. The
  // recovery path must survive one, including the exhaustion branch that asks
  // getAssistantMessageFromError to render it.
  test('recovers from a mid-stream socket reset and reports it if it persists', async () => {
    process.env[RETRY_ENV] = '1'
    const socketReset = () =>
      new RetriableStreamError(
        Object.assign(
          new Error('The socket connection was closed unexpectedly.'),
          { code: 'ECONNRESET' },
        ),
      )

    let calls = 0
    const recovers = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        if (calls === 1) {
          yield { type: 'stream_event', event: { type: 'message_start' } }
          throw socketReset()
        }
        yield { type: 'assistant', message: { content: [] }, uuid: 'recovered' }
      })()

    const recovered = await collect(withStreamRetry(recovers, 'test-model', []))
    expect(calls).toBe(2)
    expect(recovered.at(-1)?.uuid).toBe('recovered')
    expect(recovered.some(m => m.isApiErrorMessage)).toBe(false)

    const persists = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        throw socketReset()
      })()

    const failed = await collect(withStreamRetry(persists, 'test-model', []))
    const last = failed.at(-1)
    expect(last?.type).toBe('assistant')
    expect(last?.isApiErrorMessage).toBe(true)
    delete process.env[RETRY_ENV]
  })

  test('does not retry a non-RetriableStreamError; rethrows it', async () => {
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw new Error('fatal')
      })()

    await expect(
      collect(withStreamRetry(attempt, 'test-model', [])),
    ).rejects.toThrow('fatal')
    expect(calls).toBe(1)
  })

  test('maxRetries=0 makes a single attempt, then surfaces the error', async () => {
    process.env[RETRY_ENV] = '0'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw retriableError()
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(1)
    expect(out.at(-1)?.type).toBe('assistant')
    expect(out.at(-1)?.isApiErrorMessage).toBe(true)
    delete process.env[RETRY_ENV]
  })

  test('yields completed text from only the final exhausted attempt', async () => {
    process.env[RETRY_ENV] = '1'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw new RetriableStreamError(
          new Error('socket reset'),
          [
            {
              type: 'assistant',
              message: {
                id: `response-${calls}`,
                type: 'message',
                role: 'assistant',
                model: 'test-model',
                content: [{ type: 'text', text: `partial-${calls}` }],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                },
              },
              uuid: `partial-${calls}`,
              timestamp: new Date().toISOString(),
            },
          ],
        )
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))
    const partials = out.filter(
      message =>
        message.type === 'assistant' &&
        typeof message.uuid === 'string' &&
        message.uuid.startsWith('partial-'),
    )

    expect(calls).toBe(2)
    expect(partials.map(message => message.uuid)).toEqual(['partial-2'])
    expect(out.at(-1)?.isApiErrorMessage).toBe(true)
    delete process.env[RETRY_ENV]
  })

  test('passes through a clean attempt without retrying', async () => {
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        yield { type: 'assistant', message: { content: [] }, uuid: 'clean' }
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(1)
    expect(out).toHaveLength(1)
    expect(out[0].uuid).toBe('clean')
  })
})
