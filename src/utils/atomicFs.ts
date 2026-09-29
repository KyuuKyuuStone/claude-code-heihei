/**
 * 原子落盘辅助：rename 重试（v1.4.0 阶段2 · 7）
 *
 * 背景：Windows 上 Defender / 索引器会短暂持锁 ~/.claude 下的配置文件，
 * tmp+rename 的 `fs.rename` 在该窗口抛 EPERM/EBUSY（偶发），用户表现为
 * 「保存 agent 偶发 500」，测试表现为 agents-api 5s 超时 flaky。
 *
 * renameWithRetry 只对**瞬态锁类 errno**（EPERM/EBUSY/EMFILE）按固定退避重试；
 * 其它错误（ENOENT/EACCES/EISDIR…）原样抛出，不许吞——重试是给瞬时竞争的，
 * 不是给真实错误的。
 */

export type RenameRetryFs = {
  rename: (from: string, to: string) => Promise<void>
}

export type RenameRetryOptions = {
  /** 额外重试次数（总尝试 = retries + 1）；默认 3 */
  retries?: number
  /** 每次重试前的固定退避毫秒数；默认 25（10–50ms 区间取中） */
  backoffMs?: number
}

const DEFAULT_RETRIABLE = new Set(['EPERM', 'EBUSY', 'EMFILE'])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function renameWithRetry(
  fsModule: RenameRetryFs,
  from: string,
  to: string,
  options?: RenameRetryOptions,
): Promise<void> {
  const retries = options?.retries ?? 3
  const backoffMs = options?.backoffMs ?? 25
  for (let attempt = 0; ; attempt++) {
    try {
      await fsModule.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (attempt >= retries || !code || !DEFAULT_RETRIABLE.has(code)) {
        throw error
      }
      await sleep(backoffMs)
    }
  }
}
