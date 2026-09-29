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
