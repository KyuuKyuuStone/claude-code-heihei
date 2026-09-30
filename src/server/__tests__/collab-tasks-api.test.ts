import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleApiRequest } from '../router.js'
import { collabTaskService } from '../services/collabTaskService.js'
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-tasks-api-'))
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
    const otherProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-tasks-api-other-'))
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
