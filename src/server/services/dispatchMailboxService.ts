/**
 * DispatchMailboxService — 文件信箱：会话间消息的文件降级通道
 *
 * 会话的 Bash 不可用时（典型：Windows 缺 Git Bash，所有命令返回占位符），
 * curl 派活/汇报通道整体瘫痪。该服务监听各协作项目工作目录下的
 * `.heihei/dispatch/*.json`：会话用 Write 工具投递
 * `{targetSessionId, content, fromSessionId?}`，服务端代为投递
 * （等价 POST /api/session-messages，含同样的项目隔离校验）后删除文件；
 * 投递失败把文件改名 `*.failed` 并写 `*.error.txt` 说明原因，供会话 Read 排查。
 *
 * 监听范围 = 存在 enabled 员工的项目工作目录（员工登记/移除时经 sync() 收敛）。
 * 主管与员工同项目才能合法派活，所以监听员工工作目录即覆盖全部合法派活/汇报。
 */

import { watch, type FSWatcher } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { COLLAB_MAILBOX_DIR } from '../../collaboration/dispatchProtocol.js'
import { servantService, type ServantInfo } from './servantService.js'
import { sessionService } from './sessionService.js'
import { sessionMessenger } from './sessionMessenger.js'

export type DispatchPayload = {
  targetSessionId: string
  content: string
  fromSessionId?: string
}

export type MailboxDeliveryResult =
  | { ok: true }
  | { ok: false; reason: string }

const PROCESS_DELAY_MS = 200
/** Write 工具写大文件非原子：读到半截 JSON 时按此延迟重试 */
const READ_RETRY_DELAYS_MS = [100, 250, 400]
const MAX_FILE_BYTES = 256 * 1024
const MAX_CONTENT_LENGTH = 64 * 1024

type DebouncedFile = { timer: ReturnType<typeof setTimeout>; firstAt: number }

export function isDispatchPayloadName(name: string): boolean {
  return (
    name.endsWith('.json') &&
    !name.endsWith('.failed.json') &&
    !name.startsWith('.') &&
    !name.includes('/')
  )
}

/** 信箱目录位于 <项目>/.heihei/dispatch：由此反推项目根（层级跟随 COLLAB_MAILBOX_DIR） */
function projectRootFromMailboxDir(mailboxDir: string): string {
  const depth = COLLAB_MAILBOX_DIR.split('/').length
  return path.resolve(mailboxDir, ...Array.from({ length: depth }, () => '..'))
}

function parsePayload(raw: string): DispatchPayload {  const parsed = JSON.parse(raw) as Record<string, unknown>
  const targetSessionId = typeof parsed.targetSessionId === 'string' ? parsed.targetSessionId.trim() : ''
  const content = typeof parsed.content === 'string' ? parsed.content : ''
  const fromSessionId = typeof parsed.fromSessionId === 'string' ? parsed.fromSessionId.trim() : ''
  if (!targetSessionId) throw new Error('Field "targetSessionId" is required')
  if (!content.trim()) throw new Error('Field "content" is required')
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Field "content" exceeds ${MAX_CONTENT_LENGTH} characters`)
  }
  return fromSessionId ? { targetSessionId, content, fromSessionId } : { targetSessionId, content }
}

export class DispatchMailboxService {
  private serverPort = 0
  private watchers = new Map<string, FSWatcher>()
  private debounced = new Map<string, DebouncedFile>()
  private inFlight = new Set<string>()
  private syncing: Promise<void> | null = null
  private stopped = true

  private readonly deps: {
    deliver: (targetSessionId: string, content: string, serverHost: string) => Promise<boolean>
    listServants: (options: { includeAll: true }) => Promise<ServantInfo[]>
    getServant: (sessionId: string) => Promise<{ enabled: boolean } | null>
    getSessionWorkDir: (sessionId: string) => Promise<string | null | undefined>
  }

  /** 全部依赖可注入（测试用）；缺省使用真实协作服务 */
  constructor(deps: Partial<DispatchMailboxService['deps']> = {}) {
    this.deps = {
      deliver: deps.deliver ?? ((target, content, host) => sessionMessenger.deliver(target, content, host)),
      listServants: deps.listServants ?? ((options) => servantService.listServants(options)),
      getServant: deps.getServant ?? ((sessionId) => servantService.getServant(sessionId)),
      getSessionWorkDir:
        deps.getSessionWorkDir ?? ((sessionId) => sessionService.getSessionWorkDir(sessionId)),
    }
  }

  /** 服务端开始监听后调用（Bun.serve 拿到真实端口之后） */
  start(serverPort: number): void {
    this.serverPort = serverPort
    this.stopped = false
    void this.sync()
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.debounced.values()) clearTimeout(timer.timer)
    this.debounced.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }

  /** 员工花名册变化后调用：收敛监听目录（新增/移除） */
  sync(): Promise<void> {
    this.syncing ??= this.syncNow().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async syncNow(): Promise<void> {
    if (this.stopped) return
    const desired = new Set<string>()
    try {
      const servants = await this.deps.listServants({ includeAll: true })
      for (const servant of servants) {
        if (!servant.enabled || !servant.workDir) continue
        desired.add(path.resolve(servant.workDir))
      }
    } catch (error) {
      console.warn(
        `[DispatchMailbox] Failed to list servants: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    for (const [dir, watcher] of this.watchers) {
      if (!desired.has(dir)) {
        watcher.close()
        this.watchers.delete(dir)
      }
    }
    await Promise.all([...desired].map((dir) => this.openWatcher(dir)))
  }

  private mailboxDir(workDir: string): string {
    return path.join(workDir, COLLAB_MAILBOX_DIR)
  }

  private async openWatcher(workDir: string): Promise<void> {
    if (this.watchers.has(workDir)) return
    const dir = this.mailboxDir(workDir)
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch (error) {
      console.warn(
        `[DispatchMailbox] Failed to create ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (this.stopped) return

    // mkdir 与 watch 之间的窗口里已有文件也要被消费
    await this.scanExisting(dir)
    if (this.stopped) return
    const watcher = watch(dir, (_event, fileName) => {
      const name = typeof fileName === 'string' ? fileName : null
      if (!name || !isDispatchPayloadName(name)) return
      this.scheduleProcess(dir, name)
    })
    watcher.on('error', (error) => {
      console.warn(
        `[DispatchMailbox] Watcher error for ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (this.stopped) {
      watcher.close()
      return
    }
    this.watchers.set(workDir, watcher)
  }

  private async scanExisting(dir: string): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (isDispatchPayloadName(name)) this.scheduleProcess(dir, name)
    }
  }

  private scheduleProcess(dir: string, name: string): void {
    const key = `${dir}::${name}`
    const existing = this.debounced.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => {
        this.debounced.delete(key)
        void this.handleMailboxFile(dir, name)
      }, PROCESS_DELAY_MS)
      return
    }
    const timer = setTimeout(() => {
      this.debounced.delete(key)
      void this.handleMailboxFile(dir, name)
    }, PROCESS_DELAY_MS)
    this.debounced.set(key, { timer, firstAt: Date.now() })
  }

  /**
   * 处理单个信箱文件：成功投递后删除；失败改名 *.failed 并写 *.error.txt。
   * 供监听事件与测试调用。
   */
  async handleMailboxFile(dir: string, name: string): Promise<MailboxDeliveryResult> {
    const filePath = path.join(dir, name)
    const key = `${dir}::${name}`
    if (this.inFlight.has(key)) return { ok: false, reason: 'already processing' }
    this.inFlight.add(key)

    try {
      if (!isDispatchPayloadName(name)) return { ok: false, reason: 'not a dispatch payload name' }

      let raw: string | null
      try {
        raw = await this.readPayloadWithRetry(filePath)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await this.markFailed(dir, name, `Failed to read payload: ${reason}`)
        return { ok: false, reason }
      }
      if (raw === null) {
        // 文件已被处理/删除（重复事件），不算失败
        return { ok: true }
      }

      let payload: DispatchPayload
      try {
        payload = parsePayload(raw)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await this.markFailed(dir, name, `Invalid payload: ${reason}`)
        return { ok: false, reason }
      }

      const isolationError = await this.checkProjectIsolation(dir, payload)
      if (isolationError) {
        await this.markFailed(dir, name, isolationError)
        return { ok: false, reason: isolationError }
      }

      const host = `127.0.0.1:${this.serverPort}`
      try {
        const delivered = await this.deps.deliver(payload.targetSessionId, payload.content, host)
        if (!delivered) {
          const reason = 'Message could not be delivered to the target session'
          await this.markFailed(dir, name, reason)
          return { ok: false, reason }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await this.markFailed(dir, name, reason)
        return { ok: false, reason }
      }

      await fs.unlink(filePath).catch(() => {})
      return { ok: true }
    } finally {
      this.inFlight.delete(key)
    }
  }

  private async readPayloadWithRetry(filePath: string): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        const stat = await fs.stat(filePath)
        if (stat.size > MAX_FILE_BYTES) {
          await this.markFailed(path.dirname(filePath), path.basename(filePath), `File exceeds ${MAX_FILE_BYTES} bytes`)
          return null
        }
        return await fs.readFile(filePath, 'utf-8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        if (attempt >= READ_RETRY_DELAYS_MS.length) throw error
        await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt]))
      }
    }
  }

  /**
   * 与 POST /api/session-messages 相同的项目隔离规则：向 enabled 员工派活时，
   * 发送方必须与员工同项目。信箱文件写在某个项目目录里，写入口即是发送方项目。
   */
  private async checkProjectIsolation(
    dir: string,
    payload: DispatchPayload,
  ): Promise<string | null> {
    if (!payload.fromSessionId) return null
    const target = await this.deps.getServant(payload.targetSessionId)
    if (!target?.enabled) return null
    const targetWorkDir = await this.deps.getSessionWorkDir(payload.targetSessionId)
    if (!targetWorkDir) return null
    const projectRoot = projectRootFromMailboxDir(dir)
    return path.resolve(targetWorkDir) === projectRoot
      ? null
      : `Cross-project dispatch is not allowed: mailbox project is ${projectRoot}, worker is in ${targetWorkDir}`
  }

  private async markFailed(dir: string, name: string, reason: string): Promise<void> {
    const filePath = path.join(dir, name)
    const stamp = new Date().toISOString()
    await fs.rename(filePath, `${filePath}.failed`).catch(() => {})
    await fs.writeFile(
      path.join(dir, `${name}.error.txt`),
      `[${stamp}] Dispatch mailbox delivery failed.\n${reason}\n`,
      'utf-8',
    ).catch(() => {})
    console.warn(`[DispatchMailbox] Failed to deliver ${name} in ${dir}: ${reason}`)
  }
}

export const dispatchMailboxService = new DispatchMailboxService()
