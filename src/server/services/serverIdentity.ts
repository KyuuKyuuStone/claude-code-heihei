/**
 * ServerIdentity — 服务端身份与端口自发现（v1.4.0 阶段1-A ①②）
 *
 * 背景：员工会话的 CC_HEIHEI_DESKTOP_SERVER_URL 是启动时注入的，桌面 app
 * 重启换端口后即失效，员工无自发现手段（v1.3.3 员工反馈 6/7 共同确认的头号
 * 问题：汇报通道端口陈旧——ECONNREFUSED / 被本机其它服务的 200 空 body 误导 /
 * curl 挂起 30s）。本模块提供三件事：
 *
 * 1. **端口落盘**：服务端启动时把实际监听地址写到
 *    `~/.claude/cc-heihei/desktop-server.json`，员工投递前读它即可自愈。
 *    **文件路径与字段是对外契约**（另一路员工按它读取），勿改名/改结构：
 *    `{ url: "http://127.0.0.1:<port>", port, pid, startedAt }`。
 *    退出时删除；进程被强杀残留的旧文件可由 pid+startedAt 识别陈旧
 *    （读取方：先 isPidAlive(pid) 再信 port）。
 * 2. **身份探活**：getServerIdentity() 供 GET /api/whoami 返回
 *    `{ app, version, pid, startedAt }`——本机存在对任意路径回 200 空 body 的
 *    冒充服务（华硕 ArmourySocketServer 实例），探活必须有身份可一击区分。
 * 3. env 注入（CC_HEIHEI_DESKTOP_SERVER_URL）保留向后兼容，但不再是唯一来源。
 *
 * startedAt 在本模块首次加载时定格，端口文件与 whoami 同源。
 */

import { readFileSync, unlinkSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getCcHeiheiDir } from '../../utils/envUtils.js'
import { BACKGROUND_WRITE_RETRY, renameWithRetry } from '../../utils/atomicFs.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'

export type DesktopServerInfo = {
  url: string
  port: number
  pid: number
  startedAt: string
}

export type ServerIdentity = {
  app: 'cc-heihei'
  version: string
  pid: number
  startedAt: string
  /**
   * 能力声明（v1.6.0 CLI 契约 §五）。
   *
   * 客户端（CLI 协作工具）靠它区分新旧服务端：旧服务端没有这个字段，客户端只能
   * 退化成探测 `GET /api/collab-tasks?limit=1` 是否 404 `Unknown API resource`。
   * 有字段时就按这里的名字精确判断，不必再试探。
   *
   * 约定：字段只能**新增**名字，不能删除或改名；任何字段改名、状态机改动都要
   * bump 这里并附带测试（契约 §六）。
   */
  capabilities: string[]
}

/**
 * 当前服务端声明的能力名。新增能力时追加，勿改名/删除（旧客户端已按名字判断）。
 * - collab-tasks：协作台账 REST（/api/collab-tasks*）
 * - report-caller-check：report/review 的 callerSessionId 权限校验
 * - mailbox-report：文件信箱 payload 支持 report 字段（先记账再投递）
 * - broadcast-lock：同一 broadcastId 的进程内串行（仅单进程内保证）
 * - collab-context：GET /api/collab-context（compact 后按调用者身份裁剪的上下文快照）
 */
export const SERVER_CAPABILITIES: readonly string[] = [
  'collab-tasks',
  'report-caller-check',
  'mailbox-report',
  'broadcast-ledger',
  'broadcast-lock',
  'collab-context',
]

export const DESKTOP_SERVER_INFO_FILENAME = 'desktop-server.json'

/**
 * 「我是桌面 app 拉起的正式 sidecar」标记（v1.5.0）。
 *
 * 由来（真实事故，2026-09-29）：端口文件是**单一槽位**的对外契约，任何实例
 * 启动都会覆盖它、退出时按 pid 归属决定是否清除。测试套件里 `startServer(0)`
 * 的用例（conversations / tasks）会拉起真实监听的服务端——它不是提供服务的
 * 那个实例，却把正在服务的桌面 app 从端口文件上挤掉；测试进程退出后文件残留，
 * 所有按契约读文件的员工都先撞死地址（实测 ECONNREFUSED）。
 *
 * 因此：**只有桌面 app 拉起的正式 sidecar 才写/清端口文件**。
 * marker 由 desktop/electron/services/sidecarManager.ts 的 buildSidecarEnv
 * 注入（dev 模式 `bun run electron:dev` 走同一个 sidecarManager，同样会写，
 * 符合预期）；测试、脚本、手工 `bun src/server/index.ts` 一律不写。
 *
 * 注意：读端口文件**不做门槛**——所有进程（含测试）都有读取权。
 */
export const DESKTOP_SIDECAR_ENV_MARKER = 'CC_HEIHEI_DESKTOP_SIDECAR'

/** 本进程是否为桌面 app 拉起的正式 sidecar */
export function isDesktopSidecarProcess(): boolean {
  return process.env[DESKTOP_SIDECAR_ENV_MARKER] === '1'
}

/**
 * 门控说明（v1.5.0 起）：只有桌面 app 拉起的正式 sidecar 才允许占用端口文件槽位。
 *
 * v1.6.0 补充：该标记是**环境变量，会被子进程继承**——任何从 app 派生的进程
 * （e2e 测试 import index 起服务、员工 Bash 里起的 dev sidecar）都带着它。
 * 2026-09-30 实测：一个已死的实例（pid 5264 / port 57094）覆盖了用户正在用的
 * 实例（pid 18908 / 56923），所有按端口文件寻址的会话投递失败。
 * 因此 `startServer`（index.ts）在 NODE_ENV=test 时**整体跳过**端口文件写入与
 * 自愈巡检——bun test 恒为 test，e2e 正是走那条路径起的服务。
 */

/** 模块加载即定格的启动时间（ISO8601）；端口文件与 whoami 共用同一值 */
const STARTED_AT = new Date().toISOString()

/**
 * 应用版本（启动时解析一次缓存）。
 * v1.5.0 C3：打包 sidecar 下原来的 `../../../package.json`（仓库根，开发占位
 * 999.0.0-local）读不到/不可靠，whoami 实测返回 unknown。改为多级来源：
 *   ① env `CC_HEIHEI_APP_VERSION`（打包链注入，最权威；打包脚本由运维拨出）
 *   ② desktop/package.json（用户可见的真实版本号，如 1.4.1）
 * 都读不到退 'unknown'——宁可显式未知，也不回退仓库根的 999.0.0-local 占位
 * 误导探活方。
 */
let cachedVersion: string | null = null

function readVersionFrom(pkgUrl: URL): string | null {
  try {
    const parsed = JSON.parse(readFileSync(pkgUrl, 'utf-8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version : null
  } catch {
    return null
  }
}

function resolvePackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion
  const fromEnv = process.env.CC_HEIHEI_APP_VERSION
  cachedVersion =
    (fromEnv && fromEnv.trim() ? fromEnv : null) ??
    readVersionFrom(new URL('../../../desktop/package.json', import.meta.url)) ??
    'unknown'
  return cachedVersion
}

export function getServerIdentity(): ServerIdentity {
  return {
    app: 'cc-heihei',
    version: resolvePackageVersion(),
    pid: process.pid,
    startedAt: STARTED_AT,
    capabilities: [...SERVER_CAPABILITIES],
  }
}

/**
 * 端口文件所在目录。**v1.7.3 #3**：默认跟随 **config 目录**（`getClaudeConfigHomeDir()` =
 * `CLAUDE_CONFIG_DIR` || `~/.claude`）——隔离实例（CLAUDE_CONFIG_DIR=C:\cc-demo-home）
 * 从此把端口文件写进**自己的** config 目录，**不再覆盖真实应用的记录**（旧实现固定用
 * `os.homedir()`，隔离实例必然污染真实文件 ⇒ 员工汇报/CLI 投递打到错实例）。
 * **兼容性**：未设 `CLAUDE_CONFIG_DIR` 时结果与旧实现**逐字相同**（`~/.claude/cc-heihei`）
 * ⇒ 真实用户零影响；显式传 home 时仍走 `home/.claude/cc-heihei`，保持既有调用/测试契约。
 */
export function desktopServerInfoDir(home?: string): string {
  return home
    ? path.join(home, '.claude', 'cc-heihei')
    : getCcHeiheiDir()
}

export function desktopServerInfoPath(home?: string): string {
  return path.join(desktopServerInfoDir(home), DESKTOP_SERVER_INFO_FILENAME)
}

/**
 * 启动时落盘实际监听地址。写入失败只影响自发现（读方走 env 兜底），不得炸
 * 启动——调用方 catch 后打 warn 即可，本函数自身抛错由调用方决定策略。
 */
export async function writeDesktopServerInfo(
  port: number,
  opts?: { home?: string },
): Promise<void> {
  // 门控：非正式 sidecar（测试/脚本/手工启动）不得占用端口文件槽位
  if (!isDesktopSidecarProcess()) {
    logForDiagnosticsNoPII('debug', 'server_info_write_skipped_not_sidecar', {
      port,
    })
    return
  }
  const dir = desktopServerInfoDir(opts?.home)
  const info: DesktopServerInfo = {
    url: `http://127.0.0.1:${port}`,
    port,
    pid: process.pid,
    startedAt: STARTED_AT,
  }
  await fs.mkdir(dir, { recursive: true })
  // 低-2（v1.5.0）：先清扫同目录的陈旧 tmp（<文件>.<pid>.tmp，其 pid 已死）。
  // 进程被强杀时可能留下半截 tmp；不清会累积，也会与「读目录判断端口文件」的
  // 逻辑混淆。失败只记 debug（清扫是卫生项，不影响本次写入）。
  await sweepStaleServerInfoTmp(dir)
  // C3（v1.5.0）：tmp + rename 原子落盘（对跳 EPERM/EBUSY 重试）——读取方
  // （员工投递前读端口文件）不会读到半截 JSON。
  const finalPath = path.join(dir, DESKTOP_SERVER_INFO_FILENAME)
  const tmpPath = `${finalPath}.${process.pid}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(info, null, 2), 'utf-8')
  await renameWithRetry(fs, tmpPath, finalPath, BACKGROUND_WRITE_RETRY)
}

/** 端口文件巡检周期（v1.6.0 自愈；只做一次文件读 + 必要时一次写，成本可忽略） */
export const PORT_FILE_GUARD_INTERVAL_MS = 60_000

/**
 * 端口文件自愈（v1.6.0）。
 *
 * 场景：端口文件被**别的实例**覆盖——最典型的是一个已死进程留下的残值
 * （2026-09-30：死实例 pid 5264 / port 57094 覆盖了在用的 18908 / 56923，
 * 所有按端口文件寻址的会话投递失败；读方虽有「先校验 pid 存活」的规则，
 * 但那是让每个人都踩一次坑再自救）。
 *
 * 规则：仅当文件里的 pid **已死**、或文件缺失/损坏时夺回并重写；对**活着**的
 * 他人实例一律不抢（多实例同时运行时不互相刷写）。测试/非正式进程不启动巡检。
 *
 * @returns 停止函数
 */
export function startDesktopServerInfoGuard(
  port: number,
  opts?: { home?: string; intervalMs?: number },
): () => void {
  if (!isDesktopSidecarProcess()) return () => {}
  const timer = setInterval(() => {
    void reclaimPortFileIfStale(port, opts).catch((error) => {
      logForDiagnosticsNoPII('debug', 'server_info_guard_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, opts?.intervalMs ?? PORT_FILE_GUARD_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

async function reclaimPortFileIfStale(port: number, opts?: { home?: string }): Promise<void> {
  const filePath = desktopServerInfoPath(opts?.home)
  let parsed: Partial<DesktopServerInfo> | null = null
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Partial<DesktopServerInfo>
  } catch {
    parsed = null
  }
  if (parsed && parsed.pid === process.pid && parsed.port === port) return
  if (parsed && typeof parsed.pid === 'number' && isPidAlive(parsed.pid)) return
  logForDiagnosticsNoPII('warn', 'server_info_stale_reclaimed', {
    port,
    stalePid: typeof parsed?.pid === 'number' ? parsed.pid : null,
    stalePort: typeof parsed?.port === 'number' ? parsed.port : null,
  })
  await writeDesktopServerInfo(port, opts)
}

/**
 * 清扫同目录里属于**已死进程**的 desktop-server.json.<pid>.tmp。
 * 本进程自己的 tmp 不动（正在写）。任何失败只记 debug 诊断。
 */
async function sweepStaleServerInfoTmp(dir: string): Promise<void> {
  const prefix = `${DESKTOP_SERVER_INFO_FILENAME}.`
  try {
    const entries = await fs.readdir(dir)
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue
      const pidText = entry.slice(prefix.length, -'.tmp'.length)
      const pid = Number.parseInt(pidText, 10)
      if (!Number.isInteger(pid) || pid <= 0) continue
      if (pid === process.pid) continue
      if (isPidAlive(pid)) continue
      await fs.rm(path.join(dir, entry), { force: true })
    }
  } catch (error) {
    logForDiagnosticsNoPII('debug', 'server_info_tmp_sweep_failed', {
      dir,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * 正常退出清理（SIGTERM/SIGINT 路径 await；'exit' 兜底走同步变体）。
 * C3（v1.5.0）：只删**本进程写的**文件——文件记录的 pid 是另一个（正整数）
 * pid 时跳过，多实例并存/接力启动时不得清掉后来者的端口文件。坏文件
 * （读不出结构）照删，避免永久残留误导读取方。
 */
export async function clearDesktopServerInfo(opts?: { home?: string }): Promise<void> {
  // 门控同上：没写过文件的进程也不得删别人的文件
  if (!isDesktopSidecarProcess()) {
    logForDiagnosticsNoPII('debug', 'server_info_clear_skipped_not_sidecar', {})
    return
  }
  const current = await readDesktopServerInfo(opts)
  if (
    current &&
    Number.isInteger(current.pid) &&
    current.pid > 0 &&
    current.pid !== process.pid
  ) {
    return
  }
  await fs.rm(path.join(desktopServerInfoDir(opts?.home), DESKTOP_SERVER_INFO_FILENAME), {
    force: true,
  })
}

/**
 * 'exit' 处理器内的同步兜底（异步回调在退出路径不保证执行）。
 * C3：同步路径做同样的 pid 归属校验（读-判-删全同步完成）。
 */
export function clearDesktopServerInfoSync(opts?: { home?: string }): void {
  if (!isDesktopSidecarProcess()) return
  const file = path.join(desktopServerInfoDir(opts?.home), DESKTOP_SERVER_INFO_FILENAME)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { pid?: unknown }
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 && parsed.pid !== process.pid) {
      return
    }
  } catch {
    // 文件不存在/坏内容：继续尝试删除（坏文件照删）
  }
  try {
    unlinkSync(file)
  } catch {
    // 文件不存在/被占用：清理失败不阻塞退出
  }
}

/** 读端口文件；不存在或内容无效返回 null（读取方拿到 null 走 env 兜底） */
export async function readDesktopServerInfo(opts?: { home?: string }): Promise<DesktopServerInfo | null> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(desktopServerInfoDir(opts?.home), DESKTOP_SERVER_INFO_FILENAME), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const port = typeof parsed.port === 'number' ? parsed.port : NaN
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
    return {
      url: typeof parsed.url === 'string' ? parsed.url : `http://127.0.0.1:${port}`,
      port,
      pid: typeof parsed.pid === 'number' ? parsed.pid : NaN,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    }
  } catch {
    return null
  }
}

/**
 * pid 判活（读取方识别陈旧文件用）：POSIX/Windows 均以 kill(pid, 0) 探测——
 * 存在返回 true；ESRCH（不存在）返回 false；EPERM（存在但无权发信号）视为
 * 存活。pid 非正整数直接 false。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
