/**
 * P-A 集成：**发送前预检真的拦住了网络请求**
 *
 * 手法：起一个 loopback HTTP 服务器当作 API 端点（沿用
 * `claudeRequiredThinking.test.ts` 的 harness 写法），把请求体上限用 env 压到
 * 极小 ⇒ 若预检生效，超限请求**根本不会到达服务器**；把预检摘掉（判红）则请求
 * 会照发、服务器会收到 1 次。
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enableConfigs } from '../../utils/config.js'
import { queryWithModel } from './claude.js'

const ENV_MAX = 'CC_HEIHEI_API_REQUEST_MAX_BYTES'
const ENV_TRIGGER = 'CC_HEIHEI_API_REQUEST_TRIGGER_BYTES'

const ENV_KEYS = [
  'NODE_ENV',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  ENV_MAX,
  ENV_TRIGGER,
] as const

const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
let stopServer: (() => void) | undefined
let configDir: string | undefined

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  stopServer?.()
  stopServer = undefined
  if (configDir) await rm(configDir, { recursive: true, force: true })
  configDir = undefined
})

function sseOk(model: string): string {
  const ev = (name: string, data: unknown) =>
    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  return [
    ev('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_preflight',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    ev('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    ev('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'OK' },
    }),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    ev('message_stop', { type: 'message_stop' }),
  ].join('')
}

async function runQuery(options: {
  promptLength: number
  limits: { max?: string; trigger?: string }
}): Promise<{
  receivedRequests: number
  content: unknown
  sentBodyBytes: number
  stop: () => void
}> {
  const requests: Array<{ body: string; path: string }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push({ body: await request.text(), path: url.pathname })
      return new Response(sseOk('preflight-model'), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const stop = () => server.stop(true) as unknown as void
  stopServer = stop
  configDir = await mkdtemp(join(tmpdir(), 'cc-heihei-preflight-'))

  const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
  globals.MACRO = { BUILD_TIME: '' }
  process.env.NODE_ENV = 'production'
  process.env.CLAUDE_CONFIG_DIR = configDir
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
  delete process.env.ANTHROPIC_AUTH_TOKEN
  process.env.ANTHROPIC_API_KEY = 'loopback-test-key'
  process.env.ANTHROPIC_MODEL = 'preflight-model'
  if (options.limits.max === undefined) delete process.env[ENV_MAX]
  else process.env[ENV_MAX] = options.limits.max
  if (options.limits.trigger === undefined) delete process.env[ENV_TRIGGER]
  else process.env[ENV_TRIGGER] = options.limits.trigger
  enableConfigs()

  const result = await queryWithModel({
    // 空系统提示（SystemPrompt 是带 brand 的类型，测试里显式转一下）
    systemPrompt: [] as unknown as Parameters<typeof queryWithModel>[0]['systemPrompt'],
    userPrompt: 'x'.repeat(options.promptLength),
    signal: new AbortController().signal,
    options: {
      model: 'preflight-model',
      querySource: 'insights',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })

  // 只数**真正的消息发送**（排除 count_tokens 等辅助请求）
  const sendRequests = requests.filter((r) => !r.path.includes('count_tokens'))
  return {
    receivedRequests: sendRequests.length,
    content: result.message.content,
    sentBodyBytes: sendRequests[0]
      ? Buffer.byteLength(sendRequests[0].body, 'utf8')
      : 0,
    stop,
  }
}

test('回归：正常上限下照常发出 1 次请求（预检不干扰正常会话）', async () => {
  const { receivedRequests, content, stop } = await runQuery({
    promptLength: 20,
    limits: {}, // 默认 32MB/28MB，绝不触发
  })
  stop()
  expect(receivedRequests).toBe(1)
  expect(content).toEqual([{ type: 'text', text: 'OK' }])
}, 15_000)

test('预检生效：超限请求**不发网络请求**，而是返回可执行错误', async () => {
  // 第一阶段：正常上限跑一次，拿到这条请求的真实字节数（避免硬编码猜测）
  const probe = await runQuery({ promptLength: 20, limits: {} })
  probe.stop()
  expect(probe.receivedRequests).toBe(1)
  const bodyBytes = probe.sentBodyBytes
  expect(bodyBytes).toBeGreaterThan(0)

  // 第二阶段：把上限压到实测体积的一半 ⇒ system+tools+正文必然超限；
  // 纯文本无媒体可剥 ⇒ 预检直接阻断（正是「纯文本 413」这一类）
  const half = String(Math.floor(bodyBytes / 2))
  const blocked = await runQuery({
    promptLength: 20,
    limits: { max: half, trigger: half },
  })
  blocked.stop()

  // ← 关键断言：消息发送请求一次都没到服务器（超限请求没有发出去）
  expect(blocked.receivedRequests).toBe(0)
  // 返回的是可执行错误（说明实测/上限 + 出路），不是「换个更小的文件」
  const text = JSON.stringify(blocked.content)
  expect(text).toContain('Request blocked before sending')
  expect(text).toContain('exceeds the configured limit')
  expect(text).toContain('/compact')
}, 20_000)
