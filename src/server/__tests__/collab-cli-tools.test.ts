/**
 * CLI 原生协作工具测试（v1.6.0 第二批）
 *
 * 覆盖：注入条件、目标解析、地址解析与降级（端口文件/pid、env、信箱）、
 * 四个工具的 HTTP 行为与错误映射、以及「输出里不许出现回合态字段」的静态断言。
 *
 * 服务端用 Bun.serve 起桩（不启真服务端）：这样能精确控制 404/409/旧版无
 * capabilities 等分支，而这些分支正是降级契约的核心。
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COLLAB_TOOL_NAMES,
  COLLAB_WARNING_CODES,
  FORBIDDEN_TURN_STATE_FIELDS,
  TASK_STATUSES,
  collectForbiddenTurnStateFields,
  collabToolNamesForRole,
  isManualWaitToolEnabled,
  resolveCollabRole,
} from '../../collaboration/collabToolContract.js'
import {
  getCollabServer,
  resetCollabToolClientForTests,
  setCollabToolDepsForTests,
} from '../../collaboration/collabToolClient.js'
import {
  CollabDispatchTool,
  CollabListTasksTool,
  CollabReportTool,
  CollabReviewTool,
  getCollabTools,
} from '../../tools/CollabTools/index.js'
import { resolveDispatchTarget } from '../../tools/CollabTools/shared.js'
import { getAllBaseTools, getTools } from '../../tools.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { TASK_STATUSES as SERVER_TASK_STATUSES } from '../services/collabTaskService.js'

const SUPERVISOR = '11111111-1111-4111-8111-111111111111'
const WORKER = '22222222-2222-4222-8222-222222222222'
const OTHER_WORKER = '33333333-3333-4333-8333-333333333333'

type StubRequest = {
  method: string
  path: string
  query: URLSearchParams
  body: Record<string, unknown> | null
}

type StubOptions = {
  /** null = 旧服务端（whoami 不带 capabilities 字段） */
  capabilities?: string[] | null
  roster?: unknown[]
  tasks?: unknown[]
  /** 按路径前缀覆盖响应；返回 undefined 表示走默认逻辑 */
  overrides?: Record<string, (req: StubRequest) => Response | undefined>
}

function startStub(options: StubOptions = {}) {
  const received: StubRequest[] = []
  const capabilities = options.capabilities === undefined ? ['collab-tasks'] : options.capabilities
  const roster = options.roster ?? []
  const tasks = options.tasks ?? []

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      let body: Record<string, unknown> | null = null
      if (req.method !== 'GET') {
        try {
          body = (await req.json()) as Record<string, unknown>
        } catch {
          body = null
        }
      }
      const entry: StubRequest = { method: req.method, path: url.pathname, query: url.searchParams, body }
      received.push(entry)

      for (const [prefix, handler] of Object.entries(options.overrides ?? {})) {
        if (url.pathname.startsWith(prefix)) {
          const response = handler(entry)
          if (response) return response
        }
      }

      if (url.pathname === '/api/whoami') {
        return Response.json({
          app: 'cc-heihei',
          version: '1.6.0-test',
          pid: 4242,
          startedAt: '2026-09-30T00:00:00.000Z',
          ...(capabilities ? { capabilities } : {}),
        })
      }
      if (url.pathname === '/api/servant-sessions') {
        return Response.json({ servants: roster, rosterTable: '' })
      }
      if (url.pathname === '/api/collab-tasks' && req.method === 'GET') {
        // 旧服务端（capabilities 缺失）连台账 API 都不存在：探测请求应看到「未知资源」
        if (capabilities === null) {
          return Response.json(
            { error: 'NOT_FOUND', message: `Unknown API resource: ${url.pathname}` },
            { status: 404 },
          )
        }
        return Response.json({ tasks })
      }
      const taskMatch = url.pathname.match(/^\/api\/collab-tasks\/([^/]+)(?:\/(report|review))?$/)
      if (taskMatch) {
        const id = decodeURIComponent(taskMatch[1]!)
        const action = taskMatch[2]
        const task = tasks.find(
          (item) => item && typeof item === 'object' && (item as { id?: string }).id === id,
        ) as Record<string, unknown> | undefined
        if (!task) {
          return Response.json({ error: 'NOT_FOUND', message: `Task not found: ${id}` }, { status: 404 })
        }
        if (req.method === 'GET') return Response.json({ task })
        if (action === 'report') {
          return Response.json({ task: { ...task, status: 'delivered', report: body?.summary ?? '' } })
        }
        if (action === 'review') {
          const verdict = body?.verdict === 'rework' ? 'rework' : 'verified'
          return Response.json({
            task: {
              ...task,
              status: verdict,
              verdict: body?.verdict,
              history: [...((task.history as unknown[]) ?? []), { from: task.status, to: verdict }],
            },
          })
        }
      }
      if (url.pathname === '/api/session-messages' && req.method === 'POST') {
        return Response.json(
          {
            ok: true,
            messageId: `msg-${received.length}`,
            ...(typeof body?.taskId === 'string' ? { taskId: body.taskId } : {}),
            target: { sessionId: body?.targetSessionId, busy: false },
          },
          { status: 201 },
        )
      }
      return Response.json({ error: 'NOT_FOUND', message: `Unknown API resource: ${url.pathname}` }, { status: 404 })
    },
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    received,
    stop: () => server.stop(true),
  }
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    projectDir: '/ws/alpha',
    fromSessionId: SUPERVISOR,
    toSessionId: WORKER,
    title: '实现接口',
    content: '任务正文全文',
    status: 'accepted',
    deliverables: [],
    createdAt: 1,
    updatedAt: 2,
    history: [],
    ...overrides,
  }
}

function makeServant(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: WORKER,
    role: '前端',
    title: '前端',
    enabled: true,
    supervisor: false,
    updatedAt: 1,
    // 回合态字段真实存在于花名册响应里：工具必须把它们挡在输出之外
    running: true,
    turnInProgress: true,
    ...overrides,
  }
}

let workDir: string
let portFileDir: string
let stopServer: (() => void) | null = null

function useEnv(overrides: Record<string, string> = {}): void {
  setCollabToolDepsForTests({
    env: {
      CC_HEIHEI_SESSION_ID: WORKER,
      CC_HEIHEI_COLLAB_ROLE: 'servant',
      CC_HEIHEI_WORK_DIR: workDir,
      ...overrides,
    },
    portFileDir,
    sleep: async () => {},
    randomId: () => 'generated-id-0000',
  })
}

// 工具 call 的签名带 4 个参数，测试只关心 input
const callTool = (tool: unknown, input: unknown) =>
  (tool as { call: (a: unknown, b: unknown, c: unknown, d: unknown) => Promise<{ data: unknown }> }).call(
    input,
    {},
    undefined,
    undefined,
  )

/** 静态断言：任何工具输出都不得携带回合态字段 */
function expectNoTurnState(data: unknown): void {
  const hits = collectForbiddenTurnStateFields(data)
  expect(hits).toEqual([])
}

/** 信箱目录内容（目录不存在 = 没写信箱） */
function mailboxFiles(): string[] {
  try {
    return readdirSync(join(workDir, '.heihei', 'dispatch'))
  } catch {
    return []
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'collab-tool-work-'))
  portFileDir = mkdtempSync(join(tmpdir(), 'collab-tool-portfile-'))
  resetCollabToolClientForTests()
})

afterEach(() => {
  stopServer?.()
  stopServer = null
  resetCollabToolClientForTests()
  rmSync(workDir, { recursive: true, force: true })
  rmSync(portFileDir, { recursive: true, force: true })
})

describe('契约：注入条件与目标解析', () => {
  it('按角色注入工具：主管 3 个、员工 2 个、非协作会话 0 个', () => {
    expect(collabToolNamesForRole('supervisor')).toEqual([
      COLLAB_TOOL_NAMES.dispatch,
      COLLAB_TOOL_NAMES.review,
      COLLAB_TOOL_NAMES.listTasks,
    ])
    expect(collabToolNamesForRole('servant')).toEqual([
      COLLAB_TOOL_NAMES.report,
      COLLAB_TOOL_NAMES.listTasks,
    ])
    expect(collabToolNamesForRole(null)).toEqual([])

    // 工具集合按 env 求值：非协作会话一个都不注入（普通会话清单零变化）
    expect(getCollabTools({}).map((tool) => tool.name)).toEqual([])
    expect(getCollabTools({ CC_HEIHEI_COLLAB_ROLE: 'servant' }).map((tool) => tool.name)).toEqual([])
    expect(
      getCollabTools({
        CC_HEIHEI_SESSION_ID: WORKER,
        CC_HEIHEI_COLLAB_ROLE: 'servant',
      }).map((tool) => tool.name),
    ).toEqual([COLLAB_TOOL_NAMES.report, COLLAB_TOOL_NAMES.listTasks])
    expect(
      getCollabTools({
        CC_HEIHEI_SESSION_ID: SUPERVISOR,
        CC_HEIHEI_COLLAB_ROLE: 'supervisor',
      }).map((tool) => tool.name),
    ).toEqual([COLLAB_TOOL_NAMES.dispatch, COLLAB_TOOL_NAMES.review, COLLAB_TOOL_NAMES.listTasks])
  })

  it('人工等待工具按角色矩阵裁剪并尊重开关', () => {
    const env = (sessionId: string, role: string, noninteractive?: string) => ({
      CC_HEIHEI_SESSION_ID: sessionId,
      CC_HEIHEI_COLLAB_ROLE: role,
      ...(noninteractive ? { CC_HEIHEI_SERVANT_NONINTERACTIVE: noninteractive } : {}),
    })
    const servant = env(WORKER, 'servant')
    const supervisor = env(SUPERVISOR, 'supervisor')

    for (const toolName of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'ReviewArtifact']) {
      expect(isManualWaitToolEnabled(toolName, servant)).toBe(false)
      expect(isManualWaitToolEnabled(toolName, { ...servant, CC_HEIHEI_SERVANT_NONINTERACTIVE: '0' })).toBe(true)
    }
    expect(isManualWaitToolEnabled('AskUserQuestion', supervisor)).toBe(true)
    expect(isManualWaitToolEnabled('EnterPlanMode', supervisor)).toBe(false)
    expect(isManualWaitToolEnabled('ExitPlanMode', supervisor)).toBe(true)
    expect(isManualWaitToolEnabled('ReviewArtifact', supervisor)).toBe(true)
    expect(isManualWaitToolEnabled('EnterPlanMode', { ...supervisor, CC_HEIHEI_SERVANT_NONINTERACTIVE: '0' })).toBe(true)
    expect(isManualWaitToolEnabled('AskUserQuestion', {})).toBe(true)
    expect(isManualWaitToolEnabled('EnterPlanMode', {})).toBe(true)
    expect(isManualWaitToolEnabled('ExitPlanMode', {})).toBe(true)
    expect(isManualWaitToolEnabled('ReviewArtifact', {})).toBe(true)

    const saved = {
      session: process.env.CC_HEIHEI_SESSION_ID,
      role: process.env.CC_HEIHEI_COLLAB_ROLE,
      noninteractive: process.env.CC_HEIHEI_SERVANT_NONINTERACTIVE,
    }
    try {
      process.env.CC_HEIHEI_SESSION_ID = WORKER
      process.env.CC_HEIHEI_COLLAB_ROLE = 'servant'
      process.env.CC_HEIHEI_SERVANT_NONINTERACTIVE = '1'
      const permissionContext = getEmptyToolPermissionContext()
      const servantToolNames = getTools(permissionContext).map((tool) => tool.name)
      for (const toolName of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'ReviewArtifact']) {
        expect(servantToolNames).not.toContain(toolName)
      }

      process.env.CC_HEIHEI_SERVANT_NONINTERACTIVE = '0'
      const interactiveToolNames = getTools(getEmptyToolPermissionContext()).map((tool) => tool.name)
      expect(interactiveToolNames).toContain('AskUserQuestion')
      expect(interactiveToolNames).toContain('EnterPlanMode')
      expect(interactiveToolNames).toContain('ExitPlanMode')
    } finally {
      if (saved.session === undefined) delete process.env.CC_HEIHEI_SESSION_ID
      else process.env.CC_HEIHEI_SESSION_ID = saved.session
      if (saved.role === undefined) delete process.env.CC_HEIHEI_COLLAB_ROLE
      else process.env.CC_HEIHEI_COLLAB_ROLE = saved.role
      if (saved.noninteractive === undefined) delete process.env.CC_HEIHEI_SERVANT_NONINTERACTIVE
      else process.env.CC_HEIHEI_SERVANT_NONINTERACTIVE = saved.noninteractive
    }
  })

  it('角色判定兼容旧服务端（只有主管标记时仍识别为主管）', () => {
    expect(resolveCollabRole({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_SUPERVISOR: '1' })).toBe('supervisor')
    expect(resolveCollabRole({ CC_HEIHEI_SESSION_ID: WORKER })).toBeNull()
    expect(resolveCollabRole({ CC_HEIHEI_SUPERVISOR: '1' })).toBeNull()
  })

  it('任务状态常量与服务端台账逐字一致（防漂移）', () => {
    expect([...TASK_STATUSES]).toEqual([...SERVER_TASK_STATUSES])
  })

  it('目标解析：自己与主管被本地拒绝，同名多个要求改用 sessionId', () => {
    const roster = [
      { sessionId: WORKER, role: '前端' },
      { sessionId: OTHER_WORKER, role: '前端' },
      { sessionId: SUPERVISOR, role: '主管', supervisor: true },
    ]
    expect(resolveDispatchTarget(WORKER, roster, WORKER)).toMatchObject({ code: 'invalid_target' }) // 派给自己
    expect(resolveDispatchTarget(SUPERVISOR, roster, WORKER)).toMatchObject({ code: 'invalid_target' }) // 派给主管
    expect(resolveDispatchTarget(WORKER, roster, SUPERVISOR).ok).toBe(true) // 派给员工
    expect(resolveDispatchTarget('前端', roster, SUPERVISOR)).toMatchObject({ code: 'ambiguous_target' })
    expect(resolveDispatchTarget('不存在', roster, SUPERVISOR)).toMatchObject({ code: 'not_on_roster' })
    const ok = resolveDispatchTarget('前端', [roster[0]!], SUPERVISOR)
    expect(ok.ok).toBe(true)
  })

  it('静态断言 helper 能抓到嵌套的回合态字段', () => {
    expect(collectForbiddenTurnStateFields({ a: { turnInProgress: false } })).toEqual(['$.a.turnInProgress'])
    expect(collectForbiddenTurnStateFields({ target: { busy: true } })).toEqual([])
    expect(FORBIDDEN_TURN_STATE_FIELDS).toContain('running')
  })
})

describe('地址解析与降级', () => {
  it('端口文件优先（pid 存活时），env 作为第二档，都没有则不可用', async () => {
    stopServer = startStub().stop
    const stub = startStub()
    stopServer = stub.stop
    writeFileSync(
      join(portFileDir, 'desktop-server.json'),
      JSON.stringify({ url: stub.baseUrl, port: 1, pid: 999, startedAt: '2026-09-30T00:00:00.000Z' }),
    )

    // pid 存活 → 用端口文件地址
    setCollabToolDepsForTests({
      env: { CC_HEIHEI_DESKTOP_SERVER_URL: 'http://127.0.0.1:1' },
      portFileDir,
      isPidAlive: () => true,
    })
    expect((await getCollabServer())?.source).toBe('port-file')

    // pid 已死 → 陈旧的端口文件不可用，回退 env
    resetCollabToolClientForTests()
    writeFileSync(join(portFileDir, 'desktop-server.json'), JSON.stringify({ url: 'http://127.0.0.1:1', pid: 999 }))
    setCollabToolDepsForTests({
      env: { CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl },
      portFileDir,
      isPidAlive: () => false,
    })
    const viaEnv = await getCollabServer()
    expect(viaEnv?.source).toBe('env')
    expect(viaEnv?.baseUrl).toBe(stub.baseUrl)

    // 两档都没有 → 不可用（不猜地址）
    resetCollabToolClientForTests()
    setCollabToolDepsForTests({ env: {}, portFileDir })
    expect(await getCollabServer()).toBeNull()
  })
})

describe('CollabDispatch（主管）', () => {
  it('走 session-messages 投递并回传任务 ID（不调 POST /api/collab-tasks）', async () => {
    const stub = startStub({ roster: [makeServant()] })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabDispatchTool, {
      to: WORKER,
      content: '把接口实现一下',
      title: '实现接口',
      taskId: 'task-abc',
    })
    const output = data as Record<string, unknown>

    expect(output.ok).toBe(true)
    expect(output.taskId).toBe('task-abc')
    expect(output.channel).toBe('http')
    expect(output.target).toMatchObject({ sessionId: WORKER, role: '前端' })

    const posted = stub.received.filter((item) => item.method === 'POST')
    expect(posted).toHaveLength(1)
    expect(posted[0]!.path).toBe('/api/session-messages')
    expect(posted[0]!.body).toMatchObject({
      targetSessionId: WORKER,
      fromSessionId: SUPERVISOR,
      taskId: 'task-abc',
      title: '实现接口',
    })
    // 绝不直写台账：没有对 POST /api/collab-tasks 的调用
    expect(stub.received.some((item) => item.method === 'POST' && item.path === '/api/collab-tasks')).toBe(false)
    expectNoTurnState(output)
  })

  it('按角色名派活（唯一匹配）时解析成 sessionId', async () => {
    const stub = startStub({ roster: [makeServant()] })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabDispatchTool, { to: '前端', content: '任务' })
    expect((data as Record<string, unknown>).ok).toBe(true)
    const posted = stub.received.find((item) => item.method === 'POST')
    expect(posted?.body).toMatchObject({ targetSessionId: WORKER })
  })

  it('目标不在花名册 → not_on_roster 且不投递', async () => {
    const stub = startStub({ roster: [makeServant()] })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabDispatchTool, { to: OTHER_WORKER, content: '任务' })
    expect(data).toMatchObject({ ok: false, error: 'not_on_roster' })
    expect(stub.received.some((item) => item.method === 'POST')).toBe(false)
    expectNoTurnState(data)
  })

  it('旧服务端（无台账能力）→ 消息照投并标 ledger unsupported', async () => {
    const stub = startStub({ capabilities: null, roster: [makeServant()] })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabDispatchTool, { to: WORKER, content: '任务' })
    expect(data).toMatchObject({ ok: true, ledger: 'unsupported', channel: 'http' })
    expect((data as { warnings?: string[] }).warnings).toContain('ledger_unsupported')
  })

  it('同一 taskId 重发（幂等重试/返工重发）时请求体与返回值里的 taskId 完全一致', async () => {
    const stub = startStub({ roster: [makeServant()] })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const first = await callTool(CollabDispatchTool, { to: WORKER, content: '任务', taskId: 'task-idem' })
    const second = await callTool(CollabDispatchTool, { to: WORKER, content: '任务', taskId: 'task-idem' })

    const posted = stub.received.filter((item) => item.method === 'POST')
    expect(posted).toHaveLength(2)
    expect(posted[0]!.body?.taskId).toBe('task-idem')
    expect(posted[1]!.body?.taskId).toBe('task-idem')
    expect((first.data as { taskId?: string }).taskId).toBe('task-idem')
    expect((second.data as { taskId?: string }).taskId).toBe('task-idem')
  })

  it('服务不可用 → 写信箱 dispatch-*.json（含 taskId）', async () => {
    // 指向一个没有监听的地址：探活失败即视为服务不可用
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: 'http://127.0.0.1:1' })

    const { data } = await callTool(CollabDispatchTool, { to: WORKER, content: '离线派活', taskId: 'task-offline' })
    const output = data as Record<string, unknown>
    expect(output).toMatchObject({ ok: true, channel: 'mailbox', queued: true, taskId: 'task-offline' })

    const files = mailboxFiles()
    expect(files).toHaveLength(1)
    expect(files[0]!.startsWith('dispatch-')).toBe(true)
    const payload = JSON.parse(readFileSync(join(workDir, '.heihei', 'dispatch', files[0]!), 'utf8'))
    expect(payload).toMatchObject({ targetSessionId: WORKER, taskId: 'task-offline', content: '离线派活' })
    expectNoTurnState(output)
  })

  it('服务不可用且 to 是角色名 → 如实报错（离线无法解析花名册，不猜地址）', async () => {
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: 'http://127.0.0.1:1' })
    const { data } = await callTool(CollabDispatchTool, { to: '前端', content: '离线派活' })
    expect(data).toMatchObject({ ok: false, error: 'server_unreachable' })
    expect(mailboxFiles()).toHaveLength(0)
  })
})

describe('CollabReport（员工）', () => {
  it('两步顺序固定：先推台账 delivered，再投递汇报给派活人（同 taskId）', async () => {
    const stub = startStub({ tasks: [makeTask({ status: 'in_progress' })] })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabReportTool, { taskId: 'task-1', summary: '已实现', deliverables: ['src/a.ts'] })
    const output = data as Record<string, unknown>

    expect(output.ok).toBe(true)
    expect(output.status).toBe('delivered')
    expect(output.deliveredTo).toBe(SUPERVISOR)

    const writes = stub.received.filter((item) => item.method === 'POST').map((item) => item.path)
    expect(writes).toEqual(['/api/collab-tasks/task-1/report', '/api/session-messages'])
    const message = stub.received.find((item) => item.path === '/api/session-messages')
    expect(message?.body).toMatchObject({ targetSessionId: SUPERVISOR, fromSessionId: WORKER, taskId: 'task-1' })
    expect(String(message?.body?.content)).toContain('【汇报】已实现')
    expectNoTurnState(output)
  })

  it('不带 taskId 时取唯一未结任务；多个则报错并列出候选', async () => {
    const stub = startStub({
      tasks: [
        makeTask({ id: 'task-1', status: 'in_progress' }),
        makeTask({ id: 'task-2', status: 'dispatched', title: '第二个任务' }),
      ],
    })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabReportTool, { summary: '汇报' })
    const output = data as Record<string, unknown>
    expect(output.ok).toBe(false)
    expect(output.error).toBe('multiple_open_tasks')
    expect(String(output.message)).toContain('task-1')
    expect(String(output.message)).toContain('task-2')
  })

  it('第 1 步 409（回合未推进）→ 等一拍重试一次后成功', async () => {
    let reportCalls = 0
    const stub = startStub({
      tasks: [makeTask({ status: 'dispatched' })],
      overrides: {
        '/api/collab-tasks/task-1/report': () => {
          reportCalls += 1
          if (reportCalls === 1) {
            return Response.json({ error: 'CONFLICT', message: 'Invalid transition' }, { status: 409 })
          }
          return undefined
        },
      },
    })
    stopServer = stub.stop
    const sleeps: number[] = []
    setCollabToolDepsForTests({
      env: {
        CC_HEIHEI_SESSION_ID: WORKER,
        CC_HEIHEI_COLLAB_ROLE: 'servant',
        CC_HEIHEI_WORK_DIR: workDir,
        CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl,
      },
      portFileDir,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      randomId: () => 'generated-id-0000',
    })

    const { data } = await callTool(CollabReportTool, { taskId: 'task-1', summary: '已实现' })
    expect((data as Record<string, unknown>).ok).toBe(true)
    expect(sleeps).toEqual([2000])
    expect(reportCalls).toBe(2)
  })

  it('任务已结单 → task_closed 且不投递消息', async () => {
    const stub = startStub({
      tasks: [makeTask({ status: 'verified' })],
      overrides: {
        '/api/collab-tasks/task-1/report': () =>
          Response.json({ error: 'CONFLICT', message: 'Invalid transition' }, { status: 409 }),
      },
    })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabReportTool, { taskId: 'task-1', summary: '汇报' })
    expect(data).toMatchObject({ ok: false, error: 'task_closed' })
    expect(stub.received.some((item) => item.path === '/api/session-messages')).toBe(false)
  })

  it('服务不可用 → 写 report 信箱（含 report 字段），不谎报 delivered', async () => {
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: 'http://127.0.0.1:1' })
    const { data } = await callTool(CollabReportTool, {
      taskId: 'task-1',
      summary: '离线汇报',
      deliverables: ['a.ts'],
    })
    const output = data as Record<string, unknown>
    expect(output).toMatchObject({ ok: true, channel: 'mailbox', queued: true, taskId: 'task-1' })
    expect(output.status).toBeUndefined() // 台账状态未知，不伪造

    const files = mailboxFiles()
    expect(files[0]!.startsWith('report-')).toBe(true)
    const payload = JSON.parse(readFileSync(join(workDir, '.heihei', 'dispatch', files[0]!), 'utf8'))
    expect(payload.report).toMatchObject({ taskId: 'task-1', summary: '离线汇报', deliverables: ['a.ts'] })
    expectNoTurnState(output)
  })

  it('旧服务端无台账 → 用花名册回退：同项目恰好一名主管时照常投递', async () => {
    const stub = startStub({
      capabilities: null,
      roster: [
        makeServant({ sessionId: SUPERVISOR, role: '主管', title: '主管', supervisor: true }),
        makeServant(),
      ],
    })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabReportTool, { taskId: 'task-1', summary: '汇报已完工' })
    const output = data as Record<string, unknown>
    expect(output).toMatchObject({
      ok: true,
      ledger: 'unsupported',
      resolvedBy: 'roster_supervisor',
      deliveredTo: SUPERVISOR,
      channel: 'http',
    })
    expect(output.warnings).toContain('ledger_unsupported')
    // 收件人来自花名册响应，且只投递一次；不推进任何台账（旧服务端没有台账）
    const posted = stub.received.filter((item) => item.method === 'POST')
    expect(posted).toHaveLength(1)
    expect(posted[0]!.path).toBe('/api/session-messages')
    expect(posted[0]!.body).toMatchObject({ targetSessionId: SUPERVISOR, fromSessionId: WORKER })
    expect(stub.received.some((item) => item.path.endsWith('/report'))).toBe(false)
    expectNoTurnState(output)
  })

  it('旧服务端无台账 + 花名册里没有主管 → 安全拒绝，不投递', async () => {
    const stub = startStub({ capabilities: null, roster: [makeServant()] })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabReportTool, { taskId: 'task-1', summary: '汇报' })
    expect(data).toMatchObject({ ok: false, error: 'ledger_unsupported' })
    expect(stub.received.some((item) => item.method === 'POST')).toBe(false)
    expect(mailboxFiles()).toHaveLength(0)
  })

  it('旧服务端无台账 + 花名册里有多名主管 → 安全拒绝，不投递', async () => {
    const stub = startStub({
      capabilities: null,
      roster: [
        makeServant({ sessionId: SUPERVISOR, supervisor: true }),
        makeServant({ sessionId: OTHER_WORKER, supervisor: true }),
      ],
    })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabReportTool, { taskId: 'task-1', summary: '汇报' })
    expect(data).toMatchObject({ ok: false, error: 'ledger_unsupported' })
    expect(String((data as { message?: string }).message)).toContain('2')
    expect(stub.received.some((item) => item.method === 'POST')).toBe(false)
    expect(mailboxFiles()).toHaveLength(0)
  })

  it('旧服务端无台账 + 花名册请求失败 → 安全拒绝，不投递也不写信箱', async () => {
    const stub = startStub({
      capabilities: null,
      roster: [makeServant({ sessionId: SUPERVISOR, supervisor: true })],
      overrides: {
        '/api/servant-sessions': () =>
          Response.json({ error: 'INTERNAL_ERROR', message: 'roster unavailable' }, { status: 500 }),
      },
    })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabReportTool, { taskId: 'task-1', summary: '汇报' })
    expect(data).toMatchObject({ ok: false, error: 'ledger_unsupported' })
    expect(stub.received.some((item) => item.method === 'POST')).toBe(false)
    expect(mailboxFiles()).toHaveLength(0)
  })
})

describe('CollabReview（主管）', () => {
  it('rework 自动把返工消息发给原员工（同 taskId）', async () => {
    const stub = startStub({ tasks: [makeTask({ status: 'delivered' })] })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabReviewTool, { taskId: 'task-1', verdict: 'rework', note: '测试没过' })
    const output = data as Record<string, unknown>
    expect(output).toMatchObject({ ok: true, taskId: 'task-1', status: 'rework' })
    expect(typeof output.reworkMessageId).toBe('string')

    const writes = stub.received.filter((item) => item.method === 'POST').map((item) => item.path)
    expect(writes).toEqual(['/api/collab-tasks/task-1/review', '/api/session-messages'])
    const message = stub.received.find((item) => item.path === '/api/session-messages')
    expect(message?.body).toMatchObject({ targetSessionId: WORKER, taskId: 'task-1' })
    expect(String(message?.body?.content)).toBe('【返工】测试没过')
    expectNoTurnState(output)
  })

  it('pass 结单，不发额外消息', async () => {
    const stub = startStub({ tasks: [makeTask({ status: 'delivered' })] })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabReviewTool, { taskId: 'task-1', verdict: 'pass' })
    expect(data).toMatchObject({ ok: true, status: 'verified' })
    expect(stub.received.filter((item) => item.method === 'POST')).toHaveLength(1)
  })

  it('409（还没 delivered）→ not_reviewable 并给出当前状态，不改状态', async () => {
    const stub = startStub({
      tasks: [makeTask({ status: 'in_progress' })],
      overrides: {
        '/api/collab-tasks/task-1/review': () =>
          Response.json({ error: 'CONFLICT', message: 'Invalid transition' }, { status: 409 }),
      },
    })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabReviewTool, { taskId: 'task-1', verdict: 'pass' })
    expect(data).toMatchObject({ ok: false, error: 'not_reviewable', status: 'in_progress' })
    expect(stub.received.some((item) => item.path === '/api/session-messages')).toBe(false)
  })

  it('对终态重复验收 → ok:true + already_final 告警', async () => {
    const stub = startStub({ tasks: [makeTask({ status: 'verified', verdict: 'pass' })] })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabReviewTool, { taskId: 'task-1', verdict: 'pass' })
    expect((data as { warnings?: string[] }).warnings).toContain(COLLAB_WARNING_CODES.alreadyFinal)
  })

  it('rework 缺 note → 本地拒绝；服务不可用 → server_unreachable（不写信箱）', async () => {
    const stub = startStub({ tasks: [makeTask({ status: 'delivered' })] })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })
    const missingNote = await callTool(CollabReviewTool, { taskId: 'task-1', verdict: 'rework' })
    expect(missingNote.data).toMatchObject({ ok: false, error: 'bad_request' })

    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: 'http://127.0.0.1:1' })
    const offline = await callTool(CollabReviewTool, { taskId: 'task-1', verdict: 'pass' })
    expect(offline.data).toMatchObject({ ok: false, error: 'server_unreachable' })
    expect(mailboxFiles()).toHaveLength(0)
  })
})

describe('CollabListTasks（主管 / 员工）', () => {
  it('员工只看得到派给自己的任务，且摘要不含正文与汇报全文', async () => {
    const stub = startStub({
      roster: [makeServant()],
      tasks: [
        makeTask({ id: 'task-1', status: 'in_progress' }),
        makeTask({ id: 'task-2', status: 'delivered', toSessionId: OTHER_WORKER, report: '别人写的汇报' }),
      ],
    })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const { data } = await callTool(CollabListTasksTool, {})
    const output = data as { ok: boolean; tasks: Array<Record<string, unknown>> }
    expect(output.ok).toBe(true)
    expect(output.tasks).toHaveLength(1)
    expect(output.tasks[0]).toMatchObject({ taskId: 'task-1', status: 'in_progress', to: { sessionId: WORKER, role: '前端' } })
    expect(output.tasks[0]).not.toHaveProperty('content')
    expect(output.tasks[0]).not.toHaveProperty('report')
    expectNoTurnState(output)
  })

  it("status='open' 在客户端过滤未结任务；limit 生效", async () => {
    const stub = startStub({
      roster: [makeServant()],
      tasks: [
        makeTask({ id: 'task-1', status: 'verified', updatedAt: 9 }),
        makeTask({ id: 'task-2', status: 'rework', updatedAt: 8 }),
        makeTask({ id: 'task-3', status: 'dispatched', updatedAt: 7 }),
      ],
    })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const filtered = await callTool(CollabListTasksTool, { status: 'open', limit: 1 })
    const tasks = (filtered.data as { tasks: Array<{ taskId: string }> }).tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.taskId).toBe('task-2')

    const all = await callTool(CollabListTasksTool, {})
    expect((all.data as { tasks: unknown[] }).tasks).toHaveLength(3)
  })

  it('taskId 单查返回完整记录；员工查别人的任务被拒', async () => {
    const stub = startStub({
      roster: [makeServant()],
      tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-9', toSessionId: OTHER_WORKER })],
    })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const mine = await callTool(CollabListTasksTool, { taskId: 'task-1' })
    expect((mine.data as { task: Record<string, unknown> }).task).toMatchObject({
      taskId: 'task-1',
      content: '任务正文全文',
    })
    const others = await callTool(CollabListTasksTool, { taskId: 'task-9' })
    expect(others.data).toMatchObject({ ok: false, error: 'invalid_target' })
  })

  it('服务不可用 → server_unreachable 且不写信箱（读操作不走信箱）', async () => {
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: 'http://127.0.0.1:1' })
    const { data } = await callTool(CollabListTasksTool, {})
    expect(data).toMatchObject({ ok: false, error: 'server_unreachable' })
    expect(mailboxFiles()).toHaveLength(0)
  })

  it('旧服务端无台账 → ledger_unsupported', async () => {
    const stub = startStub({ capabilities: null })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })
    const { data } = await callTool(CollabListTasksTool, {})
    expect(data).toMatchObject({ ok: false, error: 'ledger_unsupported' })
  })
})

describe('静态断言：工具输出与会话回合态隔离', () => {
  it('四个工具源码里不出现禁用字段，且工具定义可按角色取到', () => {
    const dir = new URL('../../tools/CollabTools/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts') && name !== 'shared.ts')
    expect(files.length).toBeGreaterThanOrEqual(5)
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8')
      for (const field of FORBIDDEN_TURN_STATE_FIELDS) {
        // 允许出现于注释中的说明（如 shared.ts 的契约解释），故断言的是「赋值/字段声明」形态
        expect(source).not.toMatch(new RegExp(`['"\`]?${field}['"\`]?\\s*[:?]\\s*[^:\\s]`, 'i'))
      }
    }
  })

  it('非协作会话的工具清单零变化；协作会话按角色注入（装配线端到端）', () => {
    const saved = {
      session: process.env.CC_HEIHEI_SESSION_ID,
      role: process.env.CC_HEIHEI_COLLAB_ROLE,
      supervisor: process.env.CC_HEIHEI_SUPERVISOR,
    }
    const restore = () => {
      for (const [key, value] of [
        ['CC_HEIHEI_SESSION_ID', saved.session],
        ['CC_HEIHEI_COLLAB_ROLE', saved.role],
        ['CC_HEIHEI_SUPERVISOR', saved.supervisor],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const namesNow = (): string[] => {
      const names = getAllBaseTools().map((tool) => tool.name)
      restore()
      return names
    }

    try {
      delete process.env.CC_HEIHEI_SESSION_ID
      delete process.env.CC_HEIHEI_COLLAB_ROLE
      delete process.env.CC_HEIHEI_SUPERVISOR
      const plain = namesNow()
      // 普通会话：一个协作工具都不多（验收 7）
      expect(plain.filter((name) => name.startsWith('Collab'))).toEqual([])
      // 基础工具仍在——装配线没被破坏
      expect(plain).toContain('Bash')
      expect(plain).toContain('TaskCreate')

      process.env.CC_HEIHEI_SESSION_ID = WORKER
      process.env.CC_HEIHEI_COLLAB_ROLE = 'servant'
      const servant = namesNow()
      expect(servant).toContain(COLLAB_TOOL_NAMES.report)
      expect(servant).toContain(COLLAB_TOOL_NAMES.listTasks)
      expect(servant).not.toContain(COLLAB_TOOL_NAMES.dispatch) // 员工不互派
      expect(servant).not.toContain(COLLAB_TOOL_NAMES.review)

      process.env.CC_HEIHEI_SESSION_ID = SUPERVISOR
      process.env.CC_HEIHEI_COLLAB_ROLE = 'supervisor'
      const supervisor = namesNow()
      expect(supervisor).toContain(COLLAB_TOOL_NAMES.dispatch)
      expect(supervisor).toContain(COLLAB_TOOL_NAMES.review)
      expect(supervisor).toContain(COLLAB_TOOL_NAMES.listTasks)
      expect(supervisor).not.toContain(COLLAB_TOOL_NAMES.report) // 主管自己汇报？不注入
    } finally {
      restore()
    }

    // 纵深防御：isEnabled 也按角色把关（即使被误装配也调不动）
    expect(CollabDispatchTool.isEnabled()).toBe(resolveCollabRole() === 'supervisor')
    expect(CollabReportTool.isEnabled()).toBe(resolveCollabRole() === 'servant')
  })

  it('工具描述与提示文本合计不超过 1500 字（系统提示预算）', async () => {
    const tools = [CollabDispatchTool, CollabReviewTool, CollabListTasksTool, CollabReportTool]
    let total = 0
    for (const tool of tools) {
      const description = await (tool as unknown as {
        description: (input: unknown, options: unknown) => Promise<string>
      }).description({}, {})
      const prompt = await (tool as unknown as { prompt: (options: unknown) => Promise<string> }).prompt({})
      total += description.length + prompt.length
    }
    expect(total).toBeLessThanOrEqual(1500)
  })

  it('花名册里的回合态字段不会渗进工具输出（端到端）', async () => {
    const stub = startStub({ roster: [makeServant({ running: true, turnInProgress: true })], tasks: [makeTask()] })
    stopServer = stub.stop
    useEnv({ CC_HEIHEI_SESSION_ID: SUPERVISOR, CC_HEIHEI_COLLAB_ROLE: 'supervisor', CC_HEIHEI_DESKTOP_SERVER_URL: stub.baseUrl })

    const dispatched = await callTool(CollabDispatchTool, { to: '前端', content: '任务' })
    const listed = await callTool(CollabListTasksTool, {})
    expectNoTurnState(dispatched.data)
    expectNoTurnState(listed.data)
    expect(JSON.stringify(dispatched.data)).not.toContain('turnInProgress')
    expect(JSON.stringify(listed.data)).not.toContain('running')
  })
})
