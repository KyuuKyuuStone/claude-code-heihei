import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'

/**
 * v1.4.0 加载回归修复的同域测试：getSessionListSummaryForSession（单会话直查）。
 *
 * 背景：花名册轮询原实现走 listSessions({ limit: 500 }) 全量摘要扫描——冷启动
 * 对全部会话文件逐一 scan、活跃会话 mtime 一变整文件重扫，渲染端 20s 轮询 ×
 * 多客户端把事件循环打到分钟级阻塞，冷启动开会话的历史请求被排队饿死（前端
 * 「加载中…」长时间不落，用户实测 5904 条消息会话）。修复 = 花名册切到本直查
 * （复用同一 mtime+size 摘要缓存与 in-flight 去重，只付目标会话一份成本）。
 * 这里锁定直查的行为契约：存在返回摘要、未知返回 null、重复查询结果一致。
 */

const UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

describe('SessionService.getSessionListSummaryForSession (light per-session query)', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let svc: SessionService

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-list-summary-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    svc = new SessionService()
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function writeSessionFile(lines: string[]): Promise<string> {
    // projects 目录布局：<转义项目路径>/<sessionId>.jsonl（findSessionFiles 的发现结构）
    const projectDir = path.join(tmpDir, 'projects', 'D--xxw-p-claude-code-heihei')
    await fs.mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, `${UUID}.jsonl`)
    await fs.writeFile(filePath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8')
    return filePath
  }

  test('returns the summary for an existing session', async () => {
    await writeSessionFile([
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-09-28T00:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
    ])
    const summary = await svc.getSessionListSummaryForSession(UUID)
    expect(summary).not.toBeNull()
    expect(summary!.messageCount).toBeGreaterThan(0)
    // workDir 来自项目目录名反解（desanitize），证明走的是目标会话自己的文件
    expect(summary!.workDir).toBeTruthy()
  })

  test('returns null for an unknown session id', async () => {
    await writeSessionFile([])
    expect(
      await svc.getSessionListSummaryForSession('ffffffff-ffff-4fff-8fff-ffffffffffff'),
    ).toBeNull()
  })

  test('repeat queries return a consistent summary (mtime+size summary cache path)', async () => {
    await writeSessionFile([])
    const first = await svc.getSessionListSummaryForSession(UUID)
    const second = await svc.getSessionListSummaryForSession(UUID)
    expect(first).not.toBeNull()
    expect(second).toEqual(first)
  })
})

/**
 * v1.5.0 C11：会话列表的排序/分页语义（先 stat 排序分页、只对当前页做摘要）。
 * 锁定改造后 total/排序/切片不变——行为等价是这次性能改造的前提。
 */
describe('SessionService.listSessions pagination (C11 page-before-summarize)', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let svc: SessionService

  const IDS = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ]

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-list-page-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    svc = new SessionService()
    const projectDir = path.join(tmpDir, 'projects', 'D--xxw-p-demo')
    await fs.mkdir(projectDir, { recursive: true })
    // 三个会话文件，mtime 依次递增 → 列表应新→旧排序
    for (let i = 0; i < IDS.length; i += 1) {
      const filePath = path.join(projectDir, `${IDS[i]}.jsonl`)
      await fs.writeFile(
        filePath,
        JSON.stringify({
          type: 'user',
          uuid: `u-${i}`,
          timestamp: new Date(Date.UTC(2026, 8, 29, 0, 0, i)).toISOString(),
          message: { role: 'user', content: `m-${i}` },
        }) + String.fromCharCode(10),
        'utf-8',
      )
      const stamp = new Date(Date.UTC(2026, 8, 29, 1, 0, i))
      await fs.utimes(filePath, stamp, stamp)
    }
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('returns a single page but the true total, newest first', async () => {
    const page = await svc.listSessions({ limit: 1, offset: 0 })
    expect(page.total).toBe(3)
    expect(page.sessions).toHaveLength(1)
    expect(page.sessions[0]!.id).toBe(IDS[2]) // mtime 最新

    const second = await svc.listSessions({ limit: 1, offset: 1 })
    expect(second.total).toBe(3)
    expect(second.sessions[0]!.id).toBe(IDS[1])

    const rest = await svc.listSessions({ limit: 1, offset: 2 })
    expect(rest.sessions[0]!.id).toBe(IDS[0])
  })

  test('default limit still returns every session for small projects', async () => {
    const all = await svc.listSessions({})
    expect(all.total).toBe(3)
    expect(all.sessions.map((s) => s.id)).toEqual([IDS[2], IDS[1], IDS[0]])
  })
})

/**
 * 中1（v1.5.0 第二批）：列表排序键与全量摘要语义**不得漂移**。
 *
 * 原实现只读末尾 64KB，找不到 user/assistant 行就回退 stat.mtime。两个真实
 * 漂移场景：①窗口内没有 user/assistant 条目；②**最后一条 user 行本身超过
 * 64KB**（大会话的超长 tool_result）时该行横跨窗口、窗口内 parse 必败 →
 * 排序键回退 mtime 或取到更早条目 → 刚活跃的大会话在列表中偏后，用户可感。
 * 修复：64KB→256KB→1MB 逐级扩窗，仍不可断言可信则退回一次全量语义扫描
 * （与 GET /api/sessions 的 modifiedAt 同源，结果进持久索引）。
 *
 * 测试把巨型会话文件的 mtime 压到**过去**且不等于任何内容时间戳——旧实现的
 * mtime 回退会因此产生与全量语义不同的排序位置，从而可观测地锁住修复。
 */
describe('listSessions 排序键：尾部超长行回退全量语义（中1）', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let originalIndexMode: string | undefined
  let svc: SessionService

  // 内容时间戳（升序）；HUGE 的 mtime 特意压到 SMALL 与 MIDDLE 之间，不等于任何一个
  const EARLIER = '2026-08-01T00:00:00.000Z'
  const MIDDLE = '2026-09-05T00:00:00.000Z'
  const LATE = '2026-09-10T00:00:00.000Z'
  const HUGE_MTIME = '2026-09-01T00:00:00.000Z'

  const UUID_SMALL = '11111111-1111-4111-8111-111111111111'
  const UUID_MID = '22222222-2222-4222-8222-222222222222'
  const UUID_HUGE = '33333333-3333-4333-8333-333333333333'

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-tail-sort-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalIndexMode = process.env.CC_HEIHEI_LOCAL_INDEX
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    // 强制走文件扫描路径：本测试锁的是 readTailModifiedAt 的排序键
    process.env.CC_HEIHEI_LOCAL_INDEX = 'off'
    svc = new SessionService()
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalIndexMode === undefined) delete process.env.CC_HEIHEI_LOCAL_INDEX
    else process.env.CC_HEIHEI_LOCAL_INDEX = originalIndexMode
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function userLine(timestamp: string, text: string): string {
    return JSON.stringify({
      type: 'user',
      uuid: `u-${timestamp}-${text.length}`,
      timestamp,
      message: { role: 'user', content: text },
    })
  }

  async function writeSessionFile(id: string, lines: string[], mtimeIso: string): Promise<void> {
    const projectDir = path.join(tmpDir, 'projects', 'D--xxw-p-claude-code-heihei')
    await fs.mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, `${id}.jsonl`)
    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf-8')
    const when = new Date(mtimeIso)
    await fs.utimes(filePath, when, when)
  }

  test('尾部 user 行 > 64KB：排序键取内容时间戳而非 mtime，与全量语义一致', async () => {
    await writeSessionFile(UUID_SMALL, [userLine(EARLIER, 'a'.repeat(64))], EARLIER)
    await writeSessionFile(UUID_MID, [userLine(MIDDLE, 'b'.repeat(64))], MIDDLE)
    // 巨行 100KB > 64KB：旧实现的 64KB 窗口里只有该行的中段，parse 必败 →
    // 回退 mtime（2026-09-01）→ HUGE 会掉到 MID 之后
    await writeSessionFile(
      UUID_HUGE,
      [userLine(EARLIER, 'x'.repeat(32)), userLine(LATE, 'y'.repeat(100 * 1024))],
      HUGE_MTIME,
    )

    const { sessions } = await svc.listSessions({ limit: 10 })

    expect(sessions.map((item) => item.id)).toEqual([UUID_HUGE, UUID_MID, UUID_SMALL])
    // 排序键与全量摘要语义（transcriptReducer 的 modifiedAt）同值
    expect(sessions[0]!.modifiedAt).toBe(LATE)
    expect(sessions[1]!.modifiedAt).toBe(MIDDLE)
    expect(sessions[2]!.modifiedAt).toBe(EARLIER)
  })

  test('尾部 user 行 > 1MB：超出最大扩窗窗口，仍回退全量语义', async () => {
    await writeSessionFile(UUID_SMALL, [userLine(EARLIER, 'a'.repeat(64))], EARLIER)
    await writeSessionFile(UUID_MID, [userLine(MIDDLE, 'b'.repeat(64))], MIDDLE)
    await writeSessionFile(
      UUID_HUGE,
      [userLine(EARLIER, 'x'.repeat(32)), userLine(LATE, 'y'.repeat(1_200 * 1024))],
      HUGE_MTIME,
    )

    const { sessions } = await svc.listSessions({ limit: 10 })

    expect(sessions.map((item) => item.id)).toEqual([UUID_HUGE, UUID_MID, UUID_SMALL])
    expect(sessions[0]!.modifiedAt).toBe(LATE)
  })

  test('普通大会话（尾部行完整但文件很大）不受扩窗影响，仍取最后一条内容时间戳', async () => {
    // 300KB 文件、尾部行完整：64KB 窗口内末段可解析 → 无需扩窗也正确
    const filler = Array.from({ length: 30 }, (_, i) =>
      userLine(EARLIER, `${'f'.repeat(8 * 1024)}-${i}`),
    )
    await writeSessionFile(UUID_HUGE, [...filler, userLine(LATE, 'tail')], HUGE_MTIME)
    await writeSessionFile(UUID_SMALL, [userLine(MIDDLE, 'a'.repeat(64))], MIDDLE)

    const { sessions } = await svc.listSessions({ limit: 10 })

    expect(sessions.map((item) => item.id)).toEqual([UUID_HUGE, UUID_SMALL])
    expect(sessions[0]!.modifiedAt).toBe(LATE)
  })
})

/**
 * 低3（v1.5.0 第二批）：?tail=N 改走流式窗口读取——语义必须与旧实现
 * （全量读取后 slice(-N)）一致，只是不再 parse 全文。
 */
describe('getSessionMessagesWindow 无 before 时等价于全量尾部切片（低3）', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let svc: SessionService

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-tail-window-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    svc = new SessionService()
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('尾部 N 条与全量 slice(-N) 逐条一致（含中间坏行）', async () => {
    const projectDir = path.join(tmpDir, 'projects', 'D--xxw-p-claude-code-heihei')
    await fs.mkdir(projectDir, { recursive: true })
    const lines: string[] = []
    for (let i = 0; i < 12; i += 1) {
      if (i === 8) {
        lines.push('{ this is a malformed line') // 坏行：两条路径都应跳过
        continue
      }
      lines.push(
        JSON.stringify({
          type: i % 2 === 0 ? 'user' : 'assistant',
          uuid: `m${i}`,
          timestamp: `2026-09-0${(i % 9) + 1}T00:00:00.000Z`,
          message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` },
        }),
      )
    }
    await fs.writeFile(
      path.join(projectDir, `${UUID}.jsonl`),
      lines.join('\n') + '\n',
      'utf-8',
    )

    const full = await svc.getSessionMessages(UUID)
    for (const n of [1, 3, 5, 20]) {
      const window = await svc.getSessionMessagesWindow(UUID, { limit: n })
      expect(window.messages).toEqual(full.slice(-n))
    }
  })
})
