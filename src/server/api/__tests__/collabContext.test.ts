import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleCollabContextApi } from '../collabContext.js'
import { collabTaskService } from '../../services/collabTaskService.js'
import { sessionService } from '../../services/sessionService.js'
import { registerSession } from '../../services/sessionRegistry.js'
import { ServantService } from '../../services/servantService.js'
import { SERVER_CAPABILITIES } from '../../services/serverIdentity.js'
import {
  COLLAB_RULES_DIGEST,
  COLLAB_RULES_DIGEST_MAX_CODEPOINTS,
  DISPATCH_PROTOCOL_MD,
} from '../../../collaboration/dispatchProtocol.js'
import {
  FORBIDDEN_TURN_STATE_FIELDS,
  SERVER_CAPABILITY_COLLAB_CONTEXT,
} from '../../../collaboration/collabToolContract.js'

// 注：状态推进一律走 transitionTask，与线上流转表一致，避免测试自己造状态机。

/**
 * v1.6.1 GET /api/collab-context（架构裁决：架构决策_上下文自动续接.md §二、
 * §三 与「验收标准」4~5 条）。
 *
 * 这里守的是后端的硬约束：按调用者身份裁剪、字段白名单、绝不出现回合态、
 * 规则摘要是真源子串、capability 已声明、未知会话给明确错误而不是空数据套壳。
 * CLI 侧的附件工厂与降级不在这里测。
 */

describe('GET /api/collab-context', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-ctx-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function registerWorker(input: {
    role?: string
    description?: string
    supervisor?: boolean
  }): Promise<string> {
    const worker = await sessionService.createSession(tmpDir)
    registerSession(worker.sessionId)
    await new ServantService().setServant(worker.sessionId, {
      role: input.role ?? '测试员工',
      ...(input.description !== undefined ? { description: input.description } : {}),
      enabled: true,
      ...(input.supervisor !== undefined ? { supervisor: input.supervisor } : {}),
    })
    return worker.sessionId
  }

  async function callContext(sessionId?: string): Promise<Response> {
    const url = new URL('http://127.0.0.1/api/collab-context')
    if (sessionId !== undefined) url.searchParams.set('sessionId', sessionId)
    return handleCollabContextApi(new Request(url.toString()), url)
  }

  async function dispatchTo(
    toSessionId: string,
    fromSessionId: string,
    content: string,
    title = '标题',
  ) {
    return collabTaskService.recordDispatch({ toSessionId, fromSessionId, content, title })
  }

  it('未知 sessionId 返回 404 而不是空数据套壳', async () => {
    const res = await callContext('does-not-exist')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('NOT_FOUND')
  })

  it('缺少 sessionId 参数返回 400', async () => {
    const res = await callContext()
    expect(res.status).toBe(400)
  })

  it('主管拿到花名册（角色→sessionId，不带 description）与规则摘要', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    await registerWorker({ role: '后端', description: '服务端开发与 API 设计' })
    await registerWorker({ role: '设计师', description: '界面/交互/视觉规范' })

    const res = await callContext(supervisor)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      supervisor: boolean
      rulesDigest?: string
      roster?: Array<Record<string, unknown>>
    }

    expect(body.supervisor).toBe(true)
    expect(body.rulesDigest).toBe(COLLAB_RULES_DIGEST)
    expect(body.roster).toBeDefined()
    const roles = (body.roster ?? []).map((entry) => entry.role)
    expect(roles).toContain('后端')
    expect(roles).toContain('设计师')
    // 花名册精简版：只有 role/sessionId（+ 有 supervisor 标记时才带），不含 description
    for (const entry of body.roster ?? []) {
      for (const key of Object.keys(entry)) {
        expect(['role', 'sessionId', 'supervisor']).toContain(key)
      }
      expect(entry).toHaveProperty('role')
      expect(entry).toHaveProperty('sessionId')
      expect(entry).not.toHaveProperty('description')
    }
  })

  it('员工拿不到花名册与规则摘要，只得到自己的任务', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const alice = await registerWorker({ role: '后端' })
    const bob = await registerWorker({ role: '测试' })
    await dispatchTo(alice, supervisor, '给 alice 的活', '给 alice 的活')
    await dispatchTo(bob, supervisor, '给 bob 的活', '给 bob 的活')

    const res = await callContext(alice)
    const body = (await res.json()) as {
      supervisor: boolean
      roster?: unknown
      rulesDigest?: unknown
      tasks: { items: Array<{ taskId: string; title: string }> }
    }

    expect(body.supervisor).toBe(false)
    expect(body.roster).toBeUndefined()
    expect(body.rulesDigest).toBeUndefined()
    expect(body.tasks.items).toHaveLength(1)
    expect(body.tasks.items[0]!.title).toBe('给 alice 的活')
  })

  it('主管的未结任务最多 10 条，delivered 待验收排最前', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    for (let i = 0; i < 12; i += 1) {
      await dispatchTo(worker, supervisor, `任务-${i}`, `任务-${i}`)
    }
    // 把最早那条推到 delivered：它必须排在最前，即使 updatedAt 最旧
    const all = await collabTaskService.listTasks({ projectDir: tmpDir })
    const wanted = all.find((task) => task.title === '任务-0')!
    await collabTaskService.transitionTask(wanted.id, 'accepted')
    await collabTaskService.reportTask(wanted.id, { summary: '做完了', deliverables: [] })

    const res = await callContext(supervisor)
    const body = (await res.json()) as {
      tasks: { counts: Record<string, number>; items: Array<{ title: string; status: string }>; truncated: number }
    }

    expect(body.tasks.items).toHaveLength(10)
    expect(body.tasks.truncated).toBe(2)
    expect(body.tasks.items[0]!.status).toBe('delivered')
    expect(body.tasks.items[0]!.title).toBe('任务-0')
    expect(body.tasks.counts.delivered).toBe(1)
  })

  it('主管条目只对 rework 附 note，且任何条目都不含任务正文', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const taskId = (await dispatchTo(worker, supervisor, '正文里有关键信息', '返工对象'))!
    await collabTaskService.transitionTask(taskId, 'accepted')
    await collabTaskService.reportTask(taskId, { summary: '第一版', deliverables: [] })
    await collabTaskService.reviewTask(taskId, { verdict: 'rework', note: '缺边界用例' })

    const res = await callContext(supervisor)
    const body = (await res.json()) as {
      tasks: { items: Array<Record<string, unknown>> }
    }
    const item = body.tasks.items.find((entry) => entry.taskId === taskId)!
    expect(item.status).toBe('rework')
    expect(item.reworkCount).toBe(1)
    expect(item.lastReworkNote).toBe('缺边界用例')
    // 不放正文
    expect(item).not.toHaveProperty('content')
  })

  it('员工条目不含正文，只有 currentTask 带正文（≤800 码点）', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const long = 'x'.repeat(1200)
    const taskId = (await dispatchTo(worker, supervisor, long, '长正文任务'))!
    await collabTaskService.transitionTask(taskId, 'accepted')
    await collabTaskService.transitionTask(taskId, 'in_progress')

    const res = await callContext(worker)
    const body = (await res.json()) as {
      tasks: { items: Array<Record<string, unknown>> }
      currentTask?: { taskId: string; content: string; contentTruncated: boolean }
    }

    for (const item of body.tasks.items) expect(item).not.toHaveProperty('content')
    expect(body.currentTask?.taskId).toBe(taskId)
    expect(Array.from(body.currentTask!.content).length).toBe(800)
    expect(body.currentTask!.contentTruncated).toBe(true)
  })

  it('员工最多 5 条自己的未结任务', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    for (let i = 0; i < 7; i += 1) await dispatchTo(worker, supervisor, `活-${i}`, `活-${i}`)

    const res = await callContext(worker)
    const body = (await res.json()) as { tasks: { items: unknown[]; truncated: number } }
    expect(body.tasks.items).toHaveLength(5)
    expect(body.tasks.truncated).toBe(2)
  })

  it('响应里不出现任何回合态字段（递归扫描）', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    await dispatchTo(worker, supervisor, '随便一条')

    for (const who of [supervisor, worker]) {
      const res = await callContext(who)
      const body = await res.json()
      // 白名单外的字段一律不存在；这里再对已知禁用名做一次深度扫描
      const raw = JSON.stringify(body)
      for (const field of FORBIDDEN_TURN_STATE_FIELDS) {
        expect(raw).not.toContain(`"${field}"`)
      }
      for (const extra of ['busy', 'phase', 'turnState', 'running', 'turnInProgress']) {
        expect(raw).not.toContain(`"${extra}"`)
      }
    }
  })
})

describe('协作上下文：规则摘要真源与能力声明', () => {
  it('COLLAB_RULES_DIGEST 每句都逐字来自 DISPATCH_PROTOCOL_MD（防两套说法）', () => {
    const lines = COLLAB_RULES_DIGEST.split('\n').filter((line) => line.trim().length > 0)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(DISPATCH_PROTOCOL_MD).toContain(line)
    }
  })

  it('COLLAB_RULES_DIGEST 不超过上限码点，且覆盖裁决要求的关键语义', () => {
    expect(Array.from(COLLAB_RULES_DIGEST).length).toBeLessThanOrEqual(
      COLLAB_RULES_DIGEST_MAX_CODEPOINTS,
    )
    for (const key of [
      '按花名册',
      'enabled',
      '禁止自己做',
      '员工结论冲突的裁决',
      '花名册无',
      '不深读代码',
      'DELETE /api/sessions/<id>',
      '派活页脚',
    ]) {
      expect(COLLAB_RULES_DIGEST).toContain(key)
    }
  })

  it('whoami capabilities 已声明 collab-context（只增不改）', () => {
    expect(SERVER_CAPABILITIES).toContain(SERVER_CAPABILITY_COLLAB_CONTEXT)
    expect(SERVER_CAPABILITY_COLLAB_CONTEXT).toBe('collab-context')
  })
})
