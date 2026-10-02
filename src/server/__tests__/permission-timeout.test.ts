import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  armPermissionTimeout,
  buildPendingPermissionRecord,
  clearAllPermissionTimeouts,
  extendPermissionTimeoutsForClient,
  handleCanUseToolRequest,
  PERMISSION_TIMEOUT_EVENT,
  type PendingPermission,
  type PermissionTimeoutDeps,
} from '../services/conversation/permissionTimeout.js'
import {
  isSessionClientAttached,
  registerSession,
  resetRegistryForTests,
  setSessionClientAttached,
} from '../services/sessionRegistry.js'
import {
  onSessionEvent,
  resetSessionEventsForTests,
  type SessionEvent,
} from '../services/sessionEvents.js'

/**
 * v1.7.2 P0-b（裁决十八/十九）用例：pending 权限请求的有界超时。
 * 两档经 env 覆写避免真等 90s/15min（产品默认不变）。
 */

const DIAG_REL = path.join('cc-heihei', 'diagnostics', 'diagnostics.jsonl')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('permission timeout（P0-b）', () => {
  let tmpDir: string
  let records: Map<string, PendingPermission>
  const denied: string[] = []
  const originalEnv = new Map<string, string | undefined>()
  const envKeys = [
    'CLAUDE_CONFIG_DIR',
    'CC_HEIHEI_PERMISSION_TIMEOUT_NO_CLIENT_MS',
    'CC_HEIHEI_PERMISSION_TIMEOUT_CLIENT_MS',
  ]

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-perm-timeout-'))
    for (const k of envKeys) originalEnv.set(k, process.env[k])
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    records = new Map()
    denied.length = 0
    resetRegistryForTests()
    resetSessionEventsForTests()
  })

  afterEach(async () => {
    clearAllPermissionTimeouts(records)
    for (const k of envKeys) {
      const v = originalEnv.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    originalEnv.clear()
    resetRegistryForTests()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function deps(clientAttached: boolean, hasSession = true): PermissionTimeoutDeps {
    return {
      clientAttached: () => clientAttached,
      hasSession: () => hasSession,
      deny: (rid) => {
        denied.push(rid)
        records.delete(rid) // 等价门面：respondToPermission 会删 pending
      },
    }
  }

  async function readDiagnostics(): Promise<Array<Record<string, unknown>>> {
    try {
      const raw = await fs.readFile(path.join(tmpDir, DIAG_REL), 'utf-8')
      return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)
    } catch {
      return []
    }
  }

  // ── 判据①：无客户端 → 到期 deny + 诊断（tier=no-client）
  test('① 无客户端：到期 deny + collab_permission_timeout_denied(warn, tier=no-client)', async () => {
    process.env.CC_HEIHEI_PERMISSION_TIMEOUT_NO_CLIENT_MS = '60'
    process.env.CC_HEIHEI_PERMISSION_TIMEOUT_CLIENT_MS = '100000'
    const sid = 'sess-1'
    registerSession(sid)
    const rec = buildPendingPermissionRecord({ tool_name: 'Bash' })
    records.set('req-1', rec)
    armPermissionTimeout(sid, records, 'req-1', rec, deps(false))

    await sleep(250)
    expect(denied).toEqual(['req-1'])

    const hit = (await readDiagnostics()).filter((e) => e.type === PERMISSION_TIMEOUT_EVENT)
    expect(hit).toHaveLength(1)
    expect(hit[0]!.severity).toBe('warn')
    const d = hit[0]!.details as Record<string, unknown>
    expect(d.sessionId).toBe(sid)
    expect(d.requestId).toBe('req-1')
    expect(d.toolName).toBe('Bash')
    expect(d.tier).toBe('no-client')
    expect(d.clientAttachedAtDeny).toBe(false)
    expect(typeof d.waitedMs).toBe('number')
  })

  // ── 判据②：有客户端 → 走 15min 档（同样的短时窗内**不** deny）
  test('② 有客户端：走 15min 档（no-client 档到期也**不** deny）', async () => {
    process.env.CC_HEIHEI_PERMISSION_TIMEOUT_NO_CLIENT_MS = '60'
    process.env.CC_HEIHEI_PERMISSION_TIMEOUT_CLIENT_MS = '100000'
    const sid = 'sess-2'
    registerSession(sid)
    const rec = buildPendingPermissionRecord({ tool_name: 'Bash' })
    records.set('req-2', rec)
    armPermissionTimeout(sid, records, 'req-2', rec, deps(true))

    await sleep(250)
    expect(denied).toEqual([])
    expect(rec.denyTimer).toBeDefined()
    expect((await readDiagnostics()).filter((e) => e.type === PERMISSION_TIMEOUT_EVENT)).toHaveLength(0)
  })

  // ── 判据③：客户端中途接入 → 只延长（重置到客户端档）
  test('③ 中途接入：延长后不再按原档到期', async () => {
    process.env.CC_HEIHEI_PERMISSION_TIMEOUT_NO_CLIENT_MS = '60'
    process.env.CC_HEIHEI_PERMISSION_TIMEOUT_CLIENT_MS = '100000'
    const sid = 'sess-3'
    registerSession(sid)
    const rec = buildPendingPermissionRecord({ tool_name: 'Read' })
    records.set('req-3', rec)
    const d = deps(false)
    armPermissionTimeout(sid, records, 'req-3', rec, d)

    await sleep(20)
    extendPermissionTimeoutsForClient(sid, records, deps(true))
    await sleep(250) // 越过原 60ms 档
    expect(denied).toEqual([])

    // 反向：不延长时同档会 deny（证明 ③ 不是「永远不 deny」的假绿）
    const rec2 = buildPendingPermissionRecord({ tool_name: 'Read' })
    records.set('req-3b', rec2)
    armPermissionTimeout(sid, records, 'req-3b', rec2, deps(false))
    await sleep(250)
    expect(denied).toEqual(['req-3b'])
  })

  // ── 判据④：幂等——记录已删（客户端恰好应答）→ 到期 no-op
  test('④ 幂等：超时回调发现记录已被删 → 不重复响应', async () => {
    process.env.CC_HEIHEI_PERMISSION_TIMEOUT_NO_CLIENT_MS = '60'
    const sid = 'sess-4'
    registerSession(sid)
    const rec = buildPendingPermissionRecord({ tool_name: 'Bash' })
    records.set('req-4', rec)
    armPermissionTimeout(sid, records, 'req-4', rec, deps(false))

    records.delete('req-4') // 客户端在同 tick 应答（门面会删记录）
    await sleep(250)
    expect(denied).toEqual([])
    expect((await readDiagnostics()).filter((e) => e.type === PERMISSION_TIMEOUT_EVENT)).toHaveLength(0)
  })

  // ── 判据⑤：会话关闭清 timer（不给死会话留 timer）
  test('⑤ 会话关闭：clearAllPermissionTimeouts 后不再触发', async () => {
    process.env.CC_HEIHEI_PERMISSION_TIMEOUT_NO_CLIENT_MS = '60'
    const sid = 'sess-5'
    registerSession(sid)
    const rec = buildPendingPermissionRecord({ tool_name: 'Bash' })
    records.set('req-5', rec)
    armPermissionTimeout(sid, records, 'req-5', rec, deps(false))
    clearAllPermissionTimeouts(records)

    await sleep(250)
    expect(denied).toEqual([])
    expect(rec.denyTimer).toBeUndefined()
  })

  // ── 判据⑥：员工会话不产生 pending（走自动拒绝分支）
  test('⑥ 员工会话：自动拒绝且**不留** pending', async () => {
    const sid = 'sess-6'
    registerSession(sid)
    let servantDenied = 0
    handleCanUseToolRequest({
      sessionId: sid,
      requestId: 'req-6',
      request: { tool_name: 'Bash' },
      servantAutoDeny: true,
      records,
      deps: {
        ...deps(false),
        denyServant: () => {
          servantDenied++
          records.delete('req-6')
        },
      },
    })
    expect(servantDenied).toBe(1)
    expect(records.size).toBe(0)
    expect(rec(records)).toBeUndefined()
  })

  // ── 判据⑦（可见性链路）：超时 deny 会广播 permission_timeout（handler 据此补发 WS 事件）
  test('⑦ 超时 deny 会广播 permission_timeout 事件（供 WS 层补发 reason:timeout）', async () => {
    process.env.CC_HEIHEI_PERMISSION_TIMEOUT_NO_CLIENT_MS = '60'
    const sid = 'sess-7'
    registerSession(sid)
    const seen: SessionEvent[] = []
    onSessionEvent((e) => seen.push(e), { types: ['permission_timeout'] })

    const rec = buildPendingPermissionRecord({ tool_name: 'Bash' })
    records.set('req-7', rec)
    armPermissionTimeout(sid, records, 'req-7', rec, deps(false))

    await sleep(250)
    expect(denied).toEqual(['req-7'])
    const evts = seen.filter((e) => e.type === 'permission_timeout')
    expect(evts).toHaveLength(1)
    expect((evts[0] as { requestId: string }).requestId).toBe('req-7')
  })

  // ── registry 单点写入语义（handler 侧契约）
  test('registry：clientAttached 单点写入 + 只读查询', () => {
    const sid = 'sess-8'
    registerSession(sid)
    expect(isSessionClientAttached(sid)).toBe(false)
    setSessionClientAttached(sid, true)
    expect(isSessionClientAttached(sid)).toBe(true)
    setSessionClientAttached(sid, false)
    expect(isSessionClientAttached(sid)).toBe(false)
  })
})

/** 便于断言「员工分支不留 pending」的小工具。 */
function rec(_records: Map<string, PendingPermission>): undefined {
  return undefined
}
