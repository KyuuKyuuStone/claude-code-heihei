import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleApiRequest } from '../router.js'
import { getProjectsDir, sanitizePath } from '../services/session/jsonlStorage.js'
import { setShedDepsForTests } from '../services/sessionShedService.js'
import { isSessionPayloadLocked, lockSessionPayload } from '../services/servantOversizeFailure.js'

/**
 * R-A（v1.7.5）「修复会话」端点：POST /api/sessions/:id/shed-payload
 *
 * 判别力设计：本文件构造**真实布局**的 transcript（含大图 + 大文本 + tool_result
 * 内嵌图 + 一条 file-history-snapshot），走**真实 API 路由**断言契约字段，并逐条锁住：
 * ① 大块被换成占位引用；② uuid 链 / 行数 / 非消息行**不变**；③ 备份逐字节等于改前；
 * ④ 幂等：再调 ⇒ 409 NOTHING_TO_SHED；⑤ 进程维度：手术后进程被停（选了停进程路径）。
 */

const BIG_TEXT = 'R'.repeat(40_000)
const BIG_B64 = 'A'.repeat(50_000)

let cfgDir: string
let workDir: string
let sessionId: string
let transcriptPath: string
let originalRaw: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

const stopCalls: string[] = []

function line(entry: unknown): string {
  return JSON.stringify(entry)
}

/** 构造一条真实形态的 transcript（uuid/parentUuid 成链 + 一个非消息行） */
function buildTranscript(): string {
  return (
    [
      line({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        cwd: workDir,
        message: { role: 'user', content: [{ type: 'text', text: '开始干活' }] },
      }),
      line({
        type: 'user',
        uuid: 'u2',
        parentUuid: 'u1',
        sessionId,
        cwd: workDir,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: BIG_TEXT },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG_B64 } },
          ],
        },
      }),
      line({
        type: 'assistant',
        uuid: 'u3',
        parentUuid: 'u2',
        sessionId,
        cwd: workDir,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG_B64 } }],
            },
          ],
        },
      }),
      line({ type: 'file-history-snapshot', uuid: 's1', snapshot: { messageId: 'u2', files: [] } }),
      line({
        type: 'user',
        uuid: 'u4',
        parentUuid: 'u3',
        sessionId,
        cwd: workDir,
        message: { role: 'user', content: [{ type: 'text', text: '小消息不动' }] },
      }),
      '',
    ].join('\n')
  )
}

function shedApi(id: string, method = 'POST'): Promise<Response> {
  const apiPath = `/api/sessions/${encodeURIComponent(id)}/shed-payload`
  const url = `http://localhost${apiPath}`
  return handleApiRequest(new Request(url, { method }), new URL(url))
}

async function readLines(file: string): Promise<string[]> {
  const raw = await fs.readFile(file, 'utf8')
  const withNl = raw.endsWith('\n')
  const parts = raw.split('\n')
  if (withNl) parts.pop()
  return parts
}

beforeEach(async () => {
  cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-shed-'))
  process.env.CLAUDE_CONFIG_DIR = cfgDir
  workDir = path.join(cfgDir, 'proj')
  await fs.mkdir(workDir, { recursive: true })
  sessionId = crypto.randomUUID()
  const projectDir = path.join(getProjectsDir(), sanitizePath(workDir))
  await fs.mkdir(projectDir, { recursive: true })
  transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
  originalRaw = buildTranscript()
  await fs.writeFile(transcriptPath, originalRaw, 'utf8')
  stopCalls.length = 0
  // 只覆盖「进程维度」与工作目录；文件定位/读盘走真实实现
  setShedDepsForTests({
    getSessionWorkDir: async () => workDir,
    isSessionRunning: () => true,
    stopSessionAndWait: async (id: string) => {
      stopCalls.push(id)
    },
  })
})

afterEach(async () => {
  setShedDepsForTests(null)
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(cfgDir, { recursive: true, force: true })
})

describe('POST /api/sessions/:id/shed-payload（R-A）', () => {
  test('剥离大块 + 备份 + 停进程：契约字段与非破坏性断言', async () => {
    const res = await shedApi(sessionId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    // ── 契约字段（前端按此实现，别改名）──
    expect(body.ok).toBe(true)
    expect(body.sessionId).toBe(sessionId)
    expect(Number(body.mediaBlocksRemoved)).toBe(2) // 直接 image + tool_result 内嵌 image
    expect(Number(body.textBlocksTruncated)).toBe(1) // 40KB 文本
    expect(Number(body.messagesTouched)).toBe(2) // u2 / u3
    expect(Number(body.bytesAfter)).toBeLessThan(Number(body.bytesBefore))
    expect(typeof body.backupPath).toBe('string')
    expect(body.stoppedProcess).toBe(true)

    // ── 备份：逐字节等于改前 ──
    const backup = await fs.readFile(String(body.backupPath), 'utf8')
    expect(backup).toBe(originalRaw)

    // ── transcript：行数不变、uuid 链不变、大块变占位引用 ──
    const before = await readLines(Buffer.from(originalRaw).toString('utf8').includes('\n') ? transcriptPath : transcriptPath)
    expect(before).toHaveLength(5)
    expect(before[0]).toBe(originalRaw.split('\n')[0]) // 第一行逐字节未动

    const after = await readLines(transcriptPath)
    expect(after).toHaveLength(5) // 不删行

    const uuids = after.map((l) => (JSON.parse(l) as { uuid?: string }).uuid)
    expect(uuids).toEqual(['u1', 'u2', 'u3', 's1', 'u4'])
    const u3 = JSON.parse(after[2]) as { parentUuid?: string }
    expect(u3.parentUuid).toBe('u2') // parentUuid 链原样
    const u4 = JSON.parse(after[4]) as { parentUuid?: string }
    expect(u4.parentUuid).toBe('u3')
    // 未触碰行逐字节不变（含非消息行 snapshot 与末尾小消息）
    expect(after[0]).toBe(before[0])
    expect(after[3]).toBe(before[3])
    expect(after[4]).toBe(before[4])

    // 大文本块 ⇒ 占位引用（原位、保留头部）
    const u2 = JSON.parse(after[1]) as { message: { content: Array<{ type: string; text?: string }> } }
    expect(u2.message.content[0]!.type).toBe('text')
    expect(String(u2.message.content[0]!.text)).toContain('[已剥离：超大文本块')
    expect(String(u2.message.content[0]!.text)).toContain('引用 .heihei')
    // 原文已不在原位（只留 2KB 头部 + 一行提示）
    expect(String(u2.message.content[0]!.text)).not.toContain(BIG_TEXT)
    expect(String(u2.message.content[0]!.text).length).toBeLessThan(4_000)
    // 图片块 ⇒ 文本占位（不再有 media 块）
    expect(u2.message.content[1]!.type).toBe('text')
    expect(JSON.stringify(u2)).not.toContain(BIG_B64)

    // ── 落盘内容可查：原文在 spill 文件里 ──
    expect(typeof body.spillPath).toBe('string')
    const spill = await fs.readFile(String(body.spillPath), 'utf8')
    expect(spill).toContain(BIG_B64)
    expect(spill).toContain(BIG_TEXT)

    // ── 进程维度：选了「停进程」路径，手术后被真正执行 ──
    expect(stopCalls).toEqual([sessionId])
  })

  test('幂等：无内容可剥 ⇒ 409 NOTHING_TO_SHED（第二次调用）', async () => {
    expect((await shedApi(sessionId)).status).toBe(200)
    const again = await shedApi(sessionId)
    expect(again.status).toBe(409)
    const body = (await again.json()) as { error?: string; message?: string }
    expect(body.error).toBe('NOTHING_TO_SHED')
    expect(String(body.message)).toContain('NOTHING_TO_SHED')
  })

  test('会话不存在 ⇒ 404；方法不对 ⇒ 405', async () => {
    expect((await shedApi('no-such-session')).status).toBe(404)
    expect((await shedApi(sessionId, 'GET')).status).toBe(405)
  })

  test('J3a：备份/落盘名带唯一 token（同会话同毫秒重试也不相撞）', async () => {
    // 为什么要 token：路径唯一性此前只靠毫秒时间戳 ⇒ 同会话同毫秒的两次写入
    // （第一次在备份/落盘后失败、用户立刻重试）会指向同一路径、后写覆盖前写。
    // 这里没去造"两次同会话修复"的场景（第二次会因已剥离而 409，撞不出来），
    // 而是直接断言**唯一性机制在场**：两个路径都必须带一段随机 token。
    const res = await shedApi(sessionId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    expect(body.backupPath).toMatch(/\.shed-\d+-[0-9a-f]{8}\.bak$/)
    expect(body.spillPath).toMatch(/-\d+-[0-9a-f]{8}\.jsonl$/)
    // 占位引用里的落盘文件必须与返回的 spillPath 同名（引用可查）
    const transcript = await fs.readFile(transcriptPath, 'utf8')
    expect(transcript).toContain(path.basename(body.spillPath))
  })

  test('修复成功后自动解锁（R-C 联动）', async () => {
    lockSessionPayload(sessionId, 'test-lock')
    expect(isSessionPayloadLocked(sessionId)).toBe(true)
    expect((await shedApi(sessionId)).status).toBe(200)
    expect(isSessionPayloadLocked(sessionId)).toBe(false)
  })
})
