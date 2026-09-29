/**
 * sessionRegistry —— 会话生命周期 / 回合 / 权限状态的单一权威源
 * （v1.3.0 地基重构 · 阶段 0 骨架：纯加法零接线，API 全量落地，尚无存量调用方）。
 *
 * 分层（架构方案 §1 / §7）：registry 属 L1，只依赖 types/utils（本文件仅依赖
 * utils/diagLogs 与兄弟模块 sessionEvents）；其余全部模块是它的写入者/订阅者。
 *
 * 硬约束落地：
 * - C1 仅内存态：tombstone/crashed 不落盘，进程结束即消失（持久化属排除项）。
 * - C5 先改状态后发事件；事件载荷只带 sessionId + 状态字段（防环）。
 * - C7 无 mock.module；提供 resetRegistryForTests。
 *
 * ── 双输入源交错规则（架构方案 §4 阶段 1 合同补充 2；本阶段先在 API 设计留口）──
 * turn 字段未来有两个写入者：
 *   1. 注入路径 beginTurn —— 唯一的预登记入口；
 *   2. dispatchReceipt 观察流（SDK 消息流，阶段 1/2 接线）。
 * 规则：**观察流只降不升** —— 观察到的「进行中」信号在无 turn 时**丢弃**
 * （不得新建 turn）；观察到的 result 清除**任何** turn（观察流是 CLI 事实的
 * 最终裁决者）。阶段 0 不开放观察流写入入口（避免半成品 API）；接线时按此
 * 规则补一个 `observeTurnResult` 类 API（命名阶段 1 定），语义等价于
 * 「无条件按身份豁免的清 turn」，并配三组时序交错测试（观察先行/注入先行/双清竞争）。
 */
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { assertNotReentrant, emitSessionEvent } from './sessionEvents.js'

/** 会话生命周期六态（架构方案 §1）。 */
export type SessionPhase =
  | 'registered' // 已登记（元数据可用），无进程
  | 'starting' // 进程拉起中（startupPending）
  | 'running' // 进程在跑
  | 'crashed' // 进程异常退出，保留元数据等显式决策（新增态）
  | 'stopped' // 主动停止
  | 'deleted' // tombstone：API 层按不存在处理（内存态，C1）

/**
 * 回合三态。
 * - awaiting_send 对应现 ActiveUserTurnState.messageSent=false（CLI 拉起中）
 * - turn_in_progress 对应 messageSent=true
 */
export type TurnPhase = 'none' | 'awaiting_send' | 'turn_in_progress'

/** 无锁读取快照（只带状态字段，防环）。 */
export type SessionSnapshot = {
  sessionId: string
  phase: SessionPhase
  turn: TurnPhase
  /** 幂等守卫（现 activeTurn 引用比对的替代；symbol 由 registry 内部创建） */
  turnOwner: symbol | null
  awaitingPermission: boolean
  lastTurnEndedAt: number | null
}

/**
 * beginTurn 返回的回合句柄。`identity` 是内部身份符号——调用方把它原样传回
 * `settleTurnIfOwner(id, handle)` 即可完成「比对后才清」的幂等语义，勿自行构造。
 */
export type TurnHandle = {
  readonly identity: symbol
  abort(): void
  settle(result: { isError: boolean }): void
}

/**
 * markCrashed 的 meta：常规崩溃带 `exitCode`；startup 拉起失败走 `{ startup: true }`
 * （架构方案 §5d :504）。文档 §1 签名为 `{ exitCode: number }`，此处放宽为可选字段的
 * 联合形态以同时容纳两处调用（§11 允许签名微调，三语义契约不受影响）。
 */
export type CrashMeta = {
  exitCode?: number
  startup?: boolean
  reason?: string
}

type InternalState = {
  phase: SessionPhase
  turn: TurnPhase
  turnOwner: symbol | null
  awaitingPermission: boolean
  lastTurnEndedAt: number | null
}

const sessions = new Map<string, InternalState>()

/**
 * 合法 phase 迁移表（架构方案 §1 表格；合同测试逐条锁定）。
 * 对角线（同相重复调用）不在表内——按幂等 no-op 处理，不发事件、不记诊断。
 * 表外非对角迁移：拒绝（状态不变）并记 warn 诊断，绝不静默失败。
 */
const LEGAL_TRANSITIONS: Readonly<Record<SessionPhase, ReadonlySet<SessionPhase>>> = {
  registered: new Set<SessionPhase>(['starting', 'deleted']),
  starting: new Set<SessionPhase>(['registered', 'running', 'crashed', 'stopped', 'deleted']),
  running: new Set<SessionPhase>(['starting', 'crashed', 'stopped', 'deleted']),
  crashed: new Set<SessionPhase>(['starting', 'stopped', 'deleted']),
  stopped: new Set<SessionPhase>(['starting', 'deleted']),
  deleted: new Set<SessionPhase>(['registered']),
}

function getState(id: string): InternalState | undefined {
  return sessions.get(id)
}

/**
 * 统一的 phase 迁移入口：先改状态（C5），再发 phase_changed。
 * 返回是否发生了实际迁移（对角线幂等返回 true 但不发事件；拒绝返回 false）。
 */
function transitionPhase(
  id: string,
  state: InternalState,
  to: SessionPhase,
  meta?: Record<string, unknown>,
): boolean {
  assertNotReentrant()
  const from = state.phase
  if (from === to) return true
  if (!LEGAL_TRANSITIONS[from].has(to)) {
    // 表外迁移拒绝并记诊断——不要静默失败（架构方案 §1）
    logForDiagnosticsNoPII('warn', 'session_registry_transition_rejected', {
      sessionId: id,
      from,
      to,
      ...(meta ?? {}),
    })
    return false
  }
  state.phase = to
  emitSessionEvent({ type: 'phase_changed', sessionId: id, from, to, ...(meta ? { meta } : {}) })
  return true
}

/** 清当前回合（内部）：置 none、清 owner、记 lastTurnEndedAt 并发 turn_changed。 */
function clearTurnInternal(id: string, state: InternalState, meta?: Record<string, unknown>): void {
  if (state.turn === 'none') return
  state.turn = 'none'
  state.turnOwner = null
  state.lastTurnEndedAt = Date.now()
  emitSessionEvent({
    type: 'turn_changed',
    sessionId: id,
    turn: 'none',
    ...(meta ? { meta } : {}),
  })
}

// ———— 写入 API（唯一合法变更入口） ————

/** 登记会话（元数据可用、无进程）。重复登记（非 deleted 态）拒绝并记诊断；deleted 态登记 = 恢复（合法迁移，状态全重置）。 */
export function registerSession(id: string): void {
  assertNotReentrant()
  const existing = getState(id)
  if (existing) {
    if (existing.phase === 'deleted') {
      // 恢复场景：deleted → registered（合法迁移）。全新登记语义（v1.2.4）：回合/权限/时间戳全重置
      existing.phase = 'registered'
      existing.turn = 'none'
      existing.turnOwner = null
      existing.awaitingPermission = false
      existing.lastTurnEndedAt = null
      emitSessionEvent({ type: 'phase_changed', sessionId: id, from: 'deleted', to: 'registered' })
      return
    }
    logForDiagnosticsNoPII('warn', 'session_registry_register_rejected', {
      sessionId: id,
      phase: existing.phase,
    })
    return
  }
  sessions.set(id, {
    phase: 'registered',
    turn: 'none',
    turnOwner: null,
    awaitingPermission: false,
    lastTurnEndedAt: null,
  })
  // 新建条目（无前态）不发 phase_changed；「新登记」事件留待有观察者需求时扩展
  // SessionEvent 联合（阶段 0 不加，防过度设计）。
}

/** 进程拉起中（startupPending）。 */
export function markStarting(id: string): void {
  const state = getState(id)
  if (!state) return
  transitionPhase(id, state, 'starting')
}

/** 进程已在跑。 */
export function markRunning(id: string): void {
  const state = getState(id)
  if (!state) return
  transitionPhase(id, state, 'running')
}

/**
 * 进程异常退出（保留元数据等显式决策）。
 * 进程死亡 ⇒ 回合必然死亡：同时清除活跃回合（meta reason='crashed' 可回查）——
 * 否则 turn 残留会让 stall watcher 对 crashed 会话持续误判假死，且重启后
 * beginTurn 因回合未清而被拒绝。事件顺序：先 phase_changed(crashed) 后
 * turn_changed(none)（C5 先改状态后发，两事件同栈按序派发）。
 */
export function markCrashed(id: string, meta: CrashMeta = {}): void {
  const state = getState(id)
  if (!state) return
  transitionPhase(id, state, 'crashed', meta as Record<string, unknown>)
  clearTurnInternal(id, state, { reason: 'crashed' })
}

/** 主动停止。 */
export function markStopped(id: string): void {
  const state = getState(id)
  if (!state) return
  transitionPhase(id, state, 'stopped')
}

/** tombstone：API 层此后按不存在处理（内存态）。各相 → deleted 均为合法迁移；deleted 重复调用幂等。 */
export function tombstoneSession(id: string): void {
  const state = getState(id)
  if (!state) return
  if (state.phase === 'deleted') return
  clearTurnInternal(id, state, { reason: 'tombstone' })
  transitionPhase(id, state, 'deleted')
}

/**
 * beginTurn：建立回合。
 * - 幂等：该会话已有活跃 turn（awaiting_send 或 turn_in_progress）时返回 null
 *   （对应现 beginInjectedUserTurn 语义）；
 * - 会话未登记时同样返回 null 并记诊断（回合依附于已登记会话）。
 */
export function beginTurn(id: string, opts: { awaitSend: boolean }): TurnHandle | null {
  assertNotReentrant()
  const state = getState(id)
  if (!state) {
    logForDiagnosticsNoPII('warn', 'session_registry_begin_turn_no_session', { sessionId: id })
    return null
  }
  if (state.phase === 'deleted') {
    // tombstone 会话按不存在处理（架构方案 §1/§3）：不可建回合
    logForDiagnosticsNoPII('warn', 'session_registry_begin_turn_no_session', {
      sessionId: id,
      phase: state.phase,
    })
    return null
  }
  if (state.turn !== 'none') return null
  state.turn = opts.awaitSend ? 'awaiting_send' : 'turn_in_progress'
  const identity = Symbol('sessionTurnOwner')
  state.turnOwner = identity
  emitSessionEvent({ type: 'turn_changed', sessionId: id, turn: state.turn })
  return {
    identity,
    abort: () => settleTurnByIdentity(id, identity, { reason: 'abort' }),
    settle: (result: { isError: boolean }) =>
      settleTurnByIdentity(id, identity, { reason: 'settle', isError: result?.isError ?? false }),
  }
}

/** 按身份比对清回合：owner 不匹配（或回合已清）时无害 no-op——幂等（现 activeTurn 引用比对的替代）。 */
export function settleTurnIfOwner(id: string, owner: TurnHandle): void {
  settleTurnByIdentity(id, owner.identity, { reason: 'settle_if_owner' })
}

/**
 * 回合提升：awaiting_send → turn_in_progress（对应现 handler `activeTurn.messageSent = true`，
 * 即 WS 用户消息在 sendMessage 成功后的翻转）。owner 不匹配或回合非 awaiting_send 时
 * 无害 no-op（无条件翻转在外部已清回合后不会复活回合——与旧字段赋值语义等价）。
 * 需要 owner 比对而非无条件：并发下旧 turn 的迟到翻转不得污染新回合。
 */
export function markTurnSent(id: string, owner: TurnHandle): void {
  assertNotReentrant()
  const state = getState(id)
  if (!state) return
  if (state.turnOwner !== owner.identity) return
  if (state.turn !== 'awaiting_send') return
  state.turn = 'turn_in_progress'
  emitSessionEvent({ type: 'turn_changed', sessionId: id, turn: state.turn })
}

/**
 * 观察流结果裁决（双输入源交错规则 · 阶段 1 合同补充 2）：SDK 消息流见到
 * `result` 即清除**任何** turn——观察流是 CLI 事实的最终裁决者，不受 owner
 * 约束；回合不存在时幂等 no-op。阶段 1 仅落地 API + 合同测试，实际接线
 * （dispatchReceiptService 消息流）在阶段 2 的 5a。
 */
export function observeTurnResult(id: string, result: { isError: boolean }): void {
  assertNotReentrant()
  const state = getState(id)
  if (!state) return
  if (state.turn === 'none') return
  clearTurnInternal(id, state, { reason: 'observed_result', isError: result?.isError ?? false })
}

/**
 * 预防性清回合（v1.4.0 阶段2 · 6「转圈无上限」）：观察通道（SDK socket）断开
 * 而进程未退出时，该回合**失去清除来源**——result 永远到不了观察流、进程退出
 * 事件也不会发生，turn 将无上限悬空（前端转圈不落，服务端 turnInProgress 同步
 * 为 true，前后端一致地错着）。此时 turn 的存在本身就是谎言：观察流已盲，服务
 * 端对回合一无所知。此处按「观察通道失联」裁决清除——回合事实仍归 CLI：若 CLI
 * 重连并重放缓冲，result 经 observeTurnResult 到达为 no-op 无害；新回合照常经
 * beginTurn 重建。回合不存在时幂等 no-op。事件照发 turn_changed(none)（前端
 * 状态灯经补偿广播立即从 busy 降下）。
 */
export function dropActiveTurn(id: string, meta?: Record<string, unknown>): void {
  assertNotReentrant()
  const state = getState(id)
  if (!state) return
  if (state.turn === 'none') return
  clearTurnInternal(id, state, { reason: 'observation_blind', ...(meta ?? {}) })
}

/** 内部：身份比对 + 清回合（先改状态后发）。 */
function settleTurnByIdentity(id: string, identity: symbol, meta: Record<string, unknown>): void {
  assertNotReentrant()
  const state = getState(id)
  if (!state) return
  if (state.turnOwner !== identity) return
  if (state.turn === 'none') return
  clearTurnInternal(id, state, meta)
}

/** 权限等待记账（阶段 2 接线；存储本体仍留在 conversationService session 对象）。 */
export function setAwaitingPermission(id: string, awaiting: boolean): void {
  assertNotReentrant()
  const state = getState(id)
  if (!state) return
  if (state.awaitingPermission === awaiting) return
  state.awaitingPermission = awaiting
  emitSessionEvent({ type: 'permission_changed', sessionId: id, awaiting })
}

/**
 * 清除会话条目（closeSessionConnection / stopSession 收尾）。
 * - **幂等校正（09-26 质检修订，阶段 1 合同补充 1）**：若 phase 仍为 running/crashed，
 *   强制落 **stopped**（进程对象删除是 stopped 的充分事实）——阶段 2 回滚后快照自动
 *   退化为 stopped 呈现而非失真的 running；
 * - 活跃回合随对象一并清除（发 turn_changed none）；
 * - 条目不存在时幂等 no-op。
 */
export function clearSession(id: string): void {
  assertNotReentrant()
  const state = getState(id)
  if (!state) return
  if (state.phase === 'running' || state.phase === 'crashed') {
    transitionPhase(id, state, 'stopped', { reason: 'clear_session_correction' })
  }
  clearTurnInternal(id, state, { reason: 'clear_session' })
  sessions.delete(id)
}

// ———— 读取 API（无锁快照） ————

/** 会话快照；未登记（或已被 clearSession 移除）返回 null。 */
export function getSessionSnapshot(id: string): SessionSnapshot | null {
  const state = getState(id)
  if (!state) return null
  return {
    sessionId: id,
    phase: state.phase,
    turn: state.turn,
    turnOwner: state.turnOwner,
    awaitingPermission: state.awaitingPermission,
    lastTurnEndedAt: state.lastTurnEndedAt,
  }
}

/** 是否有活跃回合（awaiting_send 或 turn_in_progress）。 */
export function hasActiveTurn(id: string): boolean {
  const state = getState(id)
  return state !== undefined && state.turn !== 'none'
}

/** 回合消息是否已发出（现 handler:829 messageSent 语义）：仅 turn_in_progress 为真。 */
export function isTurnMessageSent(id: string): boolean {
  const state = getState(id)
  return state !== undefined && state.turn === 'turn_in_progress'
}

/** 存在性第一问：phase !== 'deleted'（tombstone 后为 false；未登记也为 false）。 */
export function exists(id: string): boolean {
  const state = getState(id)
  return state !== undefined && state.phase !== 'deleted'
}

/**
 * 是否已被显式 tombstone（删除）。与 exists() 的关键差别在「未登记」这一态：
 * exists() 对未登记返回 false（registry 视角＝「不认识它」），本函数对未登记
 * 也返回 false（registry 视角＝「没删过它」）。
 *
 * 操作类站点（派活/投递的 tombstone 短路）要的是后者：只拦**显式删除**的会话，
 * 不能把「重启后 registry 尚未登记」的存活会话一并拦掉——registry 是内存态
 * （约束 C1）、启动不重放，重启后所有存量会话都处于「未登记」态。
 */
export function isTombstoned(id: string): boolean {
  const state = getState(id)
  return state !== undefined && state.phase === 'deleted'
}

// ———— 测试 ————

/** 测试隔离：清空全部条目（C7；配合 resetSessionEventsForTests 使用）。 */
export function resetRegistryForTests(): void {
  sessions.clear()
}
