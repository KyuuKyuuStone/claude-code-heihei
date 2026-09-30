import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'
import { sessionSummaryIndexStore } from '../services/sessionSummaryIndexStore.js'

/**
 * 窗口模式 usageTotals（v1.5.0 会话级 token 用量合计）。
 *
 * 背景：前端首开只拉最近一页（HISTORY_PAGE_SIZE=200），据窗口内消息累加的
 * token 用量会偏小；窗口响应因此附带服务端按**全文件**口径算好的合计。
 *
 * 口径来源（必须逐项一致，字段名不能改）：desktop/src/stores/chatStore.ts 的
 * summarizeTokenUsageFromHistory。本测试把该函数**逐字复刻**到这里
 * （desktopSummarizeUsage），再断言服务端结果与它 toEqual —— 任何口径漂移
 * （字段名、全 0 判定、cache 键的出现条件）都会让这条断言变红。
 */

const UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

/** 逐字照抄 desktop/src/stores/chatStore.ts 的 summarizeTokenUsageFromHistory */
function desktopSummarizeUsage(messages: Array<{ usage?: Record<string, unknown> }>) {
  const readUsageToken = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0

  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0

  for (const message of messages) {
    const usage = message.usage
    if (!usage) continue
    inputTokens += readUsageToken(usage.input_tokens)
    outputTokens += readUsageToken(usage.output_tokens)
    cacheReadTokens += readUsageToken(usage.cache_read_input_tokens)
    cacheCreationTokens += readUsageToken(usage.cache_creation_input_tokens)
  }

  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) {
    return null
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cacheReadTokens > 0 ? { cache_read_tokens: cacheReadTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cache_creation_tokens: cacheCreationTokens } : {}),
  }
}

function assistantLine(
  timestamp: string,
  usage?: Record<string, unknown>,
  text = 'reply',
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${timestamp}-${text.length}-${usage ? Object.keys(usage).length : 0}`,
    timestamp,
    message: {
      role: 'assistant',
      content: text,
      ...(usage ? { usage } : {}),
    },
  })
}

function userLine(timestamp: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${timestamp}-${text.length}`,
    timestamp,
    message: { role: 'user', content: text },
  })
}

describe('窗口模式 usageTotals（会话级 token 合计）', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let svc: SessionService

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-usage-totals-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    svc = new SessionService()
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function writeSessionFile(id: string, lines: string[]): Promise<string> {
    const projectDir = path.join(tmpDir, 'projects', 'D--xxw-p-claude-code-heihei')
    await fs.mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, `${id}.jsonl`)
    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf-8')
    return filePath
  }

  it('与前端 summarizeTokenUsageFromHistory 逐项一致（含 cache 两项）', async () => {
    await writeSessionFile(UUID, [
      userLine('2026-09-29T00:00:00.000Z', 'question'),
      assistantLine('2026-09-29T00:01:00.000Z', {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 3,
      }),
      userLine('2026-09-29T00:02:00.000Z', 'follow-up'),
      assistantLine('2026-09-29T00:03:00.000Z', {
        input_tokens: 250,
        output_tokens: 40,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 11,
      }),
    ])

    const window = await svc.getSessionMessagesWindow(UUID, { limit: 2 })
    const all = await svc.getSessionMessages(UUID)

    expect(window.usageTotals).toEqual(desktopSummarizeUsage(all as never))
    expect(window.usageTotals).toEqual({
      input_tokens: 350,
      output_tokens: 60,
      cache_read_tokens: 7,
      cache_creation_tokens: 14,
    })
    // 窗口本身只映射了 2 条 → 单看窗口会漏掉第 1 条 assistant 的用量
    expect(window.messages).toHaveLength(2)
  })

  it('cache 两项为 0 时不出现该键（与前端同款条件字段）', async () => {
    await writeSessionFile(UUID, [
      assistantLine('2026-09-29T00:00:00.000Z', {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ])

    const window = await svc.getSessionMessagesWindow(UUID, { limit: 10 })

    expect(window.usageTotals).toEqual({ input_tokens: 10, output_tokens: 5 })
    expect(window.usageTotals && 'cache_read_tokens' in window.usageTotals).toBe(false)
    expect(window.usageTotals && 'cache_creation_tokens' in window.usageTotals).toBe(false)
  })

  it('全文件没有任何 usage（或四项全 0）→ null', async () => {
    await writeSessionFile(UUID, [
      userLine('2026-09-29T00:00:00.000Z', 'no usage here'),
      assistantLine('2026-09-29T00:01:00.000Z', {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ])

    const window = await svc.getSessionMessagesWindow(UUID, { limit: 10 })

    expect(window.usageTotals).toBeNull()
    expect(desktopSummarizeUsage(await svc.getSessionMessages(UUID) as never)).toBeNull()
  })

  it('非有限数/字符串字段按 0 计（与前端 readUsageToken 同款）', async () => {
    await writeSessionFile(UUID, [
      assistantLine('2026-09-29T00:00:00.000Z', {
        input_tokens: '999' as unknown as number,
        output_tokens: 12,
        cache_read_input_tokens: null as unknown as number,
      }),
      assistantLine('2026-09-29T00:01:00.000Z', {
        input_tokens: 8,
        output_tokens: 1,
      }),
    ])

    const window = await svc.getSessionMessagesWindow(UUID, { limit: 10 })

    expect(window.usageTotals).toEqual(desktopSummarizeUsage(await svc.getSessionMessages(UUID) as never))
    expect(window.usageTotals).toEqual({ input_tokens: 8, output_tokens: 13 })
  })

  it('超大无 usage 行（tool_result 类）不影响合计，坏行也跳过', async () => {
    await writeSessionFile(UUID, [
      assistantLine('2026-09-29T00:00:00.000Z', { input_tokens: 5, output_tokens: 2 }),
      userLine('2026-09-29T00:01:00.000Z', `huge tool_result ${'z'.repeat(200 * 1024)}`),
      '{ malformed line without usage',
      assistantLine('2026-09-29T00:02:00.000Z', { input_tokens: 5, output_tokens: 2 }),
    ])

    const window = await svc.getSessionMessagesWindow(UUID, { limit: 2 })

    expect(window.usageTotals).toEqual({ input_tokens: 10, output_tokens: 4 })
  })

  it('结果随 mtime+size 进索引缓存（第二次不再累加）', async () => {
    const filePath = await writeSessionFile(UUID, [
      assistantLine('2026-09-29T00:00:00.000Z', { input_tokens: 3, output_tokens: 1 }),
    ])

    const first = await svc.getSessionMessagesWindow(UUID, { limit: 10 })
    const stat = await fs.stat(filePath)
    // 首次调用后缓存已写入（undefined 才是「未缓存」；null 也代表有效结果）
    expect(
      sessionSummaryIndexStore.getUsageTotals(filePath, stat.mtimeMs, stat.size),
    ).toEqual(first.usageTotals)

    const second = await svc.getSessionMessagesWindow(UUID, { limit: 10 })
    expect(second.usageTotals).toEqual(first.usageTotals)
  })

  it('分页翻页时每页都带同一份全文件合计（口径与窗口位置无关）', async () => {
    const lines: string[] = []
    for (let i = 0; i < 6; i += 1) {
      lines.push(
        assistantLine(`2026-09-29T00:0${i}:00.000Z`, {
          input_tokens: 10,
          output_tokens: 1,
        }, `m${i}`),
      )
    }
    await writeSessionFile(UUID, lines)

    const page1 = await svc.getSessionMessagesWindow(UUID, { limit: 2 })
    const page2 = await svc.getSessionMessagesWindow(UUID, {
      limit: 2,
      before: page1.nextBefore,
    })

    expect(page1.usageTotals).toEqual({ input_tokens: 60, output_tokens: 6 })
    expect(page2.usageTotals).toEqual(page1.usageTotals)
    expect(desktopSummarizeUsage(await svc.getSessionMessages(UUID) as never)).toEqual(
      page1.usageTotals,
    )
  })
})
