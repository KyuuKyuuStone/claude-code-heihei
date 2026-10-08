/**
 * rosterDigest —— 给**主管**的每次注入消息捎带一段「当前花名册摘要」（v1.7.4 B2）。
 *
 * 动机（用户报的缺陷）：花名册变更信号**只喂 WS/UI**（`ws/handler.ts:3205` 是唯一消费者），
 * **不进任何会话的模型上下文** ⇒ 主管只能靠提示词约定轮询花名册，时机一错就报「没有员工可用」。
 * B2 = 让主管**每次交互都看得见实况**：纯文本、单行、**不带 taskId、不加页脚**。
 *
 * 接线点**只有一处**：`conversationService.sendMessage`（WS 用户上行 `handler.ts:775` 与
 * 投递注入 `sessionMessenger.ts:214` 都在此汇合 —— 已穷举核实；`api/conversations.ts:98`
 * 的 legacy 端点只回 202 不投递，无需接）。
 *
 * 硬约束：**摘要必须插在页脚之前**（折叠契约要求页脚是最后一个非空行）。
 */

import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'

/** 摘要里最多列出的 role 数（超出以「等 N 人」聚合）。8 ≈ 40–60 字符：每次注入都带，须与上下文成本相称。 */
export const ROSTER_DIGEST_MAX_ROLES = 8

/** 幂等标记：正文已含即不重复追加。 */
export const ROSTER_DIGEST_MARK = '【在册】'

export type RosterDigestEntry = {
  sessionId?: string
  role?: string
  supervisor?: boolean
  enabled?: boolean
}

export type RosterDigestDeps = {
  listServants: () => Promise<RosterDigestEntry[]>
}

let depsProvider: RosterDigestDeps | null = null

/**
 * 装配根注入（生产）：server/index.ts 启动序调用，形态同 registerServantInfoSource。
 *
 * 本模块**不 import 任何业务模块**。原实现用动态 import 取 servantService 以绕开
 * conversationService → rosterDigest → servantService 静态环，但那触发
 * `no-dynamic-import-in-services` 门禁；改由 L4 汇聚点（server/index.ts）反向接线。
 */
export function registerRosterDigestDeps(provider: RosterDigestDeps): void {
  depsProvider = provider
}

/** 测试注入（避免真读花名册）。传 null 复位。 */
export function setRosterDigestDepsForTests(provider: RosterDigestDeps | null): void {
  depsProvider = provider
}

/** 由花名册条目构造摘要（纯函数，供测试直接调用）。 */
export function formatRosterDigest(entries: RosterDigestEntry[]): string {
  const supervisors = entries.filter((e) => e.supervisor)
  const employees = entries.filter((e) => !e.supervisor && e.enabled !== false)
  if (employees.length === 0) {
    return `${ROSTER_DIGEST_MARK}主管 ${supervisors.length} 人；员工 0 人（暂无可用员工）`
  }
  const roles = employees.map((e) => (e.role ?? '').trim()).filter(Boolean)
  const shown = roles.slice(0, ROSTER_DIGEST_MAX_ROLES)
  const overflow = roles.length - shown.length
  const list = `${shown.join('、')}${overflow > 0 ? `等 ${roles.length} 人` : ''}`
  return `${ROSTER_DIGEST_MARK}主管 ${supervisors.length} 人；员工 ${employees.length} 人：${list}`
}

/**
 * 若 `sessionId` 是**在册主管**，把花名册摘要捎带进 `content` 并返回；
 * 否则**原样返回**（员工侧不注入）。幂等：已含摘要则不重复。
 */
export async function appendRosterDigestIfSupervisor(
  sessionId: string,
  content: string,
): Promise<string> {
  // 未装配（未走 L4 启动序，如单测）⇒ 不注入。摘要属加强项，不得阻塞投递。
  if (!depsProvider) return content

  // 摘要挂在**每条注入消息**的通路上：花名册读失败绝不可冒泡阻塞所有投递 ⇒
  // 降级为原文，但留可诊断痕迹（对齐 servantInfoSource 的「加强项不得阻塞」口径）。
  let entries: RosterDigestEntry[]
  try {
    entries = await depsProvider.listServants()
  } catch (error) {
    // 只记 error.name：diagLogs 契约要求 MUST NOT 含 PII（含路径），而 fs 类错误的
    // message 可能带路径；事件名 + sessionId 已足够定位，宁保守。
    logForDiagnosticsNoPII('warn', 'roster_digest_list_failed', {
      sessionId,
      error: error instanceof Error ? error.name : typeof error,
    })
    return content
  }

  const self = entries.find((e) => e.sessionId === sessionId)
  if (!self?.supervisor) return content
  if (content.includes(ROSTER_DIGEST_MARK)) return content

  const digest = formatRosterDigest(entries)
  const lines = content.split('\n')
  let lastNonEmpty = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? '').trim()) {
      lastNonEmpty = i
      break
    }
  }
  // 硬约束：页脚（派活/汇报页脚）必须仍是最后一个非空行 ⇒ 摘要插在它之前。
  const isFooter = lastNonEmpty >= 0 && /任务 ID：|汇报自：/.test(lines[lastNonEmpty] ?? '')
  if (isFooter) lines.splice(lastNonEmpty, 0, digest)
  else lines.push(digest)
  return lines.join('\n')
}
