/**
 * 主管会话工具收权 — 会话协作的角色边界兜底
 *
 * 背景（2026-09-11 实战复盘）：主管"只派活不干活"此前仅靠提示词约束，
 * 是软约束——延续对话的旧上下文会压过新规则，模型对"小任务"有强烈的
 * 顺手代劳倾向。此模块提供机制级收权：被标记为主管会话的 CLI 进程，
 * 文件修改类工具（Edit/Write/NotebookEdit）将被结构性拒绝，越权时返回
 * 带派活指引的拒绝文本，模型会转向正确的协作通道。
 *
 * 服务端在拉起会话时按花名册注入 CC_HEIHEI_SUPERVISOR=1（见
 * conversationService.buildChildEnv）；本模块只读环境变量，CLI 侧零依赖。
 *
 * 放行例外（主管的合法写路径）：派活协议本身需要 Write——
 * .dispatch-payload.json / report-payload.json / .heihei/dispatch/ 信箱文件。
 */

export const SUPERVISOR_SESSION_ENV = 'CC_HEIHEI_SUPERVISOR'

/** 主管越权时的统一拒绝文本：教模型走正确通道，而不是单纯报错 */
export const SUPERVISOR_DISPATCH_ONLY_REASON =
  '主管会话禁止修改文件：你的职责是拆解任务、派给员工会话、验收汇报（见 work-orchestrator 协议）。' +
  '请把这项工作按协议派给合适的员工；如确实需要你亲自执行，请用户在会话右键「协作设置…」中取消主管身份后再操作。'

export function isSupervisorSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SUPERVISOR_SESSION_ENV] === '1'
}

/** 主管允许写入的派活相关文件名（工作目录根部） */
const DISPATCH_PAYLOAD_BASENAMES = new Set(['.dispatch-payload.json', 'report-payload.json'])

/** 文件信箱目录片段（跨平台分隔符） */
const MAILBOX_SEGMENTS = ['.heihei', 'dispatch']

function isInsideMailboxDir(normalizedPath: string): boolean {
  const parts = normalizedPath.split(/[/\\]/)
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i] === MAILBOX_SEGMENTS[0] && parts[i + 1] === MAILBOX_SEGMENTS[1]) {
      return true
    }
  }
  return false
}

/**
 * 主管会话的 Write 目标是否放行（null=放行；否则返回拒绝原因）。
 * 只放行派活协议自身需要的写路径：根目录的派活 payload 与 .heihei/dispatch/ 信箱。
 */
export function supervisorWriteDeniedReason(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isSupervisorSession(env)) return null
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const basename = normalized.split('/').pop() ?? ''
  if (DISPATCH_PAYLOAD_BASENAMES.has(basename)) return null
  if (isInsideMailboxDir(normalized)) return null
  return SUPERVISOR_DISPATCH_ONLY_REASON
}

/** 主管会话的 Edit/NotebookEdit 一律拒绝（编辑不属于派活协议的任何环节） */
export function supervisorEditDeniedReason(env: NodeJS.ProcessEnv = process.env): string | null {
  return isSupervisorSession(env) ? SUPERVISOR_DISPATCH_ONLY_REASON : null
}
