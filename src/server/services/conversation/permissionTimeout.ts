/**
 * 权限请求超时（v1.7.2 P0-b，裁决十八/十九）：`pendingPermissionRequests` 原本**无任何
 * 超时/过期** ⇒ 非员工会话的 `can_use_tool` 无人应答时永久等待、回合永不结束。
 *
 * 两档（有界）：
 * - **有客户端在线 15 分钟**（用户在跟前，审批卡片可见）；
 * - **无客户端 90 秒**（覆盖 WS 重连退避：客户端 `desktop/src/api/websocket.ts:238`
 *   `Math.min(1000 * 2 ** attempt, 30_000)` ⇒ 退避上限 **30s**，90s 为其 3 倍余量）。
 * 到期统一 **deny + 诊断 + 清理**；客户端**中途接入只延长**（重置到 15min 档），
 * **断开不降档、不重置**（裁决十九）。
 *
 * 计时器**挂在既有 pending 记录上**（不新开调度器）；结构化窄缝，本模块零 `this`。
 */

import { diagnosticsService } from '../diagnosticsService.js'
import { emitPermissionTimeout, setAwaitingPermission } from '../sessionRegistry.js'

export const PERMISSION_TIMEOUT_CLIENT_MS_DEFAULT = 15 * 60_000
export const PERMISSION_TIMEOUT_NO_CLIENT_MS_DEFAULT = 90_000

/** 超时自动拒绝时给 CLI 的说明（与员工自动拒绝同族语义：无人可审批）。 */
export const PERMISSION_TIMEOUT_DENY_MESSAGE =
  '权限请求等待超时，已自动拒绝（该会话无人应答审批）。'

/** 诊断事件名（门面/用例共用，避免字面量漂移）。 */
export const PERMISSION_TIMEOUT_EVENT = 'collab_permission_timeout_denied'

/** 两档毫秒数：产品默认见上方常量；测试可经 env 覆写（每次调用读取）。 */
export function permissionTimeoutClientMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CC_HEIHEI_PERMISSION_TIMEOUT_CLIENT_MS ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : PERMISSION_TIMEOUT_CLIENT_MS_DEFAULT
}

export function permissionTimeoutNoClientMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CC_HEIHEI_PERMISSION_TIMEOUT_NO_CLIENT_MS ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : PERMISSION_TIMEOUT_NO_CLIENT_MS_DEFAULT
}

/** pending 记录（原 conversationService 内联类型；超时计时器挂在这条记录上）。 */
export type PendingPermission = {
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  description?: string
  permissionSuggestions?: unknown[]
  denyTimer?: ReturnType<typeof setTimeout>
}

/** 从 CLI 的 can_use_tool 请求构造 pending 记录（逐字搬自门面，无逻辑改动）。 */
export function buildPendingPermissionRecord(request: unknown): PendingPermission {
  const r = (request ?? {}) as Record<string, unknown>
  return {
    toolName: typeof r.tool_name === 'string' ? r.tool_name : 'Unknown',
    toolUseId:
      typeof r.tool_use_id === 'string' && r.tool_use_id.trim() ? r.tool_use_id : undefined,
    input: r.input && typeof r.input === 'object' ? (r.input as Record<string, unknown>) : {},
    description:
      typeof r.description === 'string' && r.description.trim() ? r.description : undefined,
    permissionSuggestions: Array.isArray(r.permission_suggestions)
      ? r.permission_suggestions
      : undefined,
  }
}

export type PermissionTimeoutDeps = {
  /** 该会话当前是否有客户端在线（registry 只读）。 */
  clientAttached: () => boolean
  /** 会话是否仍存在（已关闭则回调 no-op，避免给死会话留副作用）。 */
  hasSession: () => boolean
  /** 到期动作：门面注入 `respondToPermission(..., false, …, PERMISSION_TIMEOUT_DENY_MESSAGE)`。 */
  deny: (requestId: string) => void
}

export function clearPermissionTimeout(record: PendingPermission | undefined): void {
  if (record?.denyTimer) {
    clearTimeout(record.denyTimer)
    record.denyTimer = undefined
  }
}

/** 会话关闭/进程退出：清掉该会话所有未触发的 timer（别给死会话留 timer）。 */
export function clearAllPermissionTimeouts(records: Map<string, PendingPermission>): void {
  for (const record of records.values()) clearPermissionTimeout(record)
}

/** 登记时定时（挂在 pending 记录上）。 */
export function armPermissionTimeout(
  sessionId: string,
  records: Map<string, PendingPermission>,
  requestId: string,
  record: PendingPermission,
  deps: PermissionTimeoutDeps,
): void {
  clearPermissionTimeout(record)
  const armedAt = Date.now()
  const timeoutMs = deps.clientAttached()
    ? permissionTimeoutClientMs()
    : permissionTimeoutNoClientMs()
  record.denyTimer = setTimeout(() => {
    record.denyTimer = undefined
    // 幂等/竞态：记录已被删（客户端恰好应答）或会话已关 → 一律 no-op（不重复响应）。
    if (records.get(requestId) !== record) return
    if (!deps.hasSession()) return
    deps.deny(requestId)
    const clientAttachedAtDeny = deps.clientAttached()
    void diagnosticsService
      .recordEvent({
        type: PERMISSION_TIMEOUT_EVENT,
        severity: 'warn',
        sessionId,
        summary: `权限请求等待超时（${clientAttachedAtDeny ? 'client-online' : 'no-client'}）已自动拒绝`,
        details: {
          sessionId,
          requestId,
          toolName: record.toolName,
          waitedMs: Date.now() - armedAt,
          tier: clientAttachedAtDeny ? 'client-online' : 'no-client',
          clientAttachedAtDeny,
          at: Date.now(),
        },
      })
      .catch(() => {})
    // 让 WS 层能补发 permission_resolved（reason:'timeout'）给在线客户端。
    emitPermissionTimeout(sessionId, requestId, record.toolName)
  }, timeoutMs)
}

/**
 * 客户端**中途接入** → 只延长（重置到 15min 档）。已连上的会话不做任何事；
 * 未决请求不存在时自然无操作。**断开不调用本函数**（不降档、不重置）。
 */
export function extendPermissionTimeoutsForClient(
  sessionId: string,
  records: Map<string, PendingPermission>,
  deps: PermissionTimeoutDeps,
): void {
  if (!deps.clientAttached()) return
  for (const [requestId, record] of [...records.entries()]) {
    if (!record.denyTimer) continue
    armPermissionTimeout(sessionId, records, requestId, record, deps)
  }
}

/** 员工会话的自动拒绝文案由门面注入（避免本模块依赖 collaboration 层）。 */
export type CanUseToolHandling = {
  sessionId: string
  requestId: string
  request: Record<string, unknown>
  /** 员工会话（在册且非主管 + 开关开）：直接 deny，绝不停在等点击。 */
  servantAutoDeny: boolean
  records: Map<string, PendingPermission>
  deps: PermissionTimeoutDeps & { denyServant: (requestId: string) => void }
}

/**
 * can_use_tool 的两种收口（逐字搬自门面，仅把拒绝文案与依赖提为参数）：
 * - **员工**：不登记给客户端、直接 deny + 诊断（契约 §3.3 第 3 条）；
 * - **其他（主管/用户）**：登记 pending + **登记即定时**（裁决十八①）+ 同步 awaitingPermission。
 */
/** 返回 true = 已在内部消化（**调用方须 continue**，不得再转发给客户端）。 */
export function handleCanUseToolRequest(args: CanUseToolHandling): boolean {
  const { sessionId, requestId, request, records, deps } = args
  if (args.servantAutoDeny) {
    const toolName = typeof request.tool_name === 'string' ? request.tool_name : 'Unknown'
    // P0-b：收紧后的 respondToPermission 要求先有 pending（该分支原本不登记，会被 no-op 掉
    // → 员工会话挂起）。此处补登记，语义与之前逐字一致（随即被 deny 删除）。
    records.set(requestId, buildPendingPermissionRecord(request))
    deps.denyServant(requestId)
    void diagnosticsService.recordEvent({
      type: 'collab_servant_permission_auto_denied',
      severity: 'warn',
      sessionId,
      summary: `员工会话的 ${toolName} 权限请求已自动拒绝（无人可审批）`,
      details: { sessionId, toolName, at: Date.now() },
    })
    return true
  }
  const record = buildPendingPermissionRecord(request)
  records.set(requestId, record)
  armPermissionTimeout(sessionId, records, requestId, record, deps)
  // registry 记账（阶段2 · 5c）：权限等待状态单一权威源同步
  setAwaitingPermission(sessionId, true)
  return false
}
