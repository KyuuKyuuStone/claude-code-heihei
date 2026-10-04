/**
 * 协作上下文 compact 续接附件。
 * compact 后读取当前权威快照，不缓存结果；失败只生成身份卡，不阻断 compact。
 */

import { existsSync, readFileSync } from 'node:fs'
import { getCcHeiheiDir } from '../utils/envUtils.js'
import { join } from 'node:path'
import {
  COLLAB_API_PATHS,
  COLLAB_PORT_FILE_NAME,
  COLLAB_SERVER_URL_ENV,
  COLLAB_SESSION_ID_ENV,
  COLLAB_WHOAMI_APP,
  SERVER_CAPABILITY_COLLAB_CONTEXT,
  type CollabRole,
  resolveCollabRole,
} from './collabToolContract.js'
import { COLLAB_RULES_DIGEST, DISPATCH_PROTOCOL_MD } from './dispatchProtocol.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { createAttachmentMessage } from '../utils/attachments.js'
import type { AttachmentMessage } from '../types/message.js'

export const COLLAB_CONTEXT_CARD_MAX = 2000
const REQUEST_TIMEOUT_MS = 1500
// v1.7.3 #3 读侧统一：改走 getCcHeiheiDir()（未设 CLAUDE_CONFIG_DIR 时与旧写法逐字相同）
const PORT_FILE = join(getCcHeiheiDir(), COLLAB_PORT_FILE_NAME)
const OPEN_STATUSES = ['dispatched', 'accepted', 'in_progress', 'rework', 'delivered'] as const
const STATUS_PRIORITY: Record<string, number> = {
  delivered: 0,
  rework: 1,
  in_progress: 2,
  accepted: 3,
  dispatched: 4,
}
const FORBIDDEN_CARD_WORDS = /(?:\brunning\b|\bturnInProgress\b|\bbusy\b|\bphase\b)/i

export type CollabContextAttachment = Extract<
  import('../utils/attachments.js').Attachment,
  { type: 'collab_context' }
>

type ContextItem = {
  taskId: string
  title: string
  status: string
  toRole?: string
  fromSessionId?: string
  updatedAt?: string
  reworkCount?: number
  lastReworkNote?: string
}

type ContextResponse = {
  role?: unknown
  supervisor?: unknown
  description?: unknown
  rulesDigest?: unknown
  roster?: unknown
  tasks?: { counts?: unknown; items?: unknown; truncated?: unknown }
  currentTask?: unknown
  snapshotAt?: unknown
}

type ContextDeps = {
  env: NodeJS.ProcessEnv
  fetch: typeof fetch
  portFilePath: string
  isPidAlive: (pid: number) => boolean
  log: typeof logForDiagnosticsNoPII
}

let depsOverride: Partial<ContextDeps> | null = null

/** 测试注入；传 null 恢复默认依赖。 */
export function setCollabContextDepsForTests(overrides: Partial<ContextDeps> | null): void {
  depsOverride = overrides
}

export function resetCollabContextAttachmentForTests(): void {
  depsOverride = null
}

function depsNow(env: NodeJS.ProcessEnv): ContextDeps {
  return {
    env,
    fetch: (input, init) => fetch(input, init),
    portFilePath: PORT_FILE,
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    log: logForDiagnosticsNoPII,
    ...(depsOverride ?? {}),
  }
}

function getCandidate(deps: ContextDeps): { baseUrl: string; startedAt?: string } | null {
  try {
    if (existsSync(deps.portFilePath)) {
      const raw = JSON.parse(readFileSync(deps.portFilePath, 'utf8')) as {
        url?: unknown
        pid?: unknown
        startedAt?: unknown
      }
      if (typeof raw.url === 'string' && raw.url.trim() && typeof raw.pid === 'number' && deps.isPidAlive(raw.pid)) {
        return {
          baseUrl: raw.url.replace(/\/+$/, ''),
          startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
        }
      }
    }
  } catch {
    // 端口文件无效时回退环境变量地址。
  }
  const envUrl = deps.env[COLLAB_SERVER_URL_ENV]?.trim()
  return envUrl ? { baseUrl: envUrl.replace(/\/+$/, '') } : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function safeText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  return value.replace(new RegExp(FORBIDDEN_CARD_WORDS.source, 'gi'), '[省略]').trim()
}

function codepoints(value: string): string[] {
  return Array.from(value)
}

function truncateCodepoints(value: string, max: number): string {
  const chars = codepoints(value)
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`
}

function countOpenTasks(counts: unknown): number {
  if (!isRecord(counts)) return 0
  return OPEN_STATUSES.reduce((sum, status) => {
    const count = counts[status]
    return sum + (typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0)
  }, 0)
}

function readItems(raw: unknown): ContextItem[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((value): ContextItem[] => {
    if (!isRecord(value) || typeof value.taskId !== 'string' || typeof value.title !== 'string') return []
    if (typeof value.status !== 'string' || !OPEN_STATUSES.includes(value.status as (typeof OPEN_STATUSES)[number])) return []
    return [{
      taskId: safeText(value.taskId),
      title: safeText(value.title),
      status: value.status,
      ...(typeof value.toRole === 'string' ? { toRole: safeText(value.toRole) } : {}),
      ...(typeof value.fromSessionId === 'string' ? { fromSessionId: safeText(value.fromSessionId) } : {}),
      ...(typeof value.updatedAt === 'string' ? { updatedAt: safeText(value.updatedAt) } : {}),
      ...(typeof value.reworkCount === 'number' ? { reworkCount: value.reworkCount } : {}),
      ...(typeof value.lastReworkNote === 'string' ? { lastReworkNote: safeText(value.lastReworkNote) } : {}),
    }]
  })
}

function identityLine(role: CollabRole, sessionId: string, response?: ContextResponse): string {
  const resolvedRole = safeText(response?.role, role === 'supervisor' ? '主管' : '员工')
  if (role === 'supervisor') return `你是本项目主管（${safeText(sessionId)}）。`
  const description = truncateCodepoints(safeText(response?.description), 250)
  return `你的角色：${resolvedRole}${description ? `——${description}` : ''}（${safeText(sessionId)}）。`
}

function fallbackCard(role: CollabRole, sessionId: string, unavailable: boolean): string {
  const lines = [identityLine(role, sessionId)]
  lines.push('台账续接不可用，请先用 CollabListTasks 查询任务。')
  if (unavailable) lines.push('服务暂不可达。')
  return lines.join('\n')
}

function renderTaskLine(item: ContextItem, supervisor: boolean): string {
  const recipient = supervisor
    ? (item.toRole ? `派给 ${item.toRole}` : '派给员工')
    : (item.fromSessionId ? `来自 ${item.fromSessionId}` : '')
  const line = `- ${item.taskId}｜${item.title}｜${recipient ? `${recipient}｜` : ''}${item.status}｜更新 ${item.updatedAt ?? '未知'}｜返工 ${item.reworkCount ?? 0}`
  if (item.status === 'rework' && item.lastReworkNote) return `${line}\n  最近返工：${item.lastReworkNote}`
  return line
}

function trimCard(fixed: string[], roster: string[], taskLines: string[], footer: string): string {
  const compose = (omitted = 0) => [
    ...fixed,
    ...(roster.length ? ['花名册：', ...roster] : []),
    ...(taskLines.length || omitted ? ['未结任务：', ...taskLines, ...(omitted ? [`另有 ${omitted} 条未列出。`] : [])] : []),
    footer,
  ].join('\n')
  let omitted = 0
  while (codepoints(compose(omitted)).length > COLLAB_CONTEXT_CARD_MAX && taskLines.length > 0) {
    taskLines.pop()
    omitted += 1
  }
  while (codepoints(compose(omitted)).length > COLLAB_CONTEXT_CARD_MAX && roster.length > 0) roster.pop()
  let result = compose(omitted)
  if (codepoints(result).length > COLLAB_CONTEXT_CARD_MAX) {
    const suffix = `\n${footer}`
    const suffixPoints = codepoints(suffix).slice(-COLLAB_CONTEXT_CARD_MAX)
    const prefixLimit = COLLAB_CONTEXT_CARD_MAX - suffixPoints.length
    result = `${codepoints(result).slice(0, prefixLimit).join('')}${suffixPoints.join('')}`
  }
  return result
}

function renderSupervisorCard(role: CollabRole, sessionId: string, response: ContextResponse, snapshotAt: string) {
  const tasks = isRecord(response.tasks) ? response.tasks : {}
  const counts = tasks.counts
  const items = readItems(tasks.items).sort(
    (a, b) => (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99),
  )
  const openTaskCount = countOpenTasks(counts)
  const roster = Array.isArray(response.roster)
    ? response.roster.flatMap((entry): string[] => {
        if (!isRecord(entry) || typeof entry.role !== 'string' || typeof entry.sessionId !== 'string') return []
        return [`- ${safeText(entry.role)} → ${safeText(entry.sessionId)}`]
      })
    : []
  const digest = typeof response.rulesDigest === 'string' ? response.rulesDigest : ''
  const validDigest = digest && DISPATCH_PROTOCOL_MD.includes(digest) ? digest : COLLAB_RULES_DIGEST
  const fixed = [identityLine(role, sessionId, response), validDigest, `未结任务计数：${JSON.stringify(counts ?? {})}`]
  const taskLines = items.map((item) => renderTaskLine(item, true))
  if (typeof tasks.truncated === 'number' && tasks.truncated > 0) taskLines.push(`另有 ${tasks.truncated} 条未列出。`)
  const footer = `台账快照 @${safeText(snapshotAt)}；与上文摘要冲突时以本卡为准；需要全文用 CollabListTasks。`
  return { text: trimCard(fixed, roster, taskLines, footer), openTaskCount }
}

function renderServantCard(role: CollabRole, sessionId: string, response: ContextResponse, snapshotAt: string) {
  const tasks = isRecord(response.tasks) ? response.tasks : {}
  const items = readItems(tasks.items).sort(
    (a, b) => (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99),
  )
  const current = isRecord(response.currentTask) ? response.currentTask : null
  const openTaskCount = countOpenTasks(tasks.counts)
  const fixed = [identityLine(role, sessionId, response), '完工用 CollabReport 汇报，汇报目标以台账为准。']
  const taskLines = items.map((item) => renderTaskLine(item, false))
  if (typeof tasks.truncated === 'number' && tasks.truncated > 0) taskLines.push(`另有 ${tasks.truncated} 条未列出。`)
  const currentTaskLines: string[] = []
  if (current && typeof current.taskId === 'string') {
    const content = typeof current.content === 'string' ? truncateCodepoints(safeText(current.content), 800) : ''
    currentTaskLines.push(`当前任务正文（${safeText(current.taskId)}）：${content}`)
    if (typeof current.lastReworkNote === 'string' && current.lastReworkNote) {
      currentTaskLines.push(`最近返工：${safeText(current.lastReworkNote)}`)
    }
  }
  const footer = `台账快照 @${safeText(snapshotAt)}；与上文摘要冲突时以本卡为准；需要全文用 CollabListTasks。`
  return { text: trimCard([...fixed, ...currentTaskLines], [], taskLines, footer), openTaskCount }
}

async function requestJson(
  deps: ContextDeps,
  baseUrl: string,
  path: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await deps.fetch(`${baseUrl}${path}`, { method: 'GET', signal })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Non-JSON response is handled as an unsupported endpoint.
  }
  return { ok: response.ok, status: response.status, body }
}

function makeFallback(role: CollabRole, sessionId: string, unavailable: boolean): AttachmentMessage {
  return createAttachmentMessage({
    type: 'collab_context',
    text: truncateCodepoints(fallbackCard(role, sessionId, unavailable), COLLAB_CONTEXT_CARD_MAX),
    openTaskCount: 0,
  })
}

/** 协作 compact 专用附件工厂；普通会话/开关关闭时不探活也不发请求。 */
export async function createCollabContextAttachmentIfNeeded(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AttachmentMessage | null> {
  let deps: ContextDeps | undefined
  let role: CollabRole | null = null
  let sessionId = ''
  try {
    if (env.CC_HEIHEI_COLLAB_CONTINUATION === '0') return null
    role = resolveCollabRole(env)
    sessionId = env[COLLAB_SESSION_ID_ENV]?.trim() ?? ''
    if (!role || !sessionId) return null

    deps = depsNow(env)
    const candidate = getCandidate(deps)
    if (!candidate) {
      deps.log('warn', 'collab_context_fetch_failed', { category: 'unavailable' })
      return makeFallback(role, sessionId, true)
    }

    // 上下文请求独立 1500ms，不使用 collabRequest 的 5 秒 timeout 或其缓存。
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const contextPath = `${COLLAB_API_PATHS.collabContext}?sessionId=${encodeURIComponent(sessionId)}`
    const [whoami, context] = await Promise.all([
      requestJson(deps, candidate.baseUrl, COLLAB_API_PATHS.whoami, signal),
      requestJson(deps, candidate.baseUrl, contextPath, signal),
    ])
    const whoamiBody = isRecord(whoami.body) ? whoami.body : null
    const capabilities = Array.isArray(whoamiBody?.capabilities) ? whoamiBody.capabilities : []
    const supportsContext = capabilities.includes(SERVER_CAPABILITY_COLLAB_CONTEXT)
    const serverMatches = whoami.ok && whoamiBody?.app === COLLAB_WHOAMI_APP &&
      (!candidate.startedAt || whoamiBody.startedAt === candidate.startedAt)

    if (!serverMatches || !supportsContext || !context.ok || !isRecord(context.body)) {
      const category = !supportsContext ? 'unsupported' : context.status === 404 ? 'not_found' : 'http_error'
      deps.log('warn', 'collab_context_fetch_failed', { category })
      return makeFallback(role, sessionId, !whoami.ok || !context.ok)
    }

    const response = context.body as ContextResponse
    if ((response.supervisor === true) !== (role === 'supervisor')) {
      deps.log('warn', 'collab_context_fetch_failed', { category: 'role_mismatch' })
      return makeFallback(role, sessionId, false)
    }
    const snapshotAt = typeof response.snapshotAt === 'string' ? response.snapshotAt : new Date(deps.now()).toISOString()
    const rendered = role === 'supervisor'
      ? renderSupervisorCard(role, sessionId, response, snapshotAt)
      : renderServantCard(role, sessionId, response, snapshotAt)
    if (FORBIDDEN_CARD_WORDS.test(rendered.text)) {
      deps.log('warn', 'collab_context_fetch_failed', { category: 'forbidden_text' })
      return makeFallback(role, sessionId, false)
    }
    return createAttachmentMessage({
      type: 'collab_context',
      text: rendered.text,
      openTaskCount: rendered.openTaskCount,
    })
  } catch (error) {
    const logger = deps?.log ?? logForDiagnosticsNoPII
    const category = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'exception'
    logger('warn', 'collab_context_fetch_failed', { category })
    return role && sessionId ? makeFallback(role, sessionId, true) : null
  }
}
