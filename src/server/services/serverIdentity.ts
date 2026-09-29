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
}

export const DESKTOP_SERVER_INFO_FILENAME = 'desktop-server.json'

/** 模块加载即定格的启动时间（ISO8601）；端口文件与 whoami 共用同一值 */
const STARTED_AT = new Date().toISOString()

/** package.json version（启动时读一次缓存；读不到退 'unknown'，不炸启动） */
let cachedVersion: string | null = null
function resolvePackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion
  try {
    const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    cachedVersion = 'unknown'
  }
  return cachedVersion
}

export function getServerIdentity(): ServerIdentity {
  return {
    app: 'cc-heihei',
    version: resolvePackageVersion(),
    pid: process.pid,
    startedAt: STARTED_AT,
  }
}

/** 端口文件所在目录（~/.claude/cc-heihei）；home 参数仅供测试注入 */
export function desktopServerInfoDir(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'cc-heihei')
}

export function desktopServerInfoPath(home: string = os.homedir()): string {
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
  const dir = desktopServerInfoDir(opts?.home)
  const info: DesktopServerInfo = {
    url: `http://127.0.0.1:${port}`,
    port,
    pid: process.pid,
    startedAt: STARTED_AT,
  }
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, DESKTOP_SERVER_INFO_FILENAME), JSON.stringify(info, null, 2), 'utf-8')
}

/** 正常退出清理（SIGTERM/SIGINT 路径 await；'exit' 兜底走同步变体） */
export async function clearDesktopServerInfo(opts?: { home?: string }): Promise<void> {
  await fs.rm(path.join(desktopServerInfoDir(opts?.home), DESKTOP_SERVER_INFO_FILENAME), {
    force: true,
  })
}

/** 'exit' 处理器内的同步兜底（异步回调在退出路径不保证执行） */
export function clearDesktopServerInfoSync(opts?: { home?: string }): void {
  try {
    unlinkSync(path.join(desktopServerInfoDir(opts?.home), DESKTOP_SERVER_INFO_FILENAME))
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
