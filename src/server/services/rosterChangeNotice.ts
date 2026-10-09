/**
 * 花名册变更通知主管（v1.7.5）
 *
 * 背景：主管对花名册的认知来自**每条消息注入的 roster 摘要**（B2）。员工被
 * **删除**、**取消员工身份**或**降级为普通会话**时，主管这边**不会主动收到任何
 * 消息** ⇒ 认知过期，可能继续给它派活（派活会被 `resolveDispatchTarget` 以
 * `not_on_roster` 挡下，但那时已经浪费一个回合）。
 *
 * 本模块在该变化**真正发生**时，向**同项目、正在运行**的主管投递一条简短系统
 * 消息。形态镜像 `supervisorProtocolNotice`：
 * - 只投递**正在运行**的主管（不为一条通知把会话拉起来，裁决二十①）；
 * - 投递地址取**真实端口**（裁决二十②），不再用端口 0 的假值；
 * - 失败/跳过各记一条诊断，不静默；无论如何**不抛错**（通知是体验项，
 *   绝不能影响花名册变更本身）。
 *
 * 幂等：**同一跃迁只通知一次**由调用方保证——`detectRosterChange` 只在
 * 「旧状态 → 新状态」确有变化时返回 change；重复提交相同值（previous 与 next
 * 等价）返回 null，不产生任何投递。本模块自身不保留状态（无 marker），因为
 * 每次跃迁天然只发生一次；跨重启也不会重放（触发点是 API 调用，不是启动扫描）。
 *
 * 产品约束：**这不是审批点**，只是一条通知；不需要任何人批准。
 */

import { servantService } from './servantService.js'
import { ProviderService } from './providerService.js'
import { diagnosticsService } from './diagnosticsService.js'
import { requireSessionDelivery } from './sessionDelivery.js'

export type RosterChangeKind = 'removed' | 'disabled' | 'demoted' | 'role_changed'

/** 花名册跃迁输入（只取判定所需字段，便于纯函数测试） */
export type RosterSnapshot = {
  role?: string
  enabled?: boolean
  supervisor?: boolean
}

/**
 * 纯函数：判定「旧 → 新」是否构成需要通知主管的跃迁。
 *
 * 优先级：**取消员工身份 > 降级为主管之外 > 角色变更**。返回 null ＝ 无需通知
 * （首次登记、重新启用、无实质变化都不属于本条覆盖的「删除/取消/降级/改角色」）。
 *
 * 注意「新增员工」不在此列（另有上岗消息与 `servant_registered` 留痕）。
 */
export function detectRosterChange(
  previous: RosterSnapshot | null | undefined,
  next: RosterSnapshot | null | undefined,
): RosterChangeKind | null {
  if (!previous || !next) return null
  // ① 取消员工身份（曾是在册员工 → 现在不在册）
  if (previous.enabled === true && next.enabled === false) return 'disabled'
  // ② 卸任主管（曾任命为主管 → 现在不是）——"降级为普通会话"
  if (previous.supervisor === true && next.supervisor === false) return 'demoted'
  // ③ 角色变更（仅在仍是在册员工时有意义）
  if (next.enabled === true && (previous.role ?? '') !== (next.role ?? '')) return 'role_changed'
  return null
}

export type RosterChangeNoticeInput = {
  sessionId: string
  kind: RosterChangeKind
  role?: string
  description?: string
  /** 角色变更时的旧角色，仅用于文案 */
  previousRole?: string
}

/**
 * 依赖注入缝（同 `setSupervisorNoticeDeps` 形态：替代跨文件不安全的
 * mock.module）。传 null 恢复默认。
 */
export type RosterChangeNoticeDeps = {
  listServants: typeof servantService.listServants
  deliver: (targetSessionId: string, content: string, serverHost: string) => Promise<boolean>
  /** 本机服务端口：拼真实投递地址（裁决二十②）。 */
  getServerPort: () => number
  recordEvent: (input: {
    type: string
    severity?: 'info' | 'warn' | 'error'
    summary: string
    sessionId?: string
    details?: unknown
  }) => void
}

const defaultDeps: RosterChangeNoticeDeps = {
  listServants: (options) => servantService.listServants(options),
  // G2 B-b：投递经缝注入（缺注册 ⇒ requireSessionDelivery() 抛错，fail-fast）。
  deliver: async (targetSessionId, content, serverHost) =>
    requireSessionDelivery()(targetSessionId, content, serverHost),
  getServerPort: () => ProviderService.getServerPort(),
  recordEvent: (input) => {
    void diagnosticsService.recordEvent(input).catch(() => {})
  },
}

let noticeDeps: RosterChangeNoticeDeps = defaultDeps

export function setRosterChangeNoticeDeps(
  overrides: Partial<RosterChangeNoticeDeps> | null,
): void {
  noticeDeps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps
}

function roleText(input: Pick<RosterChangeNoticeInput, 'role' | 'description'>): string {
  return input.role ? `${input.role}（${input.description || '未填写特性'}）` : '未命名角色'
}

/** 通知正文：说清「谁、什么变化、别再做错事」，控制在 3 行内（主管上下文稀缺）。 */
export function buildRosterChangeNotice(input: RosterChangeNoticeInput): string {
  const who = `${roleText(input)}（会话 ${input.sessionId}）`
  switch (input.kind) {
    case 'removed':
      return `【系统】花名册变更：员工 ${who} 已被移除，不要再给它派活。\n如需重新安排，请先查看最新花名册。`
    case 'disabled':
      return `【系统】花名册变更：员工 ${who} 已取消员工身份（会话可继续对话，但不再受理派活），不要再给它派活。`
    case 'demoted':
      return `【系统】花名册变更：${who} 已卸任主管（降级为普通会话），不要再向它汇报或等它派活。`
    case 'role_changed':
      return `【系统】花名册变更：会话 ${input.sessionId} 的角色由「${input.previousRole || '未命名角色'}」改为「${input.role || '未命名角色'}」，派活请按新角色。`
  }
}

/**
 * 向**同项目、正在运行**的主管投递一条花名册变更通知。
 *
 * 同项目：经 `listServants({ forSessionId })` 过滤（花名册本身按 workDir 项目隔离）。
 * 失败路径一律吞掉并记诊断——通知是体验项，绝不能影响花名册变更本身。
 */
export async function notifySupervisorsOfRosterChange(
  input: RosterChangeNoticeInput,
): Promise<void> {
  let supervisors: Awaited<ReturnType<RosterChangeNoticeDeps['listServants']>> = []
  try {
    const all = await noticeDeps.listServants({
      includeAll: true,
      forSessionId: input.sessionId,
    })
    supervisors = all.filter((s) => s.supervisor && s.sessionId !== input.sessionId)
  } catch (error) {
    console.warn(
      `[RosterChangeNotice] Failed to list servants: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return
  }
  if (supervisors.length === 0) return

  const notice = buildRosterChangeNotice(input)
  const serverHost = `127.0.0.1:${noticeDeps.getServerPort()}`
  for (const supervisor of supervisors) {
    // 裁决二十①：不为一条通知把未运行的主管拉起来。未运行者下次启动时，
    // roster 摘要本就按**实时花名册**重新注入，认知不会过期。
    if (!supervisor.running) {
      noticeDeps.recordEvent({
        type: 'roster_change_notice_skipped',
        severity: 'info',
        summary: '主管会话未运行，跳过花名册变更通知（不代为拉起）',
        sessionId: supervisor.sessionId,
        details: { sessionId: supervisor.sessionId, reason: 'not-running', change: input.kind },
      })
      continue
    }
    try {
      await noticeDeps.deliver(supervisor.sessionId, notice, serverHost)
    } catch (error) {
      console.warn(
        `[RosterChangeNotice] Failed to notify ${supervisor.sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}
