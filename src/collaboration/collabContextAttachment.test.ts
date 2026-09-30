import { afterEach, describe, expect, test } from 'bun:test'
import {
  COLLAB_CONTEXT_CARD_MAX,
  createCollabContextAttachmentIfNeeded,
  resetCollabContextAttachmentForTests,
  setCollabContextDepsForTests,
} from './collabContextAttachment.js'
import { COLLAB_RULES_DIGEST, DISPATCH_PROTOCOL_MD } from './dispatchProtocol.js'
import { COLLAB_API_PATHS, COLLAB_PORT_FILE_DIR, COLLAB_PORT_FILE_NAME, COLLAB_SESSION_ID_ENV, SERVER_CAPABILITY_COLLAB_CONTEXT } from './collabToolContract.js'

const CONTEXT_URL = `http://127.0.0.1:43210${COLLAB_API_PATHS.collabContext}`
const WHOAMI_URL = `http://127.0.0.1:43210${COLLAB_API_PATHS.whoami}`
const NO_SERVER_FILE = `${COLLAB_PORT_FILE_DIR}/${COLLAB_PORT_FILE_NAME}.missing`

function makeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CC_HEIHEI_DESKTOP_SERVER_URL: 'http://127.0.0.1:43210',
    [COLLAB_SESSION_ID_ENV]: 'session-self',
    CC_HEIHEI_COLLAB_ROLE: 'supervisor',
    ...extra,
  }
}

function installFetch(context: unknown, calls: string[] = []) {
  setCollabContextDepsForTests({
    portFilePath: NO_SERVER_FILE,
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url === WHOAMI_URL) {
        return Response.json({
          app: 'cc-heihei',
          capabilities: [SERVER_CAPABILITY_COLLAB_CONTEXT],
        })
      }
      if (url.startsWith(CONTEXT_URL)) return Response.json(context)
      return Response.json({}, { status: 404 })
    }) as typeof fetch,
    isPidAlive: () => false,
    log: (() => {}) as typeof import('../utils/diagLogs.js').logForDiagnosticsNoPII,
  })
  return calls
}

afterEach(() => {
  resetCollabContextAttachmentForTests()
})

describe('createCollabContextAttachmentIfNeeded', () => {
  test('普通会话与关闭开关时不发请求、不注入', async () => {
    let called = false
    setCollabContextDepsForTests({
      portFilePath: NO_SERVER_FILE,
      fetch: (async () => {
        called = true
        return Response.json({})
      }) as typeof fetch,
    })

    expect(await createCollabContextAttachmentIfNeeded({})).toBeNull()
    expect(await createCollabContextAttachmentIfNeeded(makeEnv({ CC_HEIHEI_COLLAB_CONTINUATION: '0' }))).toBeNull()
    expect(called).toBe(false)
  })

  test('主管卡包含规则真源子串、花名册、计数和待验收优先任务', async () => {
    const calls: string[] = []
    installFetch({
      role: '主管',
      supervisor: true,
      rulesDigest: COLLAB_RULES_DIGEST,
      roster: [{ role: '架构师', sessionId: 'architect-session' }],
      tasks: {
        counts: { delivered: 1, rework: 1, in_progress: 2 },
        items: [
          { taskId: 'rework-id', title: '返工任务', status: 'rework', toRole: '后端', lastReworkNote: '补边界测试' },
          { taskId: 'delivered-id', title: '待验收', status: 'delivered', toRole: '测试' },
        ],
        truncated: 0,
      },
      snapshotAt: '2026-09-30T10:00:00.000Z',
    }, calls)

    const attachment = await createCollabContextAttachmentIfNeeded(makeEnv())
    expect(attachment?.attachment.type).toBe('collab_context')
    if (!attachment || attachment.attachment.type !== 'collab_context') throw new Error('missing collab context')
    expect(attachment.attachment.openTaskCount).toBe(4)
    expect(attachment.attachment.text).toContain(COLLAB_RULES_DIGEST)
    for (const line of COLLAB_RULES_DIGEST.split('\n')) expect(DISPATCH_PROTOCOL_MD).toContain(line)
    expect(attachment.attachment.text).toContain('架构师 → architect-session')
    expect(attachment.attachment.text.indexOf('delivered-id')).toBeLessThan(attachment.attachment.text.indexOf('rework-id'))
    expect(attachment.attachment.text).toContain('最近返工：补边界测试')
    expect(calls).toHaveLength(2)
    expect(calls.some((url) => url.startsWith(`${CONTEXT_URL}?sessionId=session-self`))).toBe(true)
  })

  test('员工卡保留自己的当前任务正文和最近返工说明', async () => {
    installFetch({
      role: '后端',
      supervisor: false,
      description: '负责服务端开发',
      tasks: {
        counts: { in_progress: 1, rework: 1 },
        items: [
          { taskId: 'older', title: '旧任务', status: 'rework', fromSessionId: 'boss', lastReworkNote: '修复边界' },
          { taskId: 'current', title: '当前', status: 'in_progress', fromSessionId: 'boss' },
        ],
        truncated: 0,
      },
      currentTask: {
        taskId: 'current',
        content: `${'界'.repeat(805)}`,
        lastReworkNote: '补充错误处理',
      },
      snapshotAt: '2026-09-30T10:00:00.000Z',
    })

    const attachment = await createCollabContextAttachmentIfNeeded(makeEnv({ CC_HEIHEI_COLLAB_ROLE: 'servant' }))
    if (!attachment || attachment.attachment.type !== 'collab_context') throw new Error('missing collab context')
    expect(attachment.attachment.text).toContain('你的角色：后端——负责服务端开发')
    expect(attachment.attachment.text).toContain('当前任务正文（current）：')
    expect(attachment.attachment.text).toContain('最近返工：补充错误处理')
    expect(Array.from(attachment.attachment.text.split('当前任务正文（current）：')[1]!.split('\n')[0]!).length).toBeLessThanOrEqual(820)
  })

  test('旧服务端或网络失败降级到仅身份卡并记录无 PII 诊断类别', async () => {
    const logs: Array<{ event: string; data: Record<string, unknown> }> = []
    setCollabContextDepsForTests({
      portFilePath: NO_SERVER_FILE,
      fetch: (async () => { throw new Error('sensitive URL and response') }) as typeof fetch,
      log: ((_level: string, event: string, data: Record<string, unknown>) => logs.push({ event, data })) as typeof import('../utils/diagLogs.js').logForDiagnosticsNoPII,
    })
    const attachment = await createCollabContextAttachmentIfNeeded(makeEnv())
    if (!attachment || attachment.attachment.type !== 'collab_context') throw new Error('missing fallback')
    expect(attachment.attachment.openTaskCount).toBe(0)
    expect(attachment.attachment.text).toContain('你是本项目主管（session-self）')
    expect(attachment.attachment.text).toContain('请先用 CollabListTasks 查询任务')
    expect(attachment.attachment.text).toContain('服务暂不可达')
    expect(attachment.attachment.text).not.toContain('sensitive URL')
    expect(logs[0]?.event).toBe('collab_context_fetch_failed')
    expect(JSON.stringify(logs[0]?.data)).not.toContain('sensitive')
  })

  test('固定 2000 码点上限且输出静态排除回合态字样', async () => {
    installFetch({
      role: '主管',
      supervisor: true,
      rulesDigest: COLLAB_RULES_DIGEST,
      roster: Array.from({ length: 30 }, (_, index) => ({ role: `角色${index}`, sessionId: `id-${index}` })),
      tasks: {
        counts: { dispatched: 12 },
        items: Array.from({ length: 10 }, (_, index) => ({
          taskId: `task-${index}`,
          title: '任务'.repeat(120),
          status: index === 0 ? 'delivered' : 'dispatched',
          toRole: '后端',
        })),
        truncated: 2,
      },
      snapshotAt: '2026-09-30T10:00:00.000Z',
      running: true,
    })
    const attachment = await createCollabContextAttachmentIfNeeded(makeEnv())
    if (!attachment || attachment.attachment.type !== 'collab_context') throw new Error('missing context')
    expect(COLLAB_CONTEXT_CARD_MAX).toBe(2000)
    expect(Array.from(attachment.attachment.text).length).toBeLessThanOrEqual(COLLAB_CONTEXT_CARD_MAX)
    for (const forbidden of ['running', 'turnInProgress', 'busy', 'phase']) {
      expect(attachment.attachment.text.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  test('每次 compact 都重新请求，不缓存上下文快照', async () => {
    const calls: string[] = []
    installFetch({
      role: '主管',
      supervisor: true,
      rulesDigest: COLLAB_RULES_DIGEST,
      roster: [],
      tasks: { counts: {}, items: [], truncated: 0 },
      snapshotAt: '2026-09-30T10:00:00.000Z',
    }, calls)
    await createCollabContextAttachmentIfNeeded(makeEnv())
    await createCollabContextAttachmentIfNeeded(makeEnv())
    expect(calls).toHaveLength(4)
  })

  test('1500ms 超时用身份卡降级而不是传播异常', async () => {
    setCollabContextDepsForTests({
      portFilePath: NO_SERVER_FILE,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBeDefined()
        const error = new Error('timeout')
        error.name = 'TimeoutError'
        throw error
      }) as typeof fetch,
    })
    const attachment = await createCollabContextAttachmentIfNeeded(makeEnv())
    expect(attachment?.attachment.type).toBe('collab_context')
    if (!attachment || attachment.attachment.type !== 'collab_context') throw new Error('missing timeout fallback')
    expect(attachment.attachment.text).toContain('CollabListTasks')
  })
})
