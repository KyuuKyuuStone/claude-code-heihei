/**
 * 广播的进程内按键串行队列（裁决三，v1.6.0）。
 *
 * 为什么需要：`handleBroadcast` 的临界区是「查幂等记录 → 逐目标投递 → 成功才记账」。
 * 没有串行化时，同一 broadcastId 的两个并发请求会各自查出「还没有任务」、各自投递，
 * 于是每个目标被投递两次、台账也重复。串行化后后到的请求会等前一个跑完，再重查幂等
 * 记录，命中全部已有任务就直接复用其 taskId。
 *
 * 边界（裁决三明确）：只覆盖**单进程内**的并发。跨进程 / 多实例（两个 sidecar 同时
 * 接同一 broadcastId）不保证，留待 v1.7，不在本版实现。
 */

/** key → 该 key 当前链尾（无论成功失败都已 settle 的 promise） */
const chains = new Map<string, Promise<void>>()

/**
 * 以 key 为粒度串行执行 fn。同 key 排队（FIFO），不同 key 完全并行、互不阻塞。
 *
 * 异常语义：fn 抛错会原样传给本次调用者，但**不影响**同 key 的后续调用——队列用
 * `.catch(() => {})` 消掉前一个的失败再续链。fn 的失败也不会变成 unhandled rejection，
 * 因为链尾已经把 rejection 吞掉了。
 */
export async function withBroadcastLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  // 等前一个结算（成功或失败都继续），再跑本次
  const run = previous.then(fn, fn)
  // 链尾只用于排序：吞掉结果/异常，避免 unhandled rejection 与错误传播到后来者
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  chains.set(key, tail)
  try {
    return await run
  } finally {
    // 只有当自己仍是链尾时才删除。若期间已有后来者把链尾换成自己的 tail，
    // 删除会把它刚注册的 entry 抹掉，导致后来者失去串行保护、map 也会提前泄漏。
    if (chains.get(key) === tail) chains.delete(key)
  }
}

/** 测试钩子：某个 key 当前是否仍有在途/排队的链（用于断言无 map 泄漏） */
export function hasBroadcastLock(key: string): boolean {
  return chains.has(key)
}

/** 测试钩子：清空队列状态（隔离用例） */
export function resetBroadcastLocksForTests(): void {
  chains.clear()
}
