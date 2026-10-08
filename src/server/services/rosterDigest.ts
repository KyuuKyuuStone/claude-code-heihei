/**
 * rosterDigest —— 给**主管**的每次注入消息捎带一段「当前花名册摘要」（v1.7.4 B2）。
 *
 * ⚠ v1.7.4 修缺陷（摘要被用户看见）：摘要**不得出现在用户可见的消息正文**。
 * 现在它作为**独立系统段**（`<system-reminder>【在册】…</system-reminder>`）**前置**在
 * 送 SDK 的正文里 —— 模型/主管上下文照旧可见（B2 能力不退），而所有 UI 读路径
 * （转录 → MessageEntry 转换 `messageConversion.entryToMessage`）经
 * `stripRosterDigestSegment` 把**本段的**系统段剥掉后再给前端。
 *
 * 动机（用户报的缺陷）：花名册变更信号**只喂 WS/UI**（`ws/handler.ts:3205` 是唯一消费者），
 * **不进任何会话的模型上下文** ⇒ 主管只能靠提示词约定轮询花名册，时机一错就报「没有员工可用」。
 * B2 = 让主管**每次交互都看得见实况**：纯文本、单行、**不带 taskId、不加页脚**。
 *
 * 接线点**只有一处**：`conversationService.sendMessage`（WS 用户上行 `handler.ts:775` 与
 * 投递注入 `sessionMessenger.ts:214` 都在此汇合 —— 已穷举核实；`api/conversations.ts:98`
 * 的 legacy 端点只回 202 不投递，无需接）。
 *
 * 硬约束：**系统段整段独立成行**（剥离方按整行匹配；段不得与正文/页脚共行）。
 */

import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'

/** 换行常量（本模块多处拼行；写成常量避免源码里的转义噪音）。 */
const NEWLINE = '\n'

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

/** 摘要系统段的包裹标签（沿用 CLI 的 system-reminder 约定：模型按系统注入理解，读路径剥）。 */
export const ROSTER_DIGEST_SEGMENT_OPEN = '<system-reminder>'
export const ROSTER_DIGEST_SEGMENT_CLOSE = '</system-reminder>'

/** 组装系统段（模型可见；UI 侧由 stripRosterDigestSegment 剥离）。 */
export function wrapRosterDigestSegment(digest: string): string {
  return `${ROSTER_DIGEST_SEGMENT_OPEN}${NEWLINE}${digest}${NEWLINE}${ROSTER_DIGEST_SEGMENT_CLOSE}`
}

/**
 * 若 `sessionId` 是**在册主管**，返回该注入的**系统段文本**（由调用方前置进模型正文）；
 * 否则返回 null（员工侧不注入）。幂等：正文已含摘要标记则返回 null。
 *
 * 注意：返回值**必须**走 `wrapRosterDigestSegment` 的形态，剥离方（UI 读路径）只认这一形态。
 */
export async function buildRosterDigestSegmentForSupervisor(
  sessionId: string,
  content: string,
): Promise<string | null> {
  // 未装配（未走 L4 启动序，如单测）⇒ 不注入。摘要属加强项，不得阻塞投递。
  if (!depsProvider) return null

  // 摘要挂在**每条注入消息**的通路上：花名册读失败绝不可冒泡阻塞所有投递 ⇒
  // 降级为不注入，但留可诊断痕迹（对齐 servantInfoSource 的「加强项不得阻塞」口径）。
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
    return null
  }

  const self = entries.find((e) => e.sessionId === sessionId)
  if (!self?.supervisor) return null
  if (content.includes(ROSTER_DIGEST_MARK)) return null

  return wrapRosterDigestSegment(formatRosterDigest(entries))
}

/**
 * 历史裸行形态（v1.7.4 之前摘要**直接拼在正文尾部**，没有包裹段）：
 * 行首必须是 `【在册】主管 N 人；员工 M 人`。**边界刻意收窄**——正文里正常提到
 * 「在册」（如「请参考在册员工」）或行中出现该标记的句子都不匹配。
 */
const ROSTER_DIGEST_LEGACY_LINE_RE = new RegExp(
  `^${ROSTER_DIGEST_MARK}主管 \\d+ 人；员工 \\d+ 人`,
)

/**
 * UI 读路径剥离：剥掉两类摘要痕迹，**只剥本模块自己的**——
 * ① 新形态：`<system-reminder>` 包裹的整段（段内必须带 `【在册】` 标记）；
 * ② 历史裸行：行首即 `【在册】主管 N 人；员工 M 人`（用户回看旧消息时也不再看见）。
 * 其它 `<system-reminder>`（CLI 自己的）与正文里提到「在册」的句子原样保留。
 *
 * 未命中即原样返回，不做任何空白规整（避免无谓地改动正文）。
 */
export function stripRosterDigestSegment(content: string): string {
  if (!content.includes(ROSTER_DIGEST_MARK)) return content
  const lines = content.split(NEWLINE)
  const out: string[] = []
  let removed = 0
  for (let i = 0; i < lines.length; i++) {
    const isOpen = (lines[i] ?? '').trim() === ROSTER_DIGEST_SEGMENT_OPEN
    const isDigest = (lines[i + 1] ?? '').includes(ROSTER_DIGEST_MARK)
    const isClose = (lines[i + 2] ?? '').trim() === ROSTER_DIGEST_SEGMENT_CLOSE
    if (isOpen && isDigest && isClose) {
      i += 2
      removed++
      continue
    }
    if (ROSTER_DIGEST_LEGACY_LINE_RE.test((lines[i] ?? '').trimStart())) {
      removed++
      continue
    }
    out.push(lines[i] ?? '')
  }
  if (removed === 0) return content
  // 折叠剥离后留下的首部空行与连续空行（仅在本函数确实剥离过时才规整）。
  const joined = out.join(NEWLINE)
  return joined.replace(/^\n+/, '').replace(/\n{3,}/g, NEWLINE + NEWLINE).replace(/\s+$/, '')
}

/**
 * 读路径剥离（content 形态）：`string` 与 content block 数组都支持。
 * 只对 `type: "text"` 的块剥离**本系统段**，其它块原样返回；未命中不做任何改动
 * （不触碰对象身份：无命中时返回原引用，避免下游 memo 失效）。
 */
export function stripRosterDigestFromContent(content: unknown): unknown {
  if (typeof content === 'string') return stripRosterDigestSegment(content)
  if (!Array.isArray(content)) return content
  let touched = false
  const blocks = content.map((block) => {
    if (!block || typeof block !== 'object') return block
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') return block
    const stripped = stripRosterDigestSegment(candidate.text)
    if (stripped === candidate.text) return block
    touched = true
    return { ...(block as Record<string, unknown>), text: stripped }
  })
  return touched ? blocks : content
}
