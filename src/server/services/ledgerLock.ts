/**
 * 台账单写者锁（v1.7.0 A6）。
 *
 * **问题**：台账是 JSONL，压实会把整个文件重写成快照。同一台机器上跑了两个
 * 实例（双开 app）时，A 追加的行会被 B 的快照重写整段抹掉——数据丢失级。
 *
 * **方案**（架构裁决）：单写者 pid 锁。持有者实例可写；非持有者**只读**，
 * 写操作返回 503 ledger_readonly。不做跨进程文件锁的细粒度方案。
 *
 * **两个关键设计**（读代码时先看这里）：
 * 1. 判定用 **instanceId 区分实例、用 pid 存活判定陈旧**，不是只看 pid。
 *    所以「同一进程里的第二个服务实例」（pid 相同且存活、instanceId 不同）
 *    会被正确判为**他人持有**，而不是误判成自己——这一点让测试能用同一进程
 *    模拟双实例。
 * 2. 本模块导出的 `ledgerLock` 是**进程级单例**：真实运行时一个进程只应该
 *    有一个写者，进程内多个 CollabTaskService 实例共享同一把锁。跨进程互斥
 *    才是本锁要解决的问题。
 *
 * **陈旧锁**：被 SIGKILL 的实例不会执行 exit 钩子，锁文件会留在盘上；此时其
 * pid 已不存在，任何新实例启动时都会接管。exit 钩子删锁只是避免留下垃圾文件。
 */

import * as fs from 'node:fs/promises'
import { readFileSync, unlinkSync } from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'

export type LedgerLockInfo = {
  pid: number
  /** 持有者进程启动时刻（ISO），用于诊断里区分「谁」 */
  startedAt: string
  instanceId: string
}

export type LedgerLockAcquireResult = {
  acquired: boolean
  /** 未获取时是当前持有人；获取时是自己 */
  holder: LedgerLockInfo | null
}

/** pid 是否仍存在。EPERM 表示进程存在但无权限发信号 → 视为存活。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class LedgerLock {
  readonly instanceId = crypto.randomUUID()
  private readonly startedAt = new Date().toISOString()
  private acquired = false
  private holder: LedgerLockInfo | null = null
  private exitHookInstalled = false
  private checked = false

  constructor(private readonly resolveLockFilePath: () => string) {}

  isAcquired(): boolean {
    return this.acquired
  }

  /** 是否已经做过一次获取尝试（懒获取只做一次） */
  isChecked(): boolean {
    return this.checked
  }

  currentHolder(): LedgerLockInfo | null {
    return this.holder
  }

  /**
   * 尝试获取。**不等待、不轮询、不超时**——获取不到就以只读模式运行，
   * 绝不阻塞启动或让单实例用户受影响。
   *
   * 最多两轮：第一轮撞上「陈旧锁/坏锁文件」时清掉重来一次。
   */
  async tryAcquire(): Promise<LedgerLockAcquireResult> {
    this.checked = true
    const file = this.resolveLockFilePath()
    await fs.mkdir(path.dirname(file), { recursive: true })

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(file, 'wx')
        try {
          await handle.writeFile(JSON.stringify(this.selfInfo()), 'utf-8')
        } finally {
          await handle.close()
        }
        this.acquired = true
        this.holder = this.selfInfo()
        this.installExitHook()
        return { acquired: true, holder: this.holder }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

        const existing = await this.readLockFile(file)
        if (!existing) {
          // 空文件 / 截断的 JSON：无法证明有人持有，按陈旧处理
          await fs.rm(file, { force: true }).catch(() => undefined)
          continue
        }
        if (existing.instanceId === this.instanceId) {
          this.acquired = true
          this.holder = existing
          return { acquired: true, holder: existing }
        }
        if (!isProcessAlive(existing.pid)) {
          logForDiagnosticsNoPII('warn', 'collab_task_ledger_lock_stale_taken_over', {
            staleHolderPid: existing.pid,
            staleHolderStartedAt: existing.startedAt,
          })
          await fs.rm(file, { force: true }).catch(() => undefined)
          continue
        }
        this.acquired = false
        this.holder = existing
        return { acquired: false, holder: existing }
      }
    }

    // 两轮都没抢到：保守判为他人持有（宁可只读，也不冒丢行的风险）
    const holder = await this.readLockFile(file)
    this.acquired = false
    this.holder = holder
    return { acquired: false, holder }
  }

  /** 正常退出时释放；只删**自己的**锁，避免误删接管者的。 */
  release(): void {
    if (!this.acquired) return
    const file = this.resolveLockFilePath()
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as LedgerLockInfo
      if (raw?.instanceId === this.instanceId) unlinkSync(file)
    } catch {
      // 文件已不在（被别人接管/清掉）——无需处理
    }
    this.acquired = false
    this.holder = null
  }

  /** 测试隔离：释放并允许重新获取 */
  resetForTests(): void {
    this.release()
    this.checked = false
    this.holder = null
  }

  private selfInfo(): LedgerLockInfo {
    return { pid: process.pid, startedAt: this.startedAt, instanceId: this.instanceId }
  }

  private async readLockFile(file: string): Promise<LedgerLockInfo | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as Partial<LedgerLockInfo>
      if (typeof parsed?.pid !== 'number' || typeof parsed?.instanceId !== 'string') return null
      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
        instanceId: parsed.instanceId,
      }
    } catch {
      return null
    }
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return
    this.exitHookInstalled = true
    // exit 钩子里只能做同步 IO
    process.on('exit', () => this.release())
  }
}

/** 进程级单例：进程内所有使用者共享同一把锁；跨进程互斥才是目标 */
let sharedLock: LedgerLock | null = null
let resolveSharedLockPath: (() => string) | null = null

/** 装配锁文件位置（服务端启动时调用一次；缺省时不启用锁） */
export function configureLedgerLock(lockFilePath: () => string): LedgerLock {
  resolveSharedLockPath = lockFilePath
  sharedLock = new LedgerLock(lockFilePath)
  return sharedLock
}

/** 取进程级锁；未装配时返回 null（调用方按「不启用锁」处理） */
export function getLedgerLock(): LedgerLock | null {
  return sharedLock
}

/** 测试覆盖用（与项目既有 setXxxOverrideForTests 惯例一致） */
export function setLedgerLockOverrideForTests(lock: LedgerLock | null): void {
  sharedLock = lock
  if (lock === null) resolveSharedLockPath = null
}

export function resolveConfiguredLockPath(): string | null {
  return resolveSharedLockPath?.() ?? null
}
