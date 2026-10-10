/**
 * 花名册变更通知主管（v1.7.5）
 *
 * 背景：主管对花名册的认知来自**每条消息注入的 roster 摘要**（B2）。员工被
 * **删除**、**取消员工身份**或**降级为普通会话**时，主管这边**不会主动收到任何
 * 消息** ⇒ 认知过期，可能继续给它派活（派活会被 `resolveDispatchTarget` 以
 * `not_on_roster` 挡下，但那时已经浪费一个回合）。
 *
 * 本模块在该变化**真正发生**时，向**同项目**的主管投递一条简短系统消息。
 * 形态镜像 `supervisorProtocolNotice`：
 * - **无条件投递**（过去抄自 `supervisorProtocolNotice` 的「只投递正在运行的主管，
 *   不为一条通知把会话拉起来，裁决二十①」这道闸门已于 **2026-10-10 用户报缺陷当日裁决移除**）。
 *   理由：① 花名册变更是**协作状态变化**（主管必须知道，否则会继续给失效目标派活），
 *   **不是**运维性协议通知（后者丢了无所谓，协议文档才是真源）；② 投递链路
 *   `sessionMessenger.deliver` 本就设计成**目标未加载则自动拉起**（裁决二十一④），
 *   派活/信箱都靠它 ⇒ 为花名册变更自动拉起主管与既有语义**一致**，不是新行为。
 *   原闸门使 `running = phase === 'running'`（仅"正在生成"那一瞬）⇒ 主管空闲/等输入时
 *   通知就被丢弃，表现为「时灵时不灵」（用户实测：加/删员工均收不到）。
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
import { sessionService } from './sessionService.js'
import { ProviderService } from './providerService.js'
import { diagnosticsService } from './diagnosticsService.js'
import { requireSessionDelivery } from './sessionDelivery.js'
import { sameProject } from '../../collaboration/projectPath.js'

export type RosterChangeKind = 'added' | 'removed' | 'disabled' | 'demoted' | 'role_changed'

/** 花名册跃迁输入（只取判定所需字段，便于纯函数测试） */
export type RosterSnapshot = {
  role?: string
  enabled?: boolean
  supervisor?: boolean
}

/**
 * 纯函数：判定「旧 → 新」是否构成需要通知主管的跃迁。
 *
 * 覆盖：**加入（首次登记或重新启用）> 取消员工身份 > 卸任主管 > 角色变更**。
 * 返回 null ＝ 无需通知（无实质变化）。
 *
 * 「加入」也通知主管的依据（**2026-10-09 用户当次拍板：新员工加入恢复通知主管**，
 * 翻转 v1.2.3「系统通知不进对话流」**对本案的适用**）：主管既要知道"谁走了/
 * 谁降级了"，也要知道"谁来了"——否则新员工加入后主管的花名册认知同样有缺口。
 * 详见 `api/servants.ts` 的 `recordServantRegistered` 注释（该处保留了完整沿革）。
 */
export function detectRosterChange(
  previous: RosterSnapshot | null | undefined,
  next: RosterSnapshot | null | undefined,
): RosterChangeKind | null {
  if (!next) return null
  // ① 加入：从「未登记 / 未在册」变为在册员工（首次登记或重新启用）
  if (next.enabled === true && previous?.enabled !== true) return 'added'
  if (!previous) return null
  // ② 取消员工身份（曾是在册员工 → 现在不在册）
  if (previous.enabled === true && next.enabled === false) return 'disabled'
  // ③ 卸任主管（曾任命为主管 → 现在不是）——"降级为普通会话"
  if (previous.supervisor === true && next.supervisor === false) return 'demoted'
  // ④ 角色变更（仅在仍是在册员工时有意义）
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
  /**
   * 被变更会话的工作目录。省略时由 `deps.getSessionWorkDir` 解析；
   * **解析不到 ⇒ 不通知**（记诊断）——"宁可少通知，不许错通知"
   * （主管 2026-10-09 裁决②：跨项目打扰的代价高于漏一条通知）。
   */
  workDir?: string | null
}

/**
 * 依赖注入缝（同 `setSupervisorNoticeDeps` 形态：替代跨文件不安全的
 * mock.module）。传 null 恢复默认。
 */
export type RosterChangeNoticeDeps = {
  listServants: typeof servantService.listServants
  /** 解析被变更会话的工作目录（项目隔离依据）；解析不到 ⇒ 不通知 */
  getSessionWorkDir: (sessionId: string) => Promise<string | null>
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
  getSessionWorkDir: (sessionId) => sessionService.getSessionWorkDir(sessionId),
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
    case 'added':
      return `【系统】花名册变更：员工 ${who} 已加入花名册，可以给它派活了。`
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
 * 向**同项目**的主管投递一条花名册变更通知（**无条件投递**，见模块头裁决）。
 *
 * 同项目：自己解析被变更会话的 workDir 并 `sameProject` 过滤（**解析不到就不通知**，
 * 见裁决②）。失败路径一律吞掉并记诊断——通知是体验项，绝不能影响花名册变更本身。
 */
export async function notifySupervisorsOfRosterChange(
  input: RosterChangeNoticeInput,
): Promise<void> {
  // ── 项目隔离（裁决②：取保守，解析不到就不通知）────────────────────────────
  // 不用 listServants({forSessionId})：该过滤在 workDir 未知时**退化为不过滤**，
  // 会把通知打到别的项目的主管。这里自己解析 workDir 并显式 sameProject 过滤；
  // 解析不到 ⇒ 记诊断后返回（宁可少通知，不许错通知）。
  let workDir = input.workDir ?? null
  if (!workDir) {
    try {
      workDir = await noticeDeps.getSessionWorkDir(input.sessionId)
    } catch {
      workDir = null
    }
  }
  if (!workDir) {
    noticeDeps.recordEvent({
      type: 'roster_change_notice_skipped',
      severity: 'info',
      summary: '无法解析被变更会话的工作目录，跳过花名册变更通知（宁少通知不错通知）',
      sessionId: input.sessionId,
      details: { sessionId: input.sessionId, reason: 'no-workdir', change: input.kind },
    })
    return
  }

  let supervisors: Awaited<ReturnType<RosterChangeNoticeDeps['listServants']>> = []
  try {
    const all = await noticeDeps.listServants({ includeAll: true })
    supervisors = all.filter(
      (s) =>
        s.supervisor &&
        s.sessionId !== input.sessionId &&
        !!s.workDir &&
        sameProject(s.workDir, workDir),
    )
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
    // 2026-10-10 裁决：**无条件投递**（原 `!supervisor.running` 闸门已移除）。
    // 理由见模块头：花名册变更是协作状态变化，且 `deliver` 本就会自动拉起
    // 未加载的主管（裁决二十一④）。
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
