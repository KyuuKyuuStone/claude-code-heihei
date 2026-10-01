/**
 * 原子落盘辅助：rename 重试（v1.4.0 阶段2 · 7；v1.7.0 D1 加固）
 *
 * 背景：Windows 上 Defender / 索引器会短暂持锁 ~/.claude 下的配置文件，
 * tmp+rename 的 `fs.rename` 在该窗口抛 EPERM/EBUSY（偶发），用户表现为
 * 「保存 agent 偶发 500」，测试表现为 agents-api 5s 超时 flaky。
 *
 * renameWithRetry 只对**瞬态锁类 errno**（EPERM/EBUSY/EMFILE/ENOTEMPTY）重试；
 * 其它错误（ENOENT/EACCES/EISDIR…）原样抛出，不许吞——重试是给瞬时竞争的，
 * 不是给真实错误的。
 *
 * v1.7.0 D1 加固（架构评估 v1.7.0 §一 D1）：
 * 1. 退避由**固定 25ms** 改为**指数递增**（20/40/80/160/320ms，单次上限 400ms），
 *    默认重试次数 3 → 5，总退避约 620ms。固定 75ms 覆盖不了杀软扫描窗口。
 * 2. ENOTEMPTY 与 EPERM/EBUSY/EMFILE 同列为可重试（Windows 目录 rename 竞态）。
 * 3. 最终失败抛 `AtomicWriteError`：`code` 沿用原始 errno（不破坏既有 catch 与断言），
 *    另带 `atomicWriteKind` 区分「文件被占用（locked）」与「真实 IO 失败（io）」，
 *    HTTP 层据此给出可理解的响应，而不是裸 500。
 * 4. 最终失败记诊断（errno + 目标文件名），便于线上定位。
 *
 * **不含 copy+delete 回退**：回退路径非原子（copyFile 失败时目标可能被部分写入），
 * 会抵消 tmp+rename 的「要么新要么旧」保证。该取舍属架构裁决范围，主管 13991421
 * 已暂缓（待架构师裁定）。若将来启用，须先定「仅在何种 errno、何种调用方」下开启。
 */

import { logForDiagnosticsNoPII } from './diagLogs.js'

export type RenameRetryFs = {
  rename: (from: string, to: string) => Promise<void>
}

export type RenameRetryOptions = {
  /** 额外重试次数（总尝试 = retries + 1）；默认 5 */
  retries?: number
  /** 退避基数毫秒数（首轮等待），此后按 2 的幂递增；默认 20 */
  backoffMs?: number
  /** 单次退避上限毫秒数；默认 400 */
  maxBackoffMs?: number
}

/** 瞬态锁类 errno：重试有意义，其它错误一律不重试 */
const DEFAULT_RETRIABLE = new Set(['EPERM', 'EBUSY', 'EMFILE', 'ENOTEMPTY'])

const DEFAULT_RETRIES = 5
const DEFAULT_BACKOFF_MS = 20
const DEFAULT_MAX_BACKOFF_MS = 400

/**
 * **后台写入**的重试档位：总退避约 1.9s（30+60+120+240+480+960）。
 *
 * 架构裁决（架构评估 v1.7.0 补充裁决二）：用户请求路径要尽快给出「被占用」
 * 的答复，保持默认的约 620ms；而后台写入（台账压实、摘要索引、端口文件）
 * 没有人在等，值得多等一会儿以躲开杀软/索引器的整轮扫描。
 *
 * 只用于这三处，不要顺手套到用户请求路径上。
 */
export const BACKGROUND_WRITE_RETRY: RenameRetryOptions = {
  retries: 6,
  backoffMs: 30,
  maxBackoffMs: 1000,
}

/** 失败性质：locked = 被其它进程占用（可重试/可回退）；io = 真实 IO 错误 */
export type AtomicWriteFailureKind = 'locked' | 'io'

/**
 * 写盘最终失败。`code` 保持原始 errno，既有调用方的
 * `error.code === 'EPERM'` 判断不受影响；新增 `atomicWriteKind` 供上层分类。
 */
export class AtomicWriteError extends Error {
  readonly code: string | undefined
  readonly atomicWriteKind: AtomicWriteFailureKind

  constructor(
    message: string,
    options: { kind: AtomicWriteFailureKind; code: string | undefined; cause: unknown },
  ) {
    super(message, { cause: options.cause })
    this.name = 'AtomicWriteError'
    this.code = options.code
    this.atomicWriteKind = options.kind
  }
}

/** 是否为写盘失败错误（供 HTTP 层与调用方分类用） */
export function isAtomicWriteError(error: unknown): error is AtomicWriteError {
  return error instanceof AtomicWriteError
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 第 attempt 次失败后的等待时长：base * 2^attempt，封顶 max */
function backoffFor(attempt: number, base: number, max: number): number {
  return Math.min(base * 2 ** attempt, max)
}

export async function renameWithRetry(
  fsModule: RenameRetryFs,
  from: string,
  to: string,
  options?: RenameRetryOptions,
): Promise<void> {
  const retries = options?.retries ?? DEFAULT_RETRIES
  const backoffMs = options?.backoffMs ?? DEFAULT_BACKOFF_MS
  const maxBackoffMs = options?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS

  for (let attempt = 0; ; attempt++) {
    try {
      await fsModule.rename(from, to)
      return
    } catch (error) {
      const code = errnoOf(error)

      // 非瞬态（含无 errno 的未知错误）：不重试，包装后原样上抛
      if (!code || !DEFAULT_RETRIABLE.has(code)) {
        throw new AtomicWriteError(
          `Atomic write failed (${code ?? 'unknown'}): ${(error as Error)?.message ?? String(error)}`,
          { kind: 'io', code, cause: error },
        )
      }

      if (attempt < retries) {
        await sleep(backoffFor(attempt, backoffMs, maxBackoffMs))
        continue
      }

      // 重试耗尽：目标仍被占用。不做 copy 回退（见文件头说明），原文件保持原状。
      logForDiagnosticsNoPII('error', 'atomic_write_failed', {
        target: to,
        errno: code,
        attempts: attempt + 1,
        fallbackEnabled: false,
      })
      throw new AtomicWriteError(
        `Atomic write failed after ${attempt + 1} attempts: ${to} is locked by another process (${code}); the original file was left unchanged.`,
        { kind: 'locked', code, cause: error },
      )
    }
  }
}
