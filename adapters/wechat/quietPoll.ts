/**
 * -14 session timeout 空轮询的日志节流器（v1.4.0 阶段2-8）。
 *
 * 背景：微信长轮询空闲期会周期性返回 errcode=-14（session timeout，服务端会话轮换），
 * pollLoop 每 3s 重试一次并逐条 console.warn——实测诊断日志 7.6KB 里 61 条全是它，
 * 有用日志被淹没。本器把这类空轮询噪音聚合计数：**首次照报**（保可诊断性），之后每
 * summaryIntervalMs 汇总一条「×N (last …)」；离开 -14 状态（收到消息 / 换成其他错误码 /
 * 网络异常）时 flush 尾巴。其他错误码不经过本器，保持逐条可见——真异常不被吞。
 */

export type SessionTimeoutThrottle = {
  /** 记录一次 -14 空轮询。返回需要打印的汇总行；null = 静默累计。 */
  record(nowMs: number): string | null
  /** 离开 -14 状态时调用。有累计则返回汇总行并清零；无累计返回 null。 */
  flush(): string | null
}

export function createSessionTimeoutThrottle(options?: {
  summaryIntervalMs?: number
  now?: () => number
  format?: (count: number, lastAtMs: number) => string
}): SessionTimeoutThrottle {
  const summaryIntervalMs = options?.summaryIntervalMs ?? 5 * 60_000
  const now = options?.now ?? (() => Date.now())
  const format =
    options?.format ??
    ((count: number, lastAtMs: number) =>
      `[WeChat] getupdates session-timeout ×${count} (last ${new Date(lastAtMs).toISOString()}) — idle long-poll noise, suppressed`)

  let count = 0
  let lastAtMs = 0
  let lastLoggedAtMs = Number.NEGATIVE_INFINITY

  return {
    record(nowMs: number): string | null {
      count += 1
      lastAtMs = nowMs
      if (nowMs - lastLoggedAtMs < summaryIntervalMs) return null
      const line = format(count, lastAtMs)
      count = 0
      lastLoggedAtMs = nowMs
      return line
    },
    flush(): string | null {
      if (count === 0) return null
      const line = format(count, lastAtMs)
      count = 0
      return line
    },
  }
}
