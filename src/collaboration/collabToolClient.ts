/**
 * CLI 协作工具的 HTTP 客户端与降级通道（v1.6.0 第二批）
 *
 * 职责（契约 §五）：地址解析 → 探活 → 能力检测 → JSON 请求 → 服务不可用时的
 * 文件信箱降级。**严格薄客户端**：不直写台账、不猜状态、不 fallback 到
 * curl/heredoc，所有请求体由 JSON.stringify 生成、UTF-8 由程序保证。
 *
 * 分层：src/collaboration（与 dispatchProtocol 同层），只依赖 node 内置与
 * collabToolContract。服务端侧的同名逻辑（serverIdentity）在 L2，CLI 不可引用，
 * 故此处按契约重写地址解析语义，两边靠测试对拍（见 collab-cli-tools.test.ts）。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { getCcHeiheiDir } from '../utils/envUtils.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  COLLAB_API_PATHS,
  COLLAB_HTTP_TIMEOUT_MS,
  COLLAB_MAILBOX_DIR,
  COLLAB_MAILBOX_FILE_PREFIX,
  COLLAB_PORT_FILE_DIR,
  COLLAB_PORT_FILE_NAME,
  COLLAB_SERVER_CACHE_TTL_MS,
  COLLAB_SERVER_URL_ENV,
  COLLAB_WHOAMI_APP,
  SERVER_CAPABILITY_COLLAB_TASKS,
  WORK_DIR_ENV,
} from './collabToolContract.js'

export type CollabServerSource = 'port-file' | 'env'

export type CollabServerInfo = {
  baseUrl: string
  source: CollabServerSource
  version?: string
  /** null = 旧服务端没有 capabilities 字段（需回退探测） */
  capabilities: string[] | null
  pid?: number
  startedAt?: string
}

export type CollabHttpResult = {
  /** 0 = 网络层失败（连接被拒/超时），未取得 HTTP 响应 */
  status: number
  ok: boolean
  /** 解析后的 JSON body；解析失败为 null */
  body: unknown
  /** 服务端错误消息（errorResponse 的 message 字段） */
  message?: string
  /** 服务端错误码（errorResponse 的 error 字段） */
  errorCode?: string
}

export type MailboxWriteResult = { ok: boolean; file?: string; error?: string }

/**
 * 可注入依赖：默认全用真实实现；测试通过 setCollabToolDepsForTests 覆盖
 * （端口文件目录、fetch、时间、sleep、pid 存活判定都不得硬编码，否则不可测）。
 */
export type CollabToolDeps = {
  env: NodeJS.ProcessEnv
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  now: () => number
  sleep: (ms: number) => Promise<void>
  randomId: () => string
  portFileDir: string
  isPidAlive: (pid: number) => boolean
}

function defaultDeps(): CollabToolDeps {
  return {
    env: process.env,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomId: () => globalThis.crypto.randomUUID(),
    // v1.7.3 #3 读侧统一：与写侧同一解析（getCcHeiheiDir = CLAUDE_CONFIG_DIR || ~/.claude
  // 再拼 cc-heihei）。未设 env 时结果与旧写法（join(homedir(), '.claude/cc-heihei')）逐字相同
  // ⇒ 真实用户零影响；隔离实例（设了 CLAUDE_CONFIG_DIR）从此读**自己的**端口文件，
  // 不再回落 env 打到真实应用。显式注入 portFileDir 的契约不变。
  portFileDir: getCcHeiheiDir(),
    isPidAlive: (pid) => {
      // 契约要求「端口文件先校验 pid」：pid 已死 → 该地址视为陈旧，继续走下一档
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
  }
}

let depsOverride: Partial<CollabToolDeps> | null = null

/** 测试注入（传 null 恢复默认）。 */
export function setCollabToolDepsForTests(overrides: Partial<CollabToolDeps> | null): void {
  depsOverride = overrides
}

/** 当前生效依赖（工具层与测试共用同一入口，保证测试覆盖的是真实路径）。 */
export function collabToolDeps(): CollabToolDeps {
  return { ...defaultDeps(), ...(depsOverride ?? {}) }
}

// ── 地址解析与缓存 ──

type Candidate = {
  baseUrl: string
  source: CollabServerSource
  pid?: number
  startedAt?: string
}

let cachedServer: { info: CollabServerInfo; at: number } | null = null
/** 能力探测结果按 baseUrl 缓存（避免每次调用都打探测请求） */
const capabilityProbeCache = new Map<string, boolean>()

export function invalidateCollabServerCache(): void {
  cachedServer = null
}

/** 测试隔离：清地址缓存、能力探测缓存与注入依赖。 */
export function resetCollabToolClientForTests(): void {
  cachedServer = null
  capabilityProbeCache.clear()
  depsOverride = null
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * 地址解析（契约 §五，按优先级）：
 * 1. 端口文件 ~/.claude/cc-heihei/desktop-server.json（要求 pid 存活）
 * 2. 环境变量 CC_HEIHEI_DESKTOP_SERVER_URL
 * 3. 都没有 → null（服务不可用）
 */
export function resolveServerCandidate(deps: CollabToolDeps): Candidate | null {
  const portFile = join(deps.portFileDir, COLLAB_PORT_FILE_NAME)
  try {
    const raw = JSON.parse(readFileSync(portFile, 'utf8')) as {
      url?: unknown
      pid?: unknown
      startedAt?: unknown
    }
    if (typeof raw.url === 'string' && raw.url) {
      const pid = typeof raw.pid === 'number' ? raw.pid : undefined
      // pid 缺失或已死 = 陈旧端口文件（上次启动遗留），不得使用
      if (pid !== undefined && deps.isPidAlive(pid)) {
        return {
          baseUrl: trimTrailingSlash(raw.url),
          source: 'port-file',
          pid,
          startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
        }
      }
    }
  } catch {
    // 端口文件不存在/不可读 → 下一档
  }

  const envUrl = deps.env[COLLAB_SERVER_URL_ENV]
  if (typeof envUrl === 'string' && envUrl.trim()) {
    return { baseUrl: trimTrailingSlash(envUrl.trim()), source: 'env' }
  }
  return null
}

/**
 * 探活校验：whoami 必须返回 app=cc-heihei；端口文件档还要求 startedAt 一致
 * （不一致说明端口文件来自上一次启动，见 SERVER_ADDRESS_STALENESS_NOTE）。
 */
async function probeCandidate(candidate: Candidate, deps: CollabToolDeps): Promise<CollabServerInfo | null> {
  const result = await rawRequest(deps, candidate.baseUrl, 'GET', COLLAB_API_PATHS.whoami)
  if (!result.ok) return null
  const body = result.body as { app?: unknown; version?: unknown; capabilities?: unknown; startedAt?: unknown } | null
  if (!body || body.app !== COLLAB_WHOAMI_APP) return null
  if (candidate.startedAt && body.startedAt !== candidate.startedAt) return null
  return {
    baseUrl: candidate.baseUrl,
    source: candidate.source,
    version: typeof body.version === 'string' ? body.version : undefined,
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : null,
    pid: candidate.pid,
    startedAt: typeof body.startedAt === 'string' ? body.startedAt : undefined,
  }
}

/**
 * 取当前可用服务端（60 秒缓存）。不可用返回 null —— 调用方据此走降级分支，
 * 不能用 stale 缓存冒充可用。
 */
export async function getCollabServer(deps: CollabToolDeps = collabToolDeps()): Promise<CollabServerInfo | null> {
  if (cachedServer && deps.now() - cachedServer.at < COLLAB_SERVER_CACHE_TTL_MS) {
    return cachedServer.info
  }
  cachedServer = null
  const candidate = resolveServerCandidate(deps)
  if (!candidate) return null
  const info = await probeCandidate(candidate, deps)
  if (!info) return null
  cachedServer = { info, at: deps.now() }
  return info
}

// ── HTTP 请求 ──

async function rawRequest(
  deps: CollabToolDeps,
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<CollabHttpResult> {
  try {
    const response = await deps.fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(COLLAB_HTTP_TIMEOUT_MS),
    })
    let parsed: unknown = null
    let message: string | undefined
    let errorCode: string | undefined
    try {
      parsed = await response.json()
      if (parsed && typeof parsed === 'object') {
        const record = parsed as { error?: unknown; message?: unknown }
        if (typeof record.message === 'string') message = record.message
        if (typeof record.error === 'string') errorCode = record.error
      }
    } catch {
      // 非 JSON 响应（代理错误页等）：保留 status，body 为 null
    }
    return { status: response.status, ok: response.ok, body: parsed, message, errorCode }
  } catch (error) {
    return {
      status: 0,
      ok: false,
      body: null,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 对「已知可用」的服务端发起请求。网络层失败（status=0）时清掉地址缓存，
 * 让下一次调用重新解析地址（契约：投递失败立刻清缓存再解析一次）。
 */
export async function collabRequest(
  server: CollabServerInfo,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  deps: CollabToolDeps = collabToolDeps(),
): Promise<CollabHttpResult> {
  const result = await rawRequest(deps, server.baseUrl, method, path, body)
  if (result.status === 0) invalidateCollabServerCache()
  return result
}

/**
 * 是否支持任务台账（契约 §五能力检测）：
 * - whoami 带 capabilities → 直接查 collab-tasks；
 * - 旧服务端无该字段 → 探测 GET /api/collab-tasks?limit=1，
 *   404 且提示 “Unknown API resource” 视为不支持台账。
 * 返回值表示「是否支持」，服务不可用不属于此函数职责（调用方已先探活）。
 */
export async function supportsCollabTasks(
  server: CollabServerInfo,
  deps: CollabToolDeps = collabToolDeps(),
): Promise<boolean> {
  if (server.capabilities) {
    return server.capabilities.includes(SERVER_CAPABILITY_COLLAB_TASKS)
  }
  const cached = capabilityProbeCache.get(server.baseUrl)
  if (cached !== undefined) return cached
  const probe = await collabRequest(server, 'GET', `${COLLAB_API_PATHS.collabTasks}?limit=1`, undefined, deps)
  let supported: boolean
  if (probe.status === 0) {
    supported = false
  } else if (probe.status === 404) {
    supported = !/unknown api resource/i.test(probe.message ?? '')
  } else {
    supported = probe.status < 500
  }
  capabilityProbeCache.set(server.baseUrl, supported)
  return supported
}

// ── 文件信箱降级（写操作专用；读操作绝不走信箱） ──

/** 会话工作目录（信箱挂在它下面的 .heihei/dispatch/） */
export function collabWorkDir(deps: CollabToolDeps = collabToolDeps()): string {
  const workDir = deps.env[WORK_DIR_ENV]
  return workDir && workDir.trim() ? workDir : process.cwd()
}

/**
 * 写信箱文件（原子落地：先写 .tmp 再 rename，避免服务端 watcher 读到半个 JSON）。
 * 文件命名与 dispatchMailboxService.isDispatchPayloadName 约定一致。
 */
export function writeMailboxFile(
  kind: 'dispatch' | 'report',
  payload: Record<string, unknown>,
  deps: CollabToolDeps = collabToolDeps(),
): MailboxWriteResult {
  const dir = join(collabWorkDir(deps), COLLAB_MAILBOX_DIR)
  const name = `${COLLAB_MAILBOX_FILE_PREFIX[kind]}${deps.now()}-${deps.randomId().slice(0, 8)}.json`
  const target = join(dir, name)
  const tmp = `${target}.tmp`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, target)
    return { ok: true, file: target }
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理失败不影响主错误上报
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
