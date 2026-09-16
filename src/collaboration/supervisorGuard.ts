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

import { realpathSync } from 'node:fs'

export const SUPERVISOR_SESSION_ENV = 'CC_HEIHEI_SUPERVISOR'

/** 员工约束档位：full=完全执行（现状）；readonly=只读观察（禁改文件，信箱汇报放行）；whitelist=目录白名单（仅白名单目录内可写） */
export const SERVANT_CONSTRAINT_ENV = 'CC_HEIHEI_SERVANT_CONSTRAINT'

/** whitelist 档的可写目录列表（换行分隔的绝对路径；换行符不可能出现在路径中，规避盘符冒号冲突） */
export const SERVANT_WRITE_DIRS_ENV = 'CC_HEIHEI_SERVANT_WRITE_DIRS'

export type ServantConstraint = 'full' | 'readonly' | 'whitelist'

export function servantConstraintFromEnv(env: NodeJS.ProcessEnv = process.env): ServantConstraint | null {
  if (env[SERVANT_CONSTRAINT_ENV] === 'readonly') return 'readonly'
  if (env[SERVANT_CONSTRAINT_ENV] === 'whitelist') return 'whitelist'
  return null
}

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

/** 只读观察员工的统一拒绝文本 */
export const SERVANT_READONLY_REASON =
  '只读观察会话禁止修改文件：你的职责是分析与汇报，不是改动。请把建议的修改以文本形式写入汇报（或 .heihei/dispatch/ 信箱）提交；' +
  '如需直接执行，请用户在会话右键「协作设置…」中将约束档位改为「完全执行」。'

// —— whitelist 档：目录白名单路径判定（纯函数，参数可注入供单测）——
// 设计要点（批次2_A3白名单档_设计方案 §2.2）：
// - 目录边界感知前缀：/proj-evil 不得匹配 /proj（必须比对 dir + '/' 或全等）
// - win32 大小写归一（NTFS 不区分大小写），POSIX 保持原样
// - 双侧 realpath best-effort：白名单目录内的符号链接指向外部时以真实路径
//   为准（更严格，防链接绕出）；realpath 失败（目录尚不存在/网络盘）回退原值
// - 路径穿越 .. 由工具侧 expandPath 先归一（resolve 语义），guard 侧对
//   非绝对路径直接拒绝作为纵深防御
// - whitelist 档但列表缺失/解析为空 → 全拒（最严格解释，防配置丢失静默放开）

export type WhitelistMatchOptions = {
  platform?: NodeJS.Platform
  /** 注入 fake realpath 供单测；传 null 禁用符号链接解析 */
  realpath?: ((p: string) => string) | null
}

export function parseServantWriteDirs(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function normalizeForMatch(p: string, platform: NodeJS.Platform): string {
  const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isAbsoluteNormalized(normalized: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return /^[a-z]:\//.test(normalized) || normalized.startsWith('//')
  return normalized.startsWith('/')
}

function isInsideDir(target: string, dir: string): boolean {
  return target === dir || target.startsWith(`${dir}/`)
}

function whitelistDeniedReason(dirs: readonly string[]): string {
  const list = dirs.length > 0 ? dirs.join('\n') : '（白名单为空：配置缺失已按最严格处理）'
  return (
    '目录白名单约束：你只能写以下目录：\n' +
    list +
    '\n请把目标文件放进上述目录（或在任务里说明需要哪个目录，请用户在会话右键「协作设置…」中调整白名单）；汇报可照常写入 .heihei/dispatch/ 信箱。'
  )
}

/**
 * whitelist 档路径判定：null=放行；否则返回拒绝原因。
 * 白名单目录列表来自 CC_HEIHEI_SERVANT_WRITE_DIRS（换行分隔）或直接传数组。
 */
export function servantWhitelistWriteDeniedReason(
  filePath: string,
  writeDirs: string | readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: WhitelistMatchOptions = {},
): string | null {
  const platform = options.platform ?? process.platform
  // realpath 解析：null=禁用（恒等）；抛错=该侧解析失败（目录尚不存在/网络盘）
  const resolvePath: (p: string) => string =
    options.realpath === undefined
      ? (p) => realpathSync.native(p)
      : (options.realpath ?? ((p) => p))
  const dirs = Array.isArray(writeDirs) ? writeDirs : parseServantWriteDirs(env[SERVANT_WRITE_DIRS_ENV])

  const normalizedTarget = normalizeForMatch(filePath, platform)
  if (!isAbsoluteNormalized(normalizedTarget, platform)) return whitelistDeniedReason(dirs)

  // 真实路径为准（防目录内符号链接绕出/链入）。某侧解析失败时仅该侧回退
  // 字面路径；成功侧不回退——否则「链接绕出」会被字面比对重新放行。
  let resolvedTarget: string | null = null
  try {
    resolvedTarget = normalizeForMatch(resolvePath(filePath), platform)
  } catch {
    resolvedTarget = null
  }
  for (const dir of dirs) {
    let resolvedDir: string | null = null
    try {
      resolvedDir = normalizeForMatch(resolvePath(dir), platform)
    } catch {
      resolvedDir = null
    }
    const target = resolvedTarget ?? normalizedTarget
    const dirNorm = resolvedDir ?? normalizeForMatch(dir, platform)
    if (isInsideDir(target, dirNorm)) return null
  }
  return whitelistDeniedReason(dirs)
}

/**
 * 员工约束档位检查：readonly 档拒绝一切文件修改（信箱汇报放行）；
 * whitelist 档仅放行白名单目录内写入（信箱/派活 payload 例外同样适用）。
 * full 档或未设置 → 不限制。
 */
export function servantConstraintWriteDeniedReason(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const constraint = servantConstraintFromEnv(env)
  if (constraint === null) return null
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const basename = normalized.split('/').pop() ?? ''
  if (DISPATCH_PAYLOAD_BASENAMES.has(basename)) return null
  if (isInsideMailboxDir(normalized)) return null
  if (constraint === 'readonly') return SERVANT_READONLY_REASON
  return servantWhitelistWriteDeniedReason(filePath, undefined, env)
}
