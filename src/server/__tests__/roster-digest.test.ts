import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildRosterDigestSegmentForSupervisor,
  formatRosterDigest,
  ROSTER_DIGEST_MARK,
  ROSTER_DIGEST_SEGMENT_CLOSE,
  ROSTER_DIGEST_SEGMENT_OPEN,
  setRosterDigestDepsForTests,
  stripRosterDigestFromContent,
  stripRosterDigestSegment,
  type RosterDigestEntry,
} from '../services/rosterDigest.js'
import { entriesToMessages, entryToMessage } from '../services/session/messageConversion.js'
import { extractReplayUserText } from '../ws/localCommandParsing.js'
import { setDiagnosticsLogWriterForTests } from '../../utils/diagLogs.js'

/**
 * v1.7.4 B2 + 修缺陷：给在册主管的注入消息捎带花名册摘要。
 *
 * 契约（本文件即守护）：
 *  · **模型/主管上下文可见**——摘要以独立系统段前置进送 SDK 的正文；
 *  · **用户不可见**——UI 读路径（转录 → MessageEntry 转换）剥掉该段，正文/页脚一字不动；
 *  · 只对主管、幂等、花名册读失败降级不阻塞（留诊断）。
 */

const sup: RosterDigestEntry = { sessionId: 'sup-1', supervisor: true, enabled: true }
const emp = (role: string, i = 0): RosterDigestEntry => ({ sessionId: `emp-${role}-${i}`, role, enabled: true })
const DIGEST_LINE = `${ROSTER_DIGEST_MARK}主管 1 人；员工 2 人：前端、后端`
const SEGMENT = `${ROSTER_DIGEST_SEGMENT_OPEN}\n${DIGEST_LINE}\n${ROSTER_DIGEST_SEGMENT_CLOSE}`

function withRoster(entries: RosterDigestEntry[]) {
  setRosterDigestDepsForTests({ listServants: async () => entries })
}
afterEach(() => {
  setRosterDigestDepsForTests(null)
  setDiagnosticsLogWriterForTests(null)
})

describe('rosterDigest（B2）构造系统段', () => {
  test('① 在册主管 ⇒ 返回**独立系统段**（包裹 + 单行摘要）；非主管/未在册 ⇒ null', async () => {
    withRoster([sup, emp('前端'), emp('后端')])
    const segment = await buildRosterDigestSegmentForSupervisor('sup-1', '帮我看看进度')
    expect(segment).toBe(SEGMENT)
    // 员工侧不注入
    expect(await buildRosterDigestSegmentForSupervisor('emp-前端-0', '干活')).toBeNull()
    // 未在册会话不注入
    expect(await buildRosterDigestSegmentForSupervisor('nobody', 'x')).toBeNull()
  })

  test('② 超 8 截断：只列前 8 个 role + 「等 N 人」（N = role 总数）', async () => {
    const roles = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10']
    withRoster([sup, ...roles.map((r) => emp(r))])
    const segment = await buildRosterDigestSegmentForSupervisor('sup-1', 'x')
    expect(segment).toContain('员工 10 人：r1、r2、r3、r4、r5、r6、r7、r8等 10 人')
    expect(segment).not.toContain('r9')
  })

  test('③ 空册形态：员工 0 人（暂无可用员工）', async () => {
    withRoster([sup])
    expect(formatRosterDigest([sup])).toBe(`${ROSTER_DIGEST_MARK}主管 1 人；员工 0 人（暂无可用员工）`)
    expect(await buildRosterDigestSegmentForSupervisor('sup-1', '有人吗')).toContain('员工 0 人（暂无可用员工）')
  })

  test('④ 幂等：正文已含摘要标记 ⇒ 不再注入', async () => {
    withRoster([sup, emp('前端')])
    expect(await buildRosterDigestSegmentForSupervisor('sup-1', `已经带了 ${ROSTER_DIGEST_MARK}主管 1 人`)).toBeNull()
  })

  test('⑤ 花名册读失败 ⇒ 降级为不注入（不阻塞投递）+ 留痕（不静默）', async () => {
    const logs: Array<{ level: string; event: string; data: Record<string, unknown> }> = []
    setDiagnosticsLogWriterForTests((level, event, data) => {
      logs.push({ level, event, data })
    })
    setRosterDigestDepsForTests({
      listServants: async () => {
        throw new Error('ENOENT: open C:\\Users\\alice\\.claude\\servants.json')
      },
    })

    expect(await buildRosterDigestSegmentForSupervisor('sup-1', '派活正文')).toBeNull()
    // 留痕：warn 级 + 明确事件名
    const hit = logs.find((l) => l.event === 'roster_digest_list_failed')
    expect(hit).toBeTruthy()
    expect(hit?.level).toBe('warn')
    // 只记 error.name：message（此处含路径）绝不落地——diagLogs 契约禁 PII
    expect(hit?.data.error).toBe('Error')
    expect(JSON.stringify(hit?.data ?? {})).not.toContain('ENOENT')
    expect(JSON.stringify(hit?.data ?? {})).not.toContain('alice')
  })
})

describe('rosterDigest（修缺陷）UI 读路径剥离', () => {
  test('⑥ 剥离系统段：正文与页脚一字不动；页脚仍是最后一个非空行', () => {
    const content = `${SEGMENT}\n\n派活正文\n\n任务 ID：abc-123；完工汇报目标：sup-1；`
    const out = stripRosterDigestSegment(content)
    expect(out).not.toContain(ROSTER_DIGEST_MARK)
    expect(out).not.toContain(ROSTER_DIGEST_SEGMENT_OPEN)
    expect(out.startsWith('派活正文')).toBe(true)
    const nonEmpty = out.split('\n').filter((l) => l.trim())
    expect(nonEmpty[nonEmpty.length - 1]).toContain('任务 ID：abc-123')
  })

  test('⑦ 只剥**本模块的**系统段：CLI 自己的 <system-reminder> 原样保留；无标记时返回原引用', () => {
    const foreign = '<system-reminder>\n这是 CLI 注入的提醒\n</system-reminder>'
    expect(stripRosterDigestSegment(foreign)).toBe(foreign)
    const mixed = `${SEGMENT}\n\n${foreign}\n\n用户正文`
    const out = stripRosterDigestSegment(mixed)
    expect(out).not.toContain(ROSTER_DIGEST_MARK)
    expect(out).toContain('这是 CLI 注入的提醒')
    expect(out).toContain('用户正文')
  })

  test('⑦b 历史数据形态（无包裹的裸摘要行）**不动**（按裁决：旧数据另行处置）', () => {
    const legacy = `派活正文\n\n${DIGEST_LINE}`
    expect(stripRosterDigestSegment(legacy)).toBe(legacy)
  })
  test('⑧ content 形态：string 与 block 数组都剥；无命中保持原引用（不动下游 memo）', () => {
    const blocks = [
      { type: 'text', text: `${SEGMENT}\n\n正文 A` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
    ]
    const out = stripRosterDigestFromContent(blocks) as Array<Record<string, unknown>>
    expect(String((out[0] as { text: string }).text)).toBe('正文 A')
    // 非 text 块原样
    expect(out[1]).toBe(blocks[1] as unknown as Record<string, unknown>)
    // 无命中：原引用返回
    const clean = [{ type: 'text', text: '干净正文' }]
    expect(stripRosterDigestFromContent(clean)).toBe(clean)
    expect(stripRosterDigestFromContent('干净正文')).toBe('干净正文')
  })

  test('⑨ 转录读路径（entryToMessage）：用户条目里的系统段被剥掉（前端拿不到摘要）', () => {
    const entry = {
      type: 'user',
      uuid: 'u-1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: `${SEGMENT}\n\n我需要开始新功能的开发了` },
    }
    const message = entryToMessage(entry as never)
    expect(message).toBeTruthy()
    const text = String(message?.content)
    expect(text).not.toContain(ROSTER_DIGEST_MARK)
    expect(text).toContain('我需要开始新功能的开发了')

    // block 数组形态同样被剥
    const blockEntry = {
      type: 'user',
      uuid: 'u-2',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: `${SEGMENT}\n\n正文 B` }] },
    }
    const blockMessage = entryToMessage(blockEntry as never)
    expect(String((blockMessage?.content as Array<{ text: string }>)[0]?.text)).toBe('正文 B')
  })
})

describe('rosterDigest（修缺陷）历史链路', () => {
  test('⑫ 历史 API 链路（entriesToMessages）：整链输出无摘要（前端/接口层面拿不到）', () => {
    const entries = [
      {
        type: 'user',
        uuid: 'h-1',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: `${SEGMENT}\n\n我需要开始新功能的开发了` },
      },
      {
        type: 'assistant',
        uuid: 'h-2',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
      },
    ]
    const messages = entriesToMessages(entries as never)
    const dumped = JSON.stringify(messages)
    expect(dumped).not.toContain(ROSTER_DIGEST_MARK)
    expect(dumped).toContain('我需要开始新功能的开发了')
  })
})

  test('⑬ 实时通道（user_message_replay）：CLI 回显正文剥掉系统段后才重放给 UI', () => {
    const asString = {
      isReplay: true,
      message: { role: 'user', content: `${SEGMENT}\n\n我需要开始新功能的开发了` },
    }
    expect(extractReplayUserText(asString)).toBe('我需要开始新功能的开发了')
    const asBlocks = {
      isReplay: true,
      message: { role: 'user', content: [{ type: 'text', text: `${SEGMENT}\n\n正文 C` }] },
    }
    const replay = extractReplayUserText(asBlocks)
    expect(replay).toBe('正文 C')
    expect(replay).not.toContain(ROSTER_DIGEST_MARK)
  })

describe('rosterDigest（修缺陷）模型侧可见 + 唯一注入点', () => {
  test('⑩ sendMessage：送 CLI 的 user 正文**含**系统段（B2 能力未退化）', async () => {
    const { ConversationService } = await import('../services/conversationService.js')
    withRoster([sup, emp('前端'), emp('后端')])
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-roster-'))
    const sent: string[] = []
    const service = new ConversationService() as never as {
      sessions: Map<string, unknown>
      sendMessage: (id: string, content: string) => Promise<boolean>
    }
    service.sessions.set('sup-1', {
      proc: {},
      outputCallbacks: [],
      workDir: tmpDir,
      permissionMode: 'default',
      sdkSocket: {
        send(line: string) {
          sent.push(line)
        },
      },
      pendingOutbound: [],
      startupPending: false,
      startupExitCode: null,
      stdoutLines: [],
      stderrLines: [],
      outputDrain: Promise.resolve(),
      sdkMessages: [],
      initMessage: null,
      pendingPermissionRequests: new Map(),
    })

    try {
      const ok = await service.sendMessage('sup-1', '帮我看看进度')
      expect(ok).toBe(true)
      const userLine = sent.map((line) => JSON.parse(line) as Record<string, never>).find((m) => m.type === 'user')
      expect(userLine).toBeTruthy()
      const content = (userLine as unknown as { message: { content: Array<{ text: string }> } }).message.content
      const text = content.map((block) => block.text ?? '').join('\n')
      expect(text).toContain(ROSTER_DIGEST_MARK)
      expect(text).toContain('帮我看看进度')
      expect(text.indexOf(ROSTER_DIGEST_SEGMENT_OPEN)).toBeLessThan(text.indexOf('帮我看看进度'))
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('⑪ 唯一注入点：两条上游（WS / 投递）都不自行注入摘要，只把正文交给 sendMessage', async () => {
    const read = (rel: string) => fs.readFile(new URL(rel, import.meta.url), 'utf8')
    const ws = await read('../ws/handler.ts')
    const messenger = await read('../services/sessionMessenger.ts')

    for (const [name, source] of [
      ['ws/handler.ts', ws],
      ['services/sessionMessenger.ts', messenger],
    ] as const) {
      // 上游一律不碰摘要（没有第二条注入路径 ⇒ 覆盖一条即覆盖两条）
      expect(source).not.toContain('buildRosterDigestSegmentForSupervisor')
      expect(source).not.toContain(ROSTER_DIGEST_MARK)
      // 且都经唯一注入点 conversationService.sendMessage 上行
      expect(source).toContain('conversationService.sendMessage')
    }
  })
})
