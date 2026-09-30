/**
 * CLI 原生协作工具接口契约（v1.6.0 第二批）
 *
 * 真源：`架构决策_CLI原生协作工具契约.md`。本模块是 CLI 工具与服务端之间的
 * **零业务依赖缝**：只放类型、常量、纯函数与静态断言 helper，不 import 任何
 * server 模块（CLI bundle 不能被服务端实现污染），也不做 IO。
 *
 * 分层：与 dispatchProtocol / supervisorGuard 同层（src/collaboration），
 * 只依赖 node 内置与同层模块，被 src/tools/** 引用。
 *
 * 铁律（静态断言锁定，见 collab-cli-tools.test.ts）：
 * 任务状态**只以台账为准**。工具输出、schema、提示词里不得出现回合态字段
 * （turnInProgress / running / turnState …）——accepted 与 in_progress 由服务端
 * 依据回合事件推进，工具既不读回合态也不替台账推进状态。
 * 例外：`busy` 可用（它是会话忙碌标记，契约 §4.1 明确出现在 target 里）。
 */

import { COLLAB_MAILBOX_DIR } from './dispatchProtocol.js'
import { SUPERVISOR_SESSION_ENV, WORK_DIR_ENV } from './supervisorGuard.js'

// ── 工具名（架构裁决：统一 Collab 前缀，避免与上游 TaskCreate/TaskList 撞名） ──
export const COLLAB_TOOL_NAMES = {
  dispatch: 'CollabDispatch',
  review: 'CollabReview',
  listTasks: 'CollabListTasks',
  report: 'CollabReport',
} as const

export type CollabToolName = (typeof COLLAB_TOOL_NAMES)[keyof typeof COLLAB_TOOL_NAMES]

// ── 会话身份环境变量（服务端 conversationService.buildChildEnv 注入） ──
/** 会话 ID：非协作会话不注入 → 工具一个都不注入 */
export const COLLAB_SESSION_ID_ENV = 'CC_HEIHEI_SESSION_ID'
/** 协作角色：'supervisor' | 'servant'；旧版服务端可能缺失（回退到主管标记判定） */
export const COLLAB_ROLE_ENV = 'CC_HEIHEI_COLLAB_ROLE'
/** 主管标记（与 supervisorGuard 同源，此处复用于角色回退判定） */
export { SUPERVISOR_SESSION_ENV, WORK_DIR_ENV }
/** 桌面服务端地址（降级链第二档；第一档是端口文件） */
export const COLLAB_SERVER_URL_ENV = 'CC_HEIHEI_DESKTOP_SERVER_URL'
/** 端口文件所在目录（~/.claude/cc-heihei/desktop-server.json） */
export const COLLAB_PORT_FILE_DIR = '.claude/cc-heihei'
export const COLLAB_PORT_FILE_NAME = 'desktop-server.json'

export type CollabRole = 'supervisor' | 'servant'

/**
 * 从环境判定协作角色：null = 非协作会话（不注入任何工具）。
 * 必须先有 CC_HEIHEI_SESSION_ID（服务端只对在册协作会话注入），角色缺失时
 * 回退看主管标记——兼容尚未注入 CC_HEIHEI_COLLAB_ROLE 的旧服务端。
 */
export function resolveCollabRole(env: NodeJS.ProcessEnv = process.env): CollabRole | null {
  if (!env[COLLAB_SESSION_ID_ENV]) return null
  const role = env[COLLAB_ROLE_ENV]
  if (role === 'servant') return 'servant'
  if (role === 'supervisor' || env[SUPERVISOR_SESSION_ENV] === '1') return 'supervisor'
  return null
}

/**
 * 角色 → 注入的工具名（架构裁决表）。
 * - 主管：Dispatch / Review / ListTasks
 * - 员工：Report / ListTasks（员工不互派，没有 Dispatch）
 * - 非协作会话：空（普通会话工具清单零变化）
 */
export function collabToolNamesForRole(role: CollabRole | null): readonly CollabToolName[] {
  if (role === 'supervisor') {
    return [COLLAB_TOOL_NAMES.dispatch, COLLAB_TOOL_NAMES.review, COLLAB_TOOL_NAMES.listTasks]
  }
  if (role === 'servant') {
    return [COLLAB_TOOL_NAMES.report, COLLAB_TOOL_NAMES.listTasks]
  }
  return []
}

// ── 任务状态（与 collabTaskService.TaskStatus 逐字一致；漂移由测试断言拦住） ──
export const TASK_STATUSES = [
  'dispatched',
  'accepted',
  'in_progress',
  'delivered',
  'verified',
  'rework',
  'failed',
  'cancelled',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/** 终态：无出边（要继续做只能新开任务），见 collabTaskService 的流转表 */
export const TERMINAL_TASK_STATUSES = ['verified', 'failed', 'cancelled'] as const

/** open 聚合（契约 §4.3）：CollabListTasks 的 status='open' 用 */
export const OPEN_TASK_STATUSES = [
  'dispatched',
  'accepted',
  'in_progress',
  'rework',
  'delivered',
] as const

/** 列表筛选值：TaskStatus 或聚合值 'open' */
export type TaskStatusFilter = TaskStatus | 'open'

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

export function isTerminalTaskStatus(value: unknown): boolean {
  return typeof value === 'string' && (TERMINAL_TASK_STATUSES as readonly string[]).includes(value)
}

export function isOpenTaskStatus(value: unknown): boolean {
  return typeof value === 'string' && (OPEN_TASK_STATUSES as readonly string[]).includes(value)
}

// ── 工具公共输出（契约 §四） ──
export const COLLAB_CHANNELS = ['http', 'mailbox', 'none'] as const
export type CollabChannel = (typeof COLLAB_CHANNELS)[number]

export type CollabToolOutputBase = {
  ok: boolean
  channel: CollabChannel
  serverVersion?: string
  warnings?: string[]
}

/** 列台账可用性（仅 Dispatch 输出用，见契约 §五 表格） */
export type LedgerAvailability = 'supported' | 'unsupported' | 'unknown'

export const COLLAB_ERROR_CODES = {
  notCollabSession: 'not_collab_session',
  invalidTarget: 'invalid_target',
  ambiguousTarget: 'ambiguous_target',
  notOnRoster: 'not_on_roster',
  crossProject: 'cross_project',
  taskNotFound: 'task_not_found',
  notReviewable: 'not_reviewable',
  taskClosed: 'task_closed',
  noOpenTask: 'no_open_task',
  multipleOpenTasks: 'multiple_open_tasks',
  ledgerUnsupported: 'ledger_unsupported',
  serverUnreachable: 'server_unreachable',
  mailboxWriteFailed: 'mailbox_write_failed',
  badRequest: 'bad_request',
} as const

export const COLLAB_WARNING_CODES = {
  /** 对终态重复发起同样的 review：服务端幂等返回，如实报 ok 并附此告警 */
  alreadyFinal: 'already_final',
  /** 台账没推进（员工回合事件未到），消息照投，状态不伪造 */
  ledgerNotUpdated: 'ledger_not_updated',
  /** 旧服务端无台账能力 */
  ledgerUnsupported: 'ledger_unsupported',
  /** 服务不可用，已写入文件信箱排队（等扫描周期取走，结果未经确认） */
  mailboxQueued: 'mailbox_queued',
  /** rework 已生效，但返工通知只能走信箱补投 */
  reworkMessageQueued: 'rework_message_queued',
} as const

// ── 服务端能力（whoami.capabilities，只增不改） ──
export const SERVER_CAPABILITY_COLLAB_TASKS = 'collab-tasks'
export const SERVER_CAPABILITY_REPORT_CALLER_CHECK = 'report-caller-check'
export const SERVER_CAPABILITY_MAILBOX_REPORT = 'mailbox-report'
/** whoami 必须声明的应用名（地址探活校验） */
export const COLLAB_WHOAMI_APP = 'cc-heihei'

// ── HTTP 契约路径（契约 §六：只依赖这几个接口，绝不读回合/进程状态） ──
export const COLLAB_API_PATHS = {
  whoami: '/api/whoami',
  collabTasks: '/api/collab-tasks',
  sessionMessages: '/api/session-messages',
  servantSessions: '/api/servant-sessions',
} as const

// ── 文件信箱（与服务端 dispatchMailboxService 共用格式） ──
export { COLLAB_MAILBOX_DIR }
export const COLLAB_MAILBOX_FILE_PREFIX = {
  dispatch: 'dispatch-',
  report: 'report-',
} as const

// ── 时间/尺寸常量 ──
/** 单次 HTTP 超时：协作工具在会话主路径上，宁可快速失败走降级也不挂住模型 */
export const COLLAB_HTTP_TIMEOUT_MS = 5_000
/** 服务地址缓存 TTL（契约 §五：60 秒失效；投递失败立刻重解析） */
export const COLLAB_SERVER_CACHE_TTL_MS = 60_000
/** ListTasks 默认条数（控制主管上下文） */
export const COLLAB_DEFAULT_LIST_LIMIT = 20
/** Report 第 1 步遇到 409（回合未推进）时的重试间隔 */
export const COLLAB_REPORT_LEDGER_RETRY_DELAY_MS = 2_000
/** Dispatch 不传 title 时，服务端按正文前 40 个码点截取（此处仅用于工具侧提示） */
export const COLLAB_TITLE_MAX_CODEPOINTS = 40

// ── 输出视图（List 只给摘要，不给正文全文） ──
export type CollabPeerRef = { sessionId: string; role?: string }

export type CollabTaskSummary = {
  taskId: string
  title: string
  status: TaskStatus
  to: CollabPeerRef
  from: string
  updatedAt: number
  reworkCount: number
}

/** 台账原始任务（服务端返回的子集；content/report 只在单条查询里出现） */
export type CollabTaskRecord = {
  id: string
  projectDir?: string
  fromSessionId: string
  toSessionId: string
  title: string
  content?: string
  status: TaskStatus
  deliverables?: string[]
  report?: string
  verdict?: string
  createdAt?: number
  updatedAt: number
  history?: Array<{ from: TaskStatus | null; to: TaskStatus; at?: number; note?: string }>
}

/** 返工次数：台账 history 里进入 rework 的次数（返工可数） */
export function countReworks(task: Pick<CollabTaskRecord, 'history'>): number {
  return (task.history ?? []).filter((entry) => entry.to === 'rework').length
}

// ── 回合态禁用字段（验收 8 的静态断言） ──
/**
 * 明令禁止出现在工具输出/schema/描述里的回合态字段名。
 * 状态唯一依据是任务台账；把回合态混进协作工具会让「执行中」与「待接单」
 * 两套语义互相冒充（v1.6.0 后台 agent 提示方案即因此被否决）。
 * 注意不含 `busy`：会话忙碌是契约 §4.1 明确允许透传的字段。
 */
export const FORBIDDEN_TURN_STATE_FIELDS = [
  'turnInProgress',
  'turnState',
  'isRunning',
  'running',
  'inTurn',
  'turnStartedAt',
] as const

/**
 * 递归收集对象里出现的禁用字段路径（`$` 形式，供断言输出可读信息）。
 * 静态断言用：对工具输出做整体扫描，命中即测试失败。
 */
export function collectForbiddenTurnStateFields(value: unknown, path = '$'): string[] {
  const hits: string[] = []
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`))
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = `${at}.${key}`
      if ((FORBIDDEN_TURN_STATE_FIELDS as readonly string[]).includes(key)) hits.push(childPath)
      walk(child, childPath)
    }
  }
  walk(value, path)
  return hits
}
