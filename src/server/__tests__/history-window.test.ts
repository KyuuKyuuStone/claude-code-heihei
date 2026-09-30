/**
 * v1.5.0 大会话首开：会话历史窗口化读取（尾部优先 + before 游标）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { SessionService } from '../services/sessionService.js'

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `cc-heihei-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(tmpDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const PROJECT_DIR = 'D--xxw-p-demo'

/** 写 N 条可见的 user 消息（每条一行 JSONL） */
async function writeSession(sessionId: string, count: number): Promise<void> {
  const dir = path.join(tmpDir, 'projects', PROJECT_DIR)
  await fs.mkdir(dir, { recursive: true })
  const lines: string[] = []
  for (let i = 0; i < count; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: `uuid-${i}`,
        timestamp: new Date(Date.UTC(2026, 8, 29, 0, 0, i)).toISOString(),
        message: { role: 'user', content: `msg-${i}` },
      }),
    )
  }
  // 末尾带一个空行 + 一个坏行：坏行不应计入窗口内容、也不应让读取失败
  lines.push('{ malformed')
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`, 'utf-8')
}

describe('getSessionMessagesWindow', () => {
  it('returns the most recent N messages with total/hasMore/nextBefore', async () => {
    const service = new SessionService()
    await writeSession('6e10688a-1111-4111-8111-111111111111', 20)

    const window = await service.getSessionMessagesWindow('6e10688a-1111-4111-8111-111111111111', { limit: 5 })

    expect(window.messages).toHaveLength(5)
    expect(window.messages.map((m) => m.content)).toEqual([
      'msg-15',
      'msg-16',
      'msg-17',
      'msg-18',
      'msg-19',
    ])
    expect(window.total).toBe(21) // 20 条消息 + 1 条坏行（非空行计数）
    expect(window.hasMore).toBe(true)
    expect(window.nextBefore).toBe(15)
  })

  it('pages backwards with the before cursor until exhausted', async () => {
    const service = new SessionService()
    await writeSession('6e10688a-2222-4222-8222-222222222222', 12)

    const page1 = await service.getSessionMessagesWindow('6e10688a-2222-4222-8222-222222222222', { limit: 5 })
    expect(page1.messages.map((m) => m.content)).toEqual([
      'msg-7',
      'msg-8',
      'msg-9',
      'msg-10',
      'msg-11',
    ])

    const page2 = await service.getSessionMessagesWindow('6e10688a-2222-4222-8222-222222222222', {
      limit: 5,
      before: page1.nextBefore,
    })
    expect(page2.messages.map((m) => m.content)).toEqual([
      'msg-2',
      'msg-3',
      'msg-4',
      'msg-5',
      'msg-6',
    ])
    expect(page2.hasMore).toBe(true)

    // 最后一段：剩余 2 条，窗口不足 limit 且 hasMore=false
    const page3 = await service.getSessionMessagesWindow('6e10688a-2222-4222-8222-222222222222', {
      limit: 5,
      before: page2.nextBefore,
    })
    expect(page3.messages.map((m) => m.content)).toEqual(['msg-0', 'msg-1'])
    expect(page3.hasMore).toBe(false)
    expect(page3.nextBefore).toBe(0)
  })

  it('matches the full-read result for the same tail (语义一致)', async () => {
    const service = new SessionService()
    await writeSession('6e10688a-3333-4333-8333-333333333333', 30)

    const all = await service.getSessionMessages('6e10688a-3333-4333-8333-333333333333')
    const window = await service.getSessionMessagesWindow('6e10688a-3333-4333-8333-333333333333', { limit: 8 })

    expect(window.messages.map((m) => m.content)).toEqual(
      all.slice(-8).map((m) => m.content),
    )
  })

  it('keeps the legacy full-read path unchanged when no window options are passed', async () => {
    const service = new SessionService()
    await writeSession('6e10688a-4444-4444-8444-444444444444', 6)

    const all = await service.getSessionMessages('6e10688a-4444-4444-8444-444444444444')
    expect(all).toHaveLength(6)
    expect(all.map((m) => m.content)).toEqual([
      'msg-0',
      'msg-1',
      'msg-2',
      'msg-3',
      'msg-4',
      'msg-5',
    ])
  })

  it('throws 404 for unknown sessions', async () => {
    const service = new SessionService()
    await expect(
      service.getSessionMessagesWindow('missing-session', { limit: 5 }),
    ).rejects.toThrow(/Session not found/)
  })
})
