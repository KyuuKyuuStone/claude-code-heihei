import { mkdtempReal } from "./fixtures/tmp-dir.js"
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleApiRequest } from '../router.js'
import { collabTaskService } from '../services/collabTaskService.js'
import { sameProject } from '../../collaboration/projectPath.js'
import { registerSession, resetRegistryForTests } from '../services/sessionRegistry.js'
import { sessionService } from '../services/sessionService.js'
import { ServantService } from '../services/servantService.js'

/**
 * v1.6.0 CLI 契约 §三：report/review 的 callerSessionId 权限校验（闭合审查「低 1」），
 * 以及 §一.4 的客户端预生成 taskId 幂等。全部走 HTTP 层，保证 API 契约本身被锁死。
 */

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(async () => {
  tmpDir = await mkdtempReal('collab-tasks-api-')
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  collabTaskService.resetForTests()
  resetRegistryForTests()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/** 登记一个真实会话为在册员工（投递/花名册语义都要求已登记） */
async function registerWorker(
  input: { role?: string; supervisor?: boolean; projectDir?: string } = {},
): Promise<string> {
  const session = await sessionService.createSession(input.projectDir ?? tmpDir)
  registerSession(session.sessionId)
  await new ServantService().setServant(session.sessionId, {
    role: input.role ?? '后端',
    enabled: true,
    ...(input.supervisor !== undefined ? { supervisor: input.supervisor } : {}),
  })
  return session.sessionId
}

function callApi(method: string, apiPath: string, body?: unknown): Promise<Response> {
  const url = `http://localhost${apiPath}`
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return handleApiRequest(new Request(url, init), new URL(url))
}

async function makeTask(input: {
  from: string
  to: string
  id?: string
  projectDir?: string
}): Promise<string> {
  const task = await collabTaskService.createTask({
    ...(input.id ? { id: input.id } : {}),
    projectDir: input.projectDir ?? tmpDir,
    fromSessionId: input.from,
    toSessionId: input.to,
    title: '实现接口',
    content: '实现登录接口',
  })
  // 状态机：dispatch 不能直接 report（409）。真实链路里 accepted/in_progress
  // 由员工回合开始事件推进，这里显式推进到 in_progress 以对齐 reportTask 的前置。
  await collabTaskService.transitionTask(task.id, 'accepted')
  await collabTaskService.transitionTask(task.id, 'in_progress')
  return task.id
}

// ── report：callerSessionId 必须是被派活的员工 ──────────────────────────

describe('POST /api/collab-tasks/:id/report — callerSessionId 校验', () => {
  it('受派员工本人调用 → 200 并推进到 delivered', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const taskId = await makeTask({ from: supervisor, to: worker })

    const res = await callApi('POST', `/api/collab-tasks/${taskId}/report`, {
      summary: '做完了',
      callerSessionId: worker,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task?: { status?: string } }
    expect(body.task?.status).toBe('delivered')
  })

  it('跨员工冒名（caller 是另一个员工）→ 403，且不改状态', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const other = await registerWorker({ role: '前端' })
    const taskId = await makeTask({ from: supervisor, to: worker })

    const res = await callApi('POST', `/api/collab-tasks/${taskId}/report`, {
      summary: '我替他交了',
      callerSessionId: other,
    })
    expect(res.status).toBe(403)
    // 台账没被越权改动（仍停在 in_progress）
    expect((await collabTaskService.getTask(taskId))?.status).toBe('in_progress')
  })

  it('越权：主管冒充员工汇报 → 403（主管不是受派人）', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const taskId = await makeTask({ from: supervisor, to: worker })

    const res = await callApi('POST', `/api/collab-tasks/${taskId}/report`, {
      summary: '主管替员工交',
      callerSessionId: supervisor,
    })
    expect(res.status).toBe(403)
  })

  it('不带 callerSessionId → 维持旧行为（兼容旧调用方），200', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const taskId = await makeTask({ from: supervisor, to: worker })

    const res = await callApi('POST', `/api/collab-tasks/${taskId}/report`, { summary: '旧调用方' })
    expect(res.status).toBe(200)
  })

  it('带 callerSessionId 但任务不存在 → 404（不是 403）', async () => {
    const worker = await registerWorker({ role: '后端' })
    const res = await callApi('POST', '/api/collab-tasks/no-such-task/report', {
      summary: 'x',
      callerSessionId: worker,
    })
    expect(res.status).toBe(404)
  })

  // ── v1.7.5 补齐：report 端点也接同一套正文总闸（此前是 413 绕过面）──────

  it('P-B1 补充：summary 超上限 ⇒ 413 结构化拒绝，且台账不被推进', async () => {
    const { resolveSessionMessageMaxBytes } = await import('../services/messageSizeLimits.js')
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const taskId = await makeTask({ from: supervisor, to: worker })

    process.env.CC_HEIHEI_SESSION_MESSAGE_MAX_BYTES = '1024'
    try {
      const limit = resolveSessionMessageMaxBytes()
      const res = await callApi('POST', `/api/collab-tasks/${taskId}/report`, {
        summary: 'x'.repeat(limit + 1),
        callerSessionId: worker,
      })
      expect(res.status).toBe(413)
      const body = (await res.json()) as { error?: string; message?: string }
      expect(body.error).toBe('PAYLOAD_TOO_LARGE')
      expect(String(body.message)).toContain('summary')
      expect(String(body.message)).toContain(`${limit + 1} bytes`)
      // 未推进台账：状态仍停在派活态，也没有留下 report 正文
      const task = await collabTaskService.getTask(taskId)
      expect(task?.status).not.toBe('delivered')
      expect(String(task?.report ?? '')).not.toContain('x'.repeat(100))
    } finally {
      delete process.env.CC_HEIHEI_SESSION_MESSAGE_MAX_BYTES
    }
  })

  it('P-B1 补充：deliverables 超上限同样被拒；恰好等于上限照常 200（不误伤）', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const taskId = await makeTask({ from: supervisor, to: worker })
    process.env.CC_HEIHEI_SESSION_MESSAGE_MAX_BYTES = '1024'
    try {
      const tooBig = await callApi('POST', `/api/collab-tasks/${taskId}/report`, {
        summary: 'ok',
        deliverables: ['a'.repeat(2000)],
        callerSessionId: worker,
      })
      expect(tooBig.status).toBe(413)
      expect(((await tooBig.json()) as { error?: string }).error).toBe('PAYLOAD_TOO_LARGE')

      const ok = await callApi('POST', `/api/collab-tasks/${taskId}/report`, {
        summary: 'x'.repeat(1024),
        callerSessionId: worker,
      })
      expect(ok.status).toBe(200)
    } finally {
      delete process.env.CC_HEIHEI_SESSION_MESSAGE_MAX_BYTES
    }
  })
})

// ── review：callerSessionId 必须是派活人或该项目现任主管 ──────────────────

describe('POST /api/collab-tasks/:id/review — callerSessionId 校验', () => {
  /** 建一条 delivered 的任务（report 会把它推进到 delivered） */
  async function makeDeliveredTask(input: {
    from: string
    to: string
    projectDir?: string
  }): Promise<string> {
    const taskId = await makeTask(input)
    await collabTaskService.reportTask(taskId, { summary: '完成' })
    return taskId
  }

  it('派活人本人 review → 200', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const taskId = await makeDeliveredTask({ from: supervisor, to: worker })

    const res = await callApi('POST', `/api/collab-tasks/${taskId}/review`, {
      verdict: 'pass',
      callerSessionId: supervisor,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task?: { status?: string } }
    expect(body.task?.status).toBe('verified')
  })

  it('同项目现任主管（交接后）review → 200', async () => {
    const oldSupervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    // 任务由旧主管派出并已交付
    const taskId = await makeDeliveredTask({ from: oldSupervisor, to: worker })

    // 交接：先卸任旧主管，再任命新主管（每项目最多一名主管，顺序不能反）
    await new ServantService().setServant(oldSupervisor, { enabled: true, supervisor: false })
    const newSupervisor = await registerWorker({ role: '主管', supervisor: true })

    const res = await callApi('POST', `/api/collab-tasks/${taskId}/review`, {
      verdict: 'pass',
      callerSessionId: newSupervisor,
    })
    expect(res.status).toBe(200) // 非派活人，但身为现任主管 → 允许验收旧任务
    expect((await collabTaskService.getTask(taskId))?.status).toBe('verified')
  })

  it('另一项目的现任主管 review 本项目任务 → 403，且状态不变（不能越项目验收）', async () => {
    // 本项目（tmpDir）的主管 + 员工 + 一条待验收任务
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const taskId = await makeDeliveredTask({ from: supervisor, to: worker })

    // 另一个 workDir 的项目，其主管只对那个项目有主管权
    const otherProjectDir = await mkdtempReal('collab-tasks-api-other-')
    try {
      const otherSupervisor = await registerWorker({
        role: '主管',
        supervisor: true,
        projectDir: otherProjectDir,
      })

      const res = await callApi('POST', `/api/collab-tasks/${taskId}/review`, {
        verdict: 'pass',
        callerSessionId: otherSupervisor,
      })

      expect(res.status).toBe(403)
      // 越项目验收被拒后，任务仍停在 delivered 未被改动
      expect((await collabTaskService.getTask(taskId))?.status).toBe('delivered')
    } finally {
      await fs.rm(otherProjectDir, { recursive: true, force: true })
    }
  })

  it('无关会话 review → 403，且不改状态', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const bystander = await registerWorker({ role: '测试' })
    const taskId = await makeDeliveredTask({ from: supervisor, to: worker })

    const res = await callApi('POST', `/api/collab-tasks/${taskId}/review`, {
      verdict: 'pass',
      callerSessionId: bystander,
    })
    expect(res.status).toBe(403)
    expect((await collabTaskService.getTask(taskId))?.status).toBe('delivered')
  })

  it('员工自己 review 自己的任务 → 403（越权）', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const taskId = await makeDeliveredTask({ from: supervisor, to: worker })

    const res = await callApi('POST', `/api/collab-tasks/${taskId}/review`, {
      verdict: 'pass',
      callerSessionId: worker,
    })
    expect(res.status).toBe(403)
  })

  it('不带 callerSessionId → 维持旧行为，200', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const taskId = await makeDeliveredTask({ from: supervisor, to: worker })

    const res = await callApi('POST', `/api/collab-tasks/${taskId}/review`, { verdict: 'pass' })
    expect(res.status).toBe(200)
  })
})

// ── §一.4：客户端预生成 taskId 的幂等 ────────────────────────────────────

describe('POST /api/collab-tasks — 客户端预生成 taskId 幂等', () => {
  it('同 id 重复建账只保留一条，首次为准', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })

    const body = {
      id: 'client-pregen-1',
      fromSessionId: supervisor,
      toSessionId: worker,
      title: '第一次',
      content: '正文',
    }
    const first = await callApi('POST', '/api/collab-tasks', {
      ...body,
      project: tmpDir,
    })
    expect(first.status).toBe(200)
    // 重试：换个 title，不应覆盖
    const second = await callApi('POST', '/api/collab-tasks', {
      ...body,
      title: '第二次',
      project: tmpDir,
    })
    expect(second.status).toBe(200)

    const tasks = await collabTaskService.listTasks({ projectDir: tmpDir })
    const matched = tasks.filter((task) => task.id === 'client-pregen-1')
    expect(matched).toHaveLength(1)
    expect(matched[0]?.title).toBe('第一次')
  })

  it('重试不把已推进的状态改回 dispatched', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const taskId = await makeTask({ from: supervisor, to: worker, id: 'client-pregen-2' })
    await collabTaskService.reportTask(taskId, { summary: '完成' })
    expect((await collabTaskService.getTask(taskId))?.status).toBe('delivered')

    // 客户端超时重发同 id 的建账请求
    await callApi('POST', '/api/collab-tasks', {
      id: 'client-pregen-2',
      fromSessionId: supervisor,
      toSessionId: worker,
      title: '重发',
      content: '正文',
      project: tmpDir,
    })

    const task = await collabTaskService.getTask('client-pregen-2')
    expect(task?.status).toBe('delivered') // 状态没有被重置
    expect(await collabTaskService.listTasks({ projectDir: tmpDir })).toHaveLength(1)
  })
})

/**
 * 架构裁决五第 3 条：面板标题与列表过滤必须同源。
 *
 * 响应新增 `projectDir`（服务端 resolveProjectDir 的结果），前端标题只显示它、
 * 不自己算路径——否则会出现「标题写 A、列表其实是 B」。本组断言的关键是
 * **回显值 = 实际过滤目录**，而不只是「字段存在」。
 */
describe('GET /api/collab-tasks — projectDir 回显（标题与过滤同源）', () => {
  /** 在另一个项目下建一条任务，用来证明过滤真的生效（不是全量返回） */
  async function makeOtherProjectTask(id: string): Promise<string> {
    const otherDir = await mkdtempReal('collab-tasks-other-')
    const t = await collabTaskService.createTask({
      id,
      projectDir: otherDir,
      fromSessionId: 'someone',
      toSessionId: 'someone-else',
      title: '别的项目',
      content: '正文',
    })
    return t.id
  }

  it('forSessionId 入参：回显值 = 服务端解析的 workDir = 实际过滤目录', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const mine = await makeTask({ from: supervisor, to: worker, id: 'pdr-mine' })
    await makeOtherProjectTask('pdr-other')

    const res = await callApi('GET', `/api/collab-tasks?forSessionId=${worker}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tasks: Array<{ id: string; projectDir: string }>; projectDir: string }

    // 字段来自服务端解析（resolve 后的会话 workDir），前端无需自己算
    expect(body.projectDir).toBe(path.resolve(tmpDir))
    // 过滤真的生效：只返回本项目的那条
    expect(body.tasks.map((t) => t.id)).toEqual([mine])
    // 同源：每条返回的任务都与回显目录同项目（归一后相等）
    for (const t of body.tasks) expect(sameProject(t.projectDir, body.projectDir)).toBe(true)
    // 反证：用回显值当过滤条件查，得到的就是同一批任务
    const byEchoed = await collabTaskService.listTasks({ projectDir: body.projectDir })
    expect(byEchoed.map((t) => t.id)).toEqual(body.tasks.map((t) => t.id))
  })

  it('project 入参：回显值 = resolve 后的该项目目录', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const mine = await makeTask({ from: supervisor, to: worker, id: 'pdr-proj' })
    await makeOtherProjectTask('pdr-other-2')

    const res = await callApi('GET', `/api/collab-tasks?project=${encodeURIComponent(tmpDir)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tasks: Array<{ id: string }>; projectDir: string }

    expect(body.projectDir).toBe(path.resolve(tmpDir))
    expect(body.tasks.map((t) => t.id)).toEqual([mine])
  })

  it('无有效入参：既有行为不变（200 + 全量任务），projectDir 为 null', async () => {
    // 现状核实：不带 project / forSessionId 时**不是** 400，而是不过滤、返回全部任务。
    // 本字段只增不改，因此该路径必须保持原样。
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    await makeTask({ from: supervisor, to: worker, id: 'pdr-all' })
    await makeOtherProjectTask('pdr-other-3')

    const res = await callApi('GET', '/api/collab-tasks')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tasks: unknown[]; projectDir: unknown }
    expect(body.tasks).toHaveLength(2) // 两个项目的任务都在
    expect(body.projectDir).toBe(null) // 没有解析出目录 → 不谎报一个
  })

  it('forSessionId 无效：既有 404 语义不变', async () => {
    const res = await callApi('GET', '/api/collab-tasks?forSessionId=no-such-session')
    expect(res.status).toBe(404)
  })

  it('status 过滤与 projectDir 回显可以同时使用', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const deliveredId = await makeTask({ from: supervisor, to: worker, id: 'pdr-done' })
    await collabTaskService.reportTask(deliveredId, { summary: '完成' })
    await makeTask({ from: supervisor, to: worker, id: 'pdr-open' })

    const res = await callApi(
      'GET',
      `/api/collab-tasks?forSessionId=${worker}&status=delivered`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tasks: Array<{ id: string }>; projectDir: string }
    expect(body.tasks.map((t) => t.id)).toEqual([deliveredId])
    expect(body.projectDir).toBe(path.resolve(tmpDir))
  })
})

/**
 * 裁决四方案 A 的调用方约束：身份校验必须**先于**补推进。
 * 403 的情况下不得顺手把任务补推到 delivered——否则误投防护被绕开。
 */
describe('POST /api/collab-tasks/:id/report — 调用方校验先于补推进', () => {
  /** 造一个**真的停在 dispatched** 的任务（makeTask 会推进到 in_progress，不适用） */
  async function makeDispatchedTask(id: string, from: string, to: string): Promise<string> {
    const task = await collabTaskService.createTask({
      id,
      projectDir: tmpDir,
      fromSessionId: from,
      toSessionId: to,
      title: '排队派活',
      content: '员工忙碌时入队',
    })
    return task.id
  }

  it('callerSessionId 不是受派人 → 403，且不触发补推进（仍停在 dispatched）', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const other = await registerWorker({ role: '前端' })
    const id = await makeDispatchedTask('catchup-403', supervisor, worker)

    const res = await callApi('POST', `/api/collab-tasks/${id}/report`, {
      summary: '冒名汇报',
      callerSessionId: other,
    })
    expect(res.status).toBe(403)

    const task = await collabTaskService.getTask(id)
    expect(task?.status).toBe('dispatched')
    expect(task?.history).toHaveLength(1) // 没有补链
    expect(task?.report).toBeUndefined()
  })

  it('callerSessionId 是受派人 → 200，且 dispatched 补链到 delivered', async () => {
    const supervisor = await registerWorker({ role: '主管', supervisor: true })
    const worker = await registerWorker({ role: '后端' })
    const id = await makeDispatchedTask('catchup-ok', supervisor, worker)

    const res = await callApi('POST', `/api/collab-tasks/${id}/report`, {
      summary: '做完了',
      deliverables: ['src/a.ts'],
      callerSessionId: worker,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      task: { status: string; report: string; history: Array<{ by?: string }> }
    }
    expect(body.task.status).toBe('delivered')
    expect(body.task.report).toBe('做完了')
    expect(body.task.history.filter((h) => h.by === 'system')).toHaveLength(2)
  })
})
